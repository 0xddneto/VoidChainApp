/**
 * Deploys the test-only DEX fixture inside active VOID Chain #1.
 *
 * The factory and every pool are real parent-chain contracts, but their only
 * usable entrypoints are reached through VoidChainAppRuntime with tokenId 1.
 * This script deliberately creates clearly named test assets; it never labels
 * them as Robinhood-issued assets or substitutes look-alike addresses.
 *
 * Requires DEPLOYER_PRIVATE_KEY in script/.env. It never prints that key.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  encodeFunctionData,
  http,
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const deployment = JSON.parse(readFileSync(resolve(root, 'web/lib/deployment.json'), 'utf8'));
const rpcUrl = process.env.PARENT_RPC ?? deployment.network.rpc;
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? '')) {
  throw new Error('DEPLOYER_PRIVATE_KEY is required in script/.env.');
}

const CHAIN = 1n;
const EXPECTED_CHAIN_ID = 46_630;
const account = privateKeyToAccount(privateKey as Hex);
const rpc = createPublicClient({ transport: http(rpcUrl) });
const wallet = createWalletClient({ account, transport: http(rpcUrl) });

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const source = name === 'VoidChainDexFactory' ? 'VoidChainDexFactory.sol' : `${name}.sol`;
  const raw = JSON.parse(readFileSync(resolve(root, `out/${source}/${name}.json`), 'utf8'));
  const object = raw.bytecode.object as string;
  return { abi: raw.abi as Abi, bytecode: (object.startsWith('0x') ? object : `0x${object}`) as Hex };
}

const runtime = deployment.production.VoidChainAppRuntime as Address;
const deed = deployment.production.VoidChainDeed as Address;
const voidToken = deployment.testnet.VoidTestToken as Address;
const runtimeAbi = artifact('VoidChainAppRuntime').abi;
const deedAbi = artifact('VoidChainDeed').abi;
const voidAbi = artifact('VoidTestToken').abi;
const factoryArtifact = artifact('VoidChainDexFactory');
const tokenArtifact = artifact('TestToken');
const pairAbi = artifact('ChainAppSwap').abi;

const liquidity = parseEther('200000');
const initialSupply = parseEther('5000000');

async function gasCeiling() {
  return (await rpc.getGasPrice()) * 3n;
}

async function send(to: Address, abi: Abi, functionName: string, args: readonly unknown[]) {
  const hash = await wallet.writeContract({
    account,
    chain: null,
    address: to,
    abi,
    functionName,
    args,
    maxFeePerGas: await gasCeiling(),
    maxPriorityFeePerGas: 0n,
  });
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
  return receipt;
}

async function deploy(name: string, args: readonly unknown[], art: { abi: Abi; bytecode: Hex }) {
  const hash = await wallet.sendTransaction({
    account,
    chain: null,
    data: encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args }),
    maxFeePerGas: await gasCeiling(),
    maxPriorityFeePerGas: 0n,
  });
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`${name} deployment failed: ${hash}`);
  console.log(`  ${name}: ${receipt.contractAddress}`);
  return receipt.contractAddress;
}

function spendAuth(tokens: Address[], limits: bigint[]) {
  return { tokens, limits, collections: [] as Address[], nftIds: [] as bigint[] };
}

async function createPool(factory: Address, asset: Address, fee: bigint) {
  const data = encodeFunctionData({ abi: factoryArtifact.abi, functionName: 'createPool', args: [voidToken, asset] });
  await send(runtime, runtimeAbi, 'execute', [CHAIN, factory, data, fee]);
  const pool = await rpc.readContract({
    address: factory,
    abi: factoryArtifact.abi,
    functionName: 'poolFor',
    args: [voidToken, asset],
  }) as Address;
  if (!pool || /^0x0{40}$/i.test(pool)) throw new Error('Factory did not record the new pool.');
  return pool;
}

async function seedPool(pool: Address, fee: bigint) {
  const [token0, token1] = await Promise.all([
    rpc.readContract({ address: pool, abi: pairAbi, functionName: 'token0' }) as Promise<Address>,
    rpc.readContract({ address: pool, abi: pairAbi, functionName: 'token1' }) as Promise<Address>,
  ]);
  const minimumShares = liquidity - 1_000n;
  const data = encodeFunctionData({
    abi: pairAbi,
    functionName: 'addLiquidity',
    args: [liquidity, liquidity, minimumShares],
  });
  await send(runtime, runtimeAbi, 'executeWithBudget', [
    CHAIN,
    pool,
    data,
    fee,
    spendAuth([token0, token1], [liquidity, liquidity]),
  ]);
  return { token0, token1 };
}

console.log('\nVOID CHAIN #1 — DEX TESTNET DEPLOYMENT\n');
if (await rpc.getChainId() !== EXPECTED_CHAIN_ID) {
  throw new Error(`Refusing to deploy outside Robinhood testnet ${EXPECTED_CHAIN_ID}.`);
}

const [owner, stats, configured] = await Promise.all([
  rpc.readContract({ address: deed, abi: deedAbi, functionName: 'ownerOf', args: [CHAIN] }) as Promise<Address>,
  rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'statsOf', args: [CHAIN] }) as Promise<readonly [boolean, bigint, bigint, bigint, bigint]>,
  rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'configured', args: [CHAIN] }) as Promise<boolean>,
]);
if (!configured || !stats[0]) throw new Error('VOID Chain #1 must be active before publishing its DEX.');
console.log(`  deed owner: ${owner}`);

const fee = await rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'feeOf', args: [CHAIN] }) as bigint;
if (fee === 0n) throw new Error('A positive chain fee is required for this revenue test.');

console.log('\n[1/5] Deploying clearly marked test assets');
const testUsd = await deploy('TEST-USD', ['Void Test Dollar', 'tUSD', initialSupply], tokenArtifact);
const testLink = await deploy('TEST-LINK', ['Void Test Link', 'tLINK', initialSupply], tokenArtifact);

console.log('\n[2/5] Deploying and publishing the DEX factory');
const factory = await deploy('DEX factory', [runtime, CHAIN], factoryArtifact);
await send(runtime, runtimeAbi, 'registerApp', [CHAIN, factory]);

console.log('\n[3/5] Funding the test liquidity provider and creating pools');
await send(voidToken, voidAbi, 'mintTo', [account.address, liquidity * 3n]);
for (const token of [voidToken, testUsd, testLink]) {
  await send(token, token === voidToken ? voidAbi : tokenArtifact.abi, 'approve', [runtime, 2n ** 256n - 1n]);
}
const poolUsd = await createPool(factory, testUsd, fee);
const poolLink = await createPool(factory, testLink, fee);

console.log('\n[4/5] Adding initial liquidity through VOID Chain #1');
const usdPair = await seedPool(poolUsd, fee);
const linkPair = await seedPool(poolLink, fee);

console.log('\n[5/5] Writing the public DEX configuration');
const config = {
  chainTokenId: Number(CHAIN),
  runtime,
  factory,
  baseToken: voidToken,
  pools: [
    { address: poolUsd, label: 'VOID / tUSD', asset: testUsd, token0: usdPair.token0, token1: usdPair.token1 },
    { address: poolLink, label: 'VOID / tLINK', asset: testLink, token0: linkPair.token0, token1: linkPair.token1 },
  ],
};
writeFileSync(resolve(root, 'web/lib/dex-chain1.json'), `${JSON.stringify(config, null, 2)}\n`);

console.log('\n✓ DEX deployed and registered on VOID Chain #1.');
console.log(`  factory: ${factory}`);
console.log(`  pools:   ${poolUsd}, ${poolLink}`);
