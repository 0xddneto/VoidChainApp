import { NextResponse } from 'next/server';
import { createPublicClient, createWalletClient, encodeFunctionData, fallback, getAddress, http, isAddress, parseAbi, toFunctionSelector, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DEX, MAX_GAS_VOID, CALL_GAS_LIMIT } from '../dex-config';
import { RelayAdmissionError, relayClientId, reserveRelay } from '../relay-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RUNTIME = DEX.runtime;
const PAYMASTER = DEX.paymaster;
const VOID = DEX.voidToken;
const PAIRS = new Set(DEX.pools.map(pool => pool.address.toLowerCase()));
const FAUCET = DEX.faucet.toLowerCase();
const pairAbi = parseAbi(['function swap(bool,uint256,uint256)', 'function addLiquidity(uint256,uint256,uint256)', 'function removeLiquidity(uint256,uint256,uint256)']);
const faucetAbi = parseAbi(['function claim()']);
const selectors = new Set([
  toFunctionSelector('swap(bool,uint256,uint256)'),
  toFunctionSelector('addLiquidity(uint256,uint256,uint256)'),
  toFunctionSelector('removeLiquidity(uint256,uint256,uint256)'),
]);
const faucetSelector = toFunctionSelector('claim()');
const readAbi = parseAbi(['function nonces(address) view returns(uint256)', 'function feeOf(uint256) view returns(uint256)']);
const paymasterAbi = parseAbi(['function sponsorWithAssetPermits((address user,uint256 tokenId,address target,bytes data,uint256 maxToll,uint256 maxGasVoid,uint256 callGasLimit,(address token,uint256 amount)[] spends,(address collection,uint256 tokenId)[] nftSpends,uint256 nonce,uint256 deadline),bytes,(address token,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)[]) returns(bool,bytes)']);
const transport = fallback(DEX.rpcUrls.map((url) => http(url)));
const rpc = createPublicClient({ transport });
const MAX_DEADLINE_SECONDS = 630n;

type Raw = Record<string, unknown>;
const asAddress = (value: unknown): Address | null => typeof value === 'string' && isAddress(value) ? getAddress(value) : null;
const asUint = (value: unknown): bigint | null => typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : null;
const asHex = (value: unknown): Hex | null => typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value) ? value as Hex : null;
const reject = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** Relays only a signed, bounded Chain #1 DEX action. */
export async function POST(request: Request) {
  const key = process.env.PAYMASTER_RELAYER_PRIVATE_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) return reject('VOID relay is not configured.', 503);
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(contentLength) || contentLength > 65_536) return reject('Relay request is too large.', 413);
  let body: Raw;
  try { body = await request.json() as Raw; } catch { return reject('Malformed relay request.'); }
  const raw = body.request as Raw | undefined;
  const rawPermits = body.permits;
  const signature = asHex(body.signature);
  if (!raw || !Array.isArray(rawPermits) || rawPermits.length > 3 || !signature || signature.length !== 132) return reject('Invalid signed request.');

  const user = asAddress(raw.user); const target = asAddress(raw.target); const data = asHex(raw.data);
  const tokenId = asUint(raw.tokenId); const maxToll = asUint(raw.maxToll); const maxGasVoid = asUint(raw.maxGasVoid);
  const callGasLimit = asUint(raw.callGasLimit); const nonce = asUint(raw.nonce); const deadline = asUint(raw.deadline);
  const spendsRaw = raw.spends;
  if (!user || !target || !data || data.length > 4_098 || tokenId !== 1n || maxToll === null || maxGasVoid !== MAX_GAS_VOID || callGasLimit !== CALL_GAS_LIMIT || nonce === null || deadline === null || !Array.isArray(spendsRaw)) return reject('Invalid DEX limits.');
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= now || deadline > now + MAX_DEADLINE_SECONDS) return reject('Signature expired.');
  const selector = data.slice(0, 10) as Hex;
  const isPair = PAIRS.has(target.toLowerCase());
  if (!((isPair && selectors.has(selector)) || (target.toLowerCase() === FAUCET && selector === faucetSelector))) return reject('Only registered DEX methods can be relayed.');

  const spends: Array<{ token: Address; amount: bigint }> = [];
  for (const item of spendsRaw) {
    const spend = item as Raw; const token = asAddress(spend.token); const amount = asUint(spend.amount);
    if (!token || amount === null || amount === 0n || spends.some((known) => known.token === token)) return reject('Invalid app budget.');
    spends.push({ token, amount });
  }
  if (spends.length > 2) return reject('Too many app token budgets.');

  const permits = [] as Array<{ token: Address; spender: Address; value: bigint; deadline: bigint; v: number; r: Hex; s: Hex }>;
  for (const item of rawPermits) {
    const permit = item as Raw; const token = asAddress(permit.token); const spender = asAddress(permit.spender); const value = asUint(permit.value); const permitDeadline = asUint(permit.deadline); const r = asHex(permit.r); const s = asHex(permit.s); const v = permit.v;
    if (!token || !spender || value === null || permitDeadline !== deadline || !r || !s || typeof v !== 'number' || (v !== 27 && v !== 28)) return reject('Invalid token permit.');
    if (permits.some((known) => known.token === token && known.spender === spender)) return reject('Duplicate token permit.');
    permits.push({ token, spender, value, deadline: permitDeadline, v, r: r as Hex, s: s as Hex });
  }
  const required = new Map<string, bigint>([[`${VOID}:${PAYMASTER}`.toLowerCase(), maxToll + maxGasVoid]]);
  for (const spend of spends) required.set(`${spend.token}:${RUNTIME}`.toLowerCase(), spend.amount);
  if (permits.some((permit) => {
    const needed = required.get(`${permit.token}:${permit.spender}`.toLowerCase());
    return needed === undefined || permit.value < needed;
  })) return reject('Permit does not cover a required VOID or app budget.');

  const [chainNonce, fee] = await Promise.all([
    rpc.readContract({ address: PAYMASTER, abi: readAbi, functionName: 'nonces', args: [user] }),
    rpc.readContract({ address: RUNTIME, abi: readAbi, functionName: 'feeOf', args: [1n] }),
  ]);
  if (nonce !== chainNonce || maxToll !== fee) return reject('Quote changed; sign again.', 409);

  const sponsored = { user, tokenId, target, data, maxToll, maxGasVoid, callGasLimit, spends, nftSpends: [], nonce, deadline };
  let reservation: Awaited<ReturnType<typeof reserveRelay>>;
  try {
    reservation = await reserveRelay('voiddex', user, nonce, signature, relayClientId(request));
  } catch (error) {
    if (error instanceof RelayAdmissionError) return reject(error.message, error.status);
    return reject('Relay admission control is unavailable.', 503);
  }
  try {
    const account = privateKeyToAccount(key as Hex);
    const wallet = createWalletClient({ account, transport });
    const simulation = await rpc.simulateContract({ account, address: PAYMASTER, abi: paymasterAbi, functionName: 'sponsorWithAssetPermits', args: [sponsored, signature, permits] });
    if (!simulation.result[0]) {
      await reservation.failed();
      return reject('The DEX action would fail. No transaction was sent.', 409);
    }
    const hash = await wallet.sendTransaction({ account, chain: null, to: PAYMASTER, data: encodeFunctionData({ abi: paymasterAbi, functionName: 'sponsorWithAssetPermits', args: [sponsored, signature, permits] }) });
    await reservation.submitted(hash);
    return NextResponse.json({ hash });
  } catch {
    await reservation.failed().catch(() => undefined);
    return reject('Relay refused the signed action. Sign a new request and try again.', 502);
  }
}
