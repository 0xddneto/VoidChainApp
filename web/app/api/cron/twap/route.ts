import { NextRequest, NextResponse } from 'next/server';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import GENESIS from '@/lib/genesis-v10.json';
import { rhTransport } from '@/lib/testnet';

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
const rpc = createPublicClient({ transport: rhTransport() });
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

  const twapKey = process.env.TWAP_KEEPER_PRIVATE_KEY;
  const refillKey = process.env.REFILL_KEEPER_PRIVATE_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(twapKey ?? '') || !/^0x[0-9a-fA-F]{64}$/.test(refillKey ?? '')) {
    return NextResponse.json({ error: 'Independent TWAP and refill keepers are not configured.' }, { status: 503 });
  }

  try {
    const [lastTimestamp, minInterval, block] = await Promise.all([
      rpc.readContract({ address: oracle, abi, functionName: 'lastTimestamp' }),
      rpc.readContract({ address: oracle, abi, functionName: 'minInterval' }),
      rpc.getBlock(),
    ]);
    const elapsed = block.timestamp - BigInt(lastTimestamp);
    const twapAccount = privateKeyToAccount(twapKey as Hex);
    const twapWallet = createWalletClient({ account: twapAccount, transport: rhTransport() });
    let hash: Hex | null = null;
    if (elapsed >= BigInt(minInterval)) {
      hash = await twapWallet.sendTransaction({ account: twapAccount, chain: null, to: oracle, data: encodeFunctionData({ abi, functionName: 'update' }) });
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('TWAP update reverted.');
    }
    const rate = await rpc.readContract({ address: oracle, abi, functionName: 'voidPerEth' });
    // Separate keeper transaction, never a swap inside a user's app call.
    // Use only the contract's bounded plan; do not relax its TWAP floor.
    const [needed, amount, minimum] = await rpc.readContract({ address: paymaster, abi: refillAbi, functionName: 'refillPlan' });
    let refillHash: Hex | null = null;
    if (needed) {
      const refillAccount = privateKeyToAccount(refillKey as Hex);
      const refillWallet = createWalletClient({ account: refillAccount, transport: rhTransport() });
      await rpc.simulateContract({ account: refillAccount, address: paymaster, abi: refillAbi, functionName: 'refill', args: [amount, minimum] });
      refillHash = await refillWallet.sendTransaction({ account: refillAccount, chain: null, to: paymaster, data: encodeFunctionData({ abi: refillAbi, functionName: 'refill', args: [amount, minimum] }) });
      const receipt = await rpc.waitForTransactionReceipt({ hash: refillHash });
      if (receipt.status !== 'success') throw new Error('Paymaster refill reverted.');
    }
    return NextResponse.json({ updated: hash !== null, hash, voidPerEth: rate.toString(), refilled: refillHash !== null, refillHash });
  } catch (error) {
    console.error('VOID keeper failed', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json({ error: 'TWAP keeper pass failed.' }, { status: 500 });
  }
}
