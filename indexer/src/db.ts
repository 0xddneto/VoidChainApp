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

const verifiedDatabaseUrl = (value: string): string => {
  const url = new URL(value);
  const sslMode = url.searchParams.get('sslmode');
  if (sslMode === 'prefer' || sslMode === 'require' || sslMode === 'verify-ca') {
    url.searchParams.set('sslmode', 'verify-full');
  }
  return url.toString();
};

export const pool = new pg.Pool({ connectionString: verifiedDatabaseUrl(DATABASE_URL), max: 8 });

const sessionUrl = new URL(verifiedDatabaseUrl(process.env.DATABASE_URL_UNPOOLED ?? DATABASE_URL));
if (sessionUrl.hostname.endsWith('.neon.tech')) sessionUrl.hostname = sessionUrl.hostname.replace('-pooler.', '.');
export const sessionPool = new pg.Pool({ connectionString: sessionUrl.toString(), max: 1, connectionTimeoutMillis: 5_000 });

export const TOTAL_CHAINS = 1_111;

/** Clears only chain-derived projections. User profiles, declared expenses and
 * social metadata survive a deployment cutover or confirmed-chain reorg. */
export async function resetProjection(client: pg.PoolClient): Promise<void> {
  await client.query('DELETE FROM blocks');
  await client.query('DELETE FROM transactions');
  await client.query('DELETE FROM contracts');
  await client.query('DELETE FROM chain_daily_stats');
  await client.query('DELETE FROM proposals');
  await client.query('DELETE FROM chain_revenue');
  await client.query('DELETE FROM sponsored_transactions');
  await client.query(
    `UPDATE chains SET name=NULL, description=NULL, image_uri=NULL,
       external_url=NULL, owner_address=NULL, status='reserved', activated_at=NULL,
       is_hot=FALSE, last_indexed_block=0, last_indexed_hash=NULL, updated_at=now()`,
  );
  await client.query(
    `UPDATE chain_summary SET total_txs=0,total_contracts=0,total_addresses=0,
       txs_24h=0,activity_score=0,last_block_at=NULL,updated_at=now()`,
  );
}

/**
 * Makes the database follow exactly the deployment in deployment.json.
 *
 * A testnet redeploy can reuse token #1, but it must never reuse that token's
 * old owner, apps or transaction history. Profiles are deliberately outside
 * this reset: they belong to wallet addresses, not to a deployment.
 */
export async function alignDeployment(runtime: string, deed: string): Promise<boolean> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS indexer_deployment (
       id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
       runtime_address BYTEA NOT NULL,
       deed_address BYTEA NOT NULL,
       deploy_block BIGINT NOT NULL,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const { rows } = await pool.query<{
    runtime_address: Buffer;
    deed_address: Buffer;
    deploy_block: string;
  }>('SELECT runtime_address, deed_address, deploy_block FROM indexer_deployment WHERE id = TRUE');

  const expectedRuntime = toBytes(runtime)!;
  const expectedDeed = toBytes(deed)!;
  const expectedBlock = FIRST_BLOCK.toString();
  const current = rows[0];
  const matches = current
    && current.runtime_address.equals(expectedRuntime)
    && current.deed_address.equals(expectedDeed)
    && current.deploy_block === expectedBlock;

  if (matches) return false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await resetProjection(client);
    await client.query('DELETE FROM indexer_state WHERE id = TRUE');
    await client.query(
      `INSERT INTO indexer_deployment (id, runtime_address, deed_address, deploy_block)
       VALUES (TRUE, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         runtime_address = EXCLUDED.runtime_address,
         deed_address = EXCLUDED.deed_address,
         deploy_block = EXCLUDED.deploy_block,
         updated_at = now()`,
      [expectedRuntime, expectedDeed, expectedBlock],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

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

export interface StatusRow {
  chain: number;
  status: 'live' | 'paused';
  initial: boolean;
  timestamp: number;
  blockNumber: bigint;
  logIndex: number;
}
export interface AppRow {
  blockNumber: bigint;
  logIndex: number;
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
export interface RemovedAppRow { chain: number; app: string; blockNumber: bigint; logIndex: number; }
export interface RevenueRow { chain: number; holder: string; gross: bigint; protocolFee: bigint; holderShare: bigint; hash: string; logIndex: number; timestamp: number; }
export interface NameRow {
  chain: number;
  name: string;
}
export interface SponsoredRow {
  chain: number;
  hash: string;
  logIndex: number;
  blockNumber: bigint;
  user: string;
  relayer: string;
  target: string | null;
  success: boolean;
  toll: bigint;
  gasVoid: bigint;
  marginVoid: bigint;
  ethReimbursed: bigint;
  reason: string | null;
  timestamp: number;
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
  statuses: StatusRow[],
  calls: CallRow[],
    apps: AppRow[],
    removedApps: RemovedAppRow[],
    revenueRows: RevenueRow[],
  sponsoredRows: SponsoredRow[],
  owners: OwnerRow[],
  names: NameRow[],
  newHead: bigint,
  newHeadHash: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const change of statuses) {
      await client.query(
        change.initial
          ? `UPDATE chains SET status = 'live', activated_at = to_timestamp($2), updated_at = now() WHERE id = $1`
          : `UPDATE chains SET status = $2, updated_at = now() WHERE id = $1`,
        change.initial ? [change.chain, change.timestamp] : [change.chain, change.status],
      );
    }

    // The owner is written after the activation because a token can be
    // activated and sold in the same batch, and what matters is who ended up
    // holding it.
    for (const o of owners) {
      await client.query(`UPDATE chains SET owner_address = $2, updated_at = now() WHERE id = $1`,
        [o.chain, toBytes(o.owner)]);
    }

    // The deed is the canonical name source. Storing the event here makes the
    // directory searchable without asking 1,111 contracts on every page load.
    for (const n of names) {
      await client.query(`UPDATE chains SET name = $2, updated_at = now() WHERE id = $1`,
        [n.chain, n.name]);
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

    const appChanges = [...apps.map((app) => ({ ...app, removed: false as const })), ...removedApps.map((app) => ({ ...app, removed: true as const }))].sort((a,b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);
    for (const a of appChanges) {
      if (a.removed) { await client.query('DELETE FROM contracts WHERE chain_id = $1 AND address = $2', [a.chain, toBytes(a.app)]); continue; }
      await client.query(
        `INSERT INTO contracts (chain_id, address, deployer, deployed_at, deploy_tx)
         VALUES ($1,$2,$3,to_timestamp($4),$5)
         ON CONFLICT (chain_id, address) DO NOTHING`,
        [a.chain, toBytes(a.app), toBytes(a.publisher), a.timestamp, toBytes(a.hash)],
      );
    }
    for (const revenue of revenueRows) {
      await client.query(
        `INSERT INTO chain_revenue (chain_id, settled_at, tx_hash, log_index, gross, aep_fee, protocol_fee, holder_share, holder_address)
         VALUES ($1,to_timestamp($2),$3,$4,$5,0,$6,$7,$8)
         ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`,
        [revenue.chain, revenue.timestamp, toBytes(revenue.hash), revenue.logIndex, revenue.gross.toString(), revenue.protocolFee.toString(), revenue.holderShare.toString(), toBytes(revenue.holder)],
      );
    }
    for (const sponsored of sponsoredRows) {
      await client.query(
        `INSERT INTO sponsored_transactions
           (chain_id,tx_hash,log_index,block_number,user_address,relayer_address,target_address,
            success,toll,gas_void,margin_void,eth_reimbursed,failure_reason,timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,to_timestamp($14))
         ON CONFLICT (chain_id,tx_hash,log_index) DO NOTHING`,
        [sponsored.chain, toBytes(sponsored.hash), sponsored.logIndex,
          sponsored.blockNumber.toString(), toBytes(sponsored.user), toBytes(sponsored.relayer),
          toBytes(sponsored.target), sponsored.success, sponsored.toll.toString(),
          sponsored.gasVoid.toString(), sponsored.marginVoid.toString(),
          sponsored.ethReimbursed.toString(), toBytes(sponsored.reason), sponsored.timestamp],
      );
    }

    await writeBlocks(client, calls);

    await client.query(
      `UPDATE indexer_state SET last_indexed_block = $1, last_indexed_hash = $2, updated_at = now() WHERE id = TRUE`,
      [newHead.toString(), toBytes(newHeadHash)],
    );

    for (const chain of new Set([
      ...statuses.map((change) => change.chain),
      ...calls.map((c) => c.chain),
      ...apps.map((a) => a.chain),
      ...removedApps.map((a) => a.chain),
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
       total_txs = COALESCE((SELECT tx_count FROM chain_migration_baseline WHERE chain_id = $1), 0)
                   + (SELECT count(*) FROM transactions WHERE chain_id = $1),
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
