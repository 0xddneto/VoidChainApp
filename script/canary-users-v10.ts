/**
 * Small live canary for V10. Hundreds-user load belongs in Foundry; this script
 * deliberately caps public testnet writes so shallow test liquidity and the
 * shared Paymaster are not exhausted merely to create impressive counters.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  concatHex, createPublicClient, createWalletClient, encodeFunctionData, formatEther,
  getAddress, http, keccak256, parseAbi, parseEther, toHex, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { requireSponsoredSuccess } from '../web/lib/sponsored-receipt';

const deployment = JSON.parse(readFileSync('../web/lib/deployment.json', 'utf8'));
const dex = JSON.parse(readFileSync('../../VoidDEX/lib/deployment.json', 'utf8'));
const key = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw new Error('DEPLOYER_PRIVATE_KEY is required.');
const count = Number.parseInt(process.env.CANARY_USERS ?? '3', 10);
if (!Number.isInteger(count) || count < 1 || count > 5) throw new Error('CANARY_USERS must be between 1 and 5.');
const batch = process.env.CANARY_BATCH ?? new Date().toISOString().slice(0, 10);
const account = privateKeyToAccount(key!);
const rpc = createPublicClient({ transport: http(process.env.PARENT_RPC ?? deployment.network.rpc) });
const wallet = createWalletClient({ account, transport: http(process.env.PARENT_RPC ?? deployment.network.rpc) });
const token = getAddress(deployment.testnet.VoidTestToken);
const runtime = getAddress(deployment.production.VoidChainAppRuntime);
const paymaster = getAddress(deployment.production.VoidPaymaster);
const faucet = getAddress(dex.faucet);
const MAX_GAS_VOID = parseEther('10000');
const CALL_GAS_LIMIT = 1_500_000n;
const erc20 = parseAbi([
  'function transfer(address,uint256) returns(bool)', 'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
]);
const runtimeAbi = parseAbi([
  'function feeOf(uint256) view returns(uint256)',
  'function statsOf(uint256) view returns(bool,uint256,uint256,uint256,uint256)',
]);
const paymasterAbi = parseAbi([
  'function nonces(address) view returns(uint256)',
  'function sponsor((address user,uint256 tokenId,address target,bytes data,uint256 maxToll,uint256 maxGasVoid,uint256 callGasLimit,(address token,uint256 amount)[] spends,(address collection,uint256 tokenId)[] nftSpends,uint256 nonce,uint256 deadline),bytes) returns(bool,bytes)',
]);
const faucetAbi = parseAbi(['function claim()']);
const sponsoredTypes = {
  Spend: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
  SpendNft: [{ name: 'collection', type: 'address' }, { name: 'tokenId', type: 'uint256' }],
  SponsoredCall: [
    { name: 'user', type: 'address' }, { name: 'tokenId', type: 'uint256' },
    { name: 'target', type: 'address' }, { name: 'data', type: 'bytes' },
    { name: 'maxToll', type: 'uint256' }, { name: 'maxGasVoid', type: 'uint256' },
    { name: 'callGasLimit', type: 'uint256' }, { name: 'spends', type: 'Spend[]' },
    { name: 'nftSpends', type: 'SpendNft[]' }, { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

if (await rpc.getChainId() !== 46_630) throw new Error('Robinhood testnet only.');
const [fee, statsBefore, projectVoid, reserveBefore] = await Promise.all([
  rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'feeOf', args: [1n] }),
  rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'statsOf', args: [1n] }),
  rpc.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [account.address] }),
  rpc.getBalance({ address: paymaster }),
]);
const funding = fee + MAX_GAS_VOID;
if (projectVoid < funding * BigInt(count)) {
  throw new Error(`Canary needs ${formatEther(funding * BigInt(count))} VOID; wallet has ${formatEther(projectVoid)}.`);
}

const results: Array<{ address: Address; fundingHash: Hex; sponsoredHash: Hex }> = [];
for (let index = 0; index < count; index += 1) {
  const userKey = keccak256(concatHex([key!, toHex(`VOID V10 canary ${batch} user ${index}`)]));
  const user = privateKeyToAccount(userKey);
  const existingNonce = await rpc.readContract({ address: paymaster, abi: paymasterAbi, functionName: 'nonces', args: [user.address] });
  if (existingNonce !== 0n) throw new Error(`Canary identity ${index} was already used; set a new CANARY_BATCH.`);
  const fundingHash = await wallet.writeContract({
    account, chain: null, address: token, abi: erc20, functionName: 'transfer', args: [user.address, funding],
  });
  if ((await rpc.waitForTransactionReceipt({ hash: fundingHash })).status !== 'success') throw new Error(`Funding user ${index} failed.`);

  const request = {
    user: user.address, tokenId: 1n, target: faucet,
    data: encodeFunctionData({ abi: faucetAbi, functionName: 'claim' }),
    maxToll: fee, maxGasVoid: MAX_GAS_VOID, callGasLimit: CALL_GAS_LIMIT,
    spends: [], nftSpends: [], nonce: 0n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 900),
  };
  const signature = await user.signTypedData({
    domain: { name: 'VoidPaymaster', version: '1', chainId: 46_630, verifyingContract: paymaster },
    types: sponsoredTypes, primaryType: 'SponsoredCall', message: request,
  });
  const sponsoredHash = await wallet.writeContract({
    account, chain: null, address: paymaster, abi: paymasterAbi, functionName: 'sponsor', args: [request, signature],
  });
  const receipt = await rpc.waitForTransactionReceipt({ hash: sponsoredHash });
  requireSponsoredSuccess(receipt, paymaster, user.address, 1n);
  const [eth, paymasterAllowance, runtimeAllowance] = await Promise.all([
    rpc.getBalance({ address: user.address }),
    rpc.readContract({ address: token, abi: erc20, functionName: 'allowance', args: [user.address, paymaster] }),
    rpc.readContract({ address: token, abi: erc20, functionName: 'allowance', args: [user.address, runtime] }),
  ]);
  if (eth !== 0n || paymasterAllowance !== 0n || runtimeAllowance !== 0n) {
    throw new Error(`User ${index} violated the zero-ETH/no-allowance invariant.`);
  }
  results.push({ address: user.address, fundingHash, sponsoredHash });
  console.log(`canary ${index + 1}/${count} passed: ${user.address} ${sponsoredHash}`);
}

const [statsAfter, reserveAfter] = await Promise.all([
  rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'statsOf', args: [1n] }),
  rpc.getBalance({ address: paymaster }),
]);
if (statsAfter[4] - statsBefore[4] !== BigInt(count)) throw new Error('Runtime call count did not match the canary batch.');
mkdirSync('deployments', { recursive: true });
writeFileSync(`deployments/canary-v10-${batch}.json`, `${JSON.stringify({
  version: deployment.version, batch, users: count, fee: fee.toString(),
  callsBefore: statsBefore[4].toString(), callsAfter: statsAfter[4].toString(),
  paymasterEthBefore: reserveBefore.toString(), paymasterEthAfter: reserveAfter.toString(),
  results,
}, null, 2)}\n`);
console.log(`PASS: ${count} independent zero-ETH users completed live sponsored actions.`);
