/**
 * The entire stack on testnet, ready for somebody to test.
 *
 * Usage:  npx tsx deploy-testnet.ts
 *
 * Deploys everything from scratch and leaves the system in a usable state: 1,111
 * deeds minted and switched on, a pool with stock to buy from, and the bubble
 * working — anyone holding only VOID transacts without ever touching ETH.
 *
 * WHAT IS TESTNET-ONLY AND DOES NOT GO TO MAINNET:
 *
 *   VoidTestToken   — on mainnet the token comes from the market's own factory.
 *                     This one exists because the old test VOID has no `permit`,
 *                     and without `permit` the bubble does not close.
 *   VoidTestOracle  — on mainnet the price comes from the VOID/ETH pool's TWAP
 *                     times Chainlink's ETH/USD feed. Neither exists here.
 *   VoidNftAmm      — on mainnet the market is operated by a third party. This
 *                     one reproduces its mechanics so the test means something.
 *
 * The rest — deed, treasury, runtime, paymaster — is the code that goes to
 * production.
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  formatEther,
  http,
  parseAbi,
  parseEther,
  type Abi,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const PARENT_RPC = process.env.PARENT_RPC ?? 'https://robinhood-testnet.drpc.org';
const EXPECTED_PARENT_CHAIN_ID = 46_630;

const here = dirname(fileURLToPath(import.meta.url));

/** Forge's output, one level above this script in either checkout. */
const OUT = resolve(here, '../out');

/**
 * Where the site reads its addresses from.
 *
 * Resolved from this file's own location rather than the working directory, so
 * it lands in the same place however the script was invoked.
 */
const WEB_DEPLOYMENT = resolve(here, '../web/lib/deployment.json');

const DEPLOYMENTS = resolve(here, 'deployments');

const deployerPrivateKey = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(deployerPrivateKey ?? '')) {
  throw new Error('DEPLOYER_PRIVATE_KEY must be a 32-byte key in script/.env or the environment.');
}

const account = privateKeyToAccount(deployerPrivateKey as `0x${string}`);
const parent = createPublicClient({ transport: http(PARENT_RPC) });
const wallet = createWalletClient({ account, transport: http(PARENT_RPC) });

// ---------------------------------------------------------------------------
// Parameters — the same ones mainnet would use, where that makes sense
// ---------------------------------------------------------------------------
const NFTS = 1111;
const CHAIN_ID_BASE = 46_630_000n;

/** How many tokens one deed is pegged to in the testnet pool. */
const TOKENS_PER_NFT = 900_090n * 10n ** 18n;

/** Pool fees. Set for real at the mainnet launch; here, test values. */
const RANDOM_FEE_BPS = 1_000n; // 10%
const SPECIFIC_FEE_BPS = 1_500n; // 15%

/** The toll IN DOLLARS — $0.001 per call. */
const TOLL_USD = parseEther('0.001');

/** Test price: VOID at $0.001, and ETH at $2,411. */
const VOID_USD = parseEther('0.001');
const VOID_PER_ETH = parseEther('2411000');

/**
 * How many deeds go into the pool, starting at #1.
 *
 * The pool sells from the beginning of the collection: a buyer arriving first
 * gets deed #1, not #101. An earlier version filled the pool from #101 and kept
 * the first hundred back, which meant the collection appeared to start at 101 to
 * anyone buying.
 */
const SEED_INTO_POOL = 100;

const BATCH = 20;
const DAO_BATCH = 20;

function artifact(file: string): { abi: Abi; bytecode: `0x${string}` } {
  const raw = JSON.parse(readFileSync(`${OUT}/${file}.sol/${file}.json`, 'utf8'));
  return { abi: raw.abi as Abi, bytecode: raw.bytecode.object as `0x${string}` };
}

async function ceiling(): Promise<bigint> {
  return (await parent.getGasPrice()) * 3n;
}

async function deploy(name: string, args: readonly unknown[]): Promise<Address> {
  const art = artifact(name);
  const r = await parent.waitForTransactionReceipt({
    hash: await wallet.sendTransaction({
      account, chain: null,
      data: encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args }),
      maxFeePerGas: await ceiling(), maxPriorityFeePerGas: 0n,
    }),
  });
  if (!r.contractAddress) throw new Error(`${name}: no address`);
  console.log(`  ✓ ${name.padEnd(22)} ${r.contractAddress}`);
  return r.contractAddress;
}

async function send(address: Address, abi: Abi, fn: string, args: unknown[]) {
  const receipt = await parent.waitForTransactionReceipt({
    hash: await wallet.writeContract({
      address, abi, functionName: fn, args, account, chain: null,
      maxFeePerGas: await ceiling(), maxPriorityFeePerGas: 0n,
    }),
  });
  if (receipt.status !== 'success') throw new Error(`${fn}: transaction reverted`);
  return receipt;
}

/**
 * Batches with a resynchronized nonce AND retries inside the batch.
 *
 * The public RPC slips under load and returns "nonce higher than expected" when
 * some earlier transaction dropped and opened a hole. Retrying only at the end
 * does not fix an order-dependent sequence; retrying here, before moving on,
 * does.
 */
async function bulk<T>(
  items: T[],
  build: (item: T, nonce: number, maxFeePerGas: bigint) => Promise<`0x${string}`>,
  label: string,
): Promise<number> {
  let done = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    let pending = items.slice(i, i + BATCH);
    for (let attempt = 0; attempt < 3 && pending.length > 0; attempt++) {
      const maxFee = await ceiling();
      const base = await parent.getTransactionCount({
        address: account.address, blockTag: 'pending',
      });
      const results = await Promise.allSettled(
        pending.map((item, k) =>
          build(item, base + k, maxFee).then((h) => parent.waitForTransactionReceipt({ hash: h })),
        ),
      );
      const left: T[] = [];
      results.forEach((r, k) => {
        if (r.status === 'fulfilled' && r.value.status === 'success') done++;
        else left.push(pending[k]);
      });
      pending = left;
    }
    process.stdout.write(`\r  ${label}: ${done}/${items.length}   `);
  }
  process.stdout.write('\n');
  return done;
}

// ===========================================================================
console.log('\n  VOIDS CHAINS — FULL STACK ON TESTNET\n');
console.log(`  deployer  ${account.address}`);
const parentChainId = await parent.getChainId();
if (parentChainId !== EXPECTED_PARENT_CHAIN_ID) {
  throw new Error(`Refusing to deploy: RPC returned chain ${parentChainId}, expected ${EXPECTED_PARENT_CHAIN_ID}.`);
}
const balanceBefore = await parent.getBalance({ address: account.address });
// Read BEFORE any deployment: none of our events can exist below this block, so
// this is where the indexer starts sweeping.
const firstBlock = await parent.getBlockNumber();
console.log(`  balance   ${formatEther(balanceBefore)} ETH\n`);

// ---------------------------------------------------------------------------
console.log('  [1/8] token, oracle and deed');

const token = await deploy('VoidTestToken', []);
const oracle = await deploy('VoidTestOracle', [account.address, VOID_PER_ETH, VOID_USD]);
const deed = await deploy('VoidChainDeed', [
  CHAIN_ID_BASE, account.address, account.address, 500n,
]);

// ---------------------------------------------------------------------------
console.log('\n  [2/8] treasury, runtime and paymaster');

const treasury = await deploy('VoidChainTreasury', [
  deed, token, account.address, account.address,
]);
const runtime = await deploy('VoidChainAppRuntime', [deed, token, treasury]);
const paymaster = await deploy('VoidPaymaster', [
  token, runtime, account.address, account.address, oracle,
]);
// Every chain ships with its own DAO. The factory is frozen into the runtime
// before it creates deterministic clones, because the runtime accepts registry
// writes only from that one factory.
const daoFactory = await deploy('VoidChainDaoFactory', [runtime, token, deed]);

const rtAbi = artifact('VoidChainAppRuntime').abi;
const pmAbi = artifact('VoidPaymaster').abi;

await send(runtime, rtAbi, 'setOracle', [oracle]);
await send(runtime, rtAbi, 'setForwarderOnce', [paymaster]);
await send(runtime, rtAbi, 'setDaoFactoryOnce', [daoFactory]);
await send(treasury, artifact('VoidChainTreasury').abi, 'setAuthorizedSettler', [runtime, true]);
await send(paymaster, pmAbi, 'setMargin', [1_000n]);
await send(paymaster, pmAbi, 'setLimits', [
  parseEther('0.001'), 60_000n, await ceiling(), parseEther('0.01'),
]);
console.log('  ✓ wired: oracle, forwarder and DAO factory frozen, settler, 10% margin');

// The bubble's reserve. $100 at $2,411/ETH is about 0.0415 ETH — but on testnet
// we go with less, because what matters is that it works, not that it scales.
const RESERVE = parseEther('0.01');
await parent.waitForTransactionReceipt({
  hash: await wallet.sendTransaction({
    account, chain: null, to: paymaster, value: RESERVE,
    maxFeePerGas: await ceiling(), maxPriorityFeePerGas: 0n,
  }),
});
console.log(`  ✓ paymaster reserve: ${formatEther(RESERVE)} ETH`);

// ---------------------------------------------------------------------------
console.log(`\n  [3/8] creating the ${NFTS} chain DAOs`);

const factoryAbi = artifact('VoidChainDaoFactory').abi;
const daoRanges: [bigint, bigint][] = [];
for (let start = 1; start <= NFTS; start += DAO_BATCH) {
  daoRanges.push([BigInt(start), BigInt(Math.min(start + DAO_BATCH - 1, NFTS))]);
}
const createdDaoRanges = await bulk(daoRanges, ([from, to], nonce, maxFeePerGas) =>
  wallet.writeContract({
    address: daoFactory, abi: factoryAbi, functionName: 'createMany', args: [from, to],
    account, chain: null, nonce,
    maxFeePerGas, maxPriorityFeePerGas: 0n,
  }), 'creating DAOs');
if (createdDaoRanges !== daoRanges.length) throw new Error('One or more DAO creation batches failed.');

// ---------------------------------------------------------------------------
console.log(`\n  [4/8] minting the ${NFTS} deeds`);

const deedAbi = artifact('VoidChainDeed').abi;
const mintBatches: bigint[][] = [];
for (let start = 1; start <= NFTS; start += 50) {
  const ids: bigint[] = [];
  for (let i = start; i < start + 50 && i <= NFTS; i++) ids.push(BigInt(i));
  mintBatches.push(ids);
}
const mintedBatches = await bulk(mintBatches, (ids, nonce, maxFeePerGas) =>
  wallet.writeContract({
    address: deed, abi: deedAbi, functionName: 'mintBatch',
    args: [account.address, ids], account, chain: null, nonce,
    maxFeePerGas, maxPriorityFeePerGas: 0n,
  }), 'minting');
if (mintedBatches !== mintBatches.length) throw new Error('One or more deed mint batches failed.');

// ---------------------------------------------------------------------------
console.log(`\n  [5/8] switching on the ${NFTS} chains (toll $0.001)`);

const everyId: number[] = [];
for (let i = 1; i <= NFTS; i++) everyId.push(i);
const activated = await bulk(everyId, (id, nonce, maxFeePerGas) =>
  wallet.writeContract({
    address: runtime, abi: rtAbi, functionName: 'activate',
    args: [BigInt(id), TOLL_USD], account, chain: null, nonce,
    maxFeePerGas, maxPriorityFeePerGas: 0n,
  }), 'activating');
if (activated !== everyId.length) throw new Error('One or more activation calls failed.');

// ---------------------------------------------------------------------------
console.log('\n  [6/8] the pool');

const amm = await deploy('VoidNftAmm', [
  token, deed, TOKENS_PER_NFT, RANDOM_FEE_BPS, SPECIFIC_FEE_BPS,
]);

const tokenAbi = artifact('VoidTestToken').abi;
// The pool needs tokens to pay whoever deposits a deed. Here they come from
// the tap.
await send(token, tokenAbi, 'mintTo', [amm, TOKENS_PER_NFT * BigInt(SEED_INTO_POOL + 50)]);
await send(deed, deedAbi, 'setApprovalForAll', [amm, true]);
console.log(`  ✓ pool funded, ${TOKENS_PER_NFT / 10n ** 18n} VOID per deed`);

// ---------------------------------------------------------------------------
console.log(`\n  [7/8] filling the pool's stock with ${SEED_INTO_POOL} deeds`);

const ammAbi = artifact('VoidNftAmm').abi;
// From #1 upwards, so the first deed bought is the first deed of the collection.
const forPool: number[] = [];
for (let i = 1; i <= SEED_INTO_POOL; i++) forPool.push(i);

await bulk(forPool, (id, nonce) =>
  wallet.writeContract({
    address: amm, abi: ammAbi, functionName: 'sell',
    args: [BigInt(id), 0n], account, chain: null, nonce,
    maxFeePerGas: 30_000_000n, maxPriorityFeePerGas: 0n,
  }), 'depositing');

// ---------------------------------------------------------------------------
console.log("\n  [8/8] a demo application on the pool's first 10");

const demoApps: Record<string, Address> = {};
for (let i = 0; i < 10; i++) {
  const id = BigInt(i + 1);
  const app = await deploy('Counter', [runtime, id]);
  await send(runtime, rtAbi, 'registerApp', [id, app]);
  demoApps[id.toString()] = app;
}

// ---------------------------------------------------------------------------
const balanceAfter = await parent.getBalance({ address: account.address });
const chainId = await parent.getChainId();

/**
 * The RPC written here is the PUBLIC one, never the `PARENT_RPC` the deploy used.
 *
 * This file is copied into the web app and imported by a `'use client'` page —
 * the bundler drags the whole JSON into the browser chunk, including the fields
 * the page never reads. Writing the URL with the provider key the deploy uses
 * would hand that key to every visitor, and the file also goes to the repository.
 */
const PUBLIC_RPC = 'https://robinhood-testnet.drpc.org';

const output = {
  network: {
    chainId,
    rpc: PUBLIC_RPC,
    // The indexer sweeps from here instead of Robinhood's block zero.
    deployBlock: Number(firstBlock),
  },
  production: {
    VoidChainDeed: deed,
    VoidChainTreasury: treasury,
    VoidChainAppRuntime: runtime,
    VoidPaymaster: paymaster,
    VoidChainDaoFactory: daoFactory,
  },
  testnet: { VoidTestToken: token, VoidTestOracle: oracle, VoidNftAmm: amm },
  parameters: {
    nfts: NFTS,
    tokensPerNFT: TOKENS_PER_NFT.toString(),
    randomFeeBps: Number(RANDOM_FEE_BPS),
    specificFeeBps: Number(SPECIFIC_FEE_BPS),
    tollUsd: TOLL_USD.toString(),
    voidUsd: VOID_USD.toString(),
    voidPerEth: VOID_PER_ETH.toString(),
    inPool: SEED_INTO_POOL,
  },
  demoApps,
  chainIdBase: CHAIN_ID_BASE.toString(),
};

const json = JSON.stringify(output, null, 2);
mkdirSync(DEPLOYMENTS, { recursive: true });
writeFileSync(resolve(DEPLOYMENTS, 'testnet.json'), json);
writeFileSync(WEB_DEPLOYMENT, json);

console.log('\n  ─────────────────────────────────────────────');
console.log(`  spent: ${formatEther(balanceBefore - balanceAfter)} ETH`);
console.log(`  left:  ${formatEther(balanceAfter)} ETH`);
console.log(`\n  → ${resolve(DEPLOYMENTS, 'testnet.json')}`);
console.log(`  → ${WEB_DEPLOYMENT}\n`);
