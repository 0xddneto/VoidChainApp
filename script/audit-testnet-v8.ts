/** Read-only acceptance audit for the staged V8 cutover. */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  createPublicClient, decodeFunctionResult, encodeFunctionData, fallback, http,
  parseAbi, parseEther, type Address, type Hex,
} from 'viem';

const deployment = JSON.parse(readFileSync('deployments/testnet-v8-pending.json', 'utf8'));
const snapshot = JSON.parse(readFileSync('deployments/testnet-v8-snapshot.json', 'utf8'));
const dex = JSON.parse(readFileSync('deployments/dex-v8.json', 'utf8'));
const c = deployment.contracts as Record<string, Address>;
const urls = [deployment.network.rpc, 'https://rpc.testnet.chain.robinhood.com'];
const rpc = createPublicClient({ transport: fallback(urls.map((url) => http(url))) });
const explorer = 'https://explorer.testnet.chain.robinhood.com';
const runtimeAbi = parseAbi([
  'function oracle() view returns(address)', 'function forwarder() view returns(address)',
  'function daoFactory() view returns(address)', 'function appFactory() view returns(address)',
  'function belongsTo(uint256,address) view returns(bool)',
  'function statsOf(uint256) view returns(bool,uint256,uint256,uint256,uint256)',
  'function setOracle(address)',
  'event Executed(uint256 indexed tokenId,address indexed caller,address target,uint256 fee)',
]);
const daoAbi = parseAbi(['event DaoCreated(uint256 indexed tokenId,address dao)']);
const deedAbi = parseAbi(['function ownerOf(uint256) view returns(address)', 'function totalSupply() view returns(uint256)']);
const erc20Abi = parseAbi(['function totalSupply() view returns(uint256)', 'function balanceOf(address) view returns(uint256)']);
const poolAbi = parseAbi([
  'function reserveVoid() view returns(uint112)', 'function reserveEth() view returns(uint112)',
  'function totalLiquidity() view returns(uint256)', 'function liquidityOf(address) view returns(uint256)',
  'function lpLock() view returns(address)',
]);
const mintAbi = parseAbi([
  'function totalMinted() view returns(uint256)', 'function migratedSupply() view returns(uint256)',
  'function migrationFunded() view returns(bool)', 'function hasMinted(address) view returns(bool)',
]);
const timelockAbi = parseAbi(['function proposer() view returns(address)', 'function delay() view returns(uint256)']);
const governorAbi = parseAbi(['function governor() view returns(address)']);
const governanceAbi = parseAbi(['function governance() view returns(address)']);
const oracleAbi = parseAbi(['function voidPerEth() view returns(uint256)']);
const gatewayAbi = parseAbi(['function query(bytes) view returns(bytes)']);
const marketAbi = parseAbi(['function inventoryCount() view returns(uint256)']);

const same = (actual: string, expected: string, label: string) => {
  if (actual.toLowerCase() !== expected.toLowerCase()) throw Error(`${label}: ${actual} != ${expected}`);
};
async function events(address: Address, abi: typeof daoAbi | typeof runtimeAbi, eventName: string) {
  const logs: Array<{ args?: unknown }> = [];
  const head = await rpc.getBlockNumber();
  for (let from = BigInt(deployment.network.deployBlock); from <= head; from += 5_000n) {
    const to = from + 4_999n < head ? from + 4_999n : head;
    logs.push(...await rpc.getContractEvents({ address, abi, eventName: eventName as never, fromBlock: from, toBlock: to }));
  }
  return logs;
}
async function verified(address: Address) {
  const response = await fetch(`${explorer}/api/v2/addresses/${address}`);
  return response.ok && Boolean((await response.json() as { is_verified?: boolean }).is_verified);
}

async function main() {
  if (await rpc.getChainId() !== 46630) throw Error('Wrong network');
  for (const [label, address] of Object.entries(c)) {
    if ((await rpc.getCode({ address })) === undefined) throw Error(`Missing bytecode: ${label}`);
    if (!await verified(address)) throw Error(`Explorer verification missing: ${label}`);
  }

  const [oracle, forwarder, daoFactory, appFactory] = await Promise.all([
    rpc.readContract({ address: c.runtime, abi: runtimeAbi, functionName: 'oracle' }),
    rpc.readContract({ address: c.runtime, abi: runtimeAbi, functionName: 'forwarder' }),
    rpc.readContract({ address: c.runtime, abi: runtimeAbi, functionName: 'daoFactory' }),
    rpc.readContract({ address: c.runtime, abi: runtimeAbi, functionName: 'appFactory' }),
  ]);
  same(oracle, c.oracle, 'runtime oracle'); same(forwarder, c.paymaster, 'runtime forwarder');
  same(daoFactory, c.daoFactory, 'runtime DAO factory'); same(appFactory, c.appFactory, 'runtime app factory');
  try {
    await rpc.call({ account: deployment.governor, to: c.runtime, data: encodeFunctionData({ abi: runtimeAbi, functionName: 'setOracle', args: [c.oracle] }) });
    throw Error('Runtime oracle can still be replaced');
  } catch (error) {
    if (error instanceof Error && error.message === 'Runtime oracle can still be replaced') throw error;
  }

  const daoEvents = await events(c.daoFactory, daoAbi, 'DaoCreated');
  const ids = new Set(daoEvents.map((event) => String((event.args as { tokenId?: bigint }).tokenId)));
  if (ids.size !== 1111 || Array.from({ length: 1111 }, (_, i) => String(i + 1)).some((id) => !ids.has(id))) {
    throw Error(`DAO coverage mismatch: ${ids.size}/1111`);
  }

  const [supply, totalMinted, migratedSupply, funded] = await Promise.all([
    rpc.readContract({ address: c.deed, abi: deedAbi, functionName: 'totalSupply' }),
    rpc.readContract({ address: c.mint, abi: mintAbi, functionName: 'totalMinted' }),
    rpc.readContract({ address: c.mint, abi: mintAbi, functionName: 'migratedSupply' }),
    rpc.readContract({ address: c.mint, abi: mintAbi, functionName: 'migrationFunded' }),
  ]);
  if (supply !== 6n || totalMinted !== supply || migratedSupply !== supply || !funded) throw Error('Mint migration state mismatch');
  for (const deed of snapshot.deeds) {
    const expected = deed.inLegacyPool ? c.nftAmm : deed.owner;
    const owner = await rpc.readContract({ address: c.deed, abi: deedAbi, functionName: 'ownerOf', args: [BigInt(deed.id)] });
    same(owner, expected, `Deed #${deed.id} owner`);
    if (!await rpc.readContract({ address: c.mint, abi: mintAbi, functionName: 'hasMinted', args: [expected] })) {
      throw Error(`Mint limit not migrated for ${expected}`);
    }
  }

  const [tokenSupply, reserveVoid, reserveEth, totalLiquidity, lpLock] = await Promise.all([
    rpc.readContract({ address: c.token, abi: erc20Abi, functionName: 'totalSupply' }),
    rpc.readContract({ address: c.pool, abi: poolAbi, functionName: 'reserveVoid' }),
    rpc.readContract({ address: c.pool, abi: poolAbi, functionName: 'reserveEth' }),
    rpc.readContract({ address: c.pool, abi: poolAbi, functionName: 'totalLiquidity' }),
    rpc.readContract({ address: c.pool, abi: poolAbi, functionName: 'lpLock' }),
  ]);
  if (tokenSupply !== parseEther('1000000000') || reserveVoid === 0n || reserveEth === 0n || totalLiquidity === 0n) throw Error('Genesis liquidity mismatch');
  const [lockedLiquidity, poolVoid, poolEth] = await Promise.all([
    rpc.readContract({ address: c.pool, abi: poolAbi, functionName: 'liquidityOf', args: [lpLock] }),
    rpc.readContract({ address: c.token, abi: erc20Abi, functionName: 'balanceOf', args: [c.pool] }),
    rpc.getBalance({ address: c.pool }),
  ]);
  if (lockedLiquidity !== totalLiquidity || poolVoid !== reserveVoid || poolEth !== reserveEth) throw Error('Pool reserves are not fully backed and locked');
  if (await rpc.readContract({ address: c.oracle, abi: oracleAbi, functionName: 'voidPerEth' }) === 0n) throw Error('TWAP guard is not live');

  same(await rpc.readContract({ address: c.paymaster, abi: governorAbi, functionName: 'governor' }), c.protocolTimelock, 'Paymaster governor');
  same(await rpc.readContract({ address: c.treasury, abi: governanceAbi, functionName: 'governance' }), c.protocolTimelock, 'Treasury governance');
  same(await rpc.readContract({ address: c.protocolTimelock, abi: timelockAbi, functionName: 'proposer' }), deployment.governor, 'Timelock proposer');
  if (await rpc.readContract({ address: c.protocolTimelock, abi: timelockAbi, functionName: 'delay' }) !== 172800n) throw Error('Timelock delay mismatch');

  const applications = [c.nftAmm, dex.factory, dex.faucet, ...dex.pools.map((pool: { address: Address }) => pool.address)] as Address[];
  for (const app of applications) {
    if (!await rpc.readContract({ address: c.runtime, abi: runtimeAbi, functionName: 'belongsTo', args: [1n, app] })) throw Error(`Unregistered Chain #1 app: ${app}`);
  }
  const inventoryData = encodeFunctionData({ abi: marketAbi, functionName: 'inventoryCount' });
  const inventoryRaw = await rpc.readContract({ address: c.nftAmm, abi: gatewayAbi, functionName: 'query', args: [inventoryData] }) as Hex;
  const inventory = decodeFunctionResult({ abi: marketAbi, functionName: 'inventoryCount', data: inventoryRaw }) as bigint;
  if (inventory !== 2n) throw Error(`NFT inventory mismatch: ${inventory}`);

  const executions = await events(c.runtime, runtimeAbi, 'Executed');
  if (executions.length < 2) throw Error('Sponsored V8 execution evidence missing');
  const stats = await rpc.readContract({ address: c.runtime, abi: runtimeAbi, functionName: 'statsOf', args: [1n] });
  if (stats[4] !== BigInt(executions.length)) throw Error('Runtime transaction counter mismatch');

  const report = {
    version: deployment.version, chainId: 46630, verifiedContracts: Object.keys(c).length,
    daos: ids.size, deeds: Number(supply), inventory: Number(inventory), applications: applications.length,
    sponsoredExecutions: executions.length, totalVoidSupply: tokenSupply,
    reserveVoid, reserveEth, lockedLiquidity: totalLiquidity,
    governance: { timelock: c.protocolTimelock, proposer: deployment.governor, delaySeconds: 172800 },
    checks: { oracleFrozen: true, ownersPreserved: true, mintLimitsPreserved: true, poolFullyBacked: true },
  };
  writeFileSync('deployments/testnet-v8-audit.json', JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
  deployment.status = 'acceptance-passed';
  writeFileSync('deployments/testnet-v8-pending.json', JSON.stringify(deployment, null, 2) + '\n');
  console.log('PASS', JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
}
main().catch((error) => { console.error('V8 audit stopped:', error?.shortMessage ?? error?.message ?? 'unknown'); process.exitCode = 1; });
