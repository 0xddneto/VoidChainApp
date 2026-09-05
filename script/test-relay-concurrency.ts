/** Run only against the disposable PostgreSQL fixture created for this check. */
import assert from 'node:assert/strict';
import { reserveRelay, submitWithRelayerLock } from '../web/lib/relay-guard';
import { pool, sessionPool, sessionDatabaseUrl } from '../web/lib/db';
import { saveProfile } from '../web/lib/chains';
import { writePass } from '../web/lib/chain-indexer';

if (process.env.DATABASE_URL !== 'postgres://postgres:voidscan-test-only@127.0.0.1:15439/voidscan_check') {
  throw new Error('This test requires the explicit disposable local database.');
}
const user = '0x1111111111111111111111111111111111111111' as const;
const pm = '0x2222222222222222222222222222222222222222' as const;
const signature = `0x${'33'.repeat(65)}` as const;
try {
  const original = process.env.DATABASE_URL_UNPOOLED;
  await pool.query('DELETE FROM relay_requests');
  await pool.query('DELETE FROM relay_attempts');
  await pool.query('DELETE FROM relayer_transactions');
  await pool.query('DELETE FROM profile_nonces');
  const profile = {displayName:'First',avatarUri:'',bio:'',socials:[]};
  await saveProfile(user, profile, 'fixture-first');
  await saveProfile(user, {...profile,displayName:'Second'}, 'fixture-second');
  await assert.rejects(saveProfile(user, profile, 'fixture-first'), /PROFILE_NONCE_USED/);
  assert.equal((await pool.query('SELECT display_name FROM user_profiles WHERE address=$1',[Buffer.from(user.slice(2),'hex')])).rows[0].display_name,'Second');
  await pool.query('INSERT INTO chains(id,chain_id) VALUES(1111,46631110) ON CONFLICT DO NOTHING');
  const app = {chain:1111,app:user,blockNumber:1n,logIndex:2,publisher:pm,hash:`0x${'44'.repeat(32)}`,timestamp:1};
  const emptyPass = {statuses:[],calls:[],revenue:[],sponsored:[],owners:[],names:[],head:1n,headHash:`0x${'55'.repeat(32)}`};
  await writePass({...emptyPass,apps:[app],removedApps:[{...app,logIndex:1}]});
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM contracts WHERE chain_id=1111')).rows[0].n,1,'remove then register must remain visible');
  await writePass({...emptyPass,apps:[app],removedApps:[{...app,logIndex:3}]});
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM contracts WHERE chain_id=1111')).rows[0].n,0,'register then remove must disappear');
  process.env.DATABASE_URL_UNPOOLED = 'postgres://fixture:fixture@ep-fixture-pooler.us-east-2.aws.neon.tech/db?sslmode=require';
  const sessionUrl = new URL(sessionDatabaseUrl());
  assert.equal(sessionUrl.hostname, 'ep-fixture.us-east-2.aws.neon.tech');
  assert.equal(sessionUrl.searchParams.get('sslmode'), 'verify-full');
  if (original === undefined) delete process.env.DATABASE_URL_UNPOOLED;
  else process.env.DATABASE_URL_UNPOOLED = original;
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
  const retryUser = '0x3333333333333333333333333333333333333333';
  for (let i = 0; i < 20; i++) {
    const claim = await reserveRelay('scan', pm, retryUser, 1n, signature, 'retry-client');
    await claim.failed();
  }
  await assert.rejects(reserveRelay('dex', pm, retryUser, 1n, signature, 'retry-client'), (error: unknown) => (error as {status:number}).status === 429);
  const requests = await Promise.allSettled(Array.from({length:30},(_,i) => reserveRelay('scan', pm, `0x${(100+i).toString(16).padStart(40,'0')}`, 0n, signature, 'shared-client')));
  assert.equal(requests.filter((r) => r.status === 'fulfilled').length,20, 'IP quota must hold under concurrent distinct wallets');
  console.log('PASS: cross-product duplicate rejection, immediate failed retry and serialized broadcasts.');
} finally { await Promise.all([pool.end(), sessionPool.end()]); }
