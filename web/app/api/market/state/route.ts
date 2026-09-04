import { NextRequest, NextResponse } from 'next/server';
import {
  createPublicClient, decodeFunctionResult, encodeFunctionData, getAddress,
  http, isAddress, parseAbi, type Address, type Hex,
} from 'viem';
import { DEPLOY, RH_TESTNET } from '@/lib/testnet';

export const dynamic = 'force-dynamic';

const MARKET = getAddress(DEPLOY.testnet.VoidGenesisNftAmmV6);
const rpc = createPublicClient({ transport: http(RH_TESTNET.rpcUrls[0]) });
const marketAbi = parseAbi([
  'function inventoryCount() view returns(uint256)',
  'function inventoryAt(uint256) view returns(uint256)',
  'function randomBuyQuote() view returns(uint256)',
  'function specificBuyQuote() view returns(uint256)',
  'function sellQuote() view returns(uint256)',
]);
const gatewayAbi = parseAbi(['function query(bytes) view returns(bytes)']);
const runtimeAbi = parseAbi(['function feeOf(uint256) view returns(uint256)']);
const mintAbi = parseAbi(['function totalMinted() view returns(uint256)']);
const tokenAbi = parseAbi(['function balanceOf(address) view returns(uint256)']);
const deedAbi = parseAbi(['function ownerOf(uint256) view returns(address)']);
const escrowAbi = parseAbi(['function deedReleased(uint256) view returns(bool)']);

async function query(functionName: 'inventoryCount' | 'inventoryAt' | 'randomBuyQuote' | 'specificBuyQuote' | 'sellQuote', args: readonly bigint[] = []) {
  const data = encodeFunctionData({ abi: marketAbi, functionName, args: args as never });
  const raw = await rpc.readContract({ address: MARKET, abi: gatewayAbi, functionName: 'query', args: [data] }) as Hex;
  return decodeFunctionResult({ abi: marketAbi, functionName, data: raw }) as bigint;
}

export async function GET(request: NextRequest) {
  try {
    const input = request.nextUrl.searchParams.get('account');
    const account = input && isAddress(input) ? getAddress(input) : null;
    const [count, randomQuote, specificQuote, sellQuote, fee, minted] = await Promise.all([
      query('inventoryCount'), query('randomBuyQuote'), query('specificBuyQuote'), query('sellQuote'),
      rpc.readContract({ address: getAddress(DEPLOY.production.VoidChainAppRuntime), abi: runtimeAbi, functionName: 'feeOf', args: [1n] }).catch(() => null),
      rpc.readContract({ address: getAddress(DEPLOY.production.VoidEthGenesisMintV6), abi: mintAbi, functionName: 'totalMinted' }),
    ]);
    const inventory = await Promise.all(Array.from({ length: Number(count) }, (_, index) => query('inventoryAt', [BigInt(index)])));
    let balance = 0n;
    let owned: bigint[] = [];
    if (account) {
      balance = await rpc.readContract({ address: getAddress(DEPLOY.testnet.VoidTestToken), abi: tokenAbi, functionName: 'balanceOf', args: [account] });
      const owners = await Promise.all(Array.from({ length: Number(minted) }, (_, index) =>
        rpc.readContract({ address: getAddress(DEPLOY.production.VoidChainDeed), abi: deedAbi, functionName: 'ownerOf', args: [BigInt(index + 1)] }) as Promise<Address>));
      owned = owners.flatMap((owner, index) => owner.toLowerCase() === account.toLowerCase() ? [BigInt(index + 1)] : []);
    }
    const released = await Promise.all(owned.map((id) => rpc.readContract({
      address: getAddress(DEPLOY.testnet.VoidGenesisEscrowV6), abi: escrowAbi,
      functionName: 'deedReleased', args: [id],
    })));
    return NextResponse.json({
      market: MARKET,
      inventory: inventory.map(String),
      randomQuote: randomQuote.toString(), specificQuote: specificQuote.toString(), sellQuote: sellQuote.toString(),
      transactionFee: fee?.toString() ?? null, minted: minted.toString(), balance: balance.toString(), owned: owned.map(String),
      sellable: owned.filter((_, index) => !released[index]).map(String),
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    console.error('V6 market state failed', error);
    return NextResponse.json({ error: 'Could not read the NFT/VOID market.' }, { status: 502 });
  }
}
