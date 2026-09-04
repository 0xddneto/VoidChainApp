import { createHash } from 'node:crypto';
import pg from 'pg';
import type { Address, Hex } from 'viem';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 5_000,
});
const REQUESTS_PER_MINUTE = 20;

export class RelayAdmissionError extends Error {
  constructor(message: string, readonly status: 409 | 429 | 503) {
    super(message);
  }
}

const bytes = (hex: string): Buffer => Buffer.from(hex.slice(2), 'hex');
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

export function relayClientId(request: Request): string {
  return request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? request.headers.get('x-real-ip')
    ?? 'unknown';
}

/** Persistent duplicate/rate guard shared with the VoidScan relays. */
export async function reserveRelay(surface: string, user: Address, nonce: bigint, signature: Hex, clientId: string) {
  if (!process.env.DATABASE_URL) throw new RelayAdmissionError('Relay admission control is not configured.', 503);
  const client = await pool.connect().catch(() => null);
  if (!client) throw new RelayAdmissionError('Relay admission control is unavailable.', 503);
  const userBytes = bytes(user); const clientHash = digest(clientId); const requestHash = digest(signature);
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${surface}:${user.toLowerCase()}:${clientHash.toString('hex')}`]);
    const count = await client.query<{ requests: string }>(
      `SELECT count(*) AS requests FROM relay_requests
       WHERE created_at > now() - interval '1 minute' AND (user_address = $1 OR client_hash = $2)`,
      [userBytes, clientHash],
    );
    if (Number(count.rows[0].requests) >= REQUESTS_PER_MINUTE) {
      throw new RelayAdmissionError('Too many relay requests. Wait one minute and try again.', 429);
    }
    const claim = await client.query(
      `INSERT INTO relay_requests (surface,user_address,user_nonce,client_hash,request_hash)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (surface,user_address,user_nonce) DO UPDATE SET
         client_hash=EXCLUDED.client_hash, request_hash=EXCLUDED.request_hash,
         status='pending', tx_hash=NULL, created_at=now(), updated_at=now(),
         expires_at=now()+interval '10 minutes'
       WHERE relay_requests.expires_at < now() RETURNING user_nonce`,
      [surface, userBytes, nonce.toString(), clientHash, requestHash],
    );
    if (claim.rowCount !== 1) throw new RelayAdmissionError('This signed nonce is already being relayed.', 409);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof RelayAdmissionError) throw error;
    throw new RelayAdmissionError('Relay admission control is unavailable.', 503);
  } finally { client.release(); }

  const update = (status: 'submitted' | 'failed', hash?: Hex) => pool.query(
    `UPDATE relay_requests SET status=$4,tx_hash=$5,updated_at=now()
     WHERE surface=$1 AND user_address=$2 AND user_nonce=$3 AND request_hash=$6`,
    [surface, userBytes, nonce.toString(), status, hash ? bytes(hash) : null, requestHash],
  ).then(() => undefined);
  return { submitted: (hash: Hex) => update('submitted', hash), failed: () => update('failed') };
}
