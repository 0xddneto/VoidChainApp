import { NextRequest, NextResponse } from 'next/server';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import GENESIS from '@/lib/genesis-v6.json';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const oracle = GENESIS.contracts.twapSource as Address;
const abi = parseAbi([
  'function update() returns(uint256)',
  'function lastTimestamp() view returns(uint32)',
  'function minInterval() view returns(uint32)',
  'function voidPerEth() view returns(uint256)',
]);
const rpc = createPublicClient({ transport: http(GENESIS.network.rpc) });
const paymaster = GENESIS.contracts.paymaster as Address;
const refillAbi = parseAbi([
  'function refillPlan() view returns(bool,uint256,uint256)',
  'function refill(uint256,uint256) returns(uint256)',
]);

/** Keeps the fail-closed price fresh without ever touching user transactions. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'Cron is not configured.' }, { status: 503 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const key = process.env.PAYMASTER_RELAYER_PRIVATE_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) {
    return NextResponse.json({ error: 'TWAP keeper is not configured.' }, { status: 503 });
  }

  try {
    const [lastTimestamp, minInterval, block] = await Promise.all([
      rpc.readContract({ address: oracle, abi, functionName: 'lastTimestamp' }),
      rpc.readContract({ address: oracle, abi, functionName: 'minInterval' }),
      rpc.getBlock(),
    ]);
    const elapsed = block.timestamp - BigInt(lastTimestamp);
    const account = privateKeyToAccount(key as Hex);
    const wallet = createWalletClient({ account, transport: http(GENESIS.network.rpc) });
    let hash: Hex | null = null;
    if (elapsed >= BigInt(minInterval)) {
      hash = await wallet.sendTransaction({ account, chain: null, to: oracle, data: encodeFunctionData({ abi, functionName: 'update' }) });
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('TWAP update reverted.');
    }
    const rate = await rpc.readContract({ address: oracle, abi, functionName: 'voidPerEth' });
    // Separate keeper transaction, never a swap inside a user's app call.
    // Use only the contract's bounded plan; do not relax its TWAP floor.
    const [needed, amount, minimum] = await rpc.readContract({ address: paymaster, abi: refillAbi, functionName: 'refillPlan' });
    let refillHash: Hex | null = null;
    if (needed) {
      await rpc.simulateContract({ account, address: paymaster, abi: refillAbi, functionName: 'refill', args: [amount, minimum] });
      refillHash = await wallet.sendTransaction({ account, chain: null, to: paymaster, data: encodeFunctionData({ abi: refillAbi, functionName: 'refill', args: [amount, minimum] }) });
      const receipt = await rpc.waitForTransactionReceipt({ hash: refillHash });
      if (receipt.status !== 'success') throw new Error('Paymaster refill reverted.');
    }
    return NextResponse.json({ updated: hash !== null, hash, voidPerEth: rate.toString(), refilled: refillHash !== null, refillHash });
  } catch (error) {
    console.error('VOID keeper failed', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json({ error: 'TWAP keeper pass failed.' }, { status: 500 });
  }
}
