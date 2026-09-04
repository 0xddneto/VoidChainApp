import pg from 'pg';
import { createPublicClient, fallback, http, parseAbi, parseAbiItem, type Address, type Log, type PublicClient } from 'viem';

import deployment from './deployment.json';
import { pool } from './db';

const TOTAL_CHAINS = 1_111;
const MAX_BLOCKS_PER_PASS = 10_000n;
const CONFIRMATIONS = BigInt(Math.max(
  1,
  Number.parseInt(process.env.INDEXER_CONFIRMATIONS ?? '20', 10) || 20,
));
// Held by the dedicated cron connection for the full sweep.  A second Vercel
// invocation simply reports "busy" instead of racing the cursor or RPC.
const INDEXER_LOCK = 4_662_011;

const RUNTIME = deployment.production.VoidChainAppRuntime as Address;
const DEED = deployment.production.VoidChainDeed as Address;
const FIRST_BLOCK = BigInt(deployment.network.deployBlock ?? 0);
const CHAIN_ID_BASE = BigInt(deployment.chainIdBase);
const DEED_ABI = parseAbi([
  'function ownerOf(uint256) view returns(address)',
  'function identityOf(uint256) view returns((string name,string description,string imageURI,string externalURL,string[] socials))',
]);

const EVENTS = {
  activated: parseAbiItem('event ChainAppActivated(uint256 indexed tokenId, address activator)'),
  deactivated: parseAbiItem('event ChainAppDeactivated(uint256 indexed tokenId, address holder)'),
  reactivated: parseAbiItem('event ChainAppReactivated(uint256 indexed tokenId, address holder)'),
  executed: parseAbiItem(
    'event Executed(uint256 indexed tokenId, address indexed caller, address target, uint256 fee)',
  ),
  registered: parseAbiItem('event AppRegistered(uint256 indexed tokenId, address app, address publisher)'),
  transfer: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'),
  renamed: parseAbiItem('event VoidChainRenamed(uint256 indexed tokenId, string previousName, string newName)'),
} as const;

const bytes = (hex: string | null | undefined): Buffer | null =>
  hex ? Buffer.from(hex.slice(2), 'hex') : null;

interface BlockInfo {
  timestamp: number;
  hash: string;
  parentHash: string;
}

export interface IndexerResult {
  status: 'indexed' | 'caught-up' | 'busy';
  from?: string;
  to?: string;
  events?: number;
}

async function alignDeployment(): Promise<void> {
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
  const current = rows[0];
  const matches = current
    && current.runtime_address.equals(bytes(RUNTIME)!)
    && current.deed_address.equals(bytes(DEED)!)
    && current.deploy_block === FIRST_BLOCK.toString();

  if (matches) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE chains CASCADE');
    await client.query('DELETE FROM indexer_state WHERE id = TRUE');
    await client.query(
      `INSERT INTO indexer_deployment (id, runtime_address, deed_address, deploy_block)
       VALUES (TRUE, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         runtime_address = EXCLUDED.runtime_address,
         deed_address = EXCLUDED.deed_address,
         deploy_block = EXCLUDED.deploy_block,
         updated_at = now()`,
      [bytes(RUNTIME), bytes(DEED), FIRST_BLOCK.toString()],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedChains(): Promise<void> {
  await pool.query(
    `INSERT INTO chains (id, chain_id, status)
     SELECT i, $1::bigint + i - 1, 'reserved' FROM generate_series(1, $2) AS i
     ON CONFLICT (id) DO NOTHING`,
    [CHAIN_ID_BASE.toString(), TOTAL_CHAINS],
  );
  await pool.query(
    'INSERT INTO chain_summary (chain_id) SELECT id FROM chains ON CONFLICT (chain_id) DO NOTHING',
  );
}

async function cursor(): Promise<bigint> {
  const { rows } = await pool.query<{ last_indexed_block: string }>(
    `INSERT INTO indexer_state (id, last_indexed_block) VALUES (TRUE, $1)
     ON CONFLICT (id) DO UPDATE SET last_indexed_block = indexer_state.last_indexed_block
     RETURNING last_indexed_block`,
    [(FIRST_BLOCK > 0n ? FIRST_BLOCK - 1n : 0n).toString()],
  );
  return BigInt(rows[0].last_indexed_block);
}

async function blocks(client: PublicClient, logs: Log[]): Promise<Map<bigint, BlockInfo>> {
  const out = new Map<bigint, BlockInfo>();
  for (const number of new Set(logs.map((log) => log.blockNumber!))) {
    const block = await client.getBlock({ blockNumber: number });
    out.set(number, { timestamp: Number(block.timestamp), hash: block.hash!, parentHash: block.parentHash });
  }
  return out;
}

async function refreshSummary(client: pg.PoolClient, chainId: number): Promise<void> {
  await client.query(
    `UPDATE chain_summary s SET
       total_txs = (SELECT count(*) FROM transactions WHERE chain_id = $1),
       total_contracts = (SELECT count(*) FROM contracts WHERE chain_id = $1),
       total_addresses = (SELECT count(DISTINCT from_address) FROM transactions WHERE chain_id = $1),
       txs_24h = (SELECT count(*) FROM transactions WHERE chain_id = $1 AND timestamp > now() - interval '24 hours'),
       last_block_at = (SELECT max(timestamp) FROM transactions WHERE chain_id = $1),
       updated_at = now()
     WHERE s.chain_id = $1`,
    [chainId],
  );
}

/**
 * A V2 runtime starts after some deeds have already been minted and renamed.
 * Those historical ERC-721 events deliberately sit before FIRST_BLOCK, so
 * seed missing identity straight from the canonical Deed rather than carrying
 * legacy runtime data into the V2 explorer.
 */
async function hydrateDeedMetadata(client: PublicClient): Promise<void> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM chains
     WHERE status = 'live' AND (owner_address IS NULL OR name IS NULL)`,
  );
  for (const row of rows) {
    const [owner, identity] = await Promise.all([
      client.readContract({ address: DEED, abi: DEED_ABI, functionName: 'ownerOf', args: [BigInt(row.id)] }) as Promise<Address>,
      client.readContract({ address: DEED, abi: DEED_ABI, functionName: 'identityOf', args: [BigInt(row.id)] }) as Promise<{ name: string }>,
    ]);
    await pool.query(
      `UPDATE chains SET owner_address = $2,
       name = CASE WHEN $3 <> '' THEN $3 ELSE name END,
       updated_at = now() WHERE id = $1`,
      [row.id, bytes(owner), identity.name],
    );
  }
}

async function writePass(args: {
  statuses: Array<{ chain: number; status: 'live' | 'paused'; initial: boolean; timestamp: number; blockNumber: bigint; logIndex: number }>;
  calls: Array<{ chain: number; hash: string; blockNumber: bigint; txIndex: number; logIndex: number; caller: string; target: string; toll: bigint; block: BlockInfo }>;
  apps: Array<{ chain: number; app: string; publisher: string; hash: string; timestamp: number }>;
  owners: Array<{ chain: number; owner: string }>;
  names: Array<{ chain: number; name: string }>;
  head: bigint;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const change of args.statuses) {
      await client.query(
        change.initial
          ? `UPDATE chains SET status = 'live', activated_at = to_timestamp($2), updated_at = now() WHERE id = $1`
          : `UPDATE chains SET status = $2, updated_at = now() WHERE id = $1`,
        change.initial ? [change.chain, change.timestamp] : [change.chain, change.status],
      );
    }
    for (const owner of args.owners) {
      await client.query('UPDATE chains SET owner_address = $2, updated_at = now() WHERE id = $1', [owner.chain, bytes(owner.owner)]);
    }
    for (const name of args.names) {
      await client.query('UPDATE chains SET name = $2, updated_at = now() WHERE id = $1', [name.chain, name.name]);
    }
    for (const call of args.calls) {
      await client.query(
        `INSERT INTO transactions
           (chain_id, hash, block_number, tx_index, log_index, from_address, to_address, toll, status, timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,to_timestamp($9))
         ON CONFLICT (chain_id, hash, log_index) DO NOTHING`,
        [call.chain, bytes(call.hash), call.blockNumber.toString(), call.txIndex, call.logIndex,
          bytes(call.caller), bytes(call.target), call.toll.toString(), call.block.timestamp],
      );
    }
    for (const app of args.apps) {
      await client.query(
        `INSERT INTO contracts (chain_id, address, deployer, deployed_at, deploy_tx)
         VALUES ($1,$2,$3,to_timestamp($4),$5)
         ON CONFLICT (chain_id, address) DO NOTHING`,
        [app.chain, bytes(app.app), bytes(app.publisher), app.timestamp, bytes(app.hash)],
      );
    }

    const blockCounts = new Map<string, { chain: number; number: bigint; block: BlockInfo; count: number }>();
    for (const call of args.calls) {
      const key = `${call.chain}:${call.blockNumber}`;
      const current = blockCounts.get(key);
      if (current) current.count += 1;
      else blockCounts.set(key, { chain: call.chain, number: call.blockNumber, block: call.block, count: 1 });
    }
    for (const row of blockCounts.values()) {
      await client.query(
        `INSERT INTO blocks (chain_id, number, hash, parent_hash, timestamp, tx_count)
         VALUES ($1,$2,$3,$4,to_timestamp($5),$6)
         ON CONFLICT (chain_id, number) DO UPDATE SET tx_count = EXCLUDED.tx_count`,
        [row.chain, row.number.toString(), bytes(row.block.hash), bytes(row.block.parentHash), row.block.timestamp, row.count],
      );
    }

    await client.query('UPDATE indexer_state SET last_indexed_block = $1, updated_at = now() WHERE id = TRUE', [args.head.toString()]);
    for (const chainId of new Set([...args.statuses.map((row) => row.chain), ...args.calls.map((row) => row.chain), ...args.apps.map((row) => row.chain)])) {
      await refreshSummary(client, chainId);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** One bounded, idempotent index pass. Vercel Cron calls this once per minute. */
export async function indexOnePass(): Promise<IndexerResult> {
  const lock = await pool.connect();
  try {
    const acquired = (await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [INDEXER_LOCK])).rows[0].locked;
    if (!acquired) return { status: 'busy' };

    await alignDeployment();
    await seedChains();
    const from = (await cursor()) + 1n;
    const rpc = process.env.PARENT_RPC ?? deployment.network.rpc;
    const client = createPublicClient({
      transport: fallback([http(rpc), http('https://rpc.testnet.chain.robinhood.com')]),
    }) as PublicClient;
    const tip = await client.getBlockNumber();
    if (tip < CONFIRMATIONS) {
      return { status: 'caught-up', from: from.toString(), to: '0', events: 0 };
    }
    const head = tip - CONFIRMATIONS;
    await hydrateDeedMetadata(client);
    if (from > head) return { status: 'caught-up', from: from.toString(), to: head.toString(), events: 0 };
    const to = head - from >= MAX_BLOCKS_PER_PASS ? from + MAX_BLOCKS_PER_PASS - 1n : head;
    const range = { fromBlock: from, toBlock: to } as const;
    const activated = await client.getLogs({ address: RUNTIME, event: EVENTS.activated, ...range });
    const deactivated = await client.getLogs({ address: RUNTIME, event: EVENTS.deactivated, ...range });
    const reactivated = await client.getLogs({ address: RUNTIME, event: EVENTS.reactivated, ...range });
    const executed = await client.getLogs({ address: RUNTIME, event: EVENTS.executed, ...range });
    const registered = await client.getLogs({ address: RUNTIME, event: EVENTS.registered, ...range });
    const transfers = await client.getLogs({ address: DEED, event: EVENTS.transfer, ...range });
    const renamed = await client.getLogs({ address: DEED, event: EVENTS.renamed, ...range });
    const all = [...activated, ...deactivated, ...reactivated, ...executed, ...registered, ...transfers, ...renamed];
    const info = all.length === 0 ? new Map<bigint, BlockInfo>() : await blocks(client, all);
    await writePass({
      statuses: [
        ...activated.map((log) => ({ chain: Number(log.args.tokenId!), status: 'live' as const, initial: true, timestamp: info.get(log.blockNumber!)!.timestamp, blockNumber: log.blockNumber!, logIndex: log.logIndex! })),
        ...deactivated.map((log) => ({ chain: Number(log.args.tokenId!), status: 'paused' as const, initial: false, timestamp: info.get(log.blockNumber!)!.timestamp, blockNumber: log.blockNumber!, logIndex: log.logIndex! })),
        ...reactivated.map((log) => ({ chain: Number(log.args.tokenId!), status: 'live' as const, initial: false, timestamp: info.get(log.blockNumber!)!.timestamp, blockNumber: log.blockNumber!, logIndex: log.logIndex! })),
      ].sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1),
      calls: executed.map((log) => ({
        chain: Number(log.args.tokenId!), hash: log.transactionHash!, blockNumber: log.blockNumber!, txIndex: log.transactionIndex!,
        logIndex: log.logIndex!, caller: log.args.caller!, target: log.args.target!, toll: log.args.fee!, block: info.get(log.blockNumber!)!,
      })),
      apps: registered.map((log) => ({
        chain: Number(log.args.tokenId!), app: log.args.app!, publisher: log.args.publisher!, hash: log.transactionHash!, timestamp: info.get(log.blockNumber!)!.timestamp,
      })),
      owners: transfers.map((log) => ({ chain: Number(log.args.tokenId!), owner: log.args.to! })),
      names: renamed.map((log) => ({ chain: Number(log.args.tokenId!), name: log.args.newName! })),
      head: to,
    });
    return { status: all.length === 0 ? 'caught-up' : 'indexed', from: from.toString(), to: to.toString(), events: all.length };
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [INDEXER_LOCK]).catch(() => undefined);
    lock.release();
  }
}
