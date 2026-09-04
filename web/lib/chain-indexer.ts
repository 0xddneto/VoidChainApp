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
const TREASURY = deployment.production.VoidChainTreasury as Address;
const PAYMASTER = deployment.production.VoidPaymaster as Address;
const FIRST_BLOCK = BigInt(deployment.network.deployBlock ?? 0);
const CHAIN_ID_BASE = BigInt(deployment.chainIdBase);
const DEED_ABI = parseAbi([
  'function totalSupply() view returns(uint256)',
  'function ownerOf(uint256) view returns(address)',
  'function identityOf(uint256) view returns((string name,string description,string imageURI,string externalURL,string[] socials))',
]);
const RUNTIME_STATE_ABI = parseAbi([
  'function configured(uint256) view returns(bool)',
  'function statsOf(uint256) view returns(bool active,uint256 feePerCallUsd,uint256 pending,uint256 lifetimeRevenue,uint256 callCount)',
]);

const EVENTS = {
  activated: parseAbiItem('event ChainAppActivated(uint256 indexed tokenId, address activator)'),
  deactivated: parseAbiItem('event ChainAppDeactivated(uint256 indexed tokenId, address holder)'),
  reactivated: parseAbiItem('event ChainAppReactivated(uint256 indexed tokenId, address holder)'),
  executed: parseAbiItem(
    'event Executed(uint256 indexed tokenId, address indexed caller, address target, uint256 fee)',
  ),
  registered: parseAbiItem('event AppRegistered(uint256 indexed tokenId, address app, address publisher)'),
  unregistered: parseAbiItem('event AppUnregistered(uint256 indexed tokenId, address app)'),
  revenue: parseAbiItem('event RevenueSettled(uint256 indexed tokenId, address indexed deedHolder, uint256 gross, uint256 protocolFee, uint256 holderShare)'),
  sponsored: parseAbiItem('event Sponsored(address indexed user,address indexed relayer,uint256 indexed tokenId,uint256 toll,uint256 gasVoid,uint256 marginVoid,uint256 ethReimbursed)'),
  executionFailed: parseAbiItem('event ExecutionFailed(address indexed user,uint256 indexed tokenId,address target,bytes reason)'),
  transfer: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'),
  renamed: parseAbiItem('event VoidChainRenamed(uint256 indexed tokenId, string previousName, string newName)'),
} as const;

const bytes = (hex: string | null | undefined): Buffer | null =>
  hex ? Buffer.from(hex.slice(2), 'hex') : null;

async function resetProjection(client: pg.PoolClient): Promise<void> {
  await client.query('DELETE FROM blocks');
  await client.query('DELETE FROM transactions');
  await client.query('DELETE FROM contracts');
  await client.query('DELETE FROM chain_daily_stats');
  await client.query('DELETE FROM proposals');
  await client.query('DELETE FROM chain_revenue');
  await client.query('DELETE FROM sponsored_transactions');
  await client.query(
    `UPDATE chains SET name=NULL,description=NULL,image_uri=NULL,external_url=NULL,
       owner_address=NULL,status='reserved',activated_at=NULL,is_hot=FALSE,
       last_indexed_block=0,last_indexed_hash=NULL,updated_at=now()`,
  );
  await client.query(
    `UPDATE chain_summary SET total_txs=0,total_contracts=0,total_addresses=0,
       txs_24h=0,activity_score=0,last_block_at=NULL,updated_at=now()`,
  );
}

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

async function alignDeployment(): Promise<boolean> {
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
      [bytes(RUNTIME), bytes(DEED), FIRST_BLOCK.toString()],
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

/**
 * Constructor-imported chains have no post-deployment activation event.  Read
 * the canonical Runtime once on deployment cutover so the explorer cannot
 * accidentally present an active migrated chain as reserved.
 */
async function hydrateImportedRuntimeState(client: PublicClient): Promise<void> {
  const configuredIds: number[] = [];
  const batchSize = 64;
  for (let start = 1; start <= TOTAL_CHAINS; start += batchSize) {
    const ids = Array.from({ length: Math.min(batchSize, TOTAL_CHAINS - start + 1) }, (_, i) => start + i);
    const results = await client.multicall({
      allowFailure: true,
      contracts: ids.map((id) => ({ address: RUNTIME, abi: RUNTIME_STATE_ABI, functionName: 'configured' as const, args: [BigInt(id)] })),
    });
    results.forEach((result, i) => {
      if (result.status === 'success' && result.result === true) configuredIds.push(ids[i]);
    });
  }

  for (let start = 0; start < configuredIds.length; start += batchSize) {
    const ids = configuredIds.slice(start, start + batchSize);
    const results = await client.multicall({
      allowFailure: true,
      contracts: ids.map((id) => ({ address: RUNTIME, abi: RUNTIME_STATE_ABI, functionName: 'statsOf' as const, args: [BigInt(id)] })),
    });
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      if (result.status !== 'success') throw new Error(`Could not hydrate imported Runtime state for chain ${ids[i]}.`);
      const [active] = result.result as readonly [boolean, bigint, bigint, bigint, bigint];
      await pool.query(
        `UPDATE chains SET status = $2, updated_at = now() WHERE id = $1`,
        [ids[i], active ? 'live' : 'paused'],
      );
    }
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

async function ensureCanonicalCursor(client: PublicClient): Promise<boolean> {
  const { rows } = await pool.query<{ last_indexed_block: string; last_indexed_hash: Buffer | null }>(
    'SELECT last_indexed_block, last_indexed_hash FROM indexer_state WHERE id = TRUE',
  );
  const row = rows[0];
  if (!row || BigInt(row.last_indexed_block) < FIRST_BLOCK) return false;
  const block = await client.getBlock({ blockNumber: BigInt(row.last_indexed_block) });
  const canonical = bytes(block.hash)!;
  if (!row.last_indexed_hash) {
    await pool.query('UPDATE indexer_state SET last_indexed_hash = $1 WHERE id = TRUE', [canonical]);
    return false;
  }
  if (row.last_indexed_hash.equals(canonical)) return false;
  const reset = await pool.connect();
  try {
    await reset.query('BEGIN');
    await resetProjection(reset);
    await reset.query('DELETE FROM indexer_state WHERE id = TRUE');
    await reset.query('COMMIT');
  } catch (error) {
    await reset.query('ROLLBACK'); throw error;
  } finally { reset.release(); }
  return true;
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
       total_txs = COALESCE((SELECT tx_count FROM chain_migration_baseline WHERE chain_id = $1), 0)
                   + (SELECT count(*) FROM transactions WHERE chain_id = $1),
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
     WHERE status <> 'reserved' AND (owner_address IS NULL OR name IS NULL)`,
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
  removedApps: Array<{ chain: number; app: string }>;
  revenue: Array<{ chain: number; holder: string; gross: bigint; protocolFee: bigint; holderShare: bigint; hash: string; logIndex: number; timestamp: number }>;
  sponsored: Array<{ chain: number; hash: string; logIndex: number; blockNumber: bigint; user: string; relayer: string; target: string | null; success: boolean; toll: bigint; gasVoid: bigint; marginVoid: bigint; ethReimbursed: bigint; reason: string | null; timestamp: number }>;
  owners: Array<{ chain: number; owner: string }>;
  names: Array<{ chain: number; name: string }>;
  head: bigint;
  headHash: string;
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
    for (const app of args.removedApps) {
      await client.query('DELETE FROM contracts WHERE chain_id = $1 AND address = $2', [app.chain, bytes(app.app)]);
    }
    for (const revenue of args.revenue) {
      await client.query(
        `INSERT INTO chain_revenue (chain_id, settled_at, tx_hash, log_index, gross, aep_fee, protocol_fee, holder_share, holder_address)
         VALUES ($1,to_timestamp($2),$3,$4,$5,0,$6,$7,$8)
         ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`,
        [revenue.chain, revenue.timestamp, bytes(revenue.hash), revenue.logIndex, revenue.gross.toString(), revenue.protocolFee.toString(), revenue.holderShare.toString(), bytes(revenue.holder)],
      );
    }
    for (const sponsored of args.sponsored) {
      await client.query(
        `INSERT INTO sponsored_transactions
           (chain_id,tx_hash,log_index,block_number,user_address,relayer_address,target_address,
            success,toll,gas_void,margin_void,eth_reimbursed,failure_reason,timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,to_timestamp($14))
         ON CONFLICT (chain_id,tx_hash,log_index) DO NOTHING`,
        [sponsored.chain, bytes(sponsored.hash), sponsored.logIndex, sponsored.blockNumber.toString(),
          bytes(sponsored.user), bytes(sponsored.relayer), bytes(sponsored.target), sponsored.success,
          sponsored.toll.toString(), sponsored.gasVoid.toString(), sponsored.marginVoid.toString(),
          sponsored.ethReimbursed.toString(), bytes(sponsored.reason), sponsored.timestamp],
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

    await client.query('UPDATE indexer_state SET last_indexed_block = $1, last_indexed_hash = $2, updated_at = now() WHERE id = TRUE', [args.head.toString(), bytes(args.headHash)]);
    for (const chainId of new Set([...args.statuses.map((row) => row.chain), ...args.calls.map((row) => row.chain), ...args.apps.map((row) => row.chain), ...args.removedApps.map((row) => row.chain)])) {
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

    const rpc = process.env.PARENT_RPC ?? deployment.network.rpc;
    const client = createPublicClient({
      transport: fallback([http(rpc), http('https://rpc.testnet.chain.robinhood.com')]),
    }) as PublicClient;
    const deploymentChanged = await alignDeployment();
    await seedChains();
    if (deploymentChanged) await hydrateImportedRuntimeState(client);
    if (await ensureCanonicalCursor(client)) {
      await seedChains();
      await hydrateImportedRuntimeState(client);
    }
    const from = (await cursor()) + 1n;
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
    const unregistered = await client.getLogs({ address: RUNTIME, event: EVENTS.unregistered, ...range });
    const revenue = await client.getLogs({ address: TREASURY, event: EVENTS.revenue, ...range });
    const transfers = await client.getLogs({ address: DEED, event: EVENTS.transfer, ...range });
    const renamed = await client.getLogs({ address: DEED, event: EVENTS.renamed, ...range });
    const sponsored = await client.getLogs({ address: PAYMASTER, event: EVENTS.sponsored, ...range });
    const failures = await client.getLogs({ address: PAYMASTER, event: EVENTS.executionFailed, ...range });
    const all = [...activated, ...deactivated, ...reactivated, ...executed, ...registered, ...unregistered, ...revenue, ...transfers, ...renamed, ...sponsored, ...failures];
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
      removedApps: unregistered.map((log) => ({ chain: Number(log.args.tokenId!), app: log.args.app! })),
      revenue: revenue.map((log) => ({ chain: Number(log.args.tokenId!), holder: log.args.deedHolder!, gross: log.args.gross!, protocolFee: log.args.protocolFee!, holderShare: log.args.holderShare!, hash: log.transactionHash!, logIndex: log.logIndex!, timestamp: info.get(log.blockNumber!)!.timestamp })),
      sponsored: sponsored.map((log) => {
        const previous = sponsored.filter((other) => other.transactionHash === log.transactionHash && other.logIndex! < log.logIndex!)
          .reduce((index, other) => Math.max(index, other.logIndex!), -1);
        const failed = failures.find((other) => other.transactionHash === log.transactionHash
          && other.args.user === log.args.user && other.args.tokenId === log.args.tokenId
          && other.logIndex! > previous && other.logIndex! < log.logIndex!);
        return {
          chain: Number(log.args.tokenId!), hash: log.transactionHash!, logIndex: log.logIndex!, blockNumber: log.blockNumber!,
          user: log.args.user!, relayer: log.args.relayer!, target: failed?.args.target ?? null, success: !failed,
          toll: log.args.toll!, gasVoid: log.args.gasVoid!, marginVoid: log.args.marginVoid!,
          ethReimbursed: log.args.ethReimbursed!, reason: failed?.args.reason ?? null,
          timestamp: info.get(log.blockNumber!)!.timestamp,
        };
      }),
      owners: transfers.map((log) => ({ chain: Number(log.args.tokenId!), owner: log.args.to! })),
      names: renamed.map((log) => ({ chain: Number(log.args.tokenId!), name: log.args.newName! })),
      head: to,
      headHash: (await client.getBlock({ blockNumber: to })).hash,
    });
    return { status: all.length === 0 ? 'caught-up' : 'indexed', from: from.toString(), to: to.toString(), events: all.length };
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [INDEXER_LOCK]).catch(() => undefined);
    lock.release();
  }
}
