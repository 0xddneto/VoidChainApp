import { createHash } from 'node:crypto';
import type { Address, Hex } from 'viem';

import { pool } from './db';

const REQUESTS_PER_MINUTE = 20;

export class RelayAdmissionError extends Error {
  constructor(message: string, readonly status: 409 | 429 | 503) {
    super(message);
  }
}

export interface RelayReservation {
  submitted(hash: Hex): Promise<void>;
  failed(): Promise<void>;
}

export interface RelayerSubmission {
  hash: Hex;
  confirmed(success: boolean): Promise<void>;
}

const bytes = (hex: string): Buffer => Buffer.from(hex.slice(2), 'hex');
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

export function relayClientId(request: Request): string {
  const vercel = request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim();
  if (process.env.VERCEL === '1' && vercel) return vercel;
  if (process.env.TRUST_PROXY_HEADERS === 'true') {
    return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      ?? request.headers.get('x-real-ip')
      ?? 'trusted-proxy-unknown';
  }
  return 'untrusted-network';
}

/** Atomically reserves one signed user nonce across every serverless instance. */
export async function reserveRelay(
  surface: string,
  paymaster: Address,
  user: Address,
  nonce: bigint,
  signature: Hex,
  clientId: string,
): Promise<RelayReservation> {
  const client = await pool.connect().catch(() => null);
  if (!client) throw new RelayAdmissionError('Relay admission control is unavailable.', 503);

  const userBytes = bytes(user);
  const paymasterBytes = bytes(paymaster);
  const clientHash = digest(clientId);
  const requestHash = digest(signature);
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM relay_requests WHERE created_at < now() - interval '7 days'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`relay-user:${paymaster.toLowerCase()}:${user.toLowerCase()}`]);
    const { rows } = await client.query<{ requests: string }>(
      `SELECT count(*) AS requests FROM relay_requests
       WHERE created_at > now() - interval '1 minute'
         AND (user_address = $1 OR client_hash = $2)`,
      [userBytes, clientHash],
    );
    if (Number(rows[0].requests) >= REQUESTS_PER_MINUTE) {
      await client.query('ROLLBACK');
      throw new RelayAdmissionError('Too many relay requests. Wait one minute and try again.', 429);
    }

    const claim = await client.query(
      `INSERT INTO relay_requests
         (surface, paymaster_address, user_address, user_nonce, client_hash, request_hash)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (paymaster_address, user_address, user_nonce) WHERE paymaster_address IS NOT NULL DO UPDATE SET
         surface = EXCLUDED.surface,
         client_hash = EXCLUDED.client_hash,
         request_hash = EXCLUDED.request_hash,
         status = 'pending', tx_hash = NULL,
         created_at = now(), updated_at = now(),
         expires_at = now() + interval '10 minutes'
       WHERE relay_requests.expires_at < now()
       RETURNING user_nonce`,
      [surface, paymasterBytes, userBytes, nonce.toString(), clientHash, requestHash],
    );
    if (claim.rowCount !== 1) {
      await client.query('ROLLBACK');
      throw new RelayAdmissionError('This signed nonce is already being relayed.', 409);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof RelayAdmissionError) throw error;
    throw new RelayAdmissionError('Relay admission control is unavailable.', 503);
  } finally {
    client.release();
  }

  const update = async (status: 'submitted' | 'failed', hash?: Hex) => {
    await pool.query(
      `UPDATE relay_requests SET status = $4, tx_hash = $5, updated_at = now(),
         expires_at = CASE WHEN $4 = 'failed' THEN now() ELSE expires_at END
       WHERE paymaster_address = $1 AND user_address = $2 AND user_nonce = $3 AND request_hash = $6`,
      [paymasterBytes, userBytes, nonce.toString(), status, hash ? bytes(hash) : null, requestHash],
    );
  };
  return {
    submitted: (hash) => update('submitted', hash),
    failed: () => update('failed'),
  };
}

/** Serializes EOA nonce selection and broadcast across all serverless workers. */
export async function submitWithRelayerLock(
  relayer: Address,
  surface: string,
  submit: () => Promise<Hex>,
): Promise<RelayerSubmission> {
  const client = await pool.connect().catch(() => null);
  if (!client) throw new RelayAdmissionError('Relayer coordination is unavailable.', 503);
  const lockName = `void-relayer:${relayer.toLowerCase()}`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockName]);
    const hash = await submit();
    await client.query(
      `INSERT INTO relayer_transactions (tx_hash, relayer_address, surface)
       VALUES ($1,$2,$3) ON CONFLICT (tx_hash) DO NOTHING`,
      [bytes(hash), bytes(relayer), surface],
    ).catch(() => { console.error('Relayer broadcast audit write failed', { hash, surface }); });
    return {
      hash,
      confirmed: async (success) => {
        await pool.query(
          `UPDATE relayer_transactions SET status = $2, updated_at = now() WHERE tx_hash = $1`,
          [bytes(hash), success ? 'confirmed' : 'reverted'],
        );
      },
    };
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockName]).catch(() => undefined);
    client.release();
  }
}
