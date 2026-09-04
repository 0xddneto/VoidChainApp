/** Public availability, reserve and bytecode integrity monitor. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, fallback, getAddress, http, keccak256, parseAbi, type Address } from 'viem';

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

  if (existsSync(statePath)) {
    const previous = JSON.parse(readFileSync(statePath, 'utf8')) as { checkedAt: string; reserveWei: string };
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
    checkPage(`${VOIDSCAN}/mint`),
    checkPage(`${VOIDSCAN}/market`),
    checkPage(VOIDDEX),
  ]);
  const [market, activity, dexState, chainOne] = await Promise.all([
    checkJson(`${VOIDSCAN}/api/market/state`),
    checkJson(`${VOIDSCAN}/api/activity`),
    checkJson(`${VOIDDEX}/state`),
    checkJson(`${VOIDSCAN}/api/chain/1`),
  ]);
  for (const app of (chainOne as { apps?: Array<{ address: string }> }).apps ?? []) {
    const gateway = getAddress(app.address);
    const code = await rpc.getCode({ address: gateway });
    requireState(code && code !== '0x', `Registered app has no bytecode at ${gateway}`);
    await requireVerified(gateway);
    try {
      const implementation = await rpc.readContract({
        address: gateway,
        abi: parseAbi(['function implementation() view returns(address)']),
        functionName: 'implementation',
      });
      requireState((await rpc.getCode({ address: implementation })) !== '0x', `App implementation missing at ${implementation}`);
      await requireVerified(implementation);
    } catch (error) {
      throw new Error(`Registered app ${gateway} is not an inspectable verified gateway: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  writeFileSync(statePath, JSON.stringify({ checkedAt: new Date().toISOString(), reserveWei: reserve.toString() }, null, 2) + '\n');

  console.log(JSON.stringify({
    ok: true,
    checkedAt: new Date().toISOString(),
    chainId: 46_630,
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
