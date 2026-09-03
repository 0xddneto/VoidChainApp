/**
 * VOID V5 genesis on Robinhood Chain testnet.
 *
 * V5 is intentionally a new collection. It does not rewrite, burn or take
 * custody of the prior Deeds. The first purchase is a standard ETH mint; only
 * after that genesis exception do app and marketplace actions use sponsored
 * VOID signatures.
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, encodeDeployData, getAddress, http,
  parseEther, type Abi, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = resolve(root, 'out');
const staged = resolve(here, 'deployments/testnet-v5-pending.json');
// This candidate used an unreviewed 1,000,000 VOID-per-Deed assumption. It
// remains deployed only as an isolated testnet record and must never be
// promoted or redeployed. A new launch model is being designed from the Anvil
// reserve/bucket mechanics before a fresh contract suite is written.
if (process.env.ALLOW_REJECTED_V5_CANDIDATE !== 'true') {
  throw new Error('The V5 candidate is rejected for promotion. Use the reviewed successor launch script.');
}
if (existsSync(staged) && process.env.ALLOW_REPLACE_STAGED_V5 !== 'true') {
  throw new Error('V5 is already staged. Refusing to replace a public genesis candidate.');
}

const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) {
  throw new Error('DEPLOYER_PRIVATE_KEY must be present in script/.env.');
}
const account = privateKeyToAccount(key as Hex);
const rpcUrl = process.env.PARENT_RPC ?? 'https://robinhood-testnet.drpc.org';
const rpc = createPublicClient({ transport: http(rpcUrl) });
const wallet = createWalletClient({ account, transport: http(rpcUrl) });

const CHAIN_ID = 46_630;
const CHAIN_ID_BASE = 46_630_000n;
const PROTOCOL_TREASURY = getAddress(process.env.PROTOCOL_TREASURY ?? '0x892F840aF9CFE78D4FF91D8e6D0F783264388A78');
const COMMUNITY_VAULT = getAddress(process.env.GENESIS_COMMUNITY_VAULT ?? '0xA7a12A1D7000e40Ecc18a62Af456791b89cB2770');
const MINT_PRICE = parseEther(process.env.GENESIS_MINT_PRICE_ETH ?? '0.001');
const VOID_PER_ETH = parseEther(process.env.GENESIS_VOID_PER_ETH ?? '1000000000');
const VOID_USD = parseEther(process.env.GENESIS_VOID_USD ?? '0.000002411');
const DAO_BATCH = 20;

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const raw = JSON.parse(readFileSync(resolve(out, `${name}.sol/${name}.json`), 'utf8'));
  const code = raw.bytecode.object as string;
  return { abi: raw.abi as Abi, bytecode: (code.startsWith('0x') ? code : `0x${code}`) as Hex };
}
async function gas() { return (await rpc.getGasPrice()) * 3n; }
async function wait(hash: Hex) {
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);
  return receipt;
}
async function deploy(name: string, args: readonly unknown[]): Promise<Address> {
  const item = artifact(name);
  const receipt = await wait(await wallet.sendTransaction({
    account, chain: null, data: encodeDeployData({ abi: item.abi, bytecode: item.bytecode, args }),
    maxFeePerGas: await gas(), maxPriorityFeePerGas: 0n,
  }));
  if (!receipt.contractAddress) throw new Error(`${name} deployed without a contract address.`);
  console.log(`  ✓ ${name.padEnd(26)} ${receipt.contractAddress}`);
  return receipt.contractAddress;
}
async function send(address: Address, abi: Abi, functionName: string, args: readonly unknown[]) {
  return wait(await wallet.writeContract({
    account, chain: null, address, abi, functionName, args,
    maxFeePerGas: await gas(), maxPriorityFeePerGas: 0n,
  } as never));
}

if (await rpc.getChainId() !== CHAIN_ID) throw new Error(`Refusing outside Robinhood testnet ${CHAIN_ID}.`);
if (MINT_PRICE === 0n) throw new Error('GENESIS_MINT_PRICE_ETH must be greater than zero.');

console.log('\nVOID CHAINS — V5 ETH GENESIS (TESTNET)\n');
console.log(`  deployer:          ${account.address}`);
console.log(`  mint price:        ${process.env.GENESIS_MINT_PRICE_ETH ?? '0.001'} ETH`);
console.log(`  fixed VOID supply: 1,111,000,000 VOID\n`);

console.log('[1/7] Deploying immutable token buckets and Deed');
const liquidityVault = await deploy('VoidLiquidityVault', [account.address]);
const distribution = await deploy('VoidGenesisDistribution', [
  liquidityVault, PROTOCOL_TREASURY, account.address, COMMUNITY_VAULT, account.address,
]);
const token = await deploy('VoidToken', [distribution]);
const oracle = await deploy('VoidTestOracle', [account.address, VOID_PER_ETH, VOID_USD]);
const deed = await deploy('VoidChainDeed', [CHAIN_ID_BASE, account.address, PROTOCOL_TREASURY, 500n]);

console.log('\n[2/7] Deploying V4 VOID-only execution');
const treasury = await deploy('VoidChainTreasury', [deed, token, PROTOCOL_TREASURY, account.address]);
const runtime = await deploy('VoidChainAppRuntimeV4', [deed, token, treasury]);
const paymaster = await deploy('VoidPaymaster', [token, runtime, account.address, PROTOCOL_TREASURY, oracle]);
const daoFactory = await deploy('VoidChainDaoFactory', [runtime, token, deed]);
const appFactory = await deploy('VoidChainAppFactoryV3', [runtime]);

console.log('\n[3/7] Freezing the execution boundary');
const runtimeAbi = artifact('VoidChainAppRuntimeV4').abi;
await send(runtime, runtimeAbi, 'setOracle', [oracle]);
await send(runtime, runtimeAbi, 'setForwarderOnce', [paymaster]);
await send(runtime, runtimeAbi, 'setDaoFactoryOnce', [daoFactory]);
await send(runtime, runtimeAbi, 'setAppFactoryOnce', [appFactory]);
await send(treasury, artifact('VoidChainTreasury').abi, 'setAuthorizedSettler', [runtime, true]);
await send(paymaster, artifact('VoidPaymaster').abi, 'setMargin', [1_000n]);
await send(paymaster, artifact('VoidPaymaster').abi, 'setLimits', [
  parseEther('0.001'), 60_000n, await gas(), parseEther('0.01'),
]);

console.log('\n[4/7] Creating the 1,111 isolated chain DAOs');
const daoAbi = artifact('VoidChainDaoFactory').abi;
for (let start = 1; start <= 1111; start += DAO_BATCH) {
  const end = Math.min(start + DAO_BATCH - 1, 1111);
  await send(daoFactory, daoAbi, 'createMany', [BigInt(start), BigInt(end)]);
  process.stdout.write(`\r  DAOs: ${end}/1111`);
}
process.stdout.write('\n');

console.log('\n[5/7] Binding the fixed 1,111,000,000 VOID supply');
const tokenAbi = artifact('VoidToken').abi;
const maxSupply = await rpc.readContract({ address: token, abi: tokenAbi, functionName: 'MAX_SUPPLY' }) as bigint;
await send(distribution, artifact('VoidGenesisDistribution').abi, 'configureTokenOnce', [token, maxSupply]);
for (const recipient of [liquidityVault, PROTOCOL_TREASURY, account.address, COMMUNITY_VAULT]) {
  await send(distribution, artifact('VoidGenesisDistribution').abi, 'release', [recipient]);
}

console.log('\n[6/7] Opening the standard-ETH mint');
const mint = await deploy('VoidEthGenesisMint', [deed, paymaster, liquidityVault, PROTOCOL_TREASURY, MINT_PRICE]);
await send(deed, artifact('VoidChainDeed').abi, 'transferMinter', [mint]);

console.log('\n[7/7] Writing the staged V5 record');
const firstBlock = await rpc.getBlockNumber();
const record = {
  network: { chainId: CHAIN_ID, rpc: 'https://robinhood-testnet.drpc.org', deployBlock: Number(firstBlock) },
  version: 'v5-eth-genesis-pending-first-mint',
  production: {
    VoidChainDeed: deed, VoidChainTreasury: treasury, VoidChainAppRuntime: runtime,
    VoidPaymaster: paymaster, VoidChainDaoFactory: daoFactory, VoidChainAppFactoryV3: appFactory,
    VoidEthGenesisMint: mint,
  },
  testnet: {
    VoidToken: token, VoidTestOracle: oracle, VoidGenesisDistribution: distribution,
    VoidLiquidityVault: liquidityVault,
  },
  governance: {
    paymasterGovernor: account.address, protocolTreasury: PROTOCOL_TREASURY,
    communityVault: COMMUNITY_VAULT,
  },
  parameters: {
    nfts: 1111, mintPriceWei: MINT_PRICE.toString(), voidSupply: maxSupply.toString(),
    voidPerDeed: '1000000000000000000000000', voidPerEth: VOID_PER_ETH.toString(),
    voidUsd: VOID_USD.toString(), mintEthSplitBps: { liquidity: 4000, paymaster: 2000, protocol: 4000 },
    voidSupplySplitBps: { liquidity: 4000, ecosystem: 3000, governance: 2000, community: 1000 },
  },
  next: 'Mint one Deed with ETH, fund the Paymaster from the mint share, activate that Deed, then publish the V5 marketplace inside its chain.',
};
mkdirSync(dirname(staged), { recursive: true });
writeFileSync(staged, `${JSON.stringify(record, null, 2)}\n`);
console.log(`\n✓ V5 genesis staged: ${staged}`);
console.log('  Existing V4 addresses and Deeds are untouched.\n');
