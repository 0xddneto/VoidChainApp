import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createPublicClient, fallback, formatEther, getAddress, http, parseAbi, parseAbiItem,
  type Address,
} from 'viem';

const ownership = JSON.parse(readFileSync('deployments/testnet-v9-snapshot.json', 'utf8'));
const sourceDeployment = JSON.parse(readFileSync('deployments/testnet-v8-pending.json', 'utf8'));
const path = 'deployments/testnet-v10-snapshot.json';
if (existsSync(path)) throw Error('V10 snapshot already exists; never replace an accounting cutoff.');

const urls = [ownership.source.network.rpc, process.env.PARENT_RPC, 'https://robinhood-testnet.drpc.org'].filter(Boolean) as string[];
const rpc = createPublicClient({ transport: fallback(urls.map((url) => http(url))) });
if (await rpc.getChainId() !== 46630) throw Error('Testnet only');

const blockNumber = BigInt(ownership.block);
const block = await rpc.getBlock({ blockNumber });
if (block.hash.toLowerCase() !== ownership.blockHash.toLowerCase()) throw Error('Ownership cutoff is no longer canonical');

const token = getAddress(sourceDeployment.contracts.token) as Address;
const transfer = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
const balances = new Map<string, bigint>();
for (let fromBlock = BigInt(sourceDeployment.network.deployBlock); fromBlock <= blockNumber; fromBlock += 10_000n) {
  const toBlock = fromBlock + 9_999n > blockNumber ? blockNumber : fromBlock + 9_999n;
  const logs = await rpc.getLogs({ address: token, event: transfer, fromBlock, toBlock });
  for (const log of logs) {
    const from = log.args.from!.toLowerCase();
    const to = log.args.to!.toLowerCase();
    const value = log.args.value!;
    if (from !== '0x0000000000000000000000000000000000000000') {
      balances.set(from, (balances.get(from) ?? 0n) - value);
    }
    if (to !== '0x0000000000000000000000000000000000000000') {
      balances.set(to, (balances.get(to) ?? 0n) + value);
    }
  }
}

const total = [...balances.values()].reduce((sum, value) => sum + (value > 0n ? value : 0n), 0n);
if (total !== 1_000_000_000n * 10n ** 18n) {
  throw Error(`Transfer-ledger supply mismatch: ${formatEther(total)}`);
}

const c = sourceDeployment.contracts as Record<string, Address>;
const roles = new Map<string, string>([
  [c.escrow.toLowerCase(), 'escrow'], [c.builder.toLowerCase(), 'builder'],
  [c.protocol.toLowerCase(), 'protocol'], [c.pool.toLowerCase(), 'pool'],
  [c.nftAmm.toLowerCase(), 'nftAmm'], [c.runtime.toLowerCase(), 'runtime'],
  [c.paymaster.toLowerCase(), 'paymaster'],
]);
const positiveBalances = [...balances.entries()]
  .filter(([, balance]) => balance > 0n)
  .map(([address, balance]) => ({ address: getAddress(address), balance, role: roles.get(address) ?? 'wallet' }))
  .sort((a, b) => a.address.localeCompare(b.address));

for (const required of ['escrow', 'builder', 'protocol', 'pool', 'nftAmm', 'runtime', 'paymaster']) {
  if (!positiveBalances.some((entry) => entry.role === required)) throw Error(`Missing ${required} balance`);
}
const poolAbi = parseAbi(['function reserveVoid() view returns(uint112)', 'function reserveEth() view returns(uint112)']);
const runtimeAbi = parseAbi([
  'function apps(uint256) view returns(bool,uint256,bool,uint256,address,uint256,uint256)',
  'function configured(uint256) view returns(bool)',
  'function protocolAccrued() view returns(uint256)',
]);
const [reserveVoid, reserveEth, paymasterEth, protocolAccrued] = await Promise.all([
  rpc.readContract({ address: c.pool, abi: poolAbi, functionName: 'reserveVoid', blockNumber }),
  rpc.readContract({ address: c.pool, abi: poolAbi, functionName: 'reserveEth', blockNumber }),
  rpc.getBalance({ address: c.paymaster, blockNumber }),
  rpc.readContract({ address: c.runtime, abi: runtimeAbi, functionName: 'protocolAccrued', blockNumber }),
]);
const poolBalance = positiveBalances.find((entry) => entry.role === 'pool')!.balance;
if (reserveVoid !== poolBalance) throw Error('Pool reserve and token balance diverge at cutoff');

const nftDeedIds = ownership.deeds.filter((item: any) => item.inLegacyPool).map((item: any) => item.id);
const runtimeChains = [];
for (const deed of ownership.deeds) {
  const tokenId = BigInt(deed.id);
  const [configured, state] = await Promise.all([
    rpc.readContract({ address: c.runtime, abi: runtimeAbi, functionName: 'configured', args: [tokenId], blockNumber }),
    rpc.readContract({ address: c.runtime, abi: runtimeAbi, functionName: 'apps', args: [tokenId], blockNumber }),
  ]);
  if (configured) {
    runtimeChains.push({
      tokenId, active: state[0], feePerCallUsd: state[1], permissionlessDeploy: state[2],
      pending: state[3], pendingOwner: state[4], lifetimeRevenue: state[5], callCount: state[6],
    });
  }
}
const snapshot = {
  version: 'v10-exact-ledger-migration', network: 46630,
  block: blockNumber, blockHash: block.hash, ownership: 'deployments/testnet-v9-snapshot.json',
  sourceDeployment: 'deployments/testnet-v8-pending.json', sourceToken: token,
  balances: positiveBalances, pool: { reserveVoid, reserveEth }, paymasterEth,
  runtime: { protocolAccrued, chains: runtimeChains },
  nftDeedIds,
  accounting: {
    totalSupply: total,
    lpAlreadyReleased: 1_200_000n * 10n ** 18n,
    nftAlreadyReleased: BigInt(nftDeedIds.length) * 500_000n * 10n ** 18n,
  },
  policy: 'Exact token ledger at the immutable V9 ownership cutoff. System addresses map by role; external wallets retain balances 1:1.',
};
writeFileSync(path, JSON.stringify(snapshot, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
console.log(JSON.stringify({ block: String(blockNumber), holders: positiveBalances.length, total: formatEther(total), poolVoid: formatEther(reserveVoid), poolEth: formatEther(reserveEth) }, null, 2));
