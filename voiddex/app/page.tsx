import { createPublicClient, http, parseAbi, type Address } from 'viem';

import VoidDex, { type DexPoolState } from './DexClient';

const rpc = createPublicClient({ transport: http('https://robinhood-testnet.drpc.org') });
const runtime = '0x424ec038baf1a9786a8eba1212954513ed31aa5d' as Address;
const pools = [
  '0xdEb696F2956bE3259aee83d7eb8479309841413e',
  '0xd8c47A16f6469E77d4327122DfbbFe0E71cdb262',
] as const satisfies readonly Address[];
const runtimeAbi = parseAbi(['function feeOf(uint256) view returns(uint256)']);
const pairAbi = parseAbi([
  'function reserve0() view returns(uint256)',
  'function reserve1() view returns(uint256)',
  'function totalSupply() view returns(uint256)',
]);

async function readPool(pair: Address): Promise<DexPoolState> {
  const [fee, reserve0, reserve1, totalSupply] = await Promise.all([
    rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'feeOf', args: [1n] }),
    rpc.readContract({ address: pair, abi: pairAbi, functionName: 'reserve0' }),
    rpc.readContract({ address: pair, abi: pairAbi, functionName: 'reserve1' }),
    rpc.readContract({ address: pair, abi: pairAbi, functionName: 'totalSupply' }),
  ]);
  return { fee: fee.toString(), reserve0: reserve0.toString(), reserve1: reserve1.toString(), totalSupply: totalSupply.toString(), balance: '0' };
}

export const dynamic = 'force-dynamic';

export default async function Page() {
  const initialStates = await Promise.all(pools.map(readPool));
  return <VoidDex initialStates={initialStates} />;
}
