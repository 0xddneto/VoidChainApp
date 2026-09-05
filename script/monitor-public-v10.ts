/** Public availability, reserve and bytecode integrity monitor. */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createPublicClient, fallback, getAddress, http, keccak256, parseAbi, parseAbiItem, type Address, type Hex } from 'viem';
import { MANIFEST_HASH, RELEASE } from '../web/lib/public-release';

const deployment = JSON.parse(readFileSync('../web/lib/deployment.json', 'utf8'));
const integrity = JSON.parse(readFileSync('public-v10-integrity.json', 'utf8')) as { chainId: number; contracts: Record<string, string> };
const VOIDSCAN = process.env.VOIDSCAN_URL ?? 'https://voidscan-nu.vercel.app';
const VOIDDEX = process.env.VOIDDEX_URL ?? 'https://voiddex-alpha.vercel.app';
const rpc = createPublicClient({
  transport: fallback([
    http(deployment.network.rpc),
    http('https://rpc.testnet.chain.robinhood.com'),
  ]),
});

const oracleAbi = parseAbi(['function voidPerEth() view returns(uint256)']);
const timelockAbi = parseAbi(['function delay() view returns(uint256)']);
const paymasterAbi = parseAbi(['function refillThreshold() view returns(uint256)', 'function refillTarget() view returns(uint256)']);
const poolAbi = parseAbi(['function reserveVoid() view returns(uint112)', 'function reserveEth() view returns(uint112)']);
const explorer = 'https://explorer.testnet.chain.robinhood.com';
const statePath = process.env.MONITOR_STATE_PATH ?? 'deployments/paymaster-monitor-state.json';
type RegistryState = { cursor: string; hash: Hex; runtime: string; apps: Array<{ chain: number; address: Address }> };
type MonitorState = { checkedAt: string; reserveWei: string; registry?: RegistryState };

async function readRegistry(previous?: RegistryState): Promise<RegistryState> {
  const runtime = getAddress(deployment.production.VoidChainAppRuntime);
  const latest = await rpc.getBlockNumber();
  const confirmed = latest - 20n;
  let from = BigInt(deployment.network.deployBlock);
  const apps = new Map<string, { chain: number; address: Address }>();
  if (previous?.runtime.toLowerCase() === runtime.toLowerCase() && BigInt(previous.cursor) <= confirmed) {
    const oldBlock = await rpc.getBlock({ blockNumber: BigInt(previous.cursor) });
    if (oldBlock.hash === previous.hash) {
      from = BigInt(previous.cursor) + 1n;
      for (const app of previous.apps) apps.set(app.address.toLowerCase(), app);
    }
  }
  const pinned = await rpc.getBlock({ blockNumber: confirmed });
  const events = [parseAbiItem('event AppRegistered(uint256 indexed tokenId,address app,address publisher)'),
    parseAbiItem('event AppUnregistered(uint256 indexed tokenId,address app)')];
  for (; from <= confirmed; from += 10_000n) {
    const end = from + 9_999n < confirmed ? from + 9_999n : confirmed;
    const logs = await rpc.getLogs({ address: runtime, events, fromBlock: from, toBlock: end, strict: true });
    logs.sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);
    for (const log of logs) {
      const address = getAddress(log.args.app!);
      if (log.eventName === 'AppRegistered') apps.set(address.toLowerCase(), { chain: Number(log.args.tokenId!), address });
      else apps.delete(address.toLowerCase());
    }
  }
  requireState((await rpc.getBlock({ blockNumber: confirmed })).hash === pinned.hash, 'Registry scan reorganized; retry required');
  return { cursor: confirmed.toString(), hash: pinned.hash, runtime, apps: [...apps.values()] };
}

function requireState(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function checkPage(url: string) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  requireState(response.ok, `${url} returned ${response.status}`);
  requireState(Boolean(response.headers.get('content-security-policy')), `${url} is missing CSP`);
  requireState(response.headers.get('x-frame-options') === 'DENY', `${url} is missing frame denial`);
  requireState(response.headers.get('x-content-type-options') === 'nosniff', `${url} is missing nosniff`);
}

async function checkJson(url: string) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  requireState(response.ok, `${url} returned ${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  requireState(contentType.includes('application/json'), `${url} did not return JSON`);
  return response.json();
}

async function requireVerified(address: Address) {
  const response = await fetch(`${explorer}/api/v2/addresses/${address}`, { signal: AbortSignal.timeout(15_000) });
  const record = response.ok ? await response.json() as { is_verified?: boolean } : {};
  requireState(Boolean(record.is_verified), `Explorer verification missing at ${address}`);
}

async function main() {
  requireState(await rpc.getChainId() === 46_630, 'RPC returned the wrong chain ID');

  const core = [
    ...Object.values(deployment.production),
    ...Object.values(deployment.testnet),
  ] as string[];
  for (const raw of new Set(core.map((address) => getAddress(address)))) {
    const code = await rpc.getCode({ address: raw as Address });
    requireState(code && code !== '0x', `Missing bytecode at ${raw}`);
    const expected = integrity.contracts[raw.toLowerCase()];
    requireState(expected && keccak256(code) === expected, `Runtime bytecode changed at ${raw}`);
    await requireVerified(raw);
  }

  const [rate, delay, reserve, threshold, target, reserveVoid, reserveEth] = await Promise.all([
    rpc.readContract({
      address: getAddress(deployment.testnet.VoidTwapFreshnessGuardV6),
      abi: oracleAbi,
      functionName: 'voidPerEth',
    }),
    rpc.readContract({
      address: getAddress(deployment.production.VoidProtocolTimelock),
      abi: timelockAbi,
      functionName: 'delay',
    }),
    rpc.getBalance({ address: getAddress(deployment.production.VoidPaymaster) }),
    rpc.readContract({ address: getAddress(deployment.production.VoidPaymaster), abi: paymasterAbi, functionName: 'refillThreshold' }),
    rpc.readContract({ address: getAddress(deployment.production.VoidPaymaster), abi: paymasterAbi, functionName: 'refillTarget' }),
    rpc.readContract({ address: getAddress(deployment.testnet.VoidEthPoolV6), abi: poolAbi, functionName: 'reserveVoid' }),
    rpc.readContract({ address: getAddress(deployment.testnet.VoidEthPoolV6), abi: poolAbi, functionName: 'reserveEth' }),
  ]);
  requireState(rate > 0n, 'TWAP freshness guard is unavailable');
  requireState(delay === 172_800n, 'Protocol timelock delay changed');
  requireState(reserve >= threshold, `Paymaster reserve ${reserve} is below refill threshold ${threshold}`);
  requireState(target >= threshold && threshold > 0n, 'Paymaster refill policy is invalid');
  requireState(reserveEth > 0n && reserveVoid > 0n, 'VOID/ETH pool has an empty reserve');
  const spot = reserveVoid * 10n ** 18n / reserveEth;
  const divergenceBps = spot > rate ? (spot - rate) * 10_000n / rate : (rate - spot) * 10_000n / rate;
  requireState(divergenceBps <= 2_000n, `VOID/ETH spot diverged ${divergenceBps} bps from TWAP`);

  const previous = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) as MonitorState : undefined;
  if (previous) {
    const age = Date.now() - Date.parse(previous.checkedAt);
    const before = BigInt(previous.reserveWei);
    if (age > 0 && age <= 2 * 60 * 60 * 1_000 && before > reserve) {
      const dropBps = (before - reserve) * 10_000n / before;
      requireState(dropBps <= 3_500n, `Paymaster reserve fell ${dropBps} bps in ${Math.round(age / 60_000)} minutes`);
    }
  }

  await Promise.all([
    checkPage(VOIDSCAN),
    checkPage(`${VOIDSCAN}/docs`),
    checkPage(`${VOIDSCAN}/contracts`),
    checkPage(`${VOIDSCAN}/security`),
    checkPage(`${VOIDSCAN}/mint`),
    checkPage(`${VOIDSCAN}/market`),
    checkPage(VOIDDEX),
  ]);
  const release = await checkJson(`${VOIDSCAN}/api/release`) as { chainId?: number; version?: string; manifestHash?: string; commit?: string };
  requireState(release.chainId === 46_630 && release.version === RELEASE && release.manifestHash === MANIFEST_HASH,
    'Public release disagrees with the checked-in deployment manifest');
  requireState(Boolean(release.commit), 'Production release does not identify its Git commit');
  const [market, activity, dexState, registry] = await Promise.all([
    checkJson(`${VOIDSCAN}/api/market/state`),
    checkJson(`${VOIDSCAN}/api/activity`),
    checkJson(`${VOIDDEX}/state`),
    readRegistry(previous?.registry),
  ]);
  for (const chain of new Set(registry.apps.map((app) => app.chain))) {
    const detail = await checkJson(`${VOIDSCAN}/api/chain/${chain}`) as { apps?: Array<{ address: string }> };
    const indexed = new Set((detail.apps ?? []).map((app) => app.address.toLowerCase()));
    for (const app of registry.apps.filter((app) => app.chain === chain)) {
      requireState(indexed.has(app.address.toLowerCase()), `Chain ${chain} app ${app.address} is missing from VoidScan`);
    }
  }
  for (const app of registry.apps) {
    const gateway = getAddress(app.address);
    const code = await rpc.getCode({ address: gateway });
    requireState(code && code !== '0x', `Registered app has no bytecode at ${gateway}`);
    try {
      const implementation = await rpc.readContract({
        address: gateway,
        abi: parseAbi(['function implementation() view returns(address)']),
        functionName: 'implementation',
      });
      const implementationCode = await rpc.getCode({ address: implementation });
      requireState(implementationCode && implementationCode !== '0x', `App implementation missing at ${implementation}`);
      await requireVerified(implementation);
      const response = await fetch(`${explorer}/api/v2/addresses/${gateway}`, { signal: AbortSignal.timeout(15_000) });
      const record = response.ok ? await response.json() as { implementations?: Array<{ address_hash: string }> } : {};
      requireState(
        record.implementations?.some((item) => item.address_hash.toLowerCase() === implementation.toLowerCase()),
        `Explorer proxy link is missing or wrong for app ${gateway}`,
      );
    } catch (error) {
      throw new Error(`Registered app ${gateway} is not an inspectable verified gateway: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ checkedAt: new Date().toISOString(), reserveWei: reserve.toString(), registry }, null, 2) + '\n');

  console.log(JSON.stringify({
    ok: true,
    checkedAt: new Date().toISOString(),
    chainId: 46_630,
    release: release.version,
    commit: release.commit,
    manifestHash: release.manifestHash,
    registeredAppsChecked: registry.apps.length,
    registryBlock: registry.cursor,
    contracts: new Set(core.map((address) => address.toLowerCase())).size,
    voidPerEth: rate.toString(),
    paymasterEthWei: reserve.toString(),
    refillThresholdWei: threshold.toString(),
    spotTwapDivergenceBps: divergenceBps.toString(),
    marketReadable: Boolean(market),
    activityReadable: Boolean(activity),
    dexReadable: Boolean(dexState),
  }));
}

main().catch((error) => {
  console.error(`PUBLIC V10 MONITOR FAILED: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
