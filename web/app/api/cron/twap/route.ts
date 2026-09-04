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
    if (elapsed < BigInt(minInterval)) {
      return NextResponse.json({ updated: false, elapsed: elapsed.toString(), minimum: String(minInterval) });
    }

    const account = privateKeyToAccount(key as Hex);
    const wallet = createWalletClient({ account, transport: http(GENESIS.network.rpc) });
    const hash = await wallet.sendTransaction({
      account,
      chain: null,
      to: oracle,
      data: encodeFunctionData({ abi, functionName: 'update' }),
    });
    const receipt = await rpc.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('TWAP update reverted.');
    const rate = await rpc.readContract({ address: oracle, abi, functionName: 'voidPerEth' });
    return NextResponse.json({ updated: true, hash, voidPerEth: rate.toString() });
  } catch (error) {
    console.error('VOID TWAP keeper failed', error);
    return NextResponse.json({ error: 'TWAP keeper pass failed.' }, { status: 500 });
  }
}
