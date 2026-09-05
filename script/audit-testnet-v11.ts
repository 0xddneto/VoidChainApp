/** Read-only V11 acceptance gate. Fails on any cross-contract state mismatch. */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  createPublicClient, decodeFunctionResult, encodeFunctionData, getAddress, http,
  parseAbi, parseEther, type Abi, type Address, type Hex,
} from 'viem';

const path = process.env.V11_RECORD_FILE ?? 'deployments/testnet-v11-final-pending.json';
const deployment = JSON.parse(readFileSync(path, 'utf8'));
const snapshot = JSON.parse(readFileSync(deployment.snapshotPath, 'utf8'));
const c = deployment.contracts as Record<string, Address>;
const dex = deployment.dex;
// Use the authenticated project RPC for an atomic audit view. Public dRPC is
// suitable as a browser fallback, but its load-balanced replicas can return a
// receipt from one head and historical reads from another.
const rpc = createPublicClient({ transport: http(process.env.PARENT_RPC ?? deployment.network.rpc) });
const abi = (name: string): Abi => JSON.parse(readFileSync(
  name === 'VoidChainAppGateway'
    ? '../out/VoidChainAppFactoryV3.sol/VoidChainAppGateway.json'
    : `../out/${name}.sol/${name}.json`, 'utf8')).abi;
function requireState(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}

const tokenAbi = abi('VoidTokenV11');
const deedAbi = abi('VoidChainDeed');
const runtimeAbi = abi('VoidChainAppRuntimeV11');
const paymasterAbi = abi('VoidPaymaster');
const treasuryAbi = abi('VoidChainTreasury');
const mintAbi = abi('VoidEthGenesisMintV11');
const poolAbi = abi('VoidEthPoolV6');
const votesAbi = abi('VoidGovernanceVotesV11');
const daoFactoryAbi = abi('VoidChainDaoFactory');
const gatewayAbi = abi('VoidChainAppGateway');
const nftAmmAbi = abi('VoidGenesisNftAmmV6');
const pairAbi = JSON.parse(readFileSync('../../VoidDEX/out/VoidUniswapV2Pair.sol/VoidUniswapV2Pair.json', 'utf8')).abi as Abi;

async function gatewayRead(address: Address, implementationAbi: Abi, functionName: string, args: readonly unknown[] = []) {
  const data = encodeFunctionData({ abi: implementationAbi, functionName: functionName as never, args: args as never });
  const raw = await rpc.readContract({ address, abi: gatewayAbi, functionName: 'query', args: [data] }) as Hex;
  return decodeFunctionResult({ abi: implementationAbi, functionName: functionName as never, data: raw });
}

if (await rpc.getChainId() !== 46_630) throw Error('Robinhood testnet only');
const latest = await rpc.getBlockNumber();
const zero32 = `0x${'0'.repeat(64)}`;

const [supply, frozen, totalMinted, domain, erc4494, minter] = await Promise.all([
  rpc.readContract({ address: c.token, abi: tokenAbi, functionName: 'totalSupply' }),
  rpc.readContract({ address: c.token, abi: tokenAbi, functionName: 'operatorsFrozen' }),
  rpc.readContract({ address: c.mint, abi: mintAbi, functionName: 'totalMinted' }),
  rpc.readContract({ address: c.deed, abi: deedAbi, functionName: 'DOMAIN_SEPARATOR' }),
  rpc.readContract({ address: c.deed, abi: deedAbi, functionName: 'supportsInterface', args: ['0x5604e225'] }),
  rpc.readContract({ address: c.deed, abi: deedAbi, functionName: 'minter' }),
]) as unknown as readonly [bigint, boolean, bigint, Hex, boolean, Address];
requireState(supply === parseEther('1000000000'), 'VOID supply is not exactly 1 billion');
requireState(frozen === true, 'VOID protocol operators are not frozen');
requireState(totalMinted === BigInt(snapshot.deeds.length), 'Minted Deed count does not match the migration snapshot');
requireState(domain !== zero32 && erc4494 === true, 'Deed is not ERC-4494 discoverable');
requireState(getAddress(minter) === getAddress(c.mint), 'Deed minter is not the V11 ETH mint');

for (let index = 0; index < snapshot.deeds.length; index += 1) {
  const id = BigInt(snapshot.deeds[index].id);
  const owner = await rpc.readContract({ address: c.deed, abi: deedAbi, functionName: 'ownerOf', args: [id] }) as Address;
  requireState(getAddress(owner) === getAddress(deployment.migration.holders[index]), `Deed #${id} owner mismatch`);
}

const [paymasterGovernor, treasuryGovernor, forwarder, appFactory, daoFactory, oracle, guardian, recovery, paused] = await Promise.all([
  rpc.readContract({ address: c.paymaster, abi: paymasterAbi, functionName: 'governor' }),
  rpc.readContract({ address: c.treasury, abi: treasuryAbi, functionName: 'governance' }),
  rpc.readContract({ address: c.runtime, abi: runtimeAbi, functionName: 'forwarder' }),
  rpc.readContract({ address: c.runtime, abi: runtimeAbi, functionName: 'appFactory' }),
  rpc.readContract({ address: c.runtime, abi: runtimeAbi, functionName: 'daoFactory' }),
  rpc.readContract({ address: c.runtime, abi: runtimeAbi, functionName: 'oracle' }),
  rpc.readContract({ address: c.runtime, abi: runtimeAbi, functionName: 'emergencyGuardian' }),
  rpc.readContract({ address: c.runtime, abi: runtimeAbi, functionName: 'recoveryGovernor' }),
  rpc.readContract({ address: c.runtime, abi: runtimeAbi, functionName: 'protocolPaused' }),
]) as unknown as readonly [Address, Address, Address, Address, Address, Address, Address, Address, boolean];
requireState(getAddress(paymasterGovernor) === getAddress(c.protocolTimelock), 'Paymaster is not governed by the timelock');
requireState(getAddress(treasuryGovernor) === getAddress(c.protocolTimelock), 'Treasury is not governed by the timelock');
requireState(getAddress(forwarder) === getAddress(c.paymaster), 'Runtime forwarder mismatch');
requireState(getAddress(appFactory) === getAddress(c.appFactory), 'Runtime app factory mismatch');
requireState(getAddress(daoFactory) === getAddress(c.daoFactory), 'Runtime DAO factory mismatch');
requireState(getAddress(oracle) === getAddress(c.oracle), 'Runtime oracle mismatch');
requireState(getAddress(guardian) === getAddress(deployment.governance.guardian), 'Emergency guardian mismatch');
requireState(getAddress(recovery) === getAddress(c.protocolTimelock), 'Recovery governor is not timelocked');
requireState(paused === false, 'Runtime is paused');

const [reimbursable, surplus, paymasterTokens, reserveEth, threshold, target, daily, blockLimit] = await Promise.all([
  rpc.readContract({ address: c.paymaster, abi: paymasterAbi, functionName: 'reimbursableVoid' }),
  rpc.readContract({ address: c.paymaster, abi: paymasterAbi, functionName: 'surplusVoid' }),
  rpc.readContract({ address: c.token, abi: tokenAbi, functionName: 'balanceOf', args: [c.paymaster] }),
  rpc.getBalance({ address: c.paymaster }),
  rpc.readContract({ address: c.paymaster, abi: paymasterAbi, functionName: 'refillThreshold' }),
  rpc.readContract({ address: c.paymaster, abi: paymasterAbi, functionName: 'refillTarget' }),
  rpc.readContract({ address: c.paymaster, abi: paymasterAbi, functionName: 'dailyChainEthLimit' }),
  rpc.readContract({ address: c.paymaster, abi: paymasterAbi, functionName: 'maxEthPerBlock' }),
]) as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
requireState(paymasterTokens === reimbursable + surplus, 'Paymaster VOID accounting does not reconcile');
requireState(reserveEth >= threshold && threshold > 0n && target > threshold, 'Paymaster ETH runway is outside policy');
requireState(daily === parseEther('0.0002') && blockLimit === parseEther('0.0001'), 'Paymaster live budgets differ from V11 policy');

const [poolVoid, poolEth, poolTokenBalance, poolEthBalance, rate] = await Promise.all([
  rpc.readContract({ address: c.ethPool, abi: poolAbi, functionName: 'reserveVoid' }),
  rpc.readContract({ address: c.ethPool, abi: poolAbi, functionName: 'reserveEth' }),
  rpc.readContract({ address: c.token, abi: tokenAbi, functionName: 'balanceOf', args: [c.ethPool] }),
  rpc.getBalance({ address: c.ethPool }),
  rpc.readContract({ address: c.twap, abi: parseAbi(['function voidPerEth() view returns(uint256)']), functionName: 'voidPerEth' }),
]) as unknown as readonly [bigint, bigint, bigint, bigint, bigint];
requireState(poolVoid === poolTokenBalance && poolEth === poolEthBalance, 'VOID/ETH pool reserves do not reconcile');
requireState(poolVoid > 0n && poolEth > 0n && rate > 0n, 'VOID/ETH pricing is unavailable');

const canonicalApps = [c.softStaking, c.nftAmm, dex.factory, ...dex.pools.map((item: { address: Address }) => item.address), dex.faucet] as Address[];
requireState(canonicalApps.length === 6, 'Canonical app set must contain exactly six apps');
for (const app of canonicalApps) {
  const registered = await rpc.readContract({ address: c.runtime, abi: runtimeAbi, functionName: 'belongsTo', args: [1n, app] }) as boolean;
  requireState(registered === true, `Canonical app is not registered: ${app}`);
}
for (const pool of dex.pools as Array<{ address: Address }>) {
  const lpSupply = await gatewayRead(pool.address, pairAbi, 'totalSupply') as bigint;
  requireState(lpSupply > 0n, `DEX pool has no liquidity: ${pool.address}`);
}
for (const id of [4n, 5n]) {
  const index = await gatewayRead(c.nftAmm, nftAmmAbi, 'inventoryIndexPlusOne', [id]) as bigint;
  requireState(index > 0n, `Deed #${id} is missing from NFT/VOID inventory`);
}

let daoCount = 0;
for (let start = 1; start <= 1111; start += 50) {
  const ids = Array.from({ length: Math.min(50, 1112 - start) }, (_, offset) => BigInt(start + offset));
  const daos = await Promise.all(ids.map((id) => rpc.readContract({ address: c.daoFactory, abi: daoFactoryAbi, functionName: 'daoOf', args: [id] }))) as Address[];
  for (const dao of daos) {
    requireState(!/^0x0{40}$/i.test(dao), `DAO #${daoCount + 1} is missing`);
    daoCount += 1;
  }
}
const excluded = await rpc.readContract({ address: c.governanceVotes, abi: votesAbi, functionName: 'excludedAccounts' }) as Address[];
requireState(excluded.length === 7, 'Governance reserve exclusion set is incomplete');
// Public RPC load balancers may serve replicas separated by many blocks. Use
// the immutable block immediately before the votes adapter was deployed: all
// V11 reserves and DEX liquidity already existed there, and every provider can
// safely answer that finalized historical checkpoint.
const governanceDeployment = await rpc.getTransactionReceipt({
  hash: deployment.steps['deploy:governanceVotes'],
});
const governanceBlock = await rpc.getBlock({ blockHash: governanceDeployment.blockHash });
// Robinhood exposes an L2 receipt number (~113M) while Solidity's
// `block.number` and the token checkpoints use the L1 number (~11M).
const governanceClock = BigInt(
  (governanceBlock as typeof governanceBlock & { l1BlockNumber?: bigint }).l1BlockNumber
    ?? governanceBlock.number,
);
const governanceSnapshot = governanceClock - 1n;
for (const account of excluded) {
  const votes = await rpc.readContract({ address: c.governanceVotes, abi: votesAbi, functionName: 'getPastVotes', args: [account, governanceSnapshot] }) as bigint;
  requireState(votes === 0n, `Excluded reserve retained voting power: ${account}`);
}
const eligibleSupply = await rpc.readContract({ address: c.governanceVotes, abi: votesAbi, functionName: 'getPastTotalSupply', args: [governanceSnapshot] }) as bigint;
requireState(eligibleSupply > 0n && eligibleSupply < supply, 'Eligible governance supply is invalid');

const stats = await rpc.readContract({ address: c.runtime, abi: runtimeAbi, functionName: 'statsOf', args: [1n] }) as readonly [boolean, bigint, bigint, bigint, bigint];
requireState(stats[0] === true, 'Chain #1 is not active');
requireState(stats[4] >= BigInt(snapshot.deeds[0].runtimeState[6]) + 6n, 'Sponsored acceptance calls were not recorded');

deployment.status = 'v11-acceptance-passed';
deployment.acceptance = {
  checkedAt: new Date().toISOString(), block: latest.toString(), daoCount,
  governanceSnapshot: governanceSnapshot.toString(),
  canonicalApps: canonicalApps.length, totalSupply: supply.toString(), totalMinted: totalMinted.toString(),
  paymasterEthWei: reserveEth.toString(), paymasterVoid: paymasterTokens.toString(), eligibleGovernanceSupply: eligibleSupply.toString(),
  chain1Calls: stats[4].toString(), chain1LifetimeRevenue: stats[3].toString(),
};
writeFileSync(path, `${JSON.stringify(deployment, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, ...deployment.acceptance }, null, 2));
