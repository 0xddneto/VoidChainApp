import { NextResponse } from 'next/server';
import {
  createPublicClient, createWalletClient, decodeFunctionData, decodeFunctionResult,
  encodeFunctionData, getAddress, isAddress, parseAbi,
  type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DEPLOY, rhTransport } from '@/lib/testnet';
import { RelayAdmissionError, relayClientId, reserveRelay } from '@/lib/relay-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MARKET = getAddress(DEPLOY.testnet.VoidGenesisNftAmmV6);
const VOID = getAddress(DEPLOY.testnet.VoidTestToken);
const DEED = getAddress(DEPLOY.production.VoidChainDeed);
const RUNTIME = getAddress(DEPLOY.production.VoidChainAppRuntime);
const PAYMASTER = getAddress(DEPLOY.production.VoidPaymaster);
const MAX_GAS_VOID = 10_000n * 10n ** 18n;
const CALL_GAS_LIMIT = 1_500_000n;
const MAX_DEADLINE_SECONDS = 630n;
const rpc = createPublicClient({ transport: rhTransport() });

const marketAbi = parseAbi([
  'function randomBuyQuote() view returns(uint256)',
  'function specificBuyQuote() view returns(uint256)',
  'function buyRandom(uint256) returns(uint256)',
  'function buySpecific(uint256,uint256)',
  'function sellWithPermit(uint256,uint256,uint8,bytes32,bytes32)',
]);
const readAbi = parseAbi(['function nonces(address) view returns(uint256)', 'function feeOf(uint256) view returns(uint256)']);
const paymasterAbi = parseAbi([
  'function sponsorWithAssetPermits((address user,uint256 tokenId,address target,bytes data,uint256 maxToll,uint256 maxGasVoid,uint256 callGasLimit,(address token,uint256 amount)[] spends,(address collection,uint256 tokenId)[] nftSpends,uint256 nonce,uint256 deadline),bytes,(address token,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)[]) returns(bool,bytes)',
]);
const gatewayAbi = parseAbi(['function query(bytes) view returns(bytes)']);

type Raw = Record<string, unknown>;
const reject = (error: string, status = 400) => NextResponse.json({ error }, { status });
const asAddress = (value: unknown): Address | null => typeof value === 'string' && isAddress(value) ? getAddress(value) : null;
const asUint = (value: unknown): bigint | null => typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : null;
const asHex = (value: unknown): Hex | null => typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value) ? value as Hex : null;

async function quote(functionName: 'randomBuyQuote' | 'specificBuyQuote') {
  const call = encodeFunctionData({ abi: marketAbi, functionName });
  const raw = await rpc.readContract({ address: MARKET, abi: gatewayAbi, functionName: 'query', args: [call] });
  return decodeFunctionResult({ abi: marketAbi, functionName, data: raw }) as bigint;
}

/** Relays only the three published NFT/VOID market actions. */
export async function POST(request: Request) {
  const key = process.env.PAYMASTER_RELAYER_PRIVATE_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) return reject('VOID relay is not configured.', 503);
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(contentLength) || contentLength > 65_536) return reject('Relay request is too large.', 413);

  let body: Raw;
  try { body = await request.json() as Raw; } catch { return reject('Malformed relay request.'); }
  const raw = body.request as Raw | undefined;
  const signature = asHex(body.signature);
  const rawPermits = body.permits;
  if (!raw || !signature || signature.length !== 132 || !Array.isArray(rawPermits) || rawPermits.length > 3) return reject('Invalid signed request.');

  const user = asAddress(raw.user); const target = asAddress(raw.target); const data = asHex(raw.data);
  const tokenId = asUint(raw.tokenId); const maxToll = asUint(raw.maxToll); const maxGasVoid = asUint(raw.maxGasVoid);
  const callGasLimit = asUint(raw.callGasLimit); const nonce = asUint(raw.nonce); const deadline = asUint(raw.deadline);
  if (!user || target !== MARKET || !data || data.length > 4_098 || tokenId !== 1n || maxToll === null || maxGasVoid !== MAX_GAS_VOID || callGasLimit !== CALL_GAS_LIMIT || nonce === null || deadline === null) return reject('Invalid market limits.');
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= now || deadline > now + MAX_DEADLINE_SECONDS) return reject('Signature expired.');

  const spends = [] as Array<{ token: Address; amount: bigint }>;
  for (const item of Array.isArray(raw.spends) ? raw.spends : []) {
    const value = item as Raw; const token = asAddress(value.token); const amount = asUint(value.amount);
    if (!token || amount === null || amount === 0n || spends.length >= 1) return reject('Invalid VOID budget.');
    spends.push({ token, amount });
  }
  const nftSpends = [] as Array<{ collection: Address; tokenId: bigint }>;
  for (const item of Array.isArray(raw.nftSpends) ? raw.nftSpends : []) {
    const value = item as Raw; const collection = asAddress(value.collection); const id = asUint(value.tokenId);
    if (!collection || id === null || nftSpends.length >= 1) return reject('Invalid Deed budget.');
    nftSpends.push({ collection, tokenId: id });
  }

  let decoded: ReturnType<typeof decodeFunctionData<typeof marketAbi>>;
  try { decoded = decodeFunctionData({ abi: marketAbi, data }); } catch { return reject('Unknown market action.'); }
  if (decoded.functionName === 'buyRandom' || decoded.functionName === 'buySpecific') {
    const expected = await quote(decoded.functionName === 'buyRandom' ? 'randomBuyQuote' : 'specificBuyQuote');
    const maximum = decoded.args?.[decoded.functionName === 'buyRandom' ? 0 : 1] as bigint;
    if (maximum !== expected || spends.length !== 1 || spends[0].token !== VOID || spends[0].amount !== expected || nftSpends.length !== 0) return reject('Buy budget does not match the current VOID quote.', 409);
  } else if (decoded.functionName === 'sellWithPermit') {
    const deedId = decoded.args?.[0] as bigint;
    const permitDeadline = decoded.args?.[1] as bigint;
    if (spends.length !== 0 || nftSpends.length !== 1 || nftSpends[0].collection !== DEED || nftSpends[0].tokenId !== deedId || permitDeadline !== deadline) return reject('Sale does not match the signed Deed budget.');
  } else return reject('Unknown market action.');

  const permits = [] as Array<{ token: Address; spender: Address; value: bigint; deadline: bigint; v: number; r: Hex; s: Hex }>;
  for (const item of rawPermits) {
    const value = item as Raw; const token = asAddress(value.token); const spender = asAddress(value.spender);
    const amount = asUint(value.value); const permitDeadline = asUint(value.deadline);
    const r = asHex(value.r); const s = asHex(value.s); const v = value.v;
    if (!token || !spender || amount === null || permitDeadline !== deadline || !r || !s || typeof v !== 'number' || (v !== 27 && v !== 28)) return reject('Invalid token permit.');
    if (permits.some((known) => known.token === token && known.spender === spender)) return reject('Duplicate token permit.');
    permits.push({ token, spender, value: amount, deadline: permitDeadline, v, r, s });
  }
  const required = new Map<string, bigint>([[`${VOID}:${PAYMASTER}`.toLowerCase(), maxToll + maxGasVoid]]);
  for (const spend of spends) required.set(`${spend.token}:${RUNTIME}`.toLowerCase(), spend.amount);
  if (permits.some((permit) => {
    const needed = required.get(`${permit.token}:${permit.spender}`.toLowerCase());
    return needed === undefined || permit.value < needed;
  })) return reject('A token permit does not cover a required VOID budget.');

  const [currentNonce, fee, balance] = await Promise.all([
    rpc.readContract({ address: PAYMASTER, abi: readAbi, functionName: 'nonces', args: [user] }),
    rpc.readContract({ address: RUNTIME, abi: readAbi, functionName: 'feeOf', args: [1n] }),
    rpc.readContract({ address: VOID, abi: parseAbi(['function balanceOf(address) view returns(uint256)']), functionName: 'balanceOf', args: [user] }),
  ]);
  if (nonce !== currentNonce || maxToll !== fee) return reject('Quote changed; sign again.', 409);
  if (balance < maxToll + maxGasVoid + spends.reduce((sum, spend) => sum + spend.amount, 0n)) {
    return reject('Insufficient VOID for the NFT price, chain fee and refundable gas budget. Get VOID before signing again.', 409);
  }

  let reservation: Awaited<ReturnType<typeof reserveRelay>>;
  try {
    reservation = await reserveRelay('voidscan-market', user, nonce, signature, relayClientId(request));
  } catch (error) {
    if (error instanceof RelayAdmissionError) return reject(error.message, error.status);
    return reject('Relay admission control is unavailable.', 503);
  }
  try {
    const account = privateKeyToAccount(key as Hex);
    const wallet = createWalletClient({ account, transport: rhTransport() });
    const sponsored = { user, tokenId, target, data, maxToll, maxGasVoid, callGasLimit, spends, nftSpends, nonce, deadline };
    // The Paymaster catches app reverts. Estimating transaction gas alone
    // therefore cannot establish that the requested trade will execute.
    const simulation = await rpc.simulateContract({
      account, address: PAYMASTER, abi: paymasterAbi,
      functionName: 'sponsorWithAssetPermits', args: [sponsored, signature, permits],
    });
    if (!simulation.result[0]) {
      await reservation.failed();
      return reject('The market operation would fail. No transaction was sent.', 409);
    }
    const hash = await wallet.sendTransaction({ account, chain: null, to: PAYMASTER, data: encodeFunctionData({ abi: paymasterAbi, functionName: 'sponsorWithAssetPermits', args: [sponsored, signature, permits] }) });
    await reservation.submitted(hash);
    return NextResponse.json({ hash });
  } catch (error) {
    await reservation.failed().catch(() => undefined);
    console.error('Market relay failed', error instanceof Error ? error.name : 'UnknownError');
    return reject('Relay refused the signed market action.', 502);
  }
}
