import { NextRequest, NextResponse } from 'next/server';
import {
  createPublicClient, decodeFunctionResult, encodeFunctionData, getAddress,
  isAddress, parseAbi, type Address, type Hex,
} from 'viem';
import { DEPLOY, rhTransport } from '@/lib/testnet';
import { MANIFEST_HASH, RELEASE } from '@/lib/public-release';

export const dynamic = 'force-dynamic';

const MARKET = getAddress(DEPLOY.testnet.VoidGenesisNftAmmV6);
const rpc = createPublicClient({ transport: rhTransport() });
const marketAbi = parseAbi([
  'function inventoryCount() view returns(uint256)',
  'function inventoryAt(uint256) view returns(uint256)',
  'function randomBuyQuote() view returns(uint256)',
  'function specificBuyQuote() view returns(uint256)',
  'function sellQuote() view returns(uint256)',
]);
const gatewayAbi = parseAbi(['function query(bytes) view returns(bytes)']);
const runtimeAbi = parseAbi(['function feeOf(uint256) view returns(uint256)', 'function apps(uint256) view returns(bool,uint256,bool,uint256,address,uint256,uint256)', 'function belongsTo(uint256,address) view returns(bool)']);
const mintAbi = parseAbi(['function totalMinted() view returns(uint256)']);
const tokenAbi = parseAbi(['function balanceOf(address) view returns(uint256)']);
const deedAbi = parseAbi(['function ownerOf(uint256) view returns(address)']);

async function query(functionName: 'inventoryCount' | 'inventoryAt' | 'randomBuyQuote' | 'specificBuyQuote' | 'sellQuote', args: readonly bigint[] = []) {
  const data = encodeFunctionData({ abi: marketAbi, functionName, args: args as never });
  const raw = await rpc.readContract({ address: MARKET, abi: gatewayAbi, functionName: 'query', args: [data] }) as Hex;
  return decodeFunctionResult({ abi: marketAbi, functionName, data: raw }) as bigint;
}

export async function GET(request: NextRequest) {
  try {
    if (await rpc.getChainId() !== 46630) throw new Error('Wrong RPC network');
    const input = request.nextUrl.searchParams.get('account');
    const account = input && isAddress(input) ? getAddress(input) : null;
    const [count, randomQuote, specificQuote, sellQuote, fee, minted] = await Promise.all([
      query('inventoryCount'), query('randomBuyQuote'), query('specificBuyQuote'), query('sellQuote'),
      rpc.readContract({ address: getAddress(DEPLOY.production.VoidChainAppRuntime), abi: runtimeAbi, functionName: 'feeOf', args: [1n] }).catch(() => null),
      rpc.readContract({ address: getAddress(DEPLOY.production.VoidEthGenesisMintV11), abi: mintAbi, functionName: 'totalMinted' }),
    ]);
    const inventory = await Promise.all(Array.from({ length: Number(count) }, (_, index) => query('inventoryAt', [BigInt(index)])));
    const [chain, registered, reserve, threshold] = await Promise.all([
      rpc.readContract({ address: getAddress(DEPLOY.production.VoidChainAppRuntime), abi: runtimeAbi, functionName: 'apps', args: [1n] }),
      rpc.readContract({ address: getAddress(DEPLOY.production.VoidChainAppRuntime), abi: runtimeAbi, functionName: 'belongsTo', args: [1n, MARKET] }),
      rpc.getBalance({ address: getAddress(DEPLOY.production.VoidPaymaster) }),
      rpc.readContract({ address: getAddress(DEPLOY.production.VoidPaymaster), abi: parseAbi(['function refillThreshold() view returns(uint256)']), functionName: 'refillThreshold' }),
    ]);
    const ready = fee !== null && chain[0] && registered && reserve > 0n && reserve >= threshold
      && randomQuote > 0n && specificQuote > 0n && sellQuote > 0n;
    let balance = 0n;
    let owned: bigint[] = [];
    if (account) {
      balance = await rpc.readContract({ address: getAddress(DEPLOY.testnet.VoidTestToken), abi: tokenAbi, functionName: 'balanceOf', args: [account] });
      const owners = await Promise.all(Array.from({ length: Number(minted) }, (_, index) =>
        rpc.readContract({ address: getAddress(DEPLOY.production.VoidChainDeed), abi: deedAbi, functionName: 'ownerOf', args: [BigInt(index + 1)] }) as Promise<Address>));
      owned = owners.flatMap((owner, index) => owner.toLowerCase() === account.toLowerCase() ? [BigInt(index + 1)] : []);
    }
    return NextResponse.json({
      market: MARKET,
      version: RELEASE, manifestHash: MANIFEST_HASH, checkedAt: Date.now(), ready,
      inventory: inventory.map(String),
      randomQuote: randomQuote.toString(), specificQuote: specificQuote.toString(), sellQuote: sellQuote.toString(),
      transactionFee: ready ? fee!.toString() : null, minted: minted.toString(), balance: balance.toString(), owned: owned.map(String),
      sellable: owned.map(String),
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    console.error('V11 market state failed', error);
    return NextResponse.json({ error: 'Could not read the NFT/VOID market.' }, { status: 502 });
  }
}
