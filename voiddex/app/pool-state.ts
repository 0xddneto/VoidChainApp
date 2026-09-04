import { createPublicClient, decodeFunctionResult, encodeFunctionData, fallback, http, parseAbi, type Address } from 'viem';
import { DEX } from './dex-config';

const rpc = createPublicClient({ transport: fallback(DEX.rpcUrls.map((url) => http(url))) });
const gatewayAbi = parseAbi(['function query(bytes) view returns(bytes)']);
const pairAbi = parseAbi(['function reserve0() view returns(uint112)', 'function reserve1() view returns(uint112)', 'function totalSupply() view returns(uint256)', 'function balanceOf(address) view returns(uint256)']);
const runtimeAbi = parseAbi(['function feeOf(uint256) view returns(uint256)']);

export async function poolState(index: number, account?: Address) {
  const pair = DEX.pools[index];
  if (!pair) throw new Error('Unknown pool.');
  async function query(name: 'reserve0' | 'reserve1' | 'totalSupply' | 'balanceOf') {
    const data = encodeFunctionData({ abi: pairAbi, functionName: name, args: (name === 'balanceOf' ? [account!] : []) as never });
    const raw = await rpc.readContract({ address: pair.address, abi: gatewayAbi, functionName: 'query', args: [data] });
    return decodeFunctionResult({ abi: pairAbi, functionName: name, data: raw }).toString();
  }
  const [fee, reserve0, reserve1, totalSupply, balance] = await Promise.all([
    rpc.readContract({ address: DEX.runtime, abi: runtimeAbi, functionName: 'feeOf', args: [1n] }).catch(() => null),
    query('reserve0'), query('reserve1'), query('totalSupply'), account ? query('balanceOf') : '0',
  ]);
  return { fee: fee?.toString() ?? null, reserve0, reserve1, totalSupply, balance };
}
