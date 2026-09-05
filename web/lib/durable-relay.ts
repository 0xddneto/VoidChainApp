import { keccak256, parseTransaction, recoverTransactionAddress, type Address, type Hex, type TransactionSerialized } from 'viem';
import { pool, sessionPool } from './db';
import { RelayAdmissionError } from './relay-guard';

const bytes = (value: Hex) => Buffer.from(value.slice(2), 'hex');
const hex = (value: Buffer): Hex => `0x${value.toString('hex')}`;
export interface RelayTransport {
  nonce(tag: 'latest' | 'pending'): Promise<number>;
  prepare(nonce: number): Promise<Hex>;
  broadcast(transaction: Hex): Promise<Hex>;
}

/** Write-ahead outbox: a crash/timeout cannot erase the transaction identity.
 * One outstanding transaction per EOA. Retries rebroadcast identical signed
 * bytes, never create a second transaction with a competing nonce.
 */
export async function submitDurably(relayer: Address, surface: string, transport: RelayTransport) {
  const client = await sessionPool.connect().catch(() => null);
  if (!client) throw new RelayAdmissionError('Relayer coordination is unavailable.', 503);
  const lock = `void-relayer:${relayer.toLowerCase()}`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [lock]);
    const latest = await transport.nonce('latest');
    const queued = await client.query<{ raw_transaction: Buffer; tx_hash: Buffer }>(
      `SELECT raw_transaction,tx_hash FROM relayer_transactions
       WHERE relayer_address=$1 AND eoa_nonce >= $2 AND raw_transaction IS NOT NULL
       ORDER BY eoa_nonce LIMIT 1`, [bytes(relayer), latest]);
    if (queued.rows.length) {
      const old = queued.rows[0];
      await transport.broadcast(hex(old.raw_transaction)).catch(() => undefined);
      throw new RelayAdmissionError(`Previous relay transaction is awaiting confirmation: ${hex(old.tx_hash)}`, 503);
    }
    if (await transport.nonce('pending') !== latest) {
      throw new RelayAdmissionError('Relayer has an outstanding transaction. Retry after confirmation.', 503);
    }
    const raw = await transport.prepare(latest);
    const parsed = parseTransaction(raw);
    if (parsed.chainId !== 46630 || parsed.nonce !== latest
      || (await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized })).toLowerCase() !== relayer.toLowerCase()) {
      throw new Error('Prepared relayer transaction identity mismatch');
    }
    const hash = keccak256(raw);
    // Must commit BEFORE broadcasting. Database failure means no transaction is sent.
    await client.query(
      `INSERT INTO relayer_transactions(tx_hash,relayer_address,surface,raw_transaction,eoa_nonce)
       VALUES($1,$2,$3,$4,$5)`, [bytes(hash), bytes(relayer), surface, bytes(raw), latest]);
    // An RPC error may mean accepted-but-response-lost. The durable hash remains
    // authoritative; a future worker rebroadcasts these bytes, not a fresh request.
    await transport.broadcast(raw).catch(() => undefined);
    return {
      hash,
      confirmed: async (success: boolean) => {
        await pool.query('UPDATE relayer_transactions SET status=$2,updated_at=now() WHERE tx_hash=$1',
          [bytes(hash), success ? 'confirmed' : 'reverted']);
      },
    };
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lock]).catch(() => undefined);
    client.release(true);
  }
}
