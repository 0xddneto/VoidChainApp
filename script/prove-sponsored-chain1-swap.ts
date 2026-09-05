/**
 * Proves the actual VOID-chain UX: an account with zero ETH signs permits and
 * a bounded Runtime request; a relayer sends the transaction; the Chain #1
 * fee is paid in VOID and reaches the holder/protocol accounting.
 *
 * The disposable key exists only in this process and is never printed or saved.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi,
  parseEther, type Address, type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deployment = JSON.parse(readFileSync(resolve(root, 'web/lib/deployment.json'), 'utf8'));
const dex = JSON.parse(readFileSync(resolve(root, 'web/lib/dex-chain1-v11.json'), 'utf8')) as {
  chainTokenId: number; runtime: Address; baseToken: Address;
  pools: Array<{ address: Address; token0: Address; token1: Address }>;
};
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw new Error('DEPLOYER_PRIVATE_KEY is required.');

const rpcUrl = process.env.PARENT_RPC ?? deployment.network.rpc;
const rpc = createPublicClient({ transport: http(rpcUrl) });
const relayer = privateKeyToAccount(key as Hex);
const wallet = createWalletClient({ account: relayer, transport: http(rpcUrl) });
const user = privateKeyToAccount(generatePrivateKey());
const CHAIN = BigInt(dex.chainTokenId);
const runtime = dex.runtime;
const voidToken = dex.baseToken;
const paymaster = deployment.production.VoidPaymaster as Address;
const pool = dex.pools[0];
const amountIn = parseEther('10');
const maxGasVoid = parseEther('50');
const gasLimit = 700_000n;

const tokenAbi = parseAbi([
  'function mintTo(address,uint256)', 'function balanceOf(address) view returns(uint256)',
  'function nonces(address) view returns(uint256)',
]);
const runtimeAbi = parseAbi([
  'function feeOf(uint256) view returns(uint256)', 'function statsOf(uint256) view returns(bool,uint256,uint256,uint256,uint256)',
]);
const pairAbi = parseAbi(['function quote(bool,uint256) view returns(uint256)', 'function swap(bool,uint256,uint256) returns(uint256)']);
const paymasterAbi = parseAbi([
  'function nonces(address) view returns(uint256)',
  'function sponsorWithAssetPermits((address user,uint256 tokenId,address target,bytes data,uint256 maxToll,uint256 maxGasVoid,uint256 callGasLimit,(address token,uint256 amount)[] spends,(address collection,uint256 tokenId)[] nftSpends,uint256 nonce,uint256 deadline),bytes,(address token,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)[]) returns(bool,bytes)',
]);

const typedDomain = (token: Address, name: string) => ({ name, version: '1', chainId: 46_630, verifyingContract: token });
const permitTypes = {
  Permit: [
    { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
} as const;
const sponsoredTypes = {
  Spend: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
  SpendNft: [{ name: 'collection', type: 'address' }, { name: 'tokenId', type: 'uint256' }],
  SponsoredCall: [
    { name: 'user', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'target', type: 'address' }, { name: 'data', type: 'bytes' },
    { name: 'maxToll', type: 'uint256' }, { name: 'maxGasVoid', type: 'uint256' }, { name: 'callGasLimit', type: 'uint256' },
    { name: 'spends', type: 'Spend[]' }, { name: 'nftSpends', type: 'SpendNft[]' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
} as const;

async function wait(hash: Hex) {
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`relayer transaction reverted: ${hash}`);
  return receipt;
}

console.log('\nVOID CHAIN #1 — SPONSORED VOID-ONLY SWAP PROOF\n');
if (await rpc.getChainId() !== 46_630) throw new Error('Refusing to run outside Robinhood testnet.');
if (await rpc.getBalance({ address: user.address }) !== 0n) throw new Error('Disposable user unexpectedly has ETH.');

const fee = await rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'feeOf', args: [CHAIN] }) as bigint;
const zeroForOne = pool.token0.toLowerCase() === voidToken.toLowerCase();
if (!zeroForOne && pool.token1.toLowerCase() !== voidToken.toLowerCase()) {
  throw new Error('Selected proof pool does not contain VOID.');
}
const minOut = (await rpc.readContract({ address: pool.address, abi: pairAbi, functionName: 'quote', args: [zeroForOne, amountIn] }) as bigint) * 9_950n / 10_000n;
const data = encodeFunctionData({ abi: pairAbi, functionName: 'swap', args: [zeroForOne, amountIn, minOut] });
const deadline = BigInt(Math.floor(Date.now() / 1000) + 10 * 60);

// The governor funds only VOID. The proof account never receives ETH.
const mintHash = await wallet.writeContract({ account: relayer, chain: null, address: voidToken, abi: tokenAbi, functionName: 'mintTo', args: [user.address, amountIn + fee + maxGasVoid], maxPriorityFeePerGas: 0n });
await wait(mintHash);

const [voidNonce0, voidNonce1, callNonce, beforeStats, beforeVoid] = await Promise.all([
  rpc.readContract({ address: voidToken, abi: tokenAbi, functionName: 'nonces', args: [user.address] }) as Promise<bigint>,
  rpc.readContract({ address: voidToken, abi: tokenAbi, functionName: 'nonces', args: [user.address] }) as Promise<bigint>,
  rpc.readContract({ address: paymaster, abi: paymasterAbi, functionName: 'nonces', args: [user.address] }) as Promise<bigint>,
  rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'statsOf', args: [CHAIN] }) as Promise<readonly [boolean, bigint, bigint, bigint, bigint]>,
  rpc.readContract({ address: voidToken, abi: tokenAbi, functionName: 'balanceOf', args: [user.address] }) as Promise<bigint>,
]);
if (voidNonce0 !== voidNonce1) throw new Error('Unexpected concurrent permit activity.');
const request = {
  user: user.address, tokenId: CHAIN, target: pool.address, data,
  maxToll: fee, maxGasVoid, callGasLimit: gasLimit,
  spends: [{ token: voidToken, amount: amountIn }], nftSpends: [], nonce: callNonce, deadline,
};
const [paymasterPermit, runtimePermit, signedCall] = await Promise.all([
  user.signTypedData({ domain: typedDomain(voidToken, 'VOID'), types: permitTypes, primaryType: 'Permit', message: { owner: user.address, spender: paymaster, value: fee + maxGasVoid, nonce: voidNonce0, deadline } }),
  user.signTypedData({ domain: typedDomain(voidToken, 'VOID'), types: permitTypes, primaryType: 'Permit', message: { owner: user.address, spender: runtime, value: amountIn, nonce: voidNonce0 + 1n, deadline } }),
  user.signTypedData({ domain: { name: 'VoidPaymaster', version: '1', chainId: 46_630, verifyingContract: paymaster }, types: sponsoredTypes, primaryType: 'SponsoredCall', message: request }),
]);
const split = (signature: Hex) => ({ v: Number.parseInt(signature.slice(130, 132), 16), r: signature.slice(0, 66) as Hex, s: `0x${signature.slice(66, 130)}` as Hex });
const p0 = split(paymasterPermit); const p1 = split(runtimePermit);
const hash = await wallet.writeContract({
  account: relayer, chain: null, address: paymaster, abi: paymasterAbi, functionName: 'sponsorWithAssetPermits',
  args: [request, signedCall, [
    { token: voidToken, spender: paymaster, value: fee + maxGasVoid, deadline, ...p0 },
    { token: voidToken, spender: runtime, value: amountIn, deadline, ...p1 },
  ]], maxPriorityFeePerGas: 0n,
} as never);
await wait(hash);

const [afterEth, afterStats, afterVoid, afterNonce] = await Promise.all([
  rpc.getBalance({ address: user.address }),
  rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'statsOf', args: [CHAIN] }) as Promise<readonly [boolean, bigint, bigint, bigint, bigint]>,
  rpc.readContract({ address: voidToken, abi: tokenAbi, functionName: 'balanceOf', args: [user.address] }) as Promise<bigint>,
  rpc.readContract({ address: paymaster, abi: paymasterAbi, functionName: 'nonces', args: [user.address] }) as Promise<bigint>,
]);
if (afterEth !== 0n) throw new Error('User ETH balance changed: sponsored execution failed.');
if (afterStats[4] !== beforeStats[4] + 1n) throw new Error('Runtime did not record exactly one Chain #1 transaction.');
if (afterStats[3] !== beforeStats[3] + fee) throw new Error('Chain #1 revenue did not receive the VOID fee.');
if (afterVoid >= beforeVoid - amountIn - fee) throw new Error('VOID fee/input was not collected.');
if (afterNonce !== callNonce + 1n) throw new Error('Sponsored request nonce was not consumed.');

console.log('✓ user ETH: 0 before and after');
console.log(`✓ Chain #1 runtime transaction: ${hash}`);
console.log(`✓ fee recorded: ${fee / 10n ** 18n} VOID`);
console.log('✓ VOID input, toll and gas settlement were paid through the paymaster\n');
