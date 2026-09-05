/**
 * Resumable V11 cutover from the currently published V10 state.
 *
 * Phase 1 deploys the canonical core and imports the exact token/Deed/runtime
 * ledger. VoidDEX is then deployed from its own repository against this staged
 * core. Phase 2 reads that DEX manifest, excludes all immutable reserves from
 * governance, creates the 1,111 DAOs, and freezes protocol governance behind
 * the 48-hour timelock. This script never edits the public web manifest.
 */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPublicClient, createWalletClient, decodeEventLog, encodeDeployData,
  encodeFunctionData, fallback, getAddress, http, keccak256, parseEther, toHex,
  type Abi, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const snapshotPath = resolve(process.env.V11_SNAPSHOT_FILE ?? 'deployments/testnet-v11-inventory.json');
if (!existsSync(snapshotPath)) throw Error(`Missing V11 snapshot: ${snapshotPath}`);
const snapshotText = readFileSync(snapshotPath, 'utf8');
const snapshot = JSON.parse(snapshotText);
const previous = JSON.parse(readFileSync('../web/lib/deployment.json', 'utf8'));
const previousRecord = JSON.parse(readFileSync('deployments/testnet-v10-pending.json', 'utf8'));
const recordPath = process.env.V11_RECORD_FILE ?? 'deployments/testnet-v11-pending.json';
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw Error('Missing testnet deployment key');
const account = privateKeyToAccount(key as Hex);
const rpcUrls = [process.env.PARENT_RPC, previous.network.rpc, 'https://rpc.testnet.chain.robinhood.com'].filter(Boolean) as string[];
const transport = fallback(rpcUrls.map((url) => http(url)));
const rpc = createPublicClient({ transport });
const wallet = createWalletClient({ account, transport });
if (await rpc.getChainId() !== 46_630) throw Error('Robinhood testnet only');
if (snapshot.source.version !== previous.version || snapshot.source.production.VoidChainAppRuntime.toLowerCase() !== previous.production.VoidChainAppRuntime.toLowerCase()) {
  throw Error('Snapshot is not from the currently published release');
}

const snapshotHash = keccak256(toHex(snapshotText));
const record: any = existsSync(recordPath)
  ? JSON.parse(readFileSync(recordPath, 'utf8'))
  : {
      version: 'v11-canonical-chainapp-testnet-staged', snapshotPath, snapshotHash,
      snapshotBlock: snapshot.blockNumber, snapshotBlockHash: snapshot.blockHash,
      network: { chainId: 46_630, rpc: previous.network.rpc, deployBlock: Number(await rpc.getBlockNumber()) },
      contracts: {}, steps: {}, governor: account.address,
    };
if (record.snapshotHash !== snapshotHash || record.governor.toLowerCase() !== account.address.toLowerCase()) {
  throw Error('V11 snapshot or deployer changed after staging began');
}
const save = () => writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);

function artifact(name: string) {
  const value = JSON.parse(readFileSync(`../out/${name}.sol/${name}.json`, 'utf8'));
  const raw = value.bytecode.object as string;
  return { abi: value.abi as Abi, bytecode: (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex };
}
async function receipt(hash: Hex) {
  const value = await rpc.waitForTransactionReceipt({ hash });
  if (value.status !== 'success') throw Error(`Transaction reverted: ${hash}`);
  return value;
}
async function gasPrice() { return (await rpc.getGasPrice()) * 3n; }
async function requireBalance(value = 0n) {
  const balance = await rpc.getBalance({ address: account.address });
  if (balance < value + parseEther('0.0001')) {
    throw Error(`Insufficient deployment ETH: ${balance}; need at least ${value + parseEther('0.0001')}`);
  }
}
async function deploy(label: string, name: string, args: readonly unknown[]) {
  if (record.contracts[label]) return getAddress(record.contracts[label]) as Address;
  await requireBalance();
  const built = artifact(name);
  if (!record.steps[`deploy:${label}`]) {
    record.steps[`deploy:${label}`] = await wallet.sendTransaction({
      account, chain: null, data: encodeDeployData({ ...built, args }),
      maxFeePerGas: await gasPrice(), maxPriorityFeePerGas: 0n,
    });
    save();
  }
  const deployed = await receipt(record.steps[`deploy:${label}`]);
  if (!deployed.contractAddress) throw Error(`Missing deployed address for ${label}`);
  record.contracts[label] = deployed.contractAddress;
  save();
  console.log(`${label}: ${deployed.contractAddress}`);
  return deployed.contractAddress as Address;
}
async function send(label: string, to: Address, contract: string, functionName: string, args: readonly unknown[] = [], value = 0n) {
  if (record.steps[label]) return receipt(record.steps[label]);
  await requireBalance(value);
  const hash = await wallet.sendTransaction({
    account, chain: null, to, value,
    data: encodeFunctionData({ abi: artifact(contract).abi, functionName, args }),
    maxFeePerGas: await gasPrice(), maxPriorityFeePerGas: 0n,
  });
  record.steps[label] = hash;
  save();
  return receipt(hash);
}
async function sendValue(label: string, to: Address, value: bigint) {
  if (record.steps[label]) return receipt(record.steps[label]);
  await requireBalance(value);
  const hash = await wallet.sendTransaction({
    account, chain: null, to, value,
    maxFeePerGas: await gasPrice(), maxPriorityFeePerGas: 0n,
  });
  record.steps[label] = hash;
  save();
  return receipt(hash);
}

const treasuryRecipient = getAddress(previous.governance.protocolTreasury) as Address;
const timelock = await deploy('protocolTimelock', 'VoidProtocolTimelock', [account.address, 2n * 86_400n]);
const escrow = await deploy('escrow', 'VoidGenesisEscrowV11', [account.address]);
const token = await deploy('token', 'VoidTokenV11', [escrow, account.address]);
const deed = await deploy('deed', 'VoidChainDeed', [46_630_000n, account.address, treasuryRecipient, 500n]);
const builder = await deploy('builderVault', 'VoidTimelockVaultV6', [timelock, 86_400]);
const emission = await deploy('emissionVault', 'VoidEmissionVaultV11', [timelock, 172_800, 30 * 86_400, parseEther('1000000')]);
const lpLock = await deploy('lpLock', 'VoidPermanentLpLockV6', []);
const pool = await deploy('ethPool', 'VoidEthPoolV6', [token, account.address, lpLock]);
const feed = await deploy('ethUsdFeed', 'VoidFixedEthUsdFeedV6', [240_000_000_000n]);
const twap = await deploy('twap', 'VoidTwapOracleV6', [pool, feed, 300, 3_600]);
const oracle = await deploy('oracle', 'VoidTwapFreshnessGuardV6', [twap, 900]);
const treasury = await deploy('treasury', 'VoidChainTreasury', [deed, token, treasuryRecipient, account.address]);

const importedChains = snapshot.deeds.map((item: any) => ({
  tokenId: BigInt(item.id), active: Boolean(item.runtimeState[0]), feePerCallUsd: BigInt(item.runtimeState[1]),
  permissionlessDeploy: Boolean(item.runtimeState[2]), pending: BigInt(item.runtimeState[3]),
  pendingOwner: item.runtimeState[4], lifetimeRevenue: BigInt(item.runtimeState[5]), callCount: BigInt(item.runtimeState[6]),
}));
const runtime = await deploy('runtime', 'VoidChainAppRuntimeV11', [
  deed, token, treasury, importedChains, BigInt(snapshot.runtimeAccounting.protocolAccrued),
]);
const paymaster = await deploy('paymaster', 'VoidPaymaster', [token, runtime, account.address, treasuryRecipient, oracle]);
const appFactory = await deploy('appFactory', 'VoidChainAppFactoryV3', [runtime]);
const l3Registry = await deploy('l3Registry', 'VoidL3MigrationRegistry', [deed]);
const claimer = await deploy('revenueClaimer', 'VoidRevenueClaimerV11', [runtime, treasury, deed]);

await send('runtime:oracle', runtime, 'VoidChainAppRuntimeV11', 'setOracle', [oracle]);
await send('runtime:forwarder', runtime, 'VoidChainAppRuntimeV11', 'setForwarderOnce', [paymaster]);
await send('runtime:appFactory', runtime, 'VoidChainAppRuntimeV11', 'setAppFactoryOnce', [appFactory]);
await send('runtime:emergency', runtime, 'VoidChainAppRuntimeV11', 'setEmergencyRolesOnce', [account.address, timelock]);
await send('token:operators', token, 'VoidTokenV11', 'freezeProtocolOperators', [runtime, paymaster]);
await send('treasury:settler', treasury, 'VoidChainTreasury', 'setAuthorizedSettler', [runtime, true]);
await send('paymaster:pool', paymaster, 'VoidPaymaster', 'setVoidEthPoolOnce', [pool]);
await send('paymaster:limits', paymaster, 'VoidPaymaster', 'setLimits', [parseEther('0.00002'), 60_000n, (await rpc.getGasPrice()) * 3n, parseEther('0.0001')]);
// Leave enough per-chain runway for a legitimate deployment burst while the
// contract still clamps every chain to at most one quarter of the live reserve.
await send('paymaster:daily', paymaster, 'VoidPaymaster', 'setDailyChainEthLimit', [parseEther('0.0002')]);
await send('paymaster:refill', paymaster, 'VoidPaymaster', 'setRefillPolicy', [parseEther('0.00005'), parseEther('0.0002'), 500n]);

for (const item of snapshot.deeds) {
  const id = BigInt(item.id);
  await send(`deed:mint:${id}`, deed, 'VoidChainDeed', 'mint', [account.address, id]);
  if (item.identity.name) await send(`deed:name:${id}`, deed, 'VoidChainDeed', 'rename', [id, item.identity.name]);
  const socials = item.identity.socials ?? [];
  if (item.identity.description || item.identity.imageURI || item.identity.externalURL || socials.length) {
    await send(`deed:identity:${id}`, deed, 'VoidChainDeed', 'setIdentity', [
      id, item.identity.description ?? '', item.identity.imageURI ?? '', item.identity.externalURL ?? '', socials,
    ]);
  }
}

const nftImplementation = await deploy('nftImplementation', 'VoidGenesisNftAmmV6', [runtime, 1n, token, deed, escrow, treasuryRecipient]);
const stakingImplementation = await deploy('stakingImplementation', 'VoidSoftStakingV9', [runtime, 1n, token, deed, treasuryRecipient]);
const stakingReceipt = await send('apps:staking', appFactory, 'VoidChainAppFactoryV3', 'publish', [
  1n, stakingImplementation, '0x', keccak256(toHex('void-v11-soft-staking')),
]);
if (!record.contracts.softStaking) {
  const log = stakingReceipt.logs.find((entry) => entry.address.toLowerCase() === appFactory.toLowerCase());
  if (!log) throw Error('Staking publication event missing');
  const event = decodeEventLog({ abi: artifact('VoidChainAppFactoryV3').abi, data: log.data, topics: log.topics });
  record.contracts.softStaking = (event.args as unknown as { app: Address }).app;
  save();
}
const staking = getAddress(record.contracts.softStaking) as Address;
const initRewards = encodeFunctionData({ abi: artifact('VoidGenesisNftAmmV6').abi, functionName: 'initializeStakerRewards', args: [staking] });
const nftReceipt = await send('apps:nftAmm', appFactory, 'VoidChainAppFactoryV3', 'publish', [
  1n, nftImplementation, initRewards, keccak256(toHex('void-v11-nft-amm')),
]);
if (!record.contracts.nftAmm) {
  const log = nftReceipt.logs.find((entry) => entry.address.toLowerCase() === appFactory.toLowerCase());
  if (!log) throw Error('NFT AMM publication event missing');
  const event = decodeEventLog({ abi: artifact('VoidChainAppFactoryV3').abi, data: log.data, topics: log.topics });
  record.contracts.nftAmm = (event.args as unknown as { app: Address }).app;
  save();
}
const nftAmm = getAddress(record.contracts.nftAmm) as Address;
const oldNftAmm = getAddress(previous.testnet.VoidGenesisNftAmmV6);
const holders: Address[] = [];
const migratedNftIds: bigint[] = [];
for (const item of snapshot.deeds) {
  const id = BigInt(item.id);
  const oldOwner = getAddress(item.owner);
  const owner = oldOwner === oldNftAmm ? nftAmm : oldOwner;
  holders.push(owner);
  if (oldOwner === oldNftAmm) migratedNftIds.push(id);
  if (owner.toLowerCase() !== account.address.toLowerCase()) {
    await send(`deed:owner:${id}`, deed, 'VoidChainDeed', 'transferFrom', [account.address, owner, id]);
  }
}

const migrationVoidLiquidity = BigInt(snapshot.liquidityState.reserveVoid);
const migrationEthLiquidity = BigInt(snapshot.liquidityState.reserveEth);
const mint = await deploy('mint', 'VoidEthGenesisMintV11', [
  deed, escrow, pool, paymaster, treasuryRecipient, parseEther('0.001'), holders,
  migrationVoidLiquidity, migrationEthLiquidity,
]);
await send('pool:controller', pool, 'VoidEthPoolV6', 'setGenesisControllerOnce', [mint]);

const old = previousRecord.contracts as Record<string, string>;
const skip = new Set([old.escrow, old.builder, old.protocol].map((value) => value.toLowerCase()));
const remap = new Map<string, Address>([
  [old.pool.toLowerCase(), pool], [old.nftAmm.toLowerCase(), nftAmm],
  [old.runtime.toLowerCase(), runtime], [old.paymaster.toLowerCase(), paymaster],
  // Retired and current test DEX gateways cannot move storage to a new Runtime.
  // Their LP owner is the project test wallet; VoidDEX re-seeds the canonical
  // V11 pools from this exact consolidated balance in its own repository.
  ['0xd740641198d1c460436d6bef7f036bbf38d81bc3', account.address],
  ['0xfa80e65c3d7815a713807593574a7fdee73fb11f', account.address],
  ['0x57bb44d355dade1de9f8307314ffa1b2388f8a38', account.address],
  ['0xad3618dc4be9e06162e7bd479af5ad546850c926', account.address],
  ['0xdff0280d443a96ff10f1f54dd8088fa21e558110', account.address],
  ['0x403f9ea758b7642f31eb9c34585e39afdc62cb56', account.address],
]);
const consolidated = new Map<string, { address: Address; amount: bigint }>();
for (const entry of snapshot.holders) {
  const source = getAddress(entry.address);
  if (skip.has(source.toLowerCase())) continue;
  const recipient = remap.get(source.toLowerCase()) ?? source;
  const key = recipient.toLowerCase();
  const current = consolidated.get(key);
  consolidated.set(key, { address: recipient, amount: (current?.amount ?? 0n) + BigInt(entry.balance) });
}
const recipients = [...consolidated.values()].map((entry) => entry.address);
const amounts = [...consolidated.values()].map((entry) => entry.amount);
const distributed = amounts.reduce((sum, amount) => sum + amount, 0n);
const nftAlreadyReleased = BigInt(migratedNftIds.length) * parseEther('500000');
const lpAlreadyReleased = distributed - nftAlreadyReleased;
await send('escrow:configure', escrow, 'VoidGenesisEscrowV11', 'configureMigrationOnce', [{
  token, launch: mint, liquidityPool: pool, builderVault: builder, protocolVault: emission,
  lpAlreadyReleased, nftAlreadyReleased,
}, recipients, amounts, migratedNftIds]);
await send('escrow:nftAmm', escrow, 'VoidGenesisEscrowV11', 'setNftAmmOnce', [nftAmm]);
await send('deed:minter', deed, 'VoidChainDeed', 'transferMinter', [mint]);
await send('mint:fundMigration', mint, 'VoidEthGenesisMintV11', 'fundMigration', [], migrationEthLiquidity);
await sendValue('paymaster:fundEth', paymaster, BigInt(snapshot.custody.find((item: any) => item.address.toLowerCase() === old.paymaster.toLowerCase()).eth));
await send('paymaster:importAccounting', paymaster, 'VoidPaymaster', 'initializeMigrationAccounting', [
  BigInt(snapshot.paymasterAccounting.reimbursableVoid), BigInt(snapshot.paymasterAccounting.surplusVoid),
]);
await send('paymaster:sweepLegacyExcess', paymaster, 'VoidPaymaster', 'sweepUnaccounted', [emission]);
await send('twap:bootstrap', twap, 'VoidTwapOracleV6', 'bootstrap');

const dexPath = resolve(process.env.V11_DEX_CONFIG_FILE ?? '../../VoidDEX/lib/deployment.json');
let dex: any;
if (existsSync(dexPath)) {
  const candidate = JSON.parse(readFileSync(dexPath, 'utf8'));
  if (candidate.version === record.version && candidate.runtime.toLowerCase() === runtime.toLowerCase()) dex = candidate;
}
if (!dex) {
  record.status = 'awaiting-v11-dex';
  record.migration = { distributed: distributed.toString(), lpAlreadyReleased: lpAlreadyReleased.toString(), nftAlreadyReleased: nftAlreadyReleased.toString(), holders };
  save();
  console.log('V11 core staged. Deploy VoidDEX from its separate repository, then rerun this script.');
  process.exit(0);
}

const excluded = [escrow, builder, emission, pool, nftAmm, ...dex.pools.map((item: any) => getAddress(item.address))];
const governanceVotes = await deploy('governanceVotes', 'VoidGovernanceVotesV11', [token, excluded]);
const daoFactory = await deploy('daoFactory', 'VoidChainDaoFactory', [runtime, governanceVotes, deed]);
await send('runtime:daoFactory', runtime, 'VoidChainAppRuntimeV11', 'setDaoFactoryOnce', [daoFactory]);
for (let start = 1; start <= 1111; start += 20) {
  const end = Math.min(start + 19, 1111);
  await send(`daos:${start}`, daoFactory, 'VoidChainDaoFactory', 'createMany', [BigInt(start), BigInt(end)]);
  console.log(`DAOs ${end}/1111`);
}

await send('treasury:timelock', treasury, 'VoidChainTreasury', 'transferGovernance', [timelock]);
await send('paymaster:timelock', paymaster, 'VoidPaymaster', 'transferGovernor', [timelock]);
record.status = 'awaiting-v11-acceptance';
record.dex = dex;
record.migration = { distributed: distributed.toString(), lpAlreadyReleased: lpAlreadyReleased.toString(), nftAlreadyReleased: nftAlreadyReleased.toString(), holders };
record.governance = { proposer: account.address, timelock, delaySeconds: 172_800, guardian: account.address, recovery: timelock };
save();
console.log('V11 staged. Public manifests remain unchanged until verification and live acceptance pass.');
