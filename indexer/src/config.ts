/**
 * What the indexer follows.
 *
 * A chain in the chainapp model has no RPC of its own: it is a row in
 * VoidChainAppRuntime, on Robinhood, and its activity is events tagged with the
 * tokenId. So there is no chain list to configure any more — there is one
 * contract address, and all 1,111 come out of the same sweep.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Addresses come from the file the deploy writes, not from environment
 * variables. An address typed by hand into a `.env` is an address left behind
 * by the next redeployment, and the indexer would start sweeping a dead
 * contract with no visible error — just a feed that never moves.
 */
const DEPLOYMENT = resolve(here, '../../web/lib/deployment.json');

interface Deployment {
  production: { VoidChainDeed: string; VoidChainAppRuntime: string; VoidChainTreasury: string };
  network: { rpc: string; chainId: number; deployBlock?: number };
  chainIdBase: number;
}

let deployment: Deployment;
try {
  deployment = JSON.parse(readFileSync(DEPLOYMENT, 'utf8')) as Deployment;
} catch (error) {
  throw new Error(
    `Could not read the deployment at ${DEPLOYMENT}. ` +
      `Run the deploy before the indexer — without the addresses there is nothing to sweep. ` +
      `Cause: ${(error as Error).message}`,
  );
}

export const RUNTIME = deployment.production.VoidChainAppRuntime as `0x${string}`;
export const DEED = deployment.production.VoidChainDeed as `0x${string}`;
export const TREASURY = deployment.production.VoidChainTreasury as `0x${string}`;
export const PARENT_RPC = process.env.PARENT_RPC ?? deployment.network.rpc;
export const CHAIN_ID_BASE = deployment.chainIdBase;

/**
 * The block the stack was deployed in.
 *
 * Sweeping from Robinhood's block zero would mean reading millions of blocks in
 * which our contracts did not yet exist.
 */
export const FIRST_BLOCK = BigInt(deployment.network.deployBlock ?? 0);

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://voidscan:voidscan@localhost:5433/voidscan';

/**
 * Interval between sweeps.
 *
 * Robinhood produces a block roughly every 250ms. One second keeps the feed
 * looking live without turning the indexer into load on the RPC.
 */
export const POLL_INTERVAL_MS = 1_000;

/**
 * Ceiling of blocks per log query.
 *
 * RPC providers reject wide ranges on `eth_getLogs`, and the limit varies
 * between them. Ten thousand is conservative enough to pass everywhere and
 * still catch up quickly after a long stop.
 */
export const MAX_BLOCKS_PER_PASS = 10_000;

/**
 * Only publish parent-chain events after this many newer blocks exist.
 *
 * Robinhood is fast enough that twenty blocks add only a few seconds while
 * preventing the explorer from presenting an unconfirmed tip as settled
 * history. Production may raise this without rebuilding the indexer.
 */
export const CONFIRMATIONS = Math.max(
  1,
  Number.parseInt(process.env.INDEXER_CONFIRMATIONS ?? '20', 10) || 20,
);
