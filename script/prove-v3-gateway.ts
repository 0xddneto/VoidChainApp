/**
 * Proves the V3 builder invariant on the live testnet:
 * - a factory-published app rejects direct calls;
 * - a zero-ETH wallet signs and uses the same app through the Paymaster;
 * - the chain records the VOID fee and the app state changes once.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, decodeEventLog, encodeDeployData,
  encodeFunctionData, http, parseAbi, parseEther, type Abi, type Address, type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deployment = JSON.parse(readFileSync(resolve(root, 'web/lib/deployment.json'), 'utf8'));
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw new Error('DEPLOYER_PRIVATE_KEY is required.');
const rpcUrl = process.env.PARENT_RPC ?? deployment.network.rpc;
const rpc = createPublicClient({ transport: http(rpcUrl) });
const relayer = privateKeyToAccount(key as Hex);
const wallet = createWalletClient({ account: relayer, transport: http(rpcUrl) });
const runtime = deployment.production.VoidChainAppRuntime as Address;
const paymaster = deployment.production.VoidPaymaster as Address;
const appFactory = deployment.production.VoidChainAppFactoryV3 as Address;
const voidToken = deployment.testnet.VoidTestToken as Address;
const user = privateKeyToAccount(generatePrivateKey());
const CHAIN = 1n;
const MAX_GAS_VOID = parseEther('50');
const CALL_GAS_LIMIT = 500_000n;

function artifact(name: string, source = `${name}.sol`): { abi: Abi; bytecode: Hex } {
  const raw = JSON.parse(readFileSync(resolve(root, `out/${source}/${name}.json`), 'utf8'));
  const object = raw.bytecode.object as string;
  return { abi: raw.abi as Abi, bytecode: (object.startsWith('0x') ? object : `0x${object}`) as Hex };
}
async function wait(hash: Hex) {
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);
  return receipt;
}
async function gas() { return (await rpc.getGasPrice()) * 3n; }

const runtimeAbi = parseAbi(['function feeOf(uint256) view returns(uint256)', 'function statsOf(uint256) view returns(bool,uint256,uint256,uint256,uint256)']);
const tokenAbi = parseAbi(['function mintTo(address,uint256)', 'function nonces(address) view returns(uint256)', 'function balanceOf(address) view returns(uint256)']);
const paymasterAbi = parseAbi([
  'function nonces(address) view returns(uint256)',
  'function sponsorWithAssetPermits((address user,uint256 tokenId,address target,bytes data,uint256 maxToll,uint256 maxGasVoid,uint256 callGasLimit,(address token,uint256 amount)[] spends,(address collection,uint256 tokenId)[] nftSpends,uint256 nonce,uint256 deadline),bytes,(address token,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)[]) returns(bool,bytes)',
]);
const factoryArtifact = artifact('VoidChainAppFactoryV3');
const counterArtifact = artifact('Counter');
const counterAbi = parseAbi(['function bump()', 'function count() view returns(uint256)']);
const permitTypes = { Permit: [
  { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
] } as const;
const sponsoredTypes = {
  Spend: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
  SpendNft: [{ name: 'collection', type: 'address' }, { name: 'tokenId', type: 'uint256' }],
  SponsoredCall: [
    { name: 'user', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'target', type: 'address' }, { name: 'data', type: 'bytes' },
    { name: 'maxToll', type: 'uint256' }, { name: 'maxGasVoid', type: 'uint256' }, { name: 'callGasLimit', type: 'uint256' },
    { name: 'spends', type: 'Spend[]' }, { name: 'nftSpends', type: 'SpendNft[]' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
} as const;
const split = (signature: Hex) => ({ v: Number.parseInt(signature.slice(130, 132), 16), r: signature.slice(0, 66) as Hex, s: `0x${signature.slice(66, 130)}` as Hex });

if (await rpc.getChainId() !== 46_630) throw new Error('Refusing to run outside Robinhood testnet.');
if (await rpc.getBalance({ address: user.address }) !== 0n) throw new Error('Proof wallet unexpectedly has ETH.');
console.log('\nVOID CHAIN #1 — V3 FACTORY / VOID-ONLY PROOF\n');

const implementationHash = await wallet.sendTransaction({
  account: relayer, chain: null,
  data: encodeDeployData({ abi: counterArtifact.abi, bytecode: counterArtifact.bytecode, args: [runtime, CHAIN] }),
  maxFeePerGas: await gas(), maxPriorityFeePerGas: 0n,
});
const implementationReceipt = await wait(implementationHash);
const implementation = implementationReceipt.contractAddress!;
const publishHash = await wallet.writeContract({
  account: relayer, chain: null, address: appFactory, abi: factoryArtifact.abi, functionName: 'publish',
  args: [CHAIN, implementation, '0x', `0x${Date.now().toString(16).padStart(64, '0')}`], maxFeePerGas: await gas(), maxPriorityFeePerGas: 0n,
} as never);
const publishReceipt = await wait(publishHash);
const log = publishReceipt.logs.find((item) => item.address.toLowerCase() === appFactory.toLowerCase());
if (!log) throw new Error('Factory publication emitted no event.');
const decoded = decodeEventLog({ abi: factoryArtifact.abi, data: log.data, topics: log.topics });
if (decoded.eventName !== 'AppPublished') throw new Error('Unexpected factory event.');
const { app } = decoded.args as unknown as { app: Address };

const bump = encodeFunctionData({ abi: counterAbi, functionName: 'bump' });
let directRejected = false;
try { await rpc.call({ to: app, data: bump }); } catch { directRejected = true; }
if (!directRejected) throw new Error('Factory gateway accepted a direct app call.');

const fee = await rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'feeOf', args: [CHAIN] }) as bigint;
const funding = fee + MAX_GAS_VOID;
await wait(await wallet.writeContract({ account: relayer, chain: null, address: voidToken, abi: tokenAbi, functionName: 'mintTo', args: [user.address, funding], maxFeePerGas: await gas(), maxPriorityFeePerGas: 0n }));
const [permitNonce, requestNonce, beforeStats] = await Promise.all([
  rpc.readContract({ address: voidToken, abi: tokenAbi, functionName: 'nonces', args: [user.address] }) as Promise<bigint>,
  rpc.readContract({ address: paymaster, abi: paymasterAbi, functionName: 'nonces', args: [user.address] }) as Promise<bigint>,
  rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'statsOf', args: [CHAIN] }) as Promise<readonly [boolean, bigint, bigint, bigint, bigint]>,
]);
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
const request = { user: user.address, tokenId: CHAIN, target: app, data: bump, maxToll: fee, maxGasVoid: MAX_GAS_VOID, callGasLimit: CALL_GAS_LIMIT, spends: [], nftSpends: [], nonce: requestNonce, deadline };
const permitSignature = await user.signTypedData({ domain: { name: 'VOID', version: '1', chainId: 46_630, verifyingContract: voidToken }, types: permitTypes, primaryType: 'Permit', message: { owner: user.address, spender: paymaster, value: funding, nonce: permitNonce, deadline } });
const requestSignature = await user.signTypedData({ domain: { name: 'VoidPaymaster', version: '1', chainId: 46_630, verifyingContract: paymaster }, types: sponsoredTypes, primaryType: 'SponsoredCall', message: request });
const p = split(permitSignature);
const sponsoredHash = await wallet.writeContract({
  account: relayer, chain: null, address: paymaster, abi: paymasterAbi, functionName: 'sponsorWithAssetPermits',
  args: [request, requestSignature, [{ token: voidToken, spender: paymaster, value: funding, deadline, ...p }]], maxFeePerGas: await gas(), maxPriorityFeePerGas: 0n,
} as never);
await wait(sponsoredHash);
const [afterStats, count, afterEth] = await Promise.all([
  rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'statsOf', args: [CHAIN] }) as Promise<readonly [boolean, bigint, bigint, bigint, bigint]>,
  rpc.readContract({ address: app, abi: counterAbi, functionName: 'count' }) as Promise<bigint>,
  rpc.getBalance({ address: user.address }),
]);
if (afterEth !== 0n || count !== 1n || afterStats[4] !== beforeStats[4] + 1n || afterStats[3] !== beforeStats[3] + fee) throw new Error('V3 sponsored app proof failed.');
console.log('✓ direct gateway call rejected');
console.log('✓ zero-ETH user signed and executed through Paymaster');
console.log(`✓ ${fee / 10n ** 18n} VOID charged to Chain #1`);
console.log(`✓ factory app: ${app}`);
console.log(`✓ sponsored transaction: ${sponsoredHash}`);
