/**
 * Definitive testnet load proof for the DEX published on VOID Chain #1.
 *
 * It creates disposable wallets only in process, funds their Robinhood testnet
 * gas from the governance wallet, has each wallet sign its own approvals and
 * runtime calls, then returns unused ETH before forgetting the private keys.
 * No secret is printed or written to disk.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, encodeFunctionData, formatEther,
  http, parseAbi, parseEther, type Address, type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const deployment = JSON.parse(readFileSync(resolve(root, 'web/lib/deployment.json'), 'utf8'));
const dex = JSON.parse(readFileSync(resolve(root, 'web/lib/dex-chain1.json'), 'utf8')) as {
  chainTokenId: number; runtime: Address; baseToken: Address;
  pools: Array<{ address: Address; token0: Address; token1: Address; label: string }>;
};
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw new Error('DEPLOYER_PRIVATE_KEY is required.');

const CHAIN = BigInt(dex.chainTokenId);
const USER_COUNT = 12;
const SWAPS_PER_USER = 16;
const ETH_PER_USER = parseEther('0.001');
const RECOVERY_BUFFER = parseEther('0.00002');
const VOID_PER_USER = parseEther('5000');
const ASSET_PER_USER = parseEther('5000');
const SWAP_AMOUNT = parseEther('25');
const CALL_GAS_LIMIT = 800_000n;

const rpc = createPublicClient({ transport: http(process.env.PARENT_RPC ?? deployment.network.rpc) });
const governor = privateKeyToAccount(key as Hex);
const govWallet = createWalletClient({ account: governor, transport: http(process.env.PARENT_RPC ?? deployment.network.rpc) });
const runtime = dex.runtime as Address;
const voidToken = dex.baseToken as Address;
const treasury = deployment.production.VoidChainTreasury as Address;
const deed = deployment.production.VoidChainDeed as Address;
const protocolTreasury = deployment.governance.protocolTreasury as Address;

const erc20 = parseAbi([
  'function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
const runtimeAbi = parseAbi([
  'function feeOf(uint256) view returns (uint256)', 'function statsOf(uint256) view returns (bool,uint256,uint256,uint256,uint256)',
  'function protocolAccrued() view returns (uint256)', 'function flush(uint256) returns (uint256)', 'function sweepProtocol() returns (uint256)',
  'function executeWithBudget(uint256,address,bytes,uint256,(address[] tokens,uint256[] limits,address[] collections,uint256[] nftIds)) returns (bytes)',
]);
const pairAbi = parseAbi([
  'function reserve0() view returns (uint256)', 'function reserve1() view returns (uint256)', 'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)', 'function k() view returns (uint256)',
  'function quote(bool,uint256) view returns (uint256)', 'function addLiquidity(uint256,uint256,uint256) returns (uint256)',
  'function swap(bool,uint256,uint256) returns (uint256)',
]);
const treasuryAbi = parseAbi(['function claimable(address) view returns (uint256)']);
const deedAbi = parseAbi(['function ownerOf(uint256) view returns (address)']);

async function ceiling() { return (await rpc.getGasPrice()) * 3n; }
async function wait(hash: Hex, label: string) {
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  return receipt;
}
async function govWrite(to: Address, abi: typeof runtimeAbi | typeof erc20, functionName: string, args: unknown[]) {
  const hash = await govWallet.writeContract({ account: governor, chain: null, address: to, abi, functionName, args, gas: CALL_GAS_LIMIT, maxFeePerGas: await ceiling(), maxPriorityFeePerGas: 0n } as never);
  return wait(hash, functionName);
}
async function userWrite(key: Hex, to: Address, abi: typeof runtimeAbi | typeof erc20, functionName: string, args: unknown[]) {
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, transport: http(process.env.PARENT_RPC ?? deployment.network.rpc) });
  const hash = await wallet.writeContract({ account, chain: null, address: to, abi, functionName, args, gas: CALL_GAS_LIMIT, maxFeePerGas: await ceiling(), maxPriorityFeePerGas: 0n } as never);
  return wait(hash, functionName);
}
function auth(tokens: Address[], limits: bigint[]) { return { tokens, limits, collections: [] as Address[], nftIds: [] as bigint[] }; }
function minShares(amount0: bigint, amount1: bigint, reserve0: bigint, reserve1: bigint, total: bigint) {
  const raw = total === 0n ? sqrt(amount0 * amount1) - 1_000n : (amount0 * total / reserve0) < (amount1 * total / reserve1) ? (amount0 * total / reserve0) : (amount1 * total / reserve1);
  return raw * 9_950n / 10_000n;
}
function sqrt(value: bigint): bigint { if (!value) return 0n; let x = value; let y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + value / x) / 2n; } return x; }

console.log('\nVOID CHAIN #1 — DEX DEFINITIVE TESTNET LOAD\n');
if (await rpc.getChainId() !== 46_630) throw new Error('Refusing to run outside Robinhood testnet.');
const owner = await rpc.readContract({ address: deed, abi: deedAbi, functionName: 'ownerOf', args: [CHAIN] }) as Address;
const [beforeStats, beforeProtocol, beforeOwnerClaim, beforeTreasuryBalance, initialK] = await Promise.all([
  rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'statsOf', args: [CHAIN] }) as Promise<readonly [boolean, bigint, bigint, bigint, bigint]>,
  rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'protocolAccrued' }) as Promise<bigint>,
  rpc.readContract({ address: treasury, abi: treasuryAbi, functionName: 'claimable', args: [owner] }) as Promise<bigint>,
  rpc.readContract({ address: voidToken, abi: erc20, functionName: 'balanceOf', args: [protocolTreasury] }) as Promise<bigint>,
  Promise.all(dex.pools.map((pool) => rpc.readContract({ address: pool.address, abi: pairAbi, functionName: 'k' }) as Promise<bigint>)),
]);
if (!beforeStats[0]) throw new Error('Chain #1 is not active.');
const fee = await rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'feeOf', args: [CHAIN] }) as bigint;
if (fee === 0n) throw new Error('Chain fee is zero; this cannot prove fee accounting.');

const users = Array.from({ length: USER_COUNT }, () => ({ key: generatePrivateKey(), address: undefined as Address | undefined }));
for (const user of users) user.address = privateKeyToAccount(user.key).address;
console.log(`[1/5] Funding ${USER_COUNT} disposable wallets from governance`);
for (const user of users) {
  await wait(await govWallet.sendTransaction({ account: governor, chain: null, to: user.address!, value: ETH_PER_USER, maxFeePerGas: await ceiling(), maxPriorityFeePerGas: 0n }), 'fund user');
  await govWrite(voidToken, erc20, 'transfer', [user.address!, VOID_PER_USER]);
  for (const pool of dex.pools) {
    const asset = pool.token0.toLowerCase() === voidToken.toLowerCase() ? pool.token1 : pool.token0;
    await govWrite(asset, erc20, 'transfer', [user.address!, ASSET_PER_USER]);
  }
}

async function approveExact(user: Hex, token: Address, amount: bigint) {
  // Every approval is consumed by the immediately following runtime call.
  // No test wallet leaves an unlimited or reusable application allowance.
  await userWrite(user, token, erc20, 'approve', [runtime, amount]);
}

console.log('[2/5] Every DEX call will receive its own exact token allowance');

console.log('[3/5] Each wallet adds liquidity through the runtime');
for (let i = 0; i < users.length; i++) {
  const pool = dex.pools[i % dex.pools.length];
  const [reserve0, reserve1, total] = await Promise.all([
    rpc.readContract({ address: pool.address, abi: pairAbi, functionName: 'reserve0' }) as Promise<bigint>,
    rpc.readContract({ address: pool.address, abi: pairAbi, functionName: 'reserve1' }) as Promise<bigint>,
    rpc.readContract({ address: pool.address, abi: pairAbi, functionName: 'totalSupply' }) as Promise<bigint>,
  ]);
  const amount0 = parseEther('250');
  const amount1 = amount0 * reserve1 / reserve0;
  const voidNeeded = (pool.token0.toLowerCase() === voidToken.toLowerCase() ? amount0 : pool.token1.toLowerCase() === voidToken.toLowerCase() ? amount1 : 0n) + fee;
  await approveExact(users[i].key, voidToken, voidNeeded);
  if (pool.token0.toLowerCase() !== voidToken.toLowerCase()) await approveExact(users[i].key, pool.token0, amount0);
  if (pool.token1.toLowerCase() !== voidToken.toLowerCase()) await approveExact(users[i].key, pool.token1, amount1);
  const data = encodeFunctionData({ abi: pairAbi, functionName: 'addLiquidity', args: [amount0, amount1, minShares(amount0, amount1, reserve0, reserve1, total)] });
  await userWrite(users[i].key, runtime, runtimeAbi, 'executeWithBudget', [CHAIN, pool.address, data, fee, auth([pool.token0, pool.token1], [amount0, amount1])]);
}

console.log(`[4/5] Running ${USER_COUNT * SWAPS_PER_USER} wallet-signed swaps`);
let completed = 0;
for (let i = 0; i < users.length; i++) {
  for (let step = 0; step < SWAPS_PER_USER; step++) {
    const pool = dex.pools[(i + step) % dex.pools.length];
    const zeroForOne = (i + step) % 2 === 0;
    const expected = await rpc.readContract({ address: pool.address, abi: pairAbi, functionName: 'quote', args: [zeroForOne, SWAP_AMOUNT] }) as bigint;
    if (expected === 0n) throw new Error(`Pool ${pool.label} has no quote.`);
    const data = encodeFunctionData({ abi: pairAbi, functionName: 'swap', args: [zeroForOne, SWAP_AMOUNT, expected * 9_950n / 10_000n] });
    const input = zeroForOne ? pool.token0 : pool.token1;
    await approveExact(users[i].key, voidToken, (input.toLowerCase() === voidToken.toLowerCase() ? SWAP_AMOUNT : 0n) + fee);
    if (input.toLowerCase() !== voidToken.toLowerCase()) await approveExact(users[i].key, input, SWAP_AMOUNT);
    await userWrite(users[i].key, runtime, runtimeAbi, 'executeWithBudget', [CHAIN, pool.address, data, fee, auth([input], [SWAP_AMOUNT])]);
    completed++;
  }
  console.log(`  wallet ${i + 1}/${USER_COUNT} complete · ${completed} swaps`);
}

console.log('[5/5] Settling owner and protocol revenue, then recovering unused ETH');
await govWrite(runtime, runtimeAbi, 'flush', [CHAIN]);
await govWrite(runtime, runtimeAbi, 'sweepProtocol', []);
for (const user of users) {
  const balance = await rpc.getBalance({ address: user.address! });
  // Native ETH needs a normal signed transfer, not an ERC-20 transfer.
  if (balance > RECOVERY_BUFFER) {
    const account = privateKeyToAccount(user.key);
    const wallet = createWalletClient({ account, transport: http(process.env.PARENT_RPC ?? deployment.network.rpc) });
    await wait(await wallet.sendTransaction({ account, chain: null, to: governor.address, value: balance - RECOVERY_BUFFER, maxFeePerGas: await ceiling(), maxPriorityFeePerGas: 0n }), 'recover unused ETH');
  }
}

const [afterStats, afterProtocol, afterOwnerClaim, afterTreasuryBalance, finalK] = await Promise.all([
  rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'statsOf', args: [CHAIN] }) as Promise<readonly [boolean, bigint, bigint, bigint, bigint]>,
  rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'protocolAccrued' }) as Promise<bigint>,
  rpc.readContract({ address: treasury, abi: treasuryAbi, functionName: 'claimable', args: [owner] }) as Promise<bigint>,
  rpc.readContract({ address: voidToken, abi: erc20, functionName: 'balanceOf', args: [protocolTreasury] }) as Promise<bigint>,
  Promise.all(dex.pools.map((pool) => rpc.readContract({ address: pool.address, abi: pairAbi, functionName: 'k' }) as Promise<bigint>)),
]);
const expectedCalls = BigInt(USER_COUNT * (SWAPS_PER_USER + 1));
if (afterStats[4] - beforeStats[4] !== expectedCalls) throw new Error(`Expected ${expectedCalls} runtime calls, got ${afterStats[4] - beforeStats[4]}.`);
if (afterStats[3] - beforeStats[3] !== expectedCalls * fee) throw new Error('Lifetime chain revenue does not match the charged calls.');
if (afterProtocol !== 0n) throw new Error('Protocol revenue was not swept.');
if (afterOwnerClaim <= beforeOwnerClaim) throw new Error('Owner did not receive a treasury claim.');
if (afterTreasuryBalance <= beforeTreasuryBalance) throw new Error('Protocol treasury did not receive VOID.');
for (let i = 0; i < initialK.length; i++) if (finalK[i] < initialK[i]) throw new Error(`Pool ${i} invariant shrank.`);

console.log('\n✓ DEFINITIVE TESTNET LOAD COMPLETE');
console.log(`  signed DEX calls: ${expectedCalls}`);
console.log(`  charged revenue:  ${formatEther(afterStats[3] - beforeStats[3])} VOID`);
console.log(`  owner claimable:  ${formatEther(afterOwnerClaim - beforeOwnerClaim)} VOID`);
console.log(`  protocol sent:    ${formatEther(afterTreasuryBalance - beforeTreasuryBalance)} VOID`);
