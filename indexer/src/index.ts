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
import { createPublicClient, fallback, http, parseAbiItem, type Log, type PublicClient } from 'viem';
import {
  CHAIN_ID_BASE, CONFIRMATIONS, DEED, MAX_BLOCKS_PER_PASS,
  PARENT_RPC, POLL_INTERVAL_MS, RUNTIME,
} from './config.js';
import { alignDeployment, cursor, pool, seedChains, writePass, type BlockInfo, type CallRow, type StatusRow } from './db.js';

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
  renamed: parseAbiItem(
    'event VoidChainRenamed(uint256 indexed tokenId, string previousName, string newName)',
  ),
} as const;

const client = createPublicClient({
  transport: fallback([http(PARENT_RPC), http('https://rpc.testnet.chain.robinhood.com')]),
}) as PublicClient;
let running = true;

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
  const transfers = await client.getLogs({ address: DEED, event: EVENTS.transfer, ...range });
  const renamed = await client.getLogs({ address: DEED, event: EVENTS.renamed, ...range });

  const all = [...activated, ...deactivated, ...reactivated, ...executed, ...registered, ...transfers, ...renamed];
  if (all.length === 0) {
    await writePass([], [], [], [], [], to);
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
      chain: Number(l.args.tokenId!),
      app: l.args.app!,
      publisher: l.args.publisher!,
      hash: l.transactionHash!,
      timestamp: info.get(l.blockNumber!)!.timestamp,
    })),
    // The last Transfer of each token within the batch is its owner at the end.
    transfers.map((l) => ({ chain: Number(l.args.tokenId!), owner: l.args.to! })),
    renamed.map((l) => ({ chain: Number(l.args.tokenId!), name: l.args.newName! })),
    to,
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
  console.log(`\n  VOIDSCAN INDEXER`);
  console.log(`  runtime  ${RUNTIME}`);
  console.log(`  deed     ${DEED}`);
  console.log(`  rpc      ${PARENT_RPC}`);
  console.log(`  finality ${CONFIRMATIONS} confirmations`);

  if (await alignDeployment(RUNTIME, DEED)) {
    console.log('  deployment changed; rebuilt the local chain mirror');
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
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log('\n  shutting down...');
    running = false;
    void pool.end().then(() => process.exit(0));
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
