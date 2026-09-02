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
import { readFileSync, writeFileSync } from 'node:fs';
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

const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`);
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

/** How many deeds go into the pool so somebody can buy one. */
const SEED_INTO_POOL = 100;
/** Deeds held back from the pool, so the first ones are not all for sale. */
const TREASURY_KEEP = 100;

const BATCH = 20;

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
  return parent.waitForTransactionReceipt({
    hash: await wallet.writeContract({
      address, abi, functionName: fn, args, account, chain: null,
      maxFeePerGas: await ceiling(), maxPriorityFeePerGas: 0n,
    }),
  });
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
  build: (item: T, nonce: number) => Promise<`0x${string}`>,
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
          build(item, base + k).then((h) => parent.waitForTransactionReceipt({ hash: h })),
        ),
      );
      const left: T[] = [];
      results.forEach((r, k) => {
        if (r.status === 'fulfilled' && r.value.status === 'success') done++;
        else left.push(pending[k]);
      });
      pending = left;
      void maxFee;
    }
    process.stdout.write(`\r  ${label}: ${done}/${items.length}   `);
  }
  process.stdout.write('\n');
  return done;
}

// ===========================================================================
console.log('\n  VOIDS CHAINS — FULL STACK ON TESTNET\n');
console.log(`  deployer  ${account.address}`);
const balanceBefore = await parent.getBalance({ address: account.address });
// Read BEFORE any deployment: none of our events can exist below this block, so
// this is where the indexer starts sweeping.
const firstBlock = await parent.getBlockNumber();
console.log(`  balance   ${formatEther(balanceBefore)} ETH\n`);

// ---------------------------------------------------------------------------
console.log('  [1/7] token, oracle and deed');

const token = await deploy('VoidTestToken', []);
const oracle = await deploy('VoidTestOracle', [account.address, VOID_PER_ETH, VOID_USD]);
const deed = await deploy('VoidChainDeed', [
  CHAIN_ID_BASE, account.address, account.address, 500n,
]);

// ---------------------------------------------------------------------------
console.log('\n  [2/7] treasury, runtime and paymaster');

const treasury = await deploy('VoidChainTreasury', [
  deed, token, account.address, account.address,
]);
const runtime = await deploy('VoidChainAppRuntime', [deed, token, treasury]);
const paymaster = await deploy('VoidPaymaster', [
  token, runtime, account.address, account.address, oracle,
]);

const rtAbi = artifact('VoidChainAppRuntime').abi;
const pmAbi = artifact('VoidPaymaster').abi;

await send(runtime, rtAbi, 'setOracle', [oracle]);
await send(runtime, rtAbi, 'setForwarderOnce', [paymaster]);
await send(treasury, artifact('VoidChainTreasury').abi, 'setAuthorizedSettler', [runtime, true]);
await send(paymaster, pmAbi, 'setMargin', [1_000n]);
await send(paymaster, pmAbi, 'setLimits', [
  parseEther('0.001'), 60_000n, await ceiling(), parseEther('0.01'),
]);
console.log('  ✓ wired: oracle, forwarder frozen, settler, 10% margin');

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
console.log(`\n  [3/7] minting the ${NFTS} deeds`);

const deedAbi = artifact('VoidChainDeed').abi;
const mintBatches: bigint[][] = [];
for (let start = 1; start <= NFTS; start += 50) {
  const ids: bigint[] = [];
  for (let i = start; i < start + 50 && i <= NFTS; i++) ids.push(BigInt(i));
  mintBatches.push(ids);
}
await bulk(mintBatches, (ids, nonce) =>
  wallet.writeContract({
    address: deed, abi: deedAbi, functionName: 'mintBatch',
    args: [account.address, ids], account, chain: null, nonce,
    maxFeePerGas: 30_000_000n, maxPriorityFeePerGas: 0n,
  }), 'minting');

// ---------------------------------------------------------------------------
console.log(`\n  [4/7] switching on the ${NFTS} chains (toll $0.001)`);

const everyId: number[] = [];
for (let i = 1; i <= NFTS; i++) everyId.push(i);
await bulk(everyId, (id, nonce) =>
  wallet.writeContract({
    address: runtime, abi: rtAbi, functionName: 'activate',
    args: [BigInt(id), TOLL_USD], account, chain: null, nonce,
    maxFeePerGas: 30_000_000n, maxPriorityFeePerGas: 0n,
  }), 'activating');

// ---------------------------------------------------------------------------
console.log('\n  [5/7] the pool');

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
console.log(`\n  [6/7] filling the pool's stock with ${SEED_INTO_POOL} deeds`);

const ammAbi = artifact('VoidNftAmm').abi;
// The first ones stay with the treasury; the following go to the pool.
const forPool: number[] = [];
for (let i = TREASURY_KEEP + 1; i <= TREASURY_KEEP + SEED_INTO_POOL; i++) forPool.push(i);

await bulk(forPool, (id, nonce) =>
  wallet.writeContract({
    address: amm, abi: ammAbi, functionName: 'sell',
    args: [BigInt(id), 0n], account, chain: null, nonce,
    maxFeePerGas: 30_000_000n, maxPriorityFeePerGas: 0n,
  }), 'depositing');

// ---------------------------------------------------------------------------
console.log("\n  [7/7] a demo application on the pool's first 10");

const demoApps: Record<string, Address> = {};
for (let i = 0; i < 10; i++) {
  const id = BigInt(TREASURY_KEEP + 1 + i);
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
  production: { VoidChainDeed: deed, VoidChainTreasury: treasury, VoidChainAppRuntime: runtime, VoidPaymaster: paymaster },
  testnet: { VoidTestToken: token, VoidTestOracle: oracle, VoidNftAmm: amm },
  parameters: {
    nfts: NFTS,
    tokensPerNFT: TOKENS_PER_NFT.toString(),
    randomFeeBps: Number(RANDOM_FEE_BPS),
    specificFeeBps: Number(SPECIFIC_FEE_BPS),
    tollUsd: TOLL_USD.toString(),
    voidUsd: VOID_USD.toString(),
    voidPerEth: VOID_PER_ETH.toString(),
    treasuryKeeps: TREASURY_KEEP,
    inPool: SEED_INTO_POOL,
  },
  demoApps,
  chainIdBase: CHAIN_ID_BASE.toString(),
};

const json = JSON.stringify(output, null, 2);
writeFileSync(resolve(DEPLOYMENTS, 'testnet.json'), json);
writeFileSync(WEB_DEPLOYMENT, json);

console.log('\n  ─────────────────────────────────────────────');
console.log(`  spent: ${formatEther(balanceBefore - balanceAfter)} ETH`);
console.log(`  left:  ${formatEther(balanceAfter)} ETH`);
console.log(`\n  → ${resolve(DEPLOYMENTS, 'testnet.json')}`);
console.log(`  → ${WEB_DEPLOYMENT}\n`);
