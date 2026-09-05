/**
 * The VoidScan indexer.
 *
 * Follows all 1,111 chains and keeps Postgres current. Runs as a long-lived
 * process — it does not fit in a serverless function, which is born, answers
 * and dies.
 *
 * A chain here is not a rollup with its own RPC: it is a row in
 * VoidChainAppRuntime, on Robinhood, and its activity is events tagged with the
 * tokenId. That is why there is one connection and not 1,111 — the indexer
 * reads Robinhood's log once and spreads the events across the chains.
 *
 * Usage:  npm run dev
 */
import 'dotenv/config';
import { createPublicClient, fallback, http, parseAbi, parseAbiItem, type Log, type PublicClient } from 'viem';
import {
  CHAIN_ID_BASE, CONFIRMATIONS, DEED, MAX_BLOCKS_PER_PASS,
  PARENT_RPC, POLL_INTERVAL_MS, RUNTIME, TREASURY, PAYMASTER,
} from './config.js';
import { alignDeployment, cursor, pool, sessionPool, resetProjection, seedChains, writePass, type BlockInfo, type CallRow, type StatusRow } from './db.js';

const EVENTS = {
  activated: parseAbiItem('event ChainAppActivated(uint256 indexed tokenId, address activator)'),
  deactivated: parseAbiItem('event ChainAppDeactivated(uint256 indexed tokenId, address holder)'),
  reactivated: parseAbiItem('event ChainAppReactivated(uint256 indexed tokenId, address holder)'),
  executed: parseAbiItem(
    'event Executed(uint256 indexed tokenId, address indexed caller, address target, uint256 fee)',
  ),
  registered: parseAbiItem(
    'event AppRegistered(uint256 indexed tokenId, address app, address publisher)',
  ),
  transfer: parseAbiItem(
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  ),
  unregistered: parseAbiItem('event AppUnregistered(uint256 indexed tokenId, address app)'),
  revenue: parseAbiItem('event RevenueSettled(uint256 indexed tokenId, address indexed deedHolder, uint256 gross, uint256 protocolFee, uint256 holderShare)'),
  renamed: parseAbiItem(
    'event VoidChainRenamed(uint256 indexed tokenId, string previousName, string newName)',
  ),
  sponsored: parseAbiItem('event Sponsored(address indexed user,address indexed relayer,uint256 indexed tokenId,uint256 toll,uint256 gasVoid,uint256 marginVoid,uint256 ethReimbursed)'),
  executionFailed: parseAbiItem('event ExecutionFailed(address indexed user,uint256 indexed tokenId,address target,bytes reason)'),
} as const;

const client = createPublicClient({
  transport: fallback([http(PARENT_RPC), http('https://rpc.testnet.chain.robinhood.com')]),
}) as PublicClient;
let running = true;
const INDEXER_LOCK = 4_662_011;
const RUNTIME_STATE_ABI = parseAbi([
  'function configured(uint256) view returns(bool)',
  'function statsOf(uint256) view returns(bool active,uint256 feePerCallUsd,uint256 pending,uint256 lifetimeRevenue,uint256 callCount)',
]);

async function hydrateImportedRuntimeState(): Promise<void> {
  const configuredIds: number[] = [];
  const batchSize = 64;
  for (let start = 1; start <= 1_111; start += batchSize) {
    const ids = Array.from({ length: Math.min(batchSize, 1_112 - start) }, (_, i) => start + i);
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
      await pool.query('UPDATE chains SET status = $2, updated_at = now() WHERE id = $1', [ids[i], active ? 'live' : 'paused']);
    }
  }
}

/**
 * The blocks a sweep touched, fetched once each.
 *
 * Brings the hash along with the timestamp because the same RPC response
 * already carries both — taking only the instant and then inventing the hash
 * from the number would write false data into a column that says `hash`.
 */
async function blocks(logs: Log[]): Promise<Map<bigint, BlockInfo>> {
  const wanted = [...new Set(logs.map((l) => l.blockNumber!))];
  const out = new Map<bigint, BlockInfo>();
  // In series, not with Promise.all: a large batch of simultaneous calls is
  // exactly what makes the public RPC start refusing requests.
  for (const n of wanted) {
    const b = await client.getBlock({ blockNumber: n });
    if (logs.some((log) => log.blockNumber === n && log.blockHash !== b.hash)) throw new Error('RPC logs and block hash disagree; refusing mixed-fork events.');
    out.set(n, { timestamp: Number(b.timestamp), hash: b.hash!, parentHash: b.parentHash });
  }
  return out;
}

/**
 * One sweep: from the last indexed block to the head, or to the batch ceiling.
 *
 * Returns the number of events written, so the caller knows whether to sweep
 * again immediately (it was behind) or wait out the interval (it was current).
 */
async function scan(): Promise<number> {
  const state = await pool.query<{ last_indexed_block: string; last_indexed_hash: Buffer | null }>(
    'SELECT last_indexed_block, last_indexed_hash FROM indexer_state WHERE id = TRUE',
  );
  if (state.rows[0] && BigInt(state.rows[0].last_indexed_block) >= BigInt(0)) {
    const saved = state.rows[0];
    const block = await client.getBlock({ blockNumber: BigInt(saved.last_indexed_block) });
    const canonical = Buffer.from(block.hash.slice(2), 'hex');
    if (!saved.last_indexed_hash) {
      await pool.query('UPDATE indexer_state SET last_indexed_hash = $1 WHERE id = TRUE', [canonical]);
    } else if (!saved.last_indexed_hash.equals(canonical)) {
      const reset = await pool.connect();
      try {
        await reset.query('BEGIN');
        await resetProjection(reset);
        await reset.query('DELETE FROM indexer_state WHERE id = TRUE');
        await reset.query('COMMIT');
      } catch (error) {
        await reset.query('ROLLBACK'); throw error;
      } finally { reset.release(); }
      await seedChains(CHAIN_ID_BASE);
      await hydrateImportedRuntimeState();
    }
  }
  const tip = await client.getBlockNumber();
  const confirmationDepth = BigInt(CONFIRMATIONS);
  if (tip < confirmationDepth) return 0;
  const head = tip - confirmationDepth;
  const from = (await cursor()) + 1n;
  if (from > head) return 0;

  const to = head - from >= BigInt(MAX_BLOCKS_PER_PASS)
    ? from + BigInt(MAX_BLOCKS_PER_PASS) - 1n
    : head;

  const range = { fromBlock: from, toBlock: to } as const;
  // The deployment transaction creates a dense batch of events. Query them in
  // series: public Robinhood RPCs otherwise reject the simultaneous large
  // responses even though each individual event query is valid.
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
  if (all.length === 0) {
    await writePass([], [], [], [], [], [], [], [], to, (await client.getBlock({ blockNumber: to })).hash);
    return 0;
  }

  const info = await blocks(all);

  const calls: CallRow[] = executed.map((l) => ({
    chain: Number(l.args.tokenId!),
    hash: l.transactionHash!,
    blockNumber: l.blockNumber!,
    txIndex: l.transactionIndex!,
    logIndex: l.logIndex!,
    caller: l.args.caller!,
    target: l.args.target!,
    toll: l.args.fee!,
    block: info.get(l.blockNumber!)!,
  }));
  const statuses: StatusRow[] = [
    ...activated.map((l) => ({ chain: Number(l.args.tokenId!), status: 'live' as const, initial: true, timestamp: info.get(l.blockNumber!)!.timestamp, blockNumber: l.blockNumber!, logIndex: l.logIndex! })),
    ...deactivated.map((l) => ({ chain: Number(l.args.tokenId!), status: 'paused' as const, initial: false, timestamp: info.get(l.blockNumber!)!.timestamp, blockNumber: l.blockNumber!, logIndex: l.logIndex! })),
    ...reactivated.map((l) => ({ chain: Number(l.args.tokenId!), status: 'live' as const, initial: false, timestamp: info.get(l.blockNumber!)!.timestamp, blockNumber: l.blockNumber!, logIndex: l.logIndex! })),
  ].sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);

  await writePass(
    statuses,
    calls,
    registered.map((l) => ({
      blockNumber: l.blockNumber!, logIndex: l.logIndex!,
      chain: Number(l.args.tokenId!),
      app: l.args.app!,
      publisher: l.args.publisher!,
      hash: l.transactionHash!,
      timestamp: info.get(l.blockNumber!)!.timestamp,
    })),
    unregistered.map((l) => ({ blockNumber: l.blockNumber!, logIndex: l.logIndex!, chain: Number(l.args.tokenId!), app: l.args.app! })),
    revenue.map((l) => ({ chain: Number(l.args.tokenId!), holder: l.args.deedHolder!, gross: l.args.gross!, protocolFee: l.args.protocolFee!, holderShare: l.args.holderShare!, hash: l.transactionHash!, logIndex: l.logIndex!, timestamp: info.get(l.blockNumber!)!.timestamp })),
    sponsored.map((log) => {
      const previous = sponsored.filter((other) => other.transactionHash === log.transactionHash && other.logIndex! < log.logIndex!)
        .reduce((index, other) => Math.max(index, other.logIndex!), -1);
      const failed = failures.find((other) => other.transactionHash === log.transactionHash
        && other.args.user === log.args.user && other.args.tokenId === log.args.tokenId
        && other.logIndex! > previous && other.logIndex! < log.logIndex!);
      return {
        chain: Number(log.args.tokenId!), hash: log.transactionHash!, logIndex: log.logIndex!,
        blockNumber: log.blockNumber!, user: log.args.user!, relayer: log.args.relayer!,
        target: failed?.args.target ?? null, success: !failed, toll: log.args.toll!,
        gasVoid: log.args.gasVoid!, marginVoid: log.args.marginVoid!,
        ethReimbursed: log.args.ethReimbursed!, reason: failed?.args.reason ?? null,
        timestamp: info.get(log.blockNumber!)!.timestamp,
      };
    }),
    // The last Transfer of each token within the batch is its owner at the end.
    transfers.map((l) => ({ chain: Number(l.args.tokenId!), owner: l.args.to! })),
    renamed.map((l) => ({ chain: Number(l.args.tokenId!), name: l.args.newName! })),
    to,
    (await client.getBlock({ blockNumber: to })).hash,
  );

  return all.length;
}

async function tick(): Promise<void> {
  try {
    const n = await scan();
    if (n > 0) console.log(`  +${n} event(s), now at block ${await cursor()}`);
  } catch (error) {
    // An RPC that refused a request must not take the process down: the cursor
    // did not advance, so the next pass redoes exactly the same range.
    console.error(`  failed: ${(error as Error).message.split('\n')[0]}`);
  }
}

async function main(): Promise<void> {
  const lock = await sessionPool.connect();
  const acquired = (await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [INDEXER_LOCK])).rows[0].locked;
  if (!acquired) {
    lock.release(true);
    throw new Error('Another VoidScan indexer already owns this database cursor.');
  }
  try {
  console.log(`\n  VOIDSCAN INDEXER`);
  console.log(`  runtime  ${RUNTIME}`);
  console.log(`  deed     ${DEED}`);
  console.log(`  rpc      ${PARENT_RPC}`);
  console.log(`  finality ${CONFIRMATIONS} confirmations`);

  if (await alignDeployment(RUNTIME, DEED)) {
    console.log('  deployment changed; rebuilt the local chain mirror');
    await seedChains(CHAIN_ID_BASE);
    await hydrateImportedRuntimeState();
  }

  // All 1,111 exist as rows from the first second, as 'reserved'. Without that,
  // a chain would only appear in the database once activated, and the foreign
  // keys of blocks and transactions would have nothing to rest on.
  const seeded = await seedChains(CHAIN_ID_BASE);
  console.log(`  chains   ${seeded} reserved in the database`);
  console.log(`  from block ${(await cursor()) + 1n}\n`);

  while (running) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [INDEXER_LOCK]).catch(() => undefined);
    lock.release(true);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log('\n  shutting down...');
    running = false;
    void Promise.all([pool.end(), sessionPool.end()]).then(() => process.exit(0));
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
