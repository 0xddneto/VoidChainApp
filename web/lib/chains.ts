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

// ---------------------------------------------------------------------------
// The chains card: one list, searched and paged in the browser
// ---------------------------------------------------------------------------

/** A chain as the card lists it. Compact on purpose — all 1,111 are sent at once. */
export interface ChainRow {
  id: number;
  chainId: number;
  status: ChainStatus;
  name: string | null;
  owner: string | null;
  txCount: number;
  contractCount: number;
  addressCount: number;
  /** The holder's 98% share of charged fees, in VOID wei. */
  revenue: string;
}

/**
 * Every chain, in one query.
 *
 * The card searches by name, id and wallet, and searching a wallet has to look
 * at all of them — paging on the server would mean a round trip per keystroke
 * for a dataset that fits in a single response.
 */
export async function allChains(): Promise<ChainRow[]> {
  const { rows } = await pool.query(
    `SELECT c.id, c.chain_id, c.status, c.name, c.owner_address,
            COALESCE(s.total_txs, 0)       AS txs,
            COALESCE(s.total_contracts, 0) AS contracts,
            COALESCE(s.total_addresses, 0) AS addresses,
            COALESCE((SELECT holder_revenue FROM chain_migration_baseline b WHERE b.chain_id = c.id), 0)
              + COALESCE((SELECT sum(toll - floor(toll * 200 / 10000)) FROM transactions t WHERE t.chain_id = c.id), 0) AS revenue
       FROM chains c
       LEFT JOIN chain_summary s ON s.chain_id = c.id
      ORDER BY c.id`,
  );

  const byId = new Map(
    rows.map((r) => [
      r.id as number,
      {
        id: r.id as number,
        chainId: Number(r.chain_id),
        status: r.status as ChainStatus,
        name: r.name as string | null,
        owner: toHex(r.owner_address),
        txCount: Number(r.txs),
        contractCount: Number(r.contracts),
        addressCount: Number(r.addresses),
        revenue: String(r.revenue),
      } satisfies ChainRow,
    ]),
  );

  // A chain absent from the database is reserved, which is a real state, not a
  // gap. Filling it here keeps the card at 1,111 rows from the first render.
  return Array.from({ length: TOTAL_CHAINS }, (_, i) => {
    const id = i + 1;
    return (
      byId.get(id) ?? {
        id,
        chainId: chainIdForToken(id),
        status: 'reserved' as ChainStatus,
        name: null,
        owner: null,
        txCount: 0,
        contractCount: 0,
        addressCount: 0,
        revenue: '0',
      }
    );
  });
}

/** An application published on a chain. */
export interface ChainApp {
  address: string;
  publisher: string;
  publishedAt: Date;
}

/** One call charged on a chain. */
export interface ChainCall {
  hash: string;
  caller: string;
  target: string;
  toll: string;
  at: Date;
}

export interface ChainDetail {
  apps: ChainApp[];
  calls: ChainCall[];
}

/** What the card shows when a chain is opened. Fetched only on demand. */
export async function chainDetail(id: number): Promise<ChainDetail> {
  const [apps, calls] = await Promise.all([
    pool.query(
      `SELECT address, deployer, deployed_at FROM contracts
        WHERE chain_id = $1 ORDER BY deployed_at DESC LIMIT 25`,
      [id],
    ),
    pool.query(
      `SELECT hash, from_address, to_address, toll, timestamp FROM transactions
        WHERE chain_id = $1 ORDER BY timestamp DESC, log_index DESC LIMIT 25`,
      [id],
    ),
  ]);

  return {
    apps: apps.rows.map((r) => ({
      address: toHex(r.address)!,
      publisher: toHex(r.deployer)!,
      publishedAt: r.deployed_at,
    })),
    calls: calls.rows.map((r) => ({
      hash: toHex(r.hash)!,
      caller: toHex(r.from_address)!,
      target: toHex(r.to_address)!,
      toll: String(r.toll),
      at: r.timestamp,
    })),
  };
}

// ---------------------------------------------------------------------------
// The ticker
// ---------------------------------------------------------------------------

export interface Event {
  kind: 'call' | 'failed' | 'app' | 'activated';
  chainId: number;
  detail: string;
  at: Date;
}

/**
 * Recent activity across every chain, as one stream.
 *
 * Three tables, one feed, newest first. It replaces the separate block and
 * transaction panels: with 1,111 chains the interesting thing is not any single
 * list but that something is happening at all.
 */
export async function recentEvents(limit = 30): Promise<Event[]> {
  const { rows } = await pool.query(
    `(SELECT 'call' AS kind, chain_id, toll::text AS detail, timestamp AS at
        FROM transactions ORDER BY timestamp DESC LIMIT $1)
     UNION ALL
     (SELECT 'app' AS kind, chain_id, encode(address, 'hex') AS detail, deployed_at AS at
        FROM contracts ORDER BY deployed_at DESC LIMIT $1)
     UNION ALL
     (SELECT 'activated' AS kind, id AS chain_id, '' AS detail, activated_at AS at
        FROM chains WHERE activated_at IS NOT NULL ORDER BY activated_at DESC LIMIT $1)
     UNION ALL
     (SELECT 'failed' AS kind, chain_id, (gas_void + margin_void)::text AS detail, timestamp AS at
        FROM sponsored_transactions WHERE success = FALSE ORDER BY timestamp DESC LIMIT $1)
     ORDER BY at DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    kind: r.kind as Event['kind'],
    chainId: r.chain_id as number,
    detail: r.detail as string,
    at: r.at as Date,
  }));
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export interface Social {
  platform: string;
  handle: string;
}

export interface Profile {
  address: string;
  displayName: string | null;
  avatarUri: string | null;
  bio: string | null;
  socials: Social[];
}

export interface ProfilePage {
  profile: Profile;
  /** Chains this address owns, newest id first. */
  chains: ChainRow[];
  /** Gross tolls charged across every chain they own, in VOID wei. */
  revenue: string;
  calls: number;
}

/** The small identity payload used in the connected-wallet control. */
export async function profileIdentity(address: string): Promise<Pick<Profile, 'displayName' | 'avatarUri'>> {
  const bytes = Buffer.from(address.toLowerCase().replace(/^0x/, ''), 'hex');
  const result = await pool.query(
    'SELECT display_name, avatar_uri FROM user_profiles WHERE address = $1',
    [bytes],
  );

  return {
    displayName: result.rows[0]?.display_name ?? null,
    avatarUri: result.rows[0]?.avatar_uri ?? null,
  };
}

/**
 * Everything shown on a profile.
 *
 * The profile row is optional on purpose: an address that never set a name is
 * still a real holder with real chains, and the page has to work for them. What
 * is authoritative here is the chain ownership, which comes from the deed
 * contract through the indexer — never from the profile table.
 */
export async function profilePage(address: string): Promise<ProfilePage> {
  const addr = address.toLowerCase();
  const bytes = Buffer.from(addr.replace(/^0x/, ''), 'hex');

  const [prof, socials, owned] = await Promise.all([
    pool.query(
      'SELECT display_name, avatar_uri, bio FROM user_profiles WHERE address = $1',
      [bytes],
    ),
    pool.query(
      'SELECT platform, handle FROM user_socials WHERE address = $1 ORDER BY platform',
      [bytes],
    ),
    pool.query(
      `SELECT c.id, c.chain_id, c.status, c.name, c.owner_address,
              COALESCE(s.total_txs, 0)       AS txs,
              COALESCE(s.total_contracts, 0) AS contracts,
              COALESCE(s.total_addresses, 0) AS addresses,
              COALESCE((SELECT holder_revenue FROM chain_migration_baseline b WHERE b.chain_id = c.id), 0)
                + COALESCE((SELECT sum(holder_share) FROM chain_revenue r WHERE r.chain_id = c.id), 0) AS revenue
         FROM chains c
         LEFT JOIN chain_summary s ON s.chain_id = c.id
        WHERE c.owner_address = $1
        ORDER BY c.id`,
      [bytes],
    ),
  ]);

  const chains: ChainRow[] = owned.rows.map((r) => ({
    id: r.id,
    chainId: Number(r.chain_id),
    status: r.status,
    name: r.name,
    owner: toHex(r.owner_address),
    txCount: Number(r.txs),
    contractCount: Number(r.contracts),
    addressCount: Number(r.addresses),
    revenue: String(r.revenue),
  }));

  return {
    profile: {
      address: addr,
      displayName: prof.rows[0]?.display_name ?? null,
      avatarUri: prof.rows[0]?.avatar_uri ?? null,
      bio: prof.rows[0]?.bio ?? null,
      socials: socials.rows.map((r) => ({ platform: r.platform, handle: r.handle })),
    },
    chains,
    revenue: chains.reduce((t, c) => t + BigInt(c.revenue), 0n).toString(),
    calls: chains.reduce((t, c) => t + c.txCount, 0),
  };
}

/**
 * Writes a profile.
 *
 * The address is decided by the caller, which is why the only route that calls
 * this verifies a signature over the exact payload first. Nothing here trusts
 * the request body to say who it is.
 */
export async function saveProfile(
  address: string,
  p: { displayName: string; avatarUri: string; bio: string; socials: Social[] },
  nonce?: string,
): Promise<void> {
  const bytes = Buffer.from(address.toLowerCase().replace(/^0x/, ''), 'hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (nonce) {
      const consumed = await client.query('INSERT INTO profile_nonces(user_address,nonce) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING nonce', [bytes, nonce]);
      if (consumed.rowCount !== 1) throw new Error('PROFILE_NONCE_USED');
    }
    await client.query(
      `INSERT INTO user_profiles (address, display_name, avatar_uri, bio)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (address) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             avatar_uri   = EXCLUDED.avatar_uri,
             bio          = EXCLUDED.bio,
             updated_at   = now()`,
      [bytes, p.displayName || null, p.avatarUri || null, p.bio || null],
    );
    // Replaced rather than merged: the form sends the whole set, so a handle
    // the user deleted has to disappear, and merging would keep it forever.
    await client.query('DELETE FROM user_socials WHERE address = $1', [bytes]);
    for (const s of p.socials) {
      if (!s.platform.trim() || !s.handle.trim()) continue;
      await client.query(
        `INSERT INTO user_socials (address, platform, handle) VALUES ($1, $2, $3)
         ON CONFLICT (address, platform) DO UPDATE SET handle = EXCLUDED.handle`,
        [bytes, s.platform.trim().slice(0, 32), s.handle.trim().slice(0, 64)],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Shortens an address keeping head and tail, which is what people actually check. */
export function shortAddress(address: string | null, head = 8, tail = 8): string {
  if (!address) return '—';
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}
