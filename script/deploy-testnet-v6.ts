/**
 * VOID V6 reviewed genesis on Robinhood Chain testnet.
 *
 * This script deliberately writes a staged record only. It never changes the
 * VoidScan production pointer: that happens after an ETH mint, TWAP window and
 * signed VOID-app proof have all succeeded on-chain.
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
const staged = resolve(here, 'deployments/testnet-v6-pending.json');

if (existsSync(staged) && process.env.ALLOW_REPLACE_STAGED_V6 !== 'true') {
  throw new Error('V6 is already staged. Refusing to overwrite a public genesis record.');
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
const DAO_BATCH = 20;
const PROTOCOL_TREASURY = getAddress(process.env.PROTOCOL_TREASURY ?? '0x892F840aF9CFE78D4FF91D8e6D0F783264388A78');
const MINT_PRICE = parseEther(process.env.V6_GENESIS_MINT_PRICE_ETH ?? '0.001');
const ETH_USD_8 = BigInt(process.env.V6_TEST_ETH_USD_8 ?? '240000000000'); // $2,400.00
const TWAP_INTERVAL = Number(process.env.V6_TWAP_INTERVAL_SECONDS ?? '300');
const FEED_MAX_AGE = Number(process.env.V6_FEED_MAX_AGE_SECONDS ?? '3600');
const VAULT_DELAY = Number(process.env.V6_VAULT_DELAY_SECONDS ?? '86400');

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
  console.log(`  ✓ ${name.padEnd(28)} ${receipt.contractAddress}`);
  return receipt.contractAddress;
}
async function send(address: Address, abi: Abi, functionName: string, args: readonly unknown[]) {
  return wait(await wallet.writeContract({
    account, chain: null, address, abi, functionName, args,
    maxFeePerGas: await gas(), maxPriorityFeePerGas: 0n,
  } as never));
}

if (await rpc.getChainId() !== CHAIN_ID) throw new Error(`Refusing outside Robinhood testnet ${CHAIN_ID}.`);
if (MINT_PRICE === 0n || ETH_USD_8 <= 0n || TWAP_INTERVAL <= 0 || FEED_MAX_AGE < TWAP_INTERVAL || VAULT_DELAY < 0) {
  throw new Error('Invalid V6 genesis parameters.');
}

console.log('\nVOID CHAINS — V6 REVIEWED GENESIS (TESTNET)\n');
console.log(`  deployer:          ${account.address}`);
console.log(`  mint price:        ${process.env.V6_GENESIS_MINT_PRICE_ETH ?? '0.001'} ETH`);
console.log('  fixed VOID supply: 1,000,000,000 VOID');
console.log('  value per Deed:    500,000 VOID\n');

console.log('[1/7] Deploying fixed token supply, escrow and immutable vaults');
const escrow = await deploy('VoidGenesisEscrowV6', [account.address]);
const token = await deploy('VoidTokenV6', [escrow]);
const deed = await deploy('VoidChainDeed', [CHAIN_ID_BASE, account.address, PROTOCOL_TREASURY, 500n]);
const builderVault = await deploy('VoidTimelockVaultV6', [account.address, VAULT_DELAY]);
const protocolVault = await deploy('VoidTimelockVaultV6', [account.address, VAULT_DELAY]);

console.log('\n[2/7] Deploying locked VOID/ETH pool and TWAP oracle');
const lpLock = await deploy('VoidPermanentLpLockV6', []);
const pool = await deploy('VoidEthPoolV6', [token, account.address, lpLock]);
const ethUsdFeed = await deploy('VoidFixedEthUsdFeedV6', [ETH_USD_8]);
const oracle = await deploy('VoidTwapOracleV6', [pool, ethUsdFeed, TWAP_INTERVAL, FEED_MAX_AGE]);

console.log('\n[3/7] Deploying the VOID-only runtime and reserve');
const treasury = await deploy('VoidChainTreasury', [deed, token, PROTOCOL_TREASURY, account.address]);
const runtime = await deploy('VoidChainAppRuntimeV4', [deed, token, treasury]);
const paymaster = await deploy('VoidPaymaster', [token, runtime, account.address, PROTOCOL_TREASURY, oracle]);
const daoFactory = await deploy('VoidChainDaoFactory', [runtime, token, deed]);
const appFactory = await deploy('VoidChainAppFactoryV3', [runtime]);

console.log('\n[4/7] Freezing the runtime boundary and refill route');
const runtimeAbi = artifact('VoidChainAppRuntimeV4').abi;
const paymasterAbi = artifact('VoidPaymaster').abi;
await send(runtime, runtimeAbi, 'setOracle', [oracle]);
await send(runtime, runtimeAbi, 'setForwarderOnce', [paymaster]);
await send(runtime, runtimeAbi, 'setDaoFactoryOnce', [daoFactory]);
await send(runtime, runtimeAbi, 'setAppFactoryOnce', [appFactory]);
await send(treasury, artifact('VoidChainTreasury').abi, 'setAuthorizedSettler', [runtime, true]);
await send(paymaster, paymasterAbi, 'setVoidEthPoolOnce', [pool]);
await send(paymaster, paymasterAbi, 'setMargin', [500n]);
await send(paymaster, paymasterAbi, 'setLimits', [
  parseEther('0.00002'), 60_000n, await gas(), parseEther('0.005'),
]);
await send(paymaster, paymasterAbi, 'setRefillPolicy', [
  parseEther('0.0001'), parseEther('0.0005'), 500n,
]);

console.log('\n[5/7] Creating 1,111 isolated DAO instances');
const daoAbi = artifact('VoidChainDaoFactory').abi;
for (let start = 1; start <= 1111; start += DAO_BATCH) {
  const end = Math.min(start + DAO_BATCH - 1, 1111);
  await send(daoFactory, daoAbi, 'createMany', [BigInt(start), BigInt(end)]);
  process.stdout.write(`\r  DAOs: ${end}/1111`);
}
process.stdout.write('\n');

console.log('\n[6/7] Binding mint flow and collection NFT/VOID market implementation');
const mint = await deploy('VoidEthGenesisMintV6', [deed, escrow, pool, paymaster, PROTOCOL_TREASURY, MINT_PRICE]);
const nftAmmImplementation = await deploy('VoidGenesisNftAmmV6', [
  runtime, 1n, token, deed, escrow, PROTOCOL_TREASURY,
]);
await send(pool, artifact('VoidEthPoolV6').abi, 'setGenesisControllerOnce', [mint]);
await send(escrow, artifact('VoidGenesisEscrowV6').abi, 'configureOnce', [
  token, mint, pool, builderVault, protocolVault,
]);
await send(deed, artifact('VoidChainDeed').abi, 'transferMinter', [mint]);

console.log('\n[7/7] Writing staged testnet record');
const deployBlock = await rpc.getBlockNumber();
const record = {
  network: { chainId: CHAIN_ID, rpc: 'https://robinhood-testnet.drpc.org', deployBlock: Number(deployBlock) },
  version: 'v6-reviewed-eth-genesis-pending-first-mint',
  production: {
    VoidChainDeed: deed, VoidChainTreasury: treasury, VoidChainAppRuntime: runtime,
    VoidPaymaster: paymaster, VoidChainDaoFactory: daoFactory, VoidChainAppFactoryV3: appFactory,
    VoidEthGenesisMintV6: mint,
  },
  testnet: {
    VoidTokenV6: token, VoidGenesisEscrowV6: escrow, VoidEthPoolV6: pool,
    VoidPermanentLpLockV6: lpLock, VoidFixedEthUsdFeedV6: ethUsdFeed,
    VoidTwapOracleV6: oracle, VoidBuilderTimelockV6: builderVault,
    VoidProtocolTimelockV6: protocolVault, VoidGenesisNftAmmV6Implementation: nftAmmImplementation,
  },
  governance: { temporaryTestnetGovernor: account.address, protocolTreasury: PROTOCOL_TREASURY },
  parameters: {
    nfts: 1111, mintPriceWei: MINT_PRICE.toString(), voidSupply: '1000000000000000000000000000',
    voidPerDeed: '500000000000000000000000',
    bucketCaps: {
      nftAmm: '555500000000000000000000000', lockedVoidEthLp: '222200000000000000000000000',
      builder: '150000000000000000000000000', protocol: '72300000000000000000000000',
    },
    mintEthSplitBps: { lockedLp: 4000, paymasterReserve: 2000, protocolTreasury: 4000 },
    nftAmmFeesBps: { random: 100, specific: 200, protocol: 50, sell: 150 },
    voidEthPoolFeeBps: 30, twapIntervalSeconds: TWAP_INTERVAL,
    fixedTestEthUsd8: ETH_USD_8.toString(), vaultDelaySeconds: VAULT_DELAY,
  },
  activation: {
    required: 'The first V6 Deed holder activates chain #1 in VoidScan, then the app factory publishes the prepared NFT AMM gateway and the escrow pins that gateway once.',
  },
  next: 'Run the V6 first-mint/TWAP proof. Do not point VoidScan at V6 until that proof passes.',
};
mkdirSync(dirname(staged), { recursive: true });
writeFileSync(staged, `${JSON.stringify(record, null, 2)}\n`);
console.log(`\n✓ V6 genesis staged: ${staged}`);
console.log('  Existing V4 collection, Deeds and contracts are untouched.\n');
