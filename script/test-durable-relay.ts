import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, type Hex } from 'viem';
import { submitDurably, type RelayTransport } from '../web/lib/durable-relay';
import { admitRelayIngress } from '../web/lib/relay-guard';
import { pool, sessionPool } from '../web/lib/db';

if (process.env.DATABASE_URL !== 'postgres://postgres:voidscan-test-only@127.0.0.1:15439/voidscan_check') {
  throw Error('Only the explicit disposable local database is allowed.');
}
const account = privateKeyToAccount(`0x${'0'.repeat(63)}1`);
const addressBytes = Buffer.from(account.address.slice(2), 'hex');
let nonce = 0;
let prepares = 0;
const broadcasts: Hex[] = [];
const prepare = (n: number, chainId = 46630) => account.signTransaction({
  chainId, nonce: n, to: account.address, value: 0n, gas: 21000n,
  type: 'eip1559', maxFeePerGas: 2n, maxPriorityFeePerGas: 1n,
});
const transport: RelayTransport = {
  nonce: async () => nonce,
  prepare: async (n) => { prepares++; return prepare(n); },
  broadcast: async (raw) => {
    const hash = keccak256(raw);
    const saved = await pool.query('SELECT tx_hash FROM relayer_transactions WHERE tx_hash=$1', [Buffer.from(hash.slice(2), 'hex')]);
    assert.equal(saved.rowCount, 1, 'journal must commit before network broadcast');
    broadcasts.push(raw);
    throw Error('RPC accepted the transaction but its response was lost');
  },
};
try {
  await pool.query('DELETE FROM relayer_transactions WHERE relayer_address=$1', [addressBytes]);
  const first = await submitDurably(account.address, 'fixture', transport);
  assert.equal(first.hash, keccak256(broadcasts[0]));
  await assert.rejects(submitDurably(account.address, 'fixture-other-worker', transport), /awaiting confirmation/);
  assert.equal(prepares, 1, 'recovery must not sign another transaction');
  assert.equal(broadcasts[0], broadcasts[1], 'recovery must reuse identical signed bytes');
  nonce = 1;
  await first.confirmed(true);
  const racers = await Promise.allSettled([
    submitDurably(account.address, 'fixture-scan', transport),
    submitDurably(account.address, 'fixture-dex', transport),
  ]);
  assert.equal(racers.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(prepares, 2);
  nonce = 2;
  const before = broadcasts.length;
  await assert.rejects(submitDurably(account.address, 'wrong-chain', { ...transport, prepare: (n) => prepare(n, 1) }), /identity mismatch/);
  assert.equal(broadcasts.length, before);
  await assert.rejects(submitDurably(account.address, 'database-failure', {
    ...transport,
    prepare: async (n) => {
      const raw = await prepare(n);
      await pool.query('INSERT INTO relayer_transactions(tx_hash,relayer_address,surface,eoa_nonce) VALUES($1,$2,$3,$4)',
        [Buffer.from(keccak256(raw).slice(2), 'hex'), addressBytes, 'injected-conflict', n]);
      return raw;
    },
  }), /duplicate key/);
  assert.equal(broadcasts.length, before, 'failed journal insert must prevent broadcast');
  await pool.query('DELETE FROM relay_ingress');
  const attempts = await Promise.allSettled(Array.from({ length: 80 }, () => admitRelayIngress('fixture-shared-client')));
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 60);
  console.log('PASS: durable broadcast identity, RPC timeout recovery, multi-worker nonce isolation, wrong-chain refusal, database fail-closed and pre-RPC rate limit.');
} finally {
  await Promise.all([pool.end(), sessionPool.end()]);
}
