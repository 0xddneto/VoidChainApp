import { NextResponse } from 'next/server';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
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
const PAYMASTER_ABI = parseAbi([
  'function nonces(address user) view returns (uint256)',
  'function sponsorMarketPrepaid((address user,address market,address paymentToken,string paymentSymbol,string purchaseLabel,uint256 appSpend,uint256 maxGasVoid,uint256 callGasLimit,uint256 nonce,uint256 deadline) request,bytes signature) returns (bool executed,bytes result)',
]);

type RawRequest = {
  user?: unknown; market?: unknown;
  paymentToken?: unknown; paymentSymbol?: unknown; purchaseLabel?: unknown; appSpend?: unknown; maxGasVoid?: unknown; callGasLimit?: unknown;
  nonce?: unknown; deadline?: unknown;
};

const recentUsers = new Map<string, number>();
const RATE_WINDOW_MS = 15_000;

function numberValue(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

function addressValue(value: unknown): Address | null {
  return typeof value === 'string' && isAddress(value) ? getAddress(value) : null;
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

  let body: { request?: RawRequest; signature?: unknown };
  try { body = await httpRequest.json(); } catch { return reject('Malformed request body.'); }
  const raw = body.request;
  if (!raw) {
    return reject('Invalid sponsored request.');
  }

  const user = addressValue(raw.user);
  const market = addressValue(raw.market);
  const paymentToken = addressValue(raw.paymentToken);
  const paymentSymbol = raw.paymentSymbol;
  const purchaseLabel = raw.purchaseLabel;
  const appSpend = numberValue(raw.appSpend);
  const maxGasVoid = numberValue(raw.maxGasVoid);
  const callGasLimit = numberValue(raw.callGasLimit);
  const nonce = numberValue(raw.nonce);
  const deadline = numberValue(raw.deadline);
  const signature = typeof body.signature === 'string' && /^0x[0-9a-fA-F]{130}$/.test(body.signature)
    ? body.signature as Hex
    : null;
  if (!user || !market || !paymentToken || paymentSymbol !== 'VOID' || purchaseLabel !== 'VOID deed mint' || appSpend === null || maxGasVoid === null || callGasLimit === null || nonce === null || deadline === null || !signature) {
    return reject('Invalid signed fields.');
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= now || deadline > now + MARKET_SIGNATURE_LIFETIME_SECONDS + 30n) {
    return reject('Signature expired; request a new quote.');
  }
  const previous = recentUsers.get(user.toLowerCase()) ?? 0;
  if (Date.now() - previous < RATE_WINDOW_MS) return reject('Please wait before relaying another purchase.', 429);

  if (market !== getAddress(deployment.market) || maxGasVoid !== MARKET_MAX_GAS_VOID || callGasLimit !== MARKET_CALL_GAS_LIMIT) {
    return reject('This route accepts only the bounded collection-market call.');
  }
  const voidToken = getAddress(DEPLOY.testnet.VoidTestToken);
  if (paymentToken !== voidToken) return reject('The market can be paid only in VOID.');

  const mintPaymaster = DEPLOY.production.VoidCollectionMintPaymaster;
  if (!mintPaymaster) return reject('Collection Mint Paymaster is not deployed on this testnet yet.', 503);
  const paymaster = getAddress(mintPaymaster);

  const [chainNonce, currentPrice] = await Promise.all([
    publicClient.readContract({ address: paymaster, abi: PAYMASTER_ABI, functionName: 'nonces', args: [user] }),
    publicClient.readContract({ address: getAddress(DEPLOY.testnet.VoidNftAmm), abi: AMM_ABI, functionName: 'priceToBuy', args: [false] }),
  ]);
  if (nonce !== chainNonce || appSpend !== currentPrice) {
    return reject('Quote changed or was already used; sign a new one.');
  }

  const request = {
    user, market, paymentToken: voidToken, paymentSymbol, purchaseLabel, appSpend,
    maxGasVoid, callGasLimit, nonce, deadline,
  };
  const encoded = encodeFunctionData({
    abi: PAYMASTER_ABI,
    functionName: 'sponsorMarketPrepaid',
    args: [request, signature],
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
