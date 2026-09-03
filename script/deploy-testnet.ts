/**
 * The entire stack on testnet, ready for somebody to test.
 *
 * Usage:  npx tsx deploy-testnet.ts
 *
 * Deploys everything from scratch and leaves the system in a usable state: 1,111
 * deeds minted but inactive, a pool with stock to buy from, and the bubble
 * working — anyone holding only VOID transacts without ever touching ETH.
 *
 * WHAT IS TESTNET-ONLY AND DOES NOT GO TO MAINNET:
 *
 *   VoidTestToken   — on mainnet the token comes from the market's own factory.
 *                     This one makes the explicit, exact testnet approval and
 *                     one-signature purchase path observable in wallets.
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
  getAddress,
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

// Revenue is sent directly to this public address. It is deliberately separate
// from the deployer/paymaster governor, whose signing key stays in the local
// deployment environment and is never written into the repository.
const PROTOCOL_TREASURY = getAddress(
  process.env.PROTOCOL_TREASURY ?? '0x892F840aF9CFE78D4FF91D8e6D0F783264388A78',
);

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
 * Testnet launches the complete 1,111-deed collection into the pool. Each
 * address may mint one deed through the collection market.
 */
const SEED_INTO_POOL = NFTS;

const BATCH = 20;
const DAO_BATCH = 20;
const POOL_SEED_BATCH = 25;

function artifact(file: string): { abi: Abi; bytecode: `0x${string}` } {
  const raw = JSON.parse(readFileSync(`${OUT}/${file}.sol/${file}.json`, 'utf8'));
  // Forge writes bytecode with `0x`; the local solc fallback writes the same
  // hex string without it. JSON-RPC requires the prefix, so normalize here
  // instead of silently passing malformed deployment data to the network.
  const object = raw.bytecode.object as string;
  const bytecode = (object.startsWith('0x') ? object : `0x${object}`) as `0x${string}`;
  return { abi: raw.abi as Abi, bytecode };
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
console.log(`  treasury ${PROTOCOL_TREASURY}`);
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
console.log('  [1/9] token, oracle and deed');

const token = await deploy('VoidTestToken', []);
const oracle = await deploy('VoidTestOracle', [account.address, VOID_PER_ETH, VOID_USD]);
const deed = await deploy('VoidChainDeed', [
  CHAIN_ID_BASE, account.address, account.address, 500n,
]);

// ---------------------------------------------------------------------------
console.log('\n  [2/9] treasury, runtime and paymaster');

const treasury = await deploy('VoidChainTreasury', [
  deed, token, PROTOCOL_TREASURY, account.address,
]);
const runtime = await deploy('VoidChainAppRuntime', [deed, token, treasury]);
const paymaster = await deploy('VoidPaymaster', [
  token, runtime, account.address, PROTOCOL_TREASURY, oracle,
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
// Operators may lower it for a clean test deployment when faucet ETH is scarce;
// the amount is public in the final deployment record and never changes the
// Paymaster's signature or spending limits.
const RUNTIME_RESERVE = parseEther(process.env.PAYMASTER_RESERVE ?? '0.001');
const MINT_RESERVE = parseEther(process.env.MINT_PAYMASTER_RESERVE ?? '0.001');
const REFILL_TARGET = process.env.PAYMASTER_REFILL_TARGET
  ? parseEther(process.env.PAYMASTER_REFILL_TARGET)
  : RUNTIME_RESERVE;
const REFILL_THRESHOLD = process.env.PAYMASTER_REFILL_THRESHOLD
  ? parseEther(process.env.PAYMASTER_REFILL_THRESHOLD)
  : (RUNTIME_RESERVE * 70n) / 100n;
if (RUNTIME_RESERVE === 0n || MINT_RESERVE === 0n) {
  throw new Error('Paymaster reserves must be greater than zero.');
}
if (REFILL_THRESHOLD === 0n || REFILL_THRESHOLD >= REFILL_TARGET) {
  throw new Error('Paymaster refill threshold must be positive and lower than its target.');
}
await parent.waitForTransactionReceipt({
  hash: await wallet.sendTransaction({
    account, chain: null, to: paymaster, value: RUNTIME_RESERVE,
    maxFeePerGas: await ceiling(), maxPriorityFeePerGas: 0n,
  }),
});
console.log(`  ✓ runtime paymaster reserve: ${formatEther(RUNTIME_RESERVE)} ETH`);
await send(paymaster, pmAbi, 'setRefillPolicy', [REFILL_THRESHOLD, REFILL_TARGET, 500n]);
console.log(
  `  ✓ refill policy: below ${formatEther(REFILL_THRESHOLD)} ETH → ${formatEther(REFILL_TARGET)} ETH (5% TWAP bound)`,
);

// ---------------------------------------------------------------------------
console.log(`\n  [3/9] creating the ${NFTS} chain DAOs`);

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
console.log(`\n  [4/9] minting the ${NFTS} deeds`);

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
console.log(`\n  [5/9] keeping all ${NFTS} collection deeds inactive`);
// A deed starts inactive. Its buyer alone sets its original transaction fee by
// calling runtime.activate from the personal chain card. The collection market
// below is deliberately outside the runtime, so it never needs a live deed.
console.log(`  ✓ all ${NFTS} deeds await their holder's activation`);

// ---------------------------------------------------------------------------
console.log('\n  [6/9] the pool');

const amm = await deploy('VoidNftAmm', [
  token, deed, TOKENS_PER_NFT, RANDOM_FEE_BPS, SPECIFIC_FEE_BPS, account.address,
]);

const tokenAbi = artifact('VoidTestToken').abi;
// The pool needs tokens to pay whoever deposits a deed. Here they come from
// the tap.
await send(token, tokenAbi, 'mintTo', [amm, TOKENS_PER_NFT * BigInt(SEED_INTO_POOL + 50)]);
await send(deed, deedAbi, 'setApprovalForAll', [amm, true]);
console.log(`  ✓ pool funded, ${TOKENS_PER_NFT / 10n ** 18n} VOID per deed`);

// ---------------------------------------------------------------------------
console.log(`\n  [7/9] filling the pool's stock with all ${SEED_INTO_POOL} deeds`);

const ammAbi = artifact('VoidNftAmm').abi;
// From #1 upwards, so the first deed bought is the first deed of the collection.
const poolSeedBatches: bigint[][] = [];
for (let start = 1; start <= SEED_INTO_POOL; start += POOL_SEED_BATCH) {
  const ids: bigint[] = [];
  for (let id = start; id < start + POOL_SEED_BATCH && id <= SEED_INTO_POOL; id++) ids.push(BigInt(id));
  poolSeedBatches.push(ids);
}

const seeded = await bulk(poolSeedBatches, (ids, nonce, maxFeePerGas) =>
  wallet.writeContract({
    address: amm, abi: ammAbi, functionName: 'seed',
    args: [ids, 0n], account, chain: null, nonce,
    maxFeePerGas, maxPriorityFeePerGas: 0n,
  }), 'seeding pool');
if (seeded !== poolSeedBatches.length) throw new Error('One or more pool seed batches failed.');

// ---------------------------------------------------------------------------
console.log("\n  [8/9] no applications on inactive deeds");

const demoApps: Record<string, Address> = {};

// ---------------------------------------------------------------------------
console.log("\n  [9/9] collection market outside all chains");

// The market uses one exact VOID approval to the Paymaster, then one signed
// purchase. The AMM itself never receives a user approval, and no deed needs
// to be activated before its owner exists.
const mintPaymaster = await deploy('VoidCollectionMintPaymaster', [token, oracle, account.address]);
await send(mintPaymaster, artifact('VoidCollectionMintPaymaster').abi, 'setLimits', [
  1_000n, 60_000n, await ceiling(),
]);
await parent.waitForTransactionReceipt({
  hash: await wallet.sendTransaction({
    account, chain: null, to: mintPaymaster, value: MINT_RESERVE,
    maxFeePerGas: await ceiling(), maxPriorityFeePerGas: 0n,
  }),
});
const collectionMarket = await deploy('VoidCollectionMarket', [token, amm, deed, mintPaymaster]);
await send(amm, ammAbi, 'setSaleOperatorOnce', [collectionMarket]);
await send(mintPaymaster, artifact('VoidCollectionMintPaymaster').abi, 'setCollectionMarketOnce', [collectionMarket]);
console.log(`  ✓ collection mint paymaster reserve: ${formatEther(MINT_RESERVE)} ETH`);
console.log('  ✓ collection market outside all chains; one mint per wallet; direct pool buys locked');

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
    VoidCollectionMintPaymaster: mintPaymaster,
    VoidChainDaoFactory: daoFactory,
  },
  governance: {
    paymasterGovernor: account.address,
    protocolTreasury: PROTOCOL_TREASURY,
  },
  testnet: {
    VoidTestToken: token,
    VoidTestOracle: oracle,
    VoidNftAmm: amm,
    VoidCollectionMarket: collectionMarket,
    marketPurchaseFlow: 'collection-prepaid-v2',
  },
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
