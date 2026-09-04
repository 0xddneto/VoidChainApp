/** Resumable V10 exact-ledger ChainApp migration. It never switches public manifests itself. */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, encodeDeployData, encodeFunctionData,
  fallback, http, keccak256, parseEther, toHex,
  type Abi, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ownership = JSON.parse(readFileSync('deployments/testnet-v9-snapshot.json', 'utf8'));
const snapshot = JSON.parse(readFileSync('deployments/testnet-v10-snapshot.json', 'utf8'));
const path = 'deployments/testnet-v10-pending.json';
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw Error('Missing testnet key');
const account = privateKeyToAccount(key as Hex);
const rpcUrls = [process.env.PARENT_RPC, ownership.source.network.rpc, 'https://rpc.testnet.chain.robinhood.com'].filter(Boolean) as string[];
const transport = fallback(rpcUrls.map((url) => http(url)));
const rpc = createPublicClient({ transport });
const wallet = createWalletClient({ account, transport });
if (await rpc.getChainId() !== 46630) throw Error('Testnet only');

const record: any = existsSync(path)
  ? JSON.parse(readFileSync(path, 'utf8'))
  : {
      version: 'v10-chainapp-exact-ledger-testnet-staged',
      snapshotBlock: snapshot.block,
      network: { chainId: 46630, rpc: ownership.source.network.rpc, deployBlock: Number(await rpc.getBlockNumber()) },
      contracts: {}, steps: {}, governor: account.address,
    };
if (String(record.snapshotBlock) !== String(snapshot.block) || record.governor.toLowerCase() !== account.address.toLowerCase()) {
  throw Error('Snapshot or deployer changed');
}
function save() { writeFileSync(path, JSON.stringify(record, null, 2) + '\n'); }
function artifact(name: string) {
  const value = JSON.parse(readFileSync(`../out/${name}.sol/${name}.json`, 'utf8'));
  return { abi: value.abi as Abi, bytecode: (value.bytecode.object.startsWith('0x') ? value.bytecode.object : `0x${value.bytecode.object}`) as Hex };
}
async function wait(hash: Hex) {
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw Error(`Reverted ${hash}`);
  return receipt;
}
async function guardBalance(requiredValue = 0n) {
  if (await rpc.getBalance({ address: account.address }) < requiredValue + parseEther('0.0001')) {
    throw Error('Low deployment balance; checkpoint saved');
  }
}
async function deploy(label: string, name: string, args: readonly unknown[]) {
  if (record.contracts[label]) return record.contracts[label] as Address;
  await guardBalance();
  const built = artifact(name);
  if (!record.steps[`deploy:${label}`]) {
    const hash = await wallet.sendTransaction({
      account, chain: null, data: encodeDeployData({ ...built, args }),
      maxFeePerGas: (await rpc.getGasPrice()) * 3n, maxPriorityFeePerGas: 0n,
    });
    record.steps[`deploy:${label}`] = hash; save();
  }
  const receipt = await wait(record.steps[`deploy:${label}`]);
  if (!receipt.contractAddress) throw Error(`Missing ${label} contract`);
  record.contracts[label] = receipt.contractAddress; save();
  console.log(label, receipt.contractAddress);
  return receipt.contractAddress as Address;
}
async function send(label: string, to: Address, name: string, functionName: string, args: readonly unknown[] = [], value = 0n) {
  if (record.steps[label]) return wait(record.steps[label]);
  await guardBalance(value);
  const hash = await wallet.sendTransaction({
    account, chain: null, to, value,
    data: encodeFunctionData({ abi: artifact(name).abi, functionName, args }),
    maxFeePerGas: (await rpc.getGasPrice()) * 3n, maxPriorityFeePerGas: 0n,
  });
  record.steps[label] = hash; save();
  return wait(hash);
}
async function sendValue(label: string, to: Address, value: bigint) {
  if (record.steps[label]) return wait(record.steps[label]);
  await guardBalance(value);
  const hash = await wallet.sendTransaction({
    account, chain: null, to, value,
    maxFeePerGas: (await rpc.getGasPrice()) * 3n, maxPriorityFeePerGas: 0n,
  });
  record.steps[label] = hash; save();
  return wait(hash);
}

const recipient = ownership.source.governance.protocolTreasury as Address;
const timelock = await deploy('protocolTimelock', 'VoidProtocolTimelock', [account.address, 2n * 86400n]);
const escrow = await deploy('escrow', 'VoidGenesisEscrowV10', [account.address]);
const token = await deploy('token', 'VoidTokenV9', [escrow, account.address]);
const deed = await deploy('deed', 'VoidChainDeed', [46630000n, account.address, recipient, 500n]);
const builder = await deploy('builder', 'VoidTimelockVaultV6', [timelock, 86400]);
const protocol = await deploy('protocol', 'VoidTimelockVaultV6', [timelock, 86400]);
const lock = await deploy('lpLock', 'VoidPermanentLpLockV6', []);
const pool = await deploy('pool', 'VoidEthPoolV6', [token, account.address, lock]);
const feed = await deploy('feed', 'VoidFixedEthUsdFeedV6', [240000000000n]);
const twap = await deploy('twap', 'VoidTwapOracleV6', [pool, feed, 300, 3600]);
const oracle = await deploy('oracle', 'VoidTwapFreshnessGuardV6', [twap, 900]);
const treasury = await deploy('treasury', 'VoidChainTreasury', [deed, token, recipient, account.address]);
const importedChains = snapshot.runtime.chains.map((item: any) => ({
  tokenId: BigInt(item.tokenId), active: item.active, feePerCallUsd: BigInt(item.feePerCallUsd),
  permissionlessDeploy: item.permissionlessDeploy, pending: BigInt(item.pending),
  pendingOwner: item.pendingOwner, lifetimeRevenue: BigInt(item.lifetimeRevenue), callCount: BigInt(item.callCount),
}));
const runtime = await deploy('runtime', 'VoidChainAppRuntimeV6', [
  deed, token, treasury, importedChains, BigInt(snapshot.runtime.protocolAccrued),
]);
const paymaster = await deploy('paymaster', 'VoidPaymaster', [token, runtime, account.address, recipient, oracle]);
const appFactory = await deploy('appFactory', 'VoidChainAppFactoryV3', [runtime]);

const excludedReserves = [escrow, builder, protocol, pool];
const governanceVotes = await deploy('governanceVotes', 'VoidGovernanceVotesV9', [token, excludedReserves]);
const daoFactory = await deploy('daoFactory', 'VoidChainDaoFactory', [runtime, governanceVotes, deed]);

await send('oracle', runtime, 'VoidChainAppRuntimeV6', 'setOracle', [oracle]);
await send('forwarder', runtime, 'VoidChainAppRuntimeV6', 'setForwarderOnce', [paymaster]);
await send('daoFactory', runtime, 'VoidChainAppRuntimeV6', 'setDaoFactoryOnce', [daoFactory]);
await send('appFactory', runtime, 'VoidChainAppRuntimeV6', 'setAppFactoryOnce', [appFactory]);
await send('tokenOperators', token, 'VoidTokenV9', 'freezeProtocolOperators', [runtime, paymaster]);
await send('settler', treasury, 'VoidChainTreasury', 'setAuthorizedSettler', [runtime, true]);
await send('refillPool', paymaster, 'VoidPaymaster', 'setVoidEthPoolOnce', [pool]);
await send('limits', paymaster, 'VoidPaymaster', 'setLimits', [parseEther('0.00002'), 60000n, (await rpc.getGasPrice()) * 3n, parseEther('0.005')]);
await send('refillPolicy', paymaster, 'VoidPaymaster', 'setRefillPolicy', [parseEther('0.0001'), parseEther('0.0005'), 500n]);

for (let start = 1; start <= 1111; start += 20) {
  const end = Math.min(start + 19, 1111);
  await send(`daos:${start}`, daoFactory, 'VoidChainDaoFactory', 'createMany', [BigInt(start), BigInt(end)]);
  console.log(`DAOs ${end}/1111`);
}
for (const item of ownership.deeds) {
  const id = BigInt(item.id);
  await send(`mint:${id}`, deed, 'VoidChainDeed', 'mint', [account.address, id]);
  if (item.identity.name) await send(`name:${id}`, deed, 'VoidChainDeed', 'rename', [id, item.identity.name]);
  const socials = item.identity.socials ?? [];
  if (item.identity.description || item.identity.imageURI || item.identity.externalURL || socials.length) {
    await send(`identity:${id}`, deed, 'VoidChainDeed', 'setIdentity', [
      id, item.identity.description ?? '', item.identity.imageURI ?? '',
      item.identity.externalURL ?? '', socials,
    ]);
  }
}

const implementation = await deploy('nftImplementation', 'VoidGenesisNftAmmV6', [runtime, 1n, token, deed, escrow, recipient]);
const stakingImplementation = await deploy('stakingImplementation', 'VoidSoftStakingV9', [
  runtime, 1n, token, deed, recipient,
]);
const stakingPublish = await send('publishStaking', appFactory, 'VoidChainAppFactoryV3', 'publish', [
  1n, stakingImplementation, '0x', keccak256(toHex('void-v9-soft-staking')),
]);
if (!record.contracts.softStaking) {
  const log = stakingPublish.logs.find((entry) => entry.address.toLowerCase() === appFactory.toLowerCase());
  if (!log?.topics[2]) throw Error('Staking gateway not found');
  record.contracts.softStaking = `0x${log.topics[2].slice(-40)}`; save();
}
const staking = record.contracts.softStaking as Address;
const initRewards = encodeFunctionData({
  abi: artifact('VoidGenesisNftAmmV6').abi,
  functionName: 'initializeStakerRewards', args: [staking],
});
const publish = await send('publishNft', appFactory, 'VoidChainAppFactoryV3', 'publish', [1n, implementation, initRewards, keccak256(toHex('void-v9-nft-amm'))]);
if (!record.contracts.nftAmm) {
  const log = publish.logs.find((entry) => entry.address.toLowerCase() === appFactory.toLowerCase());
  if (!log?.topics[2]) throw Error('NFT gateway not found');
  record.contracts.nftAmm = `0x${log.topics[2].slice(-40)}`; save();
}
const market = record.contracts.nftAmm as Address;
const holders: Address[] = [];
for (const item of ownership.deeds) {
  const owner = item.inLegacyPool ? market : item.owner as Address;
  holders.push(owner);
  if (owner.toLowerCase() !== account.address.toLowerCase()) {
    await send(`owner:${item.id}`, deed, 'VoidChainDeed', 'transferFrom', [account.address, owner, BigInt(item.id)]);
  }
}
const mint = await deploy('mint', 'VoidEthGenesisMintV10', [
  deed, escrow, pool, paymaster, recipient, parseEther('0.001'), holders,
  BigInt(snapshot.pool.reserveVoid), BigInt(snapshot.pool.reserveEth),
]);
await send('genesisController', pool, 'VoidEthPoolV6', 'setGenesisControllerOnce', [mint]);
const roleTargets: Record<string, Address> = { pool, nftAmm: market, runtime, paymaster };
const migrationRecipients: Address[] = [];
const migrationAmounts: bigint[] = [];
for (const entry of snapshot.balances) {
  if (['escrow', 'builder', 'protocol'].includes(entry.role)) continue;
  migrationRecipients.push(roleTargets[entry.role] ?? entry.address as Address);
  migrationAmounts.push(BigInt(entry.balance));
}
await send('escrowConfigured', escrow, 'VoidGenesisEscrowV10', 'configureMigrationOnce', [{
  token, launch: mint, liquidityPool: pool, builderVault: builder, protocolVault: protocol,
  lpAlreadyReleased: BigInt(snapshot.accounting.lpAlreadyReleased),
  nftAlreadyReleased: BigInt(snapshot.accounting.nftAlreadyReleased),
}, migrationRecipients, migrationAmounts, snapshot.nftDeedIds.map(BigInt)]);
await send('escrowMarket', escrow, 'VoidGenesisEscrowV10', 'setNftAmmOnce', [market]);
await send('minter', deed, 'VoidChainDeed', 'transferMinter', [mint]);
await send('fundMigration', mint, 'VoidEthGenesisMintV10', 'fundMigration', [], BigInt(snapshot.pool.reserveEth));
await sendValue('fundPaymasterReserve', paymaster, BigInt(snapshot.paymasterEth));
await send('twapBootstrap', twap, 'VoidTwapOracleV6', 'bootstrap');

// Configuration is complete. Global powers now acquire a visible two-day delay.
await send('treasuryTimelock', treasury, 'VoidChainTreasury', 'transferGovernance', [timelock]);
await send('paymasterTimelock', paymaster, 'VoidPaymaster', 'transferGovernor', [timelock]);

record.status = 'awaiting-twap-apps-and-acceptance-audit';
record.migratedOwners = holders;
record.governance = { proposer: account.address, timelock, delaySeconds: 172800 };
save();
console.log('V10 staged. Public manifests remain unchanged until the acceptance audit passes.');
