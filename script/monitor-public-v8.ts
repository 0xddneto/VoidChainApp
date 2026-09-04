/** Public, read-only V8 availability and integrity monitor. */
import { readFileSync } from 'node:fs';
import { createPublicClient, fallback, getAddress, http, parseAbi, type Address } from 'viem';

const deployment = JSON.parse(readFileSync('../web/lib/deployment.json', 'utf8'));
const dex = JSON.parse(readFileSync('../web/lib/dex-chain1.json', 'utf8'));
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

async function main() {
  requireState(await rpc.getChainId() === 46_630, 'RPC returned the wrong chain ID');

  const core = [
    ...Object.values(deployment.production),
    ...Object.values(deployment.testnet),
    dex.factory,
    dex.faucet,
    ...dex.pools.map((pool: { address: string }) => pool.address),
  ] as string[];
  for (const raw of new Set(core.map((address) => getAddress(address)))) {
    const code = await rpc.getCode({ address: raw as Address });
    requireState(code && code !== '0x', `Missing bytecode at ${raw}`);
  }

  const [rate, delay, reserve] = await Promise.all([
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
  ]);
  requireState(rate > 0n, 'TWAP freshness guard is unavailable');
  requireState(delay === 172_800n, 'Protocol timelock delay changed');
  requireState(reserve > 0n, 'Paymaster ETH reserve is empty');

  await Promise.all([
    checkPage(VOIDSCAN),
    checkPage(`${VOIDSCAN}/docs`),
    checkPage(`${VOIDSCAN}/mint`),
    checkPage(`${VOIDSCAN}/market`),
    checkPage(VOIDDEX),
  ]);
  const [market, activity, dexState] = await Promise.all([
    checkJson(`${VOIDSCAN}/api/market/state`),
    checkJson(`${VOIDSCAN}/api/activity`),
    checkJson(`${VOIDDEX}/state`),
  ]);

  console.log(JSON.stringify({
    ok: true,
    checkedAt: new Date().toISOString(),
    chainId: 46_630,
    contracts: new Set(core.map((address) => address.toLowerCase())).size,
    voidPerEth: rate.toString(),
    paymasterEthWei: reserve.toString(),
    marketReadable: Boolean(market),
    activityReadable: Boolean(activity),
    dexReadable: Boolean(dexState),
  }));
}

main().catch((error) => {
  console.error(`PUBLIC V8 MONITOR FAILED: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
