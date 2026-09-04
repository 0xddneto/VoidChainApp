/** Exercise setup + repeat calls through the published DEX relay. */
import { requireSponsoredSuccess } from '../web/lib/sponsored-receipt';
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  maxUint256,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deploy = JSON.parse(readFileSync(resolve(root, 'web/lib/deployment.json'), 'utf8'));
const dex = JSON.parse(readFileSync(resolve(root, 'web/lib/dex-chain1.json'), 'utf8'));
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw new Error('DEPLOYER_PRIVATE_KEY is required.');

const rpc = createPublicClient({ transport: http(process.env.PARENT_RPC ?? deploy.network.rpc) });
const user = privateKeyToAccount(key as Hex);
const runtime = deploy.production.VoidChainAppRuntime as Address;
const paymaster = deploy.production.VoidPaymaster as Address;
const voidToken = deploy.testnet.VoidTestToken as Address;
const pool = dex.pools[0].address as Address;
const asset = dex.pools[0].asset as Address;
const zeroForOne = asset.toLowerCase() === dex.pools[0].token0.toLowerCase();
const chainTokenId = 1n;
const amountIn = parseEther('1');
const maxGasVoid = parseEther('10000');

const pairAbi = parseAbi([
  'function quote(bool,uint256) view returns(uint256)',
  'function swap(bool,uint256,uint256) returns(uint256)',
]);
const gatewayAbi = parseAbi(['function query(bytes) view returns(bytes)']);
const tokenAbi = parseAbi([
  'function allowance(address,address) view returns(uint256)',
  'function name() view returns(string)',
  'function nonces(address) view returns(uint256)',
]);
const runtimeAbi = parseAbi([
  'function feeOf(uint256) view returns(uint256)',
  'function statsOf(uint256) view returns(bool,uint256,uint256,uint256,uint256)',
]);
const paymasterAbi = parseAbi([
  'function nonces(address) view returns(uint256)',
]);
const permitTypes = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;
const sponsoredTypes = {
  Spend: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
  SpendNft: [{ name: 'collection', type: 'address' }, { name: 'tokenId', type: 'uint256' }],
  SponsoredCall: [
    { name: 'user', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'target', type: 'address' },
    { name: 'data', type: 'bytes' },
    { name: 'maxToll', type: 'uint256' },
    { name: 'maxGasVoid', type: 'uint256' },
    { name: 'callGasLimit', type: 'uint256' },
    { name: 'spends', type: 'Spend[]' },
    { name: 'nftSpends', type: 'SpendNft[]' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

function split(signature: Hex) {
  return {
    v: Number.parseInt(signature.slice(130, 132), 16),
    r: signature.slice(0, 66) as Hex,
    s: `0x${signature.slice(66, 130)}` as Hex,
  };
}

async function queryQuote(): Promise<bigint> {
  const data = encodeFunctionData({ abi: pairAbi, functionName: 'quote', args: [zeroForOne, amountIn] });
  const raw = await rpc.readContract({ address: pool, abi: gatewayAbi, functionName: 'query', args: [data] }) as Hex;
  return decodeFunctionResult({ abi: pairAbi, functionName: 'quote', data: raw }) as bigint;
}

async function execute(): Promise<{ hash: Hex; permitCount: number }> {
  const [fee, requestNonce, beforeStats, quoted, voidAllowance, assetAllowance, voidName, assetName] = await Promise.all([
    rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'feeOf', args: [chainTokenId] }) as Promise<bigint>,
    rpc.readContract({ address: paymaster, abi: paymasterAbi, functionName: 'nonces', args: [user.address] }) as Promise<bigint>,
    rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'statsOf', args: [chainTokenId] }) as Promise<readonly [boolean, bigint, bigint, bigint, bigint]>,
    queryQuote(),
    rpc.readContract({ address: voidToken, abi: tokenAbi, functionName: 'allowance', args: [user.address, paymaster] }) as Promise<bigint>,
    rpc.readContract({ address: asset, abi: tokenAbi, functionName: 'allowance', args: [user.address, runtime] }) as Promise<bigint>,
    rpc.readContract({ address: voidToken, abi: tokenAbi, functionName: 'name' }) as Promise<string>,
    rpc.readContract({ address: asset, abi: tokenAbi, functionName: 'name' }) as Promise<string>,
  ]);
  if (quoted === 0n) throw new Error('pool has no quote');

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const data = encodeFunctionData({
    abi: pairAbi,
    functionName: 'swap',
    args: [zeroForOne, amountIn, quoted * 9950n / 10000n],
  });
  const request = {
    user: user.address,
    tokenId: chainTokenId,
    target: pool,
    data,
    maxToll: fee,
    maxGasVoid,
    callGasLimit: 700000n,
    spends: [{ token: asset, amount: amountIn }],
    nftSpends: [],
    nonce: requestNonce,
    deadline,
  };
  const permits = [];

  if (voidAllowance < fee + maxGasVoid) {
    const nonce = await rpc.readContract({ address: voidToken, abi: tokenAbi, functionName: 'nonces', args: [user.address] }) as bigint;
    const signature = await user.signTypedData({
      domain: { name: voidName, version: '1', chainId: 46630, verifyingContract: voidToken },
      types: permitTypes,
      primaryType: 'Permit',
      message: { owner: user.address, spender: paymaster, value: maxUint256, nonce, deadline },
    });
    permits.push({ token: voidToken, spender: paymaster, value: maxUint256, deadline, ...split(signature) });
  }

  if (assetAllowance < amountIn) {
    const nonce = await rpc.readContract({ address: asset, abi: tokenAbi, functionName: 'nonces', args: [user.address] }) as bigint;
    const signature = await user.signTypedData({
      domain: { name: assetName, version: '1', chainId: 46630, verifyingContract: asset },
      types: permitTypes,
      primaryType: 'Permit',
      message: { owner: user.address, spender: runtime, value: maxUint256, nonce, deadline },
    });
    permits.push({ token: asset, spender: runtime, value: maxUint256, deadline, ...split(signature) });
  }

  const signature = await user.signTypedData({
    domain: { name: 'VoidPaymaster', version: '1', chainId: 46630, verifyingContract: paymaster },
    types: sponsoredTypes,
    primaryType: 'SponsoredCall',
    message: request,
  });
  const response = await fetch('https://voiddex-alpha.vercel.app/relay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request, signature, permits }, (_key, value) => typeof value === 'bigint' ? value.toString() : value),
  });
  const result = await response.json() as { hash?: Hex; error?: string };
  if (!response.ok || !result.hash) throw new Error(result.error ?? `HTTP relay failed (${response.status})`);

  const receipt = await rpc.waitForTransactionReceipt({ hash: result.hash });
  if (receipt.status !== 'success') throw new Error(`reverted ${result.hash}`);
  requireSponsoredSuccess(receipt, paymaster, user.address, chainTokenId);
  const afterStats = await rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'statsOf', args: [chainTokenId] }) as readonly [boolean, bigint, bigint, bigint, bigint];
  if (afterStats[4] !== beforeStats[4] + 1n || afterStats[3] !== beforeStats[3] + fee) {
    throw new Error('Runtime accounting did not match');
  }
  return { hash: result.hash, permitCount: permits.length };
}

if (await rpc.getChainId() !== 46630) throw new Error('wrong network');
const setup = await execute();
const repeat = await execute();
if (repeat.permitCount !== 0) throw new Error(`repeat unexpectedly required ${repeat.permitCount} permits`);
console.log(JSON.stringify({
  status: 'PASS',
  setupPermits: setup.permitCount,
  repeatPermits: repeat.permitCount,
  setupHash: setup.hash,
  repeatHash: repeat.hash,
}));
