/**
 * Proves the mint page's flow works, the way the page itself does it.
 *
 * Usage:  npx tsx prove-purchase.ts
 *
 * A BRAND-NEW wallet, with zero of everything, does exactly what the page does:
 * gets VOID, approves the pool, buys a deed, and then uses the chain it bought.
 * If this passes, the page works — it calls the same contracts with the same
 * arguments.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, encodeFunctionData, formatEther,
  http, parseAbi, parseEther, type Address,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.PARENT_RPC ?? 'https://robinhood-testnet.drpc.org';
const here = dirname(fileURLToPath(import.meta.url));
const d = JSON.parse(readFileSync(resolve(here, 'deployments/testnet.json'), 'utf8'));
const parent = createPublicClient({ transport: http(RPC) });
const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`);
const dep = createWalletClient({ account: deployer, transport: http(RPC) });

const token = d.testnet.VoidTestToken as Address;
const amm = d.testnet.VoidNftAmm as Address;
const deed = d.production.VoidChainDeed as Address;
const runtime = d.production.VoidChainAppRuntime as Address;

const erc20 = parseAbi([
  'function mintTo(address,uint256)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
const ammAbi = parseAbi([
  'function available() view returns (uint256)',
  'function priceToBuy(bool) view returns (uint256)',
  'function buyRandom(uint256) returns (uint256)',
]);
const deedAbi = parseAbi(['function ownerOf(uint256) view returns (address)']);
const rtAbi = parseAbi([
  'function execute(uint256,address,bytes,uint256) returns (bytes)',
  'function statsOf(uint256) view returns (bool,uint256,uint256,uint256,uint256)',
  'function feeOf(uint256) view returns (uint256)',
]);

const ceiling = async () => (await parent.getGasPrice()) * 3n;

async function asUser(w: ReturnType<typeof createWalletClient>, acct: any,
                      to: Address, abi: any, fn: string, args: unknown[]) {
  const hash = await w.sendTransaction({
    account: acct, chain: null, to,
    data: encodeFunctionData({ abi, functionName: fn, args }),
    maxFeePerGas: await ceiling(), maxPriorityFeePerGas: 0n,
  });
  return parent.waitForTransactionReceipt({ hash });
}

const mark = (b: boolean) => (b ? '✓' : '✗');
let allOk = true;
const check = (b: boolean, m: string) => { if (!b) allOk = false; console.log(`    ${mark(b)} ${m}`); };

console.log('\n  WHAT THE PAGE DOES, DONE FOR REAL\n');

// A wallet that never existed.
const key = generatePrivateKey();
const user = privateKeyToAccount(key);
const uw = createWalletClient({ account: user, transport: http(RPC) });
console.log(`  new user: ${user.address}`);
console.log(`  their ETH: ${formatEther(await parent.getBalance({ address: user.address }))}\n`);

// They need ETH only for the transactions THEY send. The page does not hide
// this — what the bubble covers is the sponsored path, and buying from the pool
// is not one.
await parent.waitForTransactionReceipt({
  hash: await dep.sendTransaction({
    account: deployer, chain: null, to: user.address, value: parseEther('0.003'),
    maxFeePerGas: await ceiling(), maxPriorityFeePerGas: 0n,
  }),
});

// ---- step 2 of the page: get VOID -----------------------------------------
console.log('  [2] get VOID');
const FAUCET = 2_500_000n * 10n ** 18n;
await asUser(uw, user, token, erc20, 'mintTo', [user.address, FAUCET]);
const balance = await parent.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [user.address] }) as bigint;
check(balance === FAUCET, `balance: ${formatEther(balance)} VOID`);

// ---- step 3 of the page: approve and buy -----------------------------------
console.log('\n  [3] buy a deed');
const price = await parent.readContract({ address: amm, abi: ammAbi, functionName: 'priceToBuy', args: [false] }) as bigint;
const stockBefore = await parent.readContract({ address: amm, abi: ammAbi, functionName: 'available' }) as bigint;

await asUser(uw, user, token, erc20, 'approve', [amm, price * 10n]);
const r = await asUser(uw, user, amm, ammAbi, 'buyRandom', [price]);
check(r.status === 'success', `purchase confirmed (${formatEther(price)} VOID)`);

const stockAfter = await parent.readContract({ address: amm, abi: ammAbi, functionName: 'available' }) as bigint;
check(stockAfter === stockBefore - 1n, `stock: ${stockBefore} → ${stockAfter}`);

// Which deed did they get? FIFO says it is the oldest one in stock.
let bought = 0;
for (let i = 1; i <= d.parameters.nfts; i++) {
  const o = await parent.readContract({ address: deed, abi: deedAbi, functionName: 'ownerOf', args: [BigInt(i)] }) as string;
  if (o.toLowerCase() === user.address.toLowerCase()) { bought = i; break; }
}
check(bought > 0, `now owns deed #${bought}`);

// ---- what the purchase means: the chain answers to them --------------------
console.log('\n  [4] the chain answers to its new owner');
const stats = await parent.readContract({ address: runtime, abi: rtAbi, functionName: 'statsOf', args: [BigInt(bought)] }) as readonly [boolean, bigint, bigint, bigint, bigint];
check(stats[0], 'the chain is active');
const toll = await parent.readContract({ address: runtime, abi: rtAbi, functionName: 'feeOf', args: [BigInt(bought)] }) as bigint;
check(toll > 0n, `toll: $${formatEther(stats[1])} = ${formatEther(toll)} VOID at the current rate`);

const app = d.demoApps[String(bought)] as Address | undefined;
if (app) {
  const bump = encodeFunctionData({ abi: parseAbi(['function bump()']), functionName: 'bump' });
  await asUser(uw, user, token, erc20, 'approve', [runtime, toll * 100n]);
  const e = await asUser(uw, user, runtime, rtAbi, 'execute', [BigInt(bought), app, bump, toll]);
  check(e.status === 'success', 'used their own chain, paying their own toll');
  const s2 = await parent.readContract({ address: runtime, abi: rtAbi, functionName: 'statsOf', args: [BigInt(bought)] }) as readonly [boolean, bigint, bigint, bigint, bigint];
  check(s2[4] === 1n, `calls: ${s2[4]}`);
  check(s2[2] > 0n, `owner revenue pending: ${formatEther(s2[2])} VOID`);
} else {
  console.log(`    · deed #${bought} has no demo app; skipped the usage step`);
}

console.log(`\n  ${allOk ? "✓ THE PAGE'S FLOW WORKS" : '✗ SOMETHING FAILED ABOVE'}\n`);
