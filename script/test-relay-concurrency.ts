/** Run only against the disposable PostgreSQL fixture created for this check. */
import assert from 'node:assert/strict';
import { reserveRelay, submitWithRelayerLock } from '../web/lib/relay-guard';
import { pool } from '../web/lib/db';

if (process.env.DATABASE_URL !== 'postgres://postgres:voidscan-test-only@127.0.0.1:15439/voidscan_check') {
  throw new Error('This test requires the explicit disposable local database.');
}
const user = '0x1111111111111111111111111111111111111111' as const;
const pm = '0x2222222222222222222222222222222222222222' as const;
const signature = `0x${'33'.repeat(65)}` as const;
try {
  const admitted = await Promise.allSettled([
    reserveRelay('scan', pm, user, 0n, signature, 'test-client'),
    reserveRelay('dex', pm, user, 0n, signature, 'test-client'),
  ]);
  assert.equal(admitted.filter((r) => r.status === 'fulfilled').length, 1);
  const winner = admitted.find((r) => r.status === 'fulfilled');
  if (winner?.status !== 'fulfilled') throw Error('Expected one reservation');
  await winner.value.failed();
  const retry = await reserveRelay('dex', pm, user, 0n, signature, 'test-client');
  await retry.failed();
  let active = 0;
  let peak = 0;
  await Promise.all([0, 1, 2, 3].map(async (i) => {
    const submission = await submitWithRelayerLock(user, 'test', async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return `0x${(i + 1).toString(16).padStart(64, '0')}`;
    });
    await submission.confirmed(true);
  }));
  assert.equal(peak, 1, 'one relayer must never broadcast concurrently');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM relayer_transactions WHERE status='confirmed'")).rows[0].n, 4);
  console.log('PASS: cross-product duplicate rejection, immediate failed retry and serialized broadcasts.');
} finally { await pool.end(); }
