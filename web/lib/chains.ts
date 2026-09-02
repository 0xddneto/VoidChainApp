/**
 * State of the VOID Chains, read from the Postgres the indexer keeps current.
 *
 * This layer used to return the fixed addresses from the deployment files; now
 * it reads from the database. The interface did not change along with it — the
 * `Chain` type was the contract between both sources from the start, and that
 * is what made the swap invisible to the components.
 */
import { pool, toHex } from './db';
import { DEPLOY } from './testnet';

export const TOTAL_CHAINS = 1111;

/** Same derivation as the VoidChainDeed contract: CHAIN_ID_BASE + tokenId - 1. */
export const CHAIN_ID_BASE = 46_630_000;
export const chainIdForToken = (tokenId: number) => CHAIN_ID_BASE + tokenId - 1;

/**
 * The lifecycle of a chain, and why each state exists separately:
 *
 *  reserved — only the chain ID is reserved. No contract, no cost. It is where
 *             most of the 1,111 will spend most of their time.
 *  live     — activated in VoidChainAppRuntime, accepting calls.
 *  paused   — deactivated by the owner. State and history remain.
 *  created  — inherited from the L3 model ("rollup contracts up, no node"). A
 *             chainapp never passes through it: activation is a single call.
 *
 * These names mirror the CHECK constraint on the `chains` table. Diverging
 * between the two makes the indexer fail on its first write.
 */
export type ChainStatus = 'reserved' | 'created' | 'live' | 'paused';

export interface Chain {
  tokenId: number;
  chainId: number;
  status: ChainStatus;
  name: string | null;
  rollup: string | null;
  txCount: number;
  contractCount: number;
  addressCount: number;
  lastBlockAt: Date | null;
}

export interface BlockSummary {
  chainId: number;
  tokenId: number;
  number: number;
  txCount: number;
  timestamp: Date;
}

export interface TxSummary {
  tokenId: number;
  hash: string;
  from: string;
  to: string | null;
  createdContract: string | null;
  /** The chain's toll, in VOID (18 decimals). Zero when the chain charges none. */
  toll: bigint;
  timestamp: Date;
}

/**
 * Infrastructure addresses, deployed by us on Robinhood testnet.
 *
 * Read from the file the deploy writes. They were hardcoded here until the
 * architecture changed, and then kept pointing at the L3 model's contracts —
 * RollupCreator and TokenBridgeCreator, which no chainapp uses — without
 * breaking anything, because a wrong address in the footer raises no error: it
 * only misleads whoever reads it.
 */
export const PROTOCOL = {
  parentChainId: DEPLOY.network.chainId,
  parentChainName: 'Robinhood Chain Testnet',
  voidToken: DEPLOY.testnet.VoidTestToken,
  runtime: DEPLOY.production.VoidChainAppRuntime,
  deed: DEPLOY.production.VoidChainDeed,
  paymaster: DEPLOY.production.VoidPaymaster,
  /** Measured cost to activate a chain, in ETH. */
  activationCost: 0.000077572,
} as const;

/**
 * State of all 1,111, for the map on the home page.
 *
 * A single query, with chains missing from the database filled in as reserved —
 * which is what they are. Fetching 1,111 rows only to discover that most do not
 * exist would be paying for information we already have.
 */
export async function allChainStates(): Promise<ChainStatus[]> {
  const { rows } = await pool.query<{ id: number; status: ChainStatus }>(
    'SELECT id, status FROM chains',
  );
  const byId = new Map(rows.map((r) => [r.id, r.status]));
  return Array.from({ length: TOTAL_CHAINS }, (_, i) => byId.get(i + 1) ?? 'reserved');
}

export async function statusCounts(): Promise<Record<ChainStatus, number>> {
  const counts: Record<ChainStatus, number> = { reserved: 0, created: 0, live: 0, paused: 0 };
  for (const status of await allChainStates()) counts[status]++;
  return counts;
}

/** The chains for the table, active first and the busiest at the top. */
export async function listChains(limit = 10): Promise<Chain[]> {
  const { rows } = await pool.query(
    `SELECT c.id, c.chain_id, c.status, c.name,
            s.total_txs, s.total_contracts, s.total_addresses, s.last_block_at
       FROM chains c
       LEFT JOIN chain_summary s ON s.chain_id = c.id
      ORDER BY CASE c.status
                 WHEN 'live' THEN 0 WHEN 'created' THEN 1
                 WHEN 'paused' THEN 2 ELSE 3 END,
               COALESCE(s.total_txs, 0) DESC, c.id
      LIMIT $1`,
    [limit],
  );

  const found: Chain[] = rows.map((r) => ({
    tokenId: r.id,
    chainId: Number(r.chain_id),
    status: r.status,
    name: r.name,
    rollup: null,
    txCount: Number(r.total_txs ?? 0),
    contractCount: Number(r.total_contracts ?? 0),
    addressCount: Number(r.total_addresses ?? 0),
    lastBlockAt: r.last_block_at,
  }));

  // Pads with reserved chains up to the limit, so the table does not shrink
  // while only a few are active.
  const seen = new Set(found.map((c) => c.tokenId));
  for (let id = 1; found.length < limit && id <= TOTAL_CHAINS; id++) {
    if (seen.has(id)) continue;
    found.push({
      tokenId: id,
      chainId: chainIdForToken(id),
      status: 'reserved',
      name: null,
      rollup: null,
      txCount: 0,
      contractCount: 0,
      addressCount: 0,
      lastBlockAt: null,
    });
  }
  return found;
}

export async function recentBlocks(limit = 8): Promise<BlockSummary[]> {
  const { rows } = await pool.query(
    `SELECT b.chain_id, c.chain_id AS eip155, b.number, b.tx_count, b.timestamp
       FROM blocks b JOIN chains c ON c.id = b.chain_id
      ORDER BY b.timestamp DESC, b.number DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    tokenId: r.chain_id,
    chainId: Number(r.eip155),
    number: Number(r.number),
    txCount: r.tx_count,
    timestamp: r.timestamp,
  }));
}

export async function recentTransactions(limit = 8): Promise<TxSummary[]> {
  const { rows } = await pool.query(
    `SELECT chain_id, hash, from_address, to_address, created_contract, timestamp, toll
       FROM transactions
      ORDER BY timestamp DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    tokenId: r.chain_id,
    hash: toHex(r.hash)!,
    from: toHex(r.from_address)!,
    to: toHex(r.to_address),
    createdContract: toHex(r.created_contract),
    toll: BigInt(r.toll ?? 0),
    timestamp: r.timestamp,
  }));
}

/**
 * Total billed calls, summed across all 1,111.
 *
 * Read from chain_summary and not from transactions: the summary is maintained
 * per chain by the indexer, and adding up 1,111 small numbers is cheaper than
 * counting a table that grows without a ceiling.
 */
export async function totalExecutions(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT COALESCE(sum(total_txs), 0) AS n FROM chain_summary',
  );
  return Number(rows[0].n);
}

/** Shortens an address keeping head and tail, which is what people actually check. */
export function shortAddress(address: string | null, head = 8, tail = 8): string {
  if (!address) return '—';
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}
