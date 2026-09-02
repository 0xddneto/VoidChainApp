import pg from 'pg';
import { DATABASE_URL, FIRST_BLOCK } from './config.js';

/**
 * Addresses and hashes are stored as BYTEA, not as text.
 *
 * Half the space, exact comparison without depending on upper or lower case,
 * and indexes that work. The cost is converting at the boundary — which these
 * two functions do, and nothing else in the code has to think about it.
 */
export const toBytes = (hex: string | null | undefined): Buffer | null =>
  hex ? Buffer.from(hex.slice(2), 'hex') : null;

export const toHex = (bytes: Buffer | null): `0x${string}` | null =>
  bytes ? (`0x${bytes.toString('hex')}` as `0x${string}`) : null;

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });

export const TOTAL_CHAINS = 1_111;

/** The Robinhood block a call was ordered in. */
export interface BlockInfo {
  timestamp: number;
  hash: string;
  parentHash: string;
}

/** A call to a chainapp: one `Executed` event from the runtime. */
export interface CallRow {
  chain: number;
  hash: string;
  blockNumber: bigint;
  txIndex: number;
  logIndex: number;
  caller: string;
  target: string;
  /** Toll in VOID. */
  toll: bigint;
  block: BlockInfo;
}

export interface ActivationRow {
  chain: number;
  timestamp: number;
}
export interface AppRow {
  chain: number;
  app: string;
  publisher: string;
  hash: string;
  timestamp: number;
}
export interface OwnerRow {
  chain: number;
  owner: string;
}

/**
 * Creates the 1,111 reserved rows, once.
 *
 * Returns how many exist at the end — not how many were inserted — because the
 * caller wants to know the state of the database, and on a second run the
 * correct answer is still 1,111.
 */
export async function seedChains(chainIdBase: number | string): Promise<number> {
  const base = BigInt(chainIdBase);
  await pool.query(
    `INSERT INTO chains (id, chain_id, status)
     SELECT i, $1::bigint + i - 1, 'reserved' FROM generate_series(1, $2) AS i
     ON CONFLICT (id) DO NOTHING`,
    [base.toString(), TOTAL_CHAINS],
  );
  await pool.query(
    `INSERT INTO chain_summary (chain_id)
     SELECT id FROM chains ON CONFLICT (chain_id) DO NOTHING`,
  );
  const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM chains');
  return Number(rows[0].n);
}

/** Last block swept. On the first run, the block before the deployment. */
export async function cursor(): Promise<bigint> {
  const { rows } = await pool.query<{ last_indexed_block: string }>(
    `INSERT INTO indexer_state (id, last_indexed_block) VALUES (TRUE, $1)
     ON CONFLICT (id) DO UPDATE SET last_indexed_block = indexer_state.last_indexed_block
     RETURNING last_indexed_block`,
    [(FIRST_BLOCK > 0n ? FIRST_BLOCK - 1n : 0n).toString()],
  );
  return BigInt(rows[0].last_indexed_block);
}

/**
 * Writes a whole sweep in one transaction.
 *
 * Either the entire batch lands and the cursor advances, or nothing lands and
 * it stays where it was. Without this, a failure halfway through would leave
 * events written that the indexer believed unprocessed, and the next pass would
 * count them again.
 */
export async function writePass(
  activations: ActivationRow[],
  calls: CallRow[],
  apps: AppRow[],
  owners: OwnerRow[],
  newHead: bigint,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const a of activations) {
      await client.query(
        `UPDATE chains SET status = 'live', activated_at = to_timestamp($2), updated_at = now()
         WHERE id = $1`,
        [a.chain, a.timestamp],
      );
    }

    // The owner is written after the activation because a token can be
    // activated and sold in the same batch, and what matters is who ended up
    // holding it.
    for (const o of owners) {
      await client.query(`UPDATE chains SET owner_address = $2, updated_at = now() WHERE id = $1`,
        [o.chain, toBytes(o.owner)]);
    }

    for (const c of calls) {
      await client.query(
        `INSERT INTO transactions
           (chain_id, hash, block_number, tx_index, log_index, from_address, to_address,
            toll, status, timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,to_timestamp($9))
         ON CONFLICT (chain_id, hash, log_index) DO NOTHING`,
        [c.chain, toBytes(c.hash), c.blockNumber.toString(), c.txIndex, c.logIndex,
         toBytes(c.caller), toBytes(c.target), c.toll.toString(), c.block.timestamp],
      );
    }

    for (const a of apps) {
      await client.query(
        `INSERT INTO contracts (chain_id, address, deployer, deployed_at, deploy_tx)
         VALUES ($1,$2,$3,to_timestamp($4),$5)
         ON CONFLICT (chain_id, address) DO NOTHING`,
        [a.chain, toBytes(a.app), toBytes(a.publisher), a.timestamp, toBytes(a.hash)],
      );
    }

    await writeBlocks(client, calls);

    await client.query(
      `UPDATE indexer_state SET last_indexed_block = $1, updated_at = now() WHERE id = TRUE`,
      [newHead.toString()],
    );

    for (const chain of new Set([
      ...activations.map((a) => a.chain),
      ...calls.map((c) => c.chain),
      ...apps.map((a) => a.chain),
    ])) {
      await refreshSummary(client, chain);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The blocks of a chain.
 *
 * A chainapp produces no blocks at all: what orders its calls is Robinhood. So
 * what this table holds is the subsequence of Robinhood blocks in which that
 * chain had activity — its history seen from the inside. The same block shows
 * up for several chains when it carries calls to several of them, which is
 * faithful: one parent block can serve many.
 *
 * `tx_count` is the number of calls to THAT chain in the block, not the block's
 * total on Robinhood, which would say nothing about the chain.
 */
async function writeBlocks(client: pg.PoolClient, calls: CallRow[]): Promise<void> {
  const perBlock = new Map<string, { chain: number; number: bigint; b: BlockInfo; n: number }>();
  for (const c of calls) {
    const key = `${c.chain}:${c.blockNumber}`;
    const current = perBlock.get(key);
    if (current) current.n++;
    else perBlock.set(key, { chain: c.chain, number: c.blockNumber, b: c.block, n: 1 });
  }

  for (const r of perBlock.values()) {
    await client.query(
      `INSERT INTO blocks (chain_id, number, hash, parent_hash, timestamp, tx_count)
       VALUES ($1,$2,$3,$4,to_timestamp($5),$6)
       ON CONFLICT (chain_id, number) DO UPDATE SET tx_count = EXCLUDED.tx_count`,
      [r.chain, r.number.toString(), toBytes(r.b.hash), toBytes(r.b.parentHash),
       r.b.timestamp, r.n],
    );
  }
}

/**
 * Recomputes the summary from the detail tables.
 *
 * Recompute rather than increment: an incremental counter drifts silently the
 * moment a reinsertion or a rollback happens, and the drift only surfaces
 * months later, when nobody remembers the cause.
 */
async function refreshSummary(client: pg.PoolClient, chainId: number): Promise<void> {
  await client.query(
    `UPDATE chain_summary s SET
       total_txs = (SELECT count(*) FROM transactions WHERE chain_id = $1),
       total_contracts = (SELECT count(*) FROM contracts WHERE chain_id = $1),
       total_addresses = (SELECT count(DISTINCT from_address) FROM transactions WHERE chain_id = $1),
       txs_24h = (SELECT count(*) FROM transactions
                  WHERE chain_id = $1 AND timestamp > now() - interval '24 hours'),
       last_block_at = (SELECT max(timestamp) FROM transactions WHERE chain_id = $1),
       updated_at = now()
     WHERE s.chain_id = $1`,
    [chainId],
  );
}
