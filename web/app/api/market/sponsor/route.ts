import { NextResponse } from 'next/server';
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  isHex,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DEPLOY, RH_TESTNET } from '@/lib/testnet';
import {
  MARKET_CALL_GAS_LIMIT,
  MARKET_MAX_GAS_VOID,
  MARKET_SIGNATURE_LIFETIME_SECONDS,
  marketDeployment,
} from '@/lib/market';

const publicClient = createPublicClient({ transport: http(RH_TESTNET.rpcUrls[0]) });

const AMM_ABI = parseAbi([
  'function priceToBuy(bool specific) view returns (uint256)',
]);
const RUNTIME_ABI = parseAbi([
  'function feeOf(uint256 tokenId) view returns (uint256)',
]);
const MARKET_ABI = parseAbi([
  'function buyRandom(uint256 maxCost) returns (uint256 deedId)',
]);
const PAYMASTER_ABI = parseAbi([
  'function nonces(address user) view returns (uint256)',
  'function sponsorWithPermit((address user,uint256 tokenId,address target,bytes data,uint256 maxToll,uint256 maxGasVoid,uint256 callGasLimit,(address token,uint256 amount)[] spends,(address collection,uint256 tokenId)[] nftSpends,uint256 nonce,uint256 deadline) request,bytes signature,(address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)[] permissions) returns (bool executed,bytes result)',
]);

type RawSpend = { token?: unknown; amount?: unknown };
type RawNftSpend = { collection?: unknown; tokenId?: unknown };
type RawPermit = { spender?: unknown; value?: unknown; deadline?: unknown; v?: unknown; r?: unknown; s?: unknown };
type RawRequest = {
  user?: unknown; tokenId?: unknown; target?: unknown; data?: unknown; maxToll?: unknown;
  maxGasVoid?: unknown; callGasLimit?: unknown; spends?: unknown; nftSpends?: unknown;
  nonce?: unknown; deadline?: unknown;
};

type Permit = { spender: Address; value: bigint; deadline: bigint; v: number; r: Hex; s: Hex };

const recentUsers = new Map<string, number>();
const RATE_WINDOW_MS = 15_000;

function numberValue(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

function addressValue(value: unknown): Address | null {
  return typeof value === 'string' && isAddress(value) ? getAddress(value) : null;
}

function hexValue(value: unknown, bytes?: number): Hex | null {
  if (typeof value !== 'string' || !isHex(value)) return null;
  if (bytes !== undefined && value.length !== 2 + bytes * 2) return null;
  return value as Hex;
}

function permitValue(raw: RawPermit): Permit | null {
  const spender = addressValue(raw.spender);
  const value = numberValue(raw.value);
  const deadline = numberValue(raw.deadline);
  const r = hexValue(raw.r, 32);
  const s = hexValue(raw.s, 32);
  const v = raw.v;
  if (!spender || value === null || deadline === null || !r || !s || (v !== 27 && v !== 28)) return null;
  return { spender, value, deadline, v, r, s };
}

function reject(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

/**
 * Submits only a fully bounded collection-market purchase. The browser never
 * receives the relayer key, and this route never forwards an arbitrary call.
 */
export async function POST(httpRequest: Request) {
  const deployment = marketDeployment();
  if (!deployment) return reject('Sponsored market is not deployed on this testnet yet.', 503);

  const relayerKey = process.env.PAYMASTER_RELAYER_PRIVATE_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(relayerKey ?? '')) {
    return reject('Sponsored market relayer is not configured.', 503);
  }

  let body: { request?: RawRequest; signature?: unknown; permissions?: unknown };
  try { body = await httpRequest.json(); } catch { return reject('Malformed request body.'); }
  const raw = body.request;
  if (!raw || !Array.isArray(raw.spends) || !Array.isArray(raw.nftSpends) || !Array.isArray(body.permissions)) {
    return reject('Invalid sponsored request.');
  }

  const user = addressValue(raw.user);
  const target = addressValue(raw.target);
  const tokenId = numberValue(raw.tokenId);
  const maxToll = numberValue(raw.maxToll);
  const maxGasVoid = numberValue(raw.maxGasVoid);
  const callGasLimit = numberValue(raw.callGasLimit);
  const nonce = numberValue(raw.nonce);
  const deadline = numberValue(raw.deadline);
  const data = hexValue(raw.data);
  const signature = hexValue(body.signature, 65);
  if (!user || !target || tokenId === null || maxToll === null || maxGasVoid === null || callGasLimit === null || nonce === null || deadline === null || !data || !signature) {
    return reject('Invalid signed fields.');
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= now || deadline > now + MARKET_SIGNATURE_LIFETIME_SECONDS + 30n) {
    return reject('Signature expired; request a new quote.');
  }
  const previous = recentUsers.get(user.toLowerCase()) ?? 0;
  if (Date.now() - previous < RATE_WINDOW_MS) return reject('Please wait before relaying another purchase.', 429);

  if (target !== getAddress(deployment.app) || tokenId !== deployment.chainId || maxGasVoid !== MARKET_MAX_GAS_VOID || callGasLimit !== MARKET_CALL_GAS_LIMIT) {
    return reject('This route accepts only the bounded collection-market call.');
  }
  if (raw.spends.length !== 1 || raw.nftSpends.length !== 0 || body.permissions.length !== 2) {
    return reject('Unexpected spending permissions.');
  }

  const rawSpend = raw.spends[0] as RawSpend;
  const spendToken = addressValue(rawSpend.token);
  const spendAmount = numberValue(rawSpend.amount);
  const voidToken = getAddress(DEPLOY.testnet.VoidTestToken);
  if (spendToken !== voidToken || spendAmount === null) return reject('The market can spend only the signed VOID price.');

  let decoded: { functionName: string; args?: readonly unknown[] };
  try { decoded = decodeFunctionData({ abi: MARKET_ABI, data }); } catch { return reject('Invalid market call data.'); }
  const signedCost = decoded.functionName === 'buyRandom' ? numberValue(String(decoded.args?.[0])) : null;
  if (signedCost === null || signedCost !== spendAmount) return reject('Market price and signed spending budget do not match.');

  const permits = (body.permissions as RawPermit[]).map(permitValue);
  if (permits.some((permit) => permit === null)) return reject('Invalid permit.');
  const [paymasterPermit, runtimePermit] = permits as Permit[];
  const paymaster = getAddress(DEPLOY.production.VoidPaymaster);
  const runtime = getAddress(DEPLOY.production.VoidChainAppRuntime);
  if (
    paymasterPermit.spender !== paymaster || paymasterPermit.value !== maxToll + maxGasVoid || paymasterPermit.deadline !== deadline
    || runtimePermit.spender !== runtime || runtimePermit.value !== signedCost || runtimePermit.deadline !== deadline
  ) return reject('Permit limits do not match this market purchase.');

  const [chainNonce, currentPrice, currentToll] = await Promise.all([
    publicClient.readContract({ address: paymaster, abi: PAYMASTER_ABI, functionName: 'nonces', args: [user] }),
    publicClient.readContract({ address: getAddress(DEPLOY.testnet.VoidNftAmm), abi: AMM_ABI, functionName: 'priceToBuy', args: [false] }),
    publicClient.readContract({ address: runtime, abi: RUNTIME_ABI, functionName: 'feeOf', args: [deployment.chainId] }),
  ]);
  if (nonce !== chainNonce || signedCost !== currentPrice || maxToll !== currentToll) {
    return reject('Quote changed or was already used; sign a new one.');
  }

  const request = {
    user, tokenId, target, data, maxToll, maxGasVoid, callGasLimit,
    spends: [{ token: voidToken, amount: signedCost }],
    nftSpends: [] as { collection: Address; tokenId: bigint }[], nonce, deadline,
  };
  const encoded = encodeFunctionData({
    abi: PAYMASTER_ABI,
    functionName: 'sponsorWithPermit',
    args: [request, signature, [paymasterPermit, runtimePermit]],
  });

  try {
    recentUsers.set(user.toLowerCase(), Date.now());
    const account = privateKeyToAccount(relayerKey as Hex);
    const wallet = createWalletClient({ account, transport: http(RH_TESTNET.rpcUrls[0]) });
    const hash = await wallet.sendTransaction({ account, chain: null, to: paymaster, data: encoded });
    return NextResponse.json({ hash });
  } catch {
    recentUsers.delete(user.toLowerCase());
    return reject('The relay did not accept this request. Sign a fresh quote and try again.', 502);
  }
}
