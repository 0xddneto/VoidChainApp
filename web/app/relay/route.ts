import { NextResponse } from 'next/server';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  isAddress,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { BodyError, readJsonObject } from '@/lib/request-body';
import { authenticSponsored } from '@/lib/verify-sponsored';
import { DEPLOY, rhTransport } from '@/lib/testnet';
import { RelayAdmissionError, relayClientId, reserveRelay, admitRelayIngress } from '@/lib/relay-guard';
import { submitDurably } from '@/lib/durable-relay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_CALL_GAS_LIMIT = 1_500_000n;
const MAX_GAS_VOID = 100n * 10n ** 18n;
const MAX_SIGNATURE_LIFETIME_SECONDS = 630n;
const publicClient = createPublicClient({ transport: rhTransport() });

const RUNTIME_ABI = parseAbi([
  'function feeOf(uint256) view returns(uint256)',
  'function belongsTo(uint256,address) view returns(bool)',
]);
const PAYMASTER_ABI = parseAbi([
  'function nonces(address) view returns(uint256)',
  'function sponsorWithAssetPermits((address user,uint256 tokenId,address target,bytes data,uint256 maxToll,uint256 maxGasVoid,uint256 callGasLimit,(address token,uint256 amount)[] spends,(address collection,uint256 tokenId)[] nftSpends,uint256 nonce,uint256 deadline),bytes,(address token,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)[]) returns(bool,bytes)',
]);

type Raw = Record<string, unknown>;
type Spend = { token: Address; amount: bigint };
type NftSpend = { collection: Address; tokenId: bigint };
type AssetPermit = { token: Address; spender: Address; value: bigint; deadline: bigint; v: number; r: Hex; s: Hex };

const asAddress = (value: unknown): Address | null => typeof value === 'string' && isAddress(value) ? getAddress(value) : null;
const asUint = (value: unknown): bigint | null => typeof value === 'string' && /^\d{1,78}$/.test(value) && BigInt(value) < (1n << 256n) ? BigInt(value) : null;
const asHex = (value: unknown): Hex | null => typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value) ? value as Hex : null;
const reject = (error: string, status = 400) => NextResponse.json({ error }, { status });

/**
 * Generic official execution gateway for every canonical ChainApp.
 *
 * The request is signed by the user and the contracts re-check every bound.
 * This route never chooses an app, token amount, fee, recipient or chain: it
 * only relays an already-signed request to a registered app in the active
 * runtime. The browser therefore has no wallet transaction path to ETH gas.
 */
export async function POST(httpRequest: Request) {
  const relayerKey = process.env.VOIDSCAN_RELAYER_PRIVATE_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(relayerKey ?? '')) return reject('VOID relay is not configured.', 503);
  const contentLength = Number(httpRequest.headers.get('content-length') ?? '0');
  if (!Number.isFinite(contentLength) || contentLength > 65_536) return reject('Relay request is too large.', 413);

  let body: Raw;
  try { body = await readJsonObject(httpRequest, 65_536); } catch (error) { return reject(error instanceof BodyError ? error.message : 'Malformed relay request.', error instanceof BodyError ? error.status : 400); }
  const rawRequest = body.request as Raw | undefined;
  const rawPermits = body.permits;
  const signature = asHex(body.signature);
  if (!rawRequest || !Array.isArray(rawPermits) || rawPermits.length > 9 || !signature || signature.length !== 132) return reject('Invalid signed request.');

  const user = asAddress(rawRequest.user); const target = asAddress(rawRequest.target); const data = asHex(rawRequest.data);
  const tokenId = asUint(rawRequest.tokenId); const maxToll = asUint(rawRequest.maxToll); const maxGasVoid = asUint(rawRequest.maxGasVoid);
  const callGasLimit = asUint(rawRequest.callGasLimit); const nonce = asUint(rawRequest.nonce); const deadline = asUint(rawRequest.deadline);
  const rawSpends = rawRequest.spends; const rawNftSpends = rawRequest.nftSpends;
  if (!user || !target || !data || data.length > 49_154 || !tokenId || maxToll === null || maxGasVoid === null || callGasLimit === null || nonce === null || deadline === null || !Array.isArray(rawSpends) || !Array.isArray(rawNftSpends)) return reject('Invalid signed fields.');
  if (maxGasVoid > MAX_GAS_VOID || callGasLimit === 0n || callGasLimit > MAX_CALL_GAS_LIMIT) return reject('Gas limit exceeds the public relayer policy.');
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= now || deadline > now + MAX_SIGNATURE_LIFETIME_SECONDS) return reject('Signature expired.');

  const spends: Spend[] = [];
  for (const item of rawSpends) {
    if (!item || typeof item !== 'object') return reject('Invalid request item.'); const value = item as Raw; const token = asAddress(value.token); const amount = asUint(value.amount);
    if (!token || amount === null || amount === 0n || spends.some((known) => known.token === token)) return reject('Invalid app token budget.');
    spends.push({ token, amount });
  }
  if (spends.length > 8) return reject('Too many app token budgets.');

  const nftSpends: NftSpend[] = [];
  for (const item of rawNftSpends) {
    const value = item as Raw; const collection = asAddress(value.collection); const nftId = asUint(value.tokenId);
    if (!collection || nftId === null || nftSpends.some((known) => known.collection === collection && known.tokenId === nftId)) return reject('Invalid NFT budget.');
    nftSpends.push({ collection, tokenId: nftId });
  }
  if (nftSpends.length > 8) return reject('Too many NFT budgets.');

  const runtime = getAddress(DEPLOY.production.VoidChainAppRuntime);
  const paymaster = getAddress(DEPLOY.production.VoidPaymaster);
  const voidToken = getAddress(DEPLOY.testnet.VoidTestToken);
  const permits: AssetPermit[] = [];
  for (const item of rawPermits) {
    if (!item || typeof item !== 'object') return reject('Invalid asset permit.');
    const value = item as Raw;
    const token = asAddress(value.token); const spender = asAddress(value.spender); const amount = asUint(value.value); const permitDeadline = asUint(value.deadline);
    const r = asHex(value.r); const s = asHex(value.s); const v = value.v;
    if (!token || !spender || amount === null || permitDeadline !== deadline || !r || r.length !== 66 || !s || s.length !== 66 || typeof v !== 'number' || (v !== 27 && v !== 28)) return reject('Invalid asset permit.');
    if (permits.some((known) => known.token === token && known.spender === spender)) return reject('Duplicate asset permit.');
    permits.push({ token, spender, value: amount, deadline: permitDeadline, v, r, s });
  }
  const expected = new Map<string, bigint>([[`${voidToken}:${paymaster}`.toLowerCase(), maxToll + maxGasVoid]]);
  for (const spend of spends) expected.set(`${spend.token}:${runtime}`.toLowerCase(), spend.amount);
  if (permits.some((permit) => {
    const needed = expected.get(`${permit.token}:${permit.spender}`.toLowerCase());
    return needed === undefined || permit.value < needed;
  })) return reject('An asset permit does not cover a signed VOID or app budget.');

  const request = { user, tokenId, target, data, maxToll, maxGasVoid, callGasLimit, spends, nftSpends, nonce, deadline };
  try { await admitRelayIngress(relayClientId(httpRequest)); }
  catch (error) { return reject(error instanceof Error ? error.message : 'Relay unavailable.', error instanceof RelayAdmissionError ? error.status : 503); }
  if (!await authenticSponsored(request, signature, paymaster)) return reject('Invalid action signature.', 401);
  const [chainNonce, currentFee, registered] = await Promise.all([
    publicClient.readContract({ address: paymaster, abi: PAYMASTER_ABI, functionName: 'nonces', args: [user] }),
    publicClient.readContract({ address: runtime, abi: RUNTIME_ABI, functionName: 'feeOf', args: [tokenId] }),
    publicClient.readContract({ address: runtime, abi: RUNTIME_ABI, functionName: 'belongsTo', args: [tokenId, target] }),
  ]);
  if (!registered) return reject('Target is not a registered app of this VoidChain.');
  if (nonce !== chainNonce || maxToll !== currentFee) return reject('Fee or nonce changed; sign again.', 409);

  let reservation: Awaited<ReturnType<typeof reserveRelay>>;
  let broadcast = false;
  let broadcastHash: Hex | null = null;
  try {
    reservation = await reserveRelay('voidscan-app', paymaster, user, nonce, signature, relayClientId(httpRequest));
  } catch (error) {
    if (error instanceof RelayAdmissionError) return reject(error.message, error.status);
    return reject('Relay admission control is unavailable.', 503);
  }
  try {
    const account = privateKeyToAccount(relayerKey as Hex);
    const wallet = createWalletClient({ account, transport: rhTransport() });
    const simulation = await publicClient.simulateContract({
      account,
      address: paymaster,
      abi: PAYMASTER_ABI,
      functionName: 'sponsorWithAssetPermits',
      args: [request, signature, permits],
    });
    if (!simulation.result[0]) {
      await reservation.failed();
      return reject('The application action would fail. No transaction was sent.', 409);
    }
    const submission = await submitDurably(account.address, 'voidscan-app', {
      nonce: (blockTag) => publicClient.getTransactionCount({ address: account.address, blockTag }),
      prepare: async (nonce) => wallet.signTransaction({ ...await wallet.prepareTransactionRequest({
        account, chain: null, nonce, to: paymaster,
        data: encodeFunctionData({ abi: PAYMASTER_ABI, functionName: 'sponsorWithAssetPermits', args: [request, signature, permits] }),
      }), account, chain: null }),
      broadcast: (serializedTransaction) => publicClient.sendRawTransaction({ serializedTransaction }),
    });
    broadcast = true;
    broadcastHash = submission.hash;
    await reservation.submitted(submission.hash).catch(() => undefined);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: submission.hash, timeout: 45_000 });
    await submission.confirmed(receipt.status === 'success');
    if (receipt.status !== 'success') return reject('Sponsored transaction reverted.', 502);
    return NextResponse.json({ hash: submission.hash });
  } catch {
    if (broadcastHash) return NextResponse.json({ hash: broadcastHash, status: 'submitted' }, { status: 202 });
    if (!broadcast) await reservation.failed().catch(() => undefined);
    return reject('Relay refused the signed action. Sign a fresh request and try again.', 502);
  }
}
