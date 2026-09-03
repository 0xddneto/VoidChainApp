import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, http, isAddress, parseAbi, type Address } from 'viem';

export const dynamic = 'force-dynamic';

const RPC = 'https://robinhood-testnet.drpc.org';
const RUNTIME = '0x424ec038baf1a9786a8eba1212954513ed31aa5d' as Address;
const VOID = '0x2a64fa56c1de6f7c737b4a964b5b693ed3841ff4' as Address;
const PAIRS = [
  '0xdEb696F2956bE3259aee83d7eb8479309841413e',
  '0xd8c47A16f6469E77d4327122DfbbFe0E71cdb262',
] as const satisfies readonly Address[];

const runtimeAbi = parseAbi(['function feeOf(uint256) view returns(uint256)']);
const pairAbi = parseAbi([
  'function reserve0() view returns(uint256)',
  'function reserve1() view returns(uint256)',
  'function totalSupply() view returns(uint256)',
  'function balanceOf(address) view returns(uint256)',
]);
const rpc = createPublicClient({ transport: http(RPC) });

/**
 * Browser RPC access is not assumed here. The DEX reads its public state from
 * this server route, while transaction signatures still stay in the wallet.
 */
export async function GET(request: NextRequest) {
  const pairIndex = Number(request.nextUrl.searchParams.get('pair') ?? '0');
  const pair = PAIRS[pairIndex];
  if (!pair) return NextResponse.json({ error: 'Unknown pool.' }, { status: 400 });

  const accountInput = request.nextUrl.searchParams.get('account');
  const account = accountInput && isAddress(accountInput) ? accountInput as Address : undefined;
  const [fee, reserve0, reserve1, totalSupply, balance] = await Promise.all([
    rpc.readContract({ address: RUNTIME, abi: runtimeAbi, functionName: 'feeOf', args: [1n] }),
    rpc.readContract({ address: pair, abi: pairAbi, functionName: 'reserve0' }),
    rpc.readContract({ address: pair, abi: pairAbi, functionName: 'reserve1' }),
    rpc.readContract({ address: pair, abi: pairAbi, functionName: 'totalSupply' }),
    account ? rpc.readContract({ address: pair, abi: pairAbi, functionName: 'balanceOf', args: [account] }) : Promise.resolve(0n),
  ]);

  return NextResponse.json(
    { fee: fee.toString(), reserve0: reserve0.toString(), reserve1: reserve1.toString(), totalSupply: totalSupply.toString(), balance: balance.toString(), voidToken: VOID },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
