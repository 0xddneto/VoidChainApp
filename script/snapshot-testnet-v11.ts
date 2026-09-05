/** Fresh read-only inventory for V11. It never changes a live manifest. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, fallback, http, parseAbi, parseAbiItem, zeroAddress, encodeFunctionData, decodeFunctionResult, type Abi, type Address } from 'viem';

const source = JSON.parse(readFileSync('../web/lib/deployment.json', 'utf8'));
const rpc = createPublicClient({ transport: fallback([
  http(source.network.rpc), http('https://rpc.testnet.chain.robinhood.com'),
]) });
if (await rpc.getChainId() !== 46630) throw Error('Testnet only');
const blockNumber = (await rpc.getBlockNumber()) - 20n;
const block = await rpc.getBlock({ blockNumber });
const token = source.testnet.VoidTestToken as Address;
const tokenAbi = parseAbi(['function totalSupply() view returns(uint256)', 'function balanceOf(address) view returns(uint256)']);
const transfer = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
const balances = new Map<string, bigint>();
for (let fromBlock = BigInt(source.network.deployBlock); fromBlock <= blockNumber; fromBlock += 10_000n) {
  const toBlock = fromBlock + 9_999n < blockNumber ? fromBlock + 9_999n : blockNumber;
  for (const log of await rpc.getLogs({ address: token, event: transfer, fromBlock, toBlock })) {
    const from = log.args.from!.toLowerCase(); const to = log.args.to!.toLowerCase(); const value = log.args.value!;
    if (from !== zeroAddress) balances.set(from, (balances.get(from) ?? 0n) - value);
    if (to !== zeroAddress) balances.set(to, (balances.get(to) ?? 0n) + value);
  }
}
const totalSupply = await rpc.readContract({ address: token, abi: tokenAbi, functionName: 'totalSupply', blockNumber });
if ([...balances.values()].some((value) => value < 0n)) throw Error('Incomplete token transfer ledger');
if ([...balances.values()].reduce((sum, value) => sum + value, 0n) !== totalSupply) throw Error('Supply mismatch');
const holders = [];
const creditAbi = parseAbi(['function owed(address) view returns(uint256)', 'function claimable(address) view returns(uint256)']);
for (const [address, balance] of balances) {
  const actual = await rpc.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [address as Address], blockNumber });
  if (actual !== balance) throw Error(`Token balance mismatch ${address}`);
  const owed = await rpc.readContract({ address: source.production.VoidChainAppRuntime, abi: creditAbi, functionName: 'owed', args: [address as Address], blockNumber });
  const claimable = await rpc.readContract({ address: source.production.VoidChainTreasury, abi: creditAbi, functionName: 'claimable', args: [address as Address], blockNumber });
  holders.push({ address, balance, runtimeOwed: owed, treasuryClaimable: claimable });
}
const deedAbi = parseAbi([
  'function totalSupply() view returns(uint256)', 'function ownerOf(uint256) view returns(address)',
  'function identityOf(uint256) view returns((string name,string description,string imageURI,string externalURL,string[] socials))',
]);
const runtimeAbi = parseAbi([
  'function apps(uint256) view returns(bool,uint256,bool,uint256,address,uint256,uint256)',
  'function daoOf(uint256) view returns(address)',
]);
const daoAbi = parseAbi(['function proposalCount() view returns(uint256)', 'function state(uint256) view returns(uint8)']);
const minted = await rpc.readContract({ address: source.production.VoidChainDeed, abi: deedAbi, functionName: 'totalSupply', blockNumber });
const deeds = [];
for (let id = 1n; id <= minted; id++) {
  const owner = await rpc.readContract({ address: source.production.VoidChainDeed, abi: deedAbi, functionName: 'ownerOf', args: [id], blockNumber });
  const identity = await rpc.readContract({ address: source.production.VoidChainDeed, abi: deedAbi, functionName: 'identityOf', args: [id], blockNumber });
  const state = await rpc.readContract({ address: source.production.VoidChainAppRuntime, abi: runtimeAbi, functionName: 'apps', args: [id], blockNumber });
  const dao = await rpc.readContract({ address: source.production.VoidChainAppRuntime, abi: runtimeAbi, functionName: 'daoOf', args: [id], blockNumber });
  const proposals = [];
  if (dao !== zeroAddress) {
    const count = await rpc.readContract({ address: dao, abi: daoAbi, functionName: 'proposalCount', blockNumber });
    for (let proposalId = 1n; proposalId <= count; proposalId++) {
      proposals.push({ id: proposalId, state: await rpc.readContract({ address: dao, abi: daoAbi, functionName: 'state', args: [proposalId], blockNumber }) });
    }
  }
  deeds.push({ id, owner, identity, runtimeState: state, dao, proposals });
}
const stakingAddress = source.testnet.VoidSoftStakingV9 as Address;
const stakingAbi = parseAbi([
  'function positions(uint256) view returns(address,uint64,uint32,uint256,uint256)',
  'function earned(uint256) view returns(uint256)',
]);
const stakingPositions = [];
async function gatewayRead(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
  const data = encodeFunctionData({ abi, functionName, args });
  const raw = await rpc.readContract({ address, abi: parseAbi(['function query(bytes) view returns(bytes)']),
    functionName: 'query', args: [data], blockNumber });
  return decodeFunctionResult({ abi, functionName, data: raw });
}
for (const deed of deeds) {
  stakingPositions.push({ id: deed.id,
    position: await gatewayRead(stakingAddress, stakingAbi, 'positions', [deed.id]),
    earned: await gatewayRead(stakingAddress, stakingAbi, 'earned', [deed.id]),
  });
}
async function uintState(address: Address, names: string[], gateway = false) {
  const result: Record<string, bigint> = {};
  for (const name of names) {
    const abi = parseAbi([`function ${name}() view returns(uint256)`]);
    result[name] = (gateway ? await gatewayRead(address, abi, name)
      : await rpc.readContract({ address, abi, functionName: name, blockNumber })) as bigint;
  }
  return result;
}
const stakingState = await uintState(stakingAddress, ['totalWeight', 'rewardRate', 'periodFinish', 'lastUpdateTime',
  'rewardPerWeightStored', 'queuedRewards', 'lifetimeRewardsReceived', 'lifetimeRewardsPaid'], true);
const ethPool = source.testnet.VoidEthPoolV6 as Address;
const liquidityState = await uintState(ethPool, ['reserveVoid', 'reserveEth', 'totalLiquidity', 'lastTimestamp', 'voidPerEthCumulative']);
const runtimeAccounting = await uintState(source.production.VoidChainAppRuntime, ['protocolAccrued']);
const custody = [];
for (const address of new Set<string>([...Object.values<string>(source.production), ...Object.values<string>(source.testnet)])) {
  custody.push({ address, eth: await rpc.getBalance({ address: address as Address, blockNumber }),
    void: await rpc.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [address as Address], blockNumber }) });
}
if ((await rpc.getBlock({ blockNumber })).hash !== block.hash) throw Error('Snapshot block reorganized');
const snapshot = {
  version: 'v11-read-only-migration-inventory', source, blockNumber, blockHash: block.hash,
  totalSupply, holders, deeds, stakingPositions, stakingState, liquidityState, runtimeAccounting, custody,
  limitations: ['Inventory is not a migration authorization or complete app-state export.',
    'DEX LP shares, external asset custody, staking rewards and proposal payloads need explicit migration adapters.',
    'Frozen VOID operators require a new token to use a replacement Runtime/Paymaster without approvals.'],
};
mkdirSync('deployments', { recursive: true });
const path = `deployments/testnet-v11-inventory-${blockNumber}.json`;
writeFileSync(path, JSON.stringify(snapshot, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ path, block: blockNumber.toString(), totalSupply: totalSupply.toString(), holders: holders.length, minted: minted.toString() }));
