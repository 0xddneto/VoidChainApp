/**
 * Proves the V6 NFT/VOID market with a wallet holding zero ETH: it signs the
 * Deed permit and sponsored request, while the Paymaster relays and charges
 * VOID. The temporary keys exist only for this process.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, decodeFunctionResult, encodeFunctionData, http, parseAbi,
  parseEther, type Address, type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deployment = JSON.parse(readFileSync(resolve(root, 'script/deployments/testnet-v6-pending.json'), 'utf8'));
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw new Error('DEPLOYER_PRIVATE_KEY is required.');
if (deployment.firstMintProof?.status !== 'twap-ready') throw new Error('Run prove:v6-twap before the sponsored-action proof.');
const project = privateKeyToAccount(key as Hex);
const rpcUrl = process.env.PARENT_RPC ?? deployment.network.rpc;
const rpc = createPublicClient({ transport: http(rpcUrl) });
const projectWallet = createWalletClient({ account: project, transport: http(rpcUrl) });
const buyer = privateKeyToAccount(generatePrivateKey());
const zeroEthSeller = privateKeyToAccount(generatePrivateKey());
const buyerWallet = createWalletClient({ account: buyer, transport: http(rpcUrl) });

const mint = deployment.production.VoidEthGenesisMintV6 as Address;
const deed = deployment.production.VoidChainDeed as Address;
const token = deployment.testnet.VoidTokenV6 as Address;
const pool = deployment.testnet.VoidEthPoolV6 as Address;
const runtime = deployment.production.VoidChainAppRuntime as Address;
const paymaster = deployment.production.VoidPaymaster as Address;
const market = deployment.firstMintProof.gateway as Address;
const mintPrice = BigInt(deployment.parameters.mintPriceWei);
const mintAbi = parseAbi(['function mint() payable returns(uint256)']);
const tokenAbi = parseAbi(['function transfer(address,uint256) returns(bool)','function balanceOf(address) view returns(uint256)','function nonces(address) view returns(uint256)']);
const deedAbi = parseAbi(['function transferFrom(address,address,uint256)','function nonces(uint256) view returns(uint256)','function ownerOf(uint256) view returns(address)']);
const poolAbi = parseAbi(['function swapEthForVoid(uint256) payable returns(uint256)','function reserveVoid() view returns(uint112)','function reserveEth() view returns(uint112)']);
const runtimeAbi = parseAbi(['function feeOf(uint256) view returns(uint256)','function statsOf(uint256) view returns(bool,uint256,uint256,uint256,uint256)']);
const marketAbi = parseAbi(['function sellWithPermit(uint256,uint256,uint8,bytes32,bytes32)','function inventoryCount() view returns(uint256)']);
const gatewayAbi = parseAbi(['function query(bytes) view returns(bytes)']);
const paymasterAbi = parseAbi(['function nonces(address) view returns(uint256)','function sponsorWithAssetPermits((address user,uint256 tokenId,address target,bytes data,uint256 maxToll,uint256 maxGasVoid,uint256 callGasLimit,(address token,uint256 amount)[] spends,(address collection,uint256 tokenId)[] nftSpends,uint256 nonce,uint256 deadline),bytes,(address token,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)[]) returns(bool,bytes)']);
const permitTypes = { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] } as const;
const deedPermitTypes = { Permit: [{ name: 'spender', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] } as const;
const sponsoredTypes = {
  Spend: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
  SpendNft: [{ name: 'collection', type: 'address' }, { name: 'tokenId', type: 'uint256' }],
  SponsoredCall: [{ name: 'user', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'target', type: 'address' }, { name: 'data', type: 'bytes' }, { name: 'maxToll', type: 'uint256' }, { name: 'maxGasVoid', type: 'uint256' }, { name: 'callGasLimit', type: 'uint256' }, { name: 'spends', type: 'Spend[]' }, { name: 'nftSpends', type: 'SpendNft[]' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
} as const;
const split = (signature: Hex) => ({ v: Number.parseInt(signature.slice(130, 132), 16), r: signature.slice(0, 66) as Hex, s: `0x${signature.slice(66, 130)}` as Hex });
async function gas() { return (await rpc.getGasPrice()) * 3n; }
async function wait(hash: Hex) { const r = await rpc.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error(`reverted: ${hash}`); return r; }
async function send(wallet: ReturnType<typeof createWalletClient>, account: typeof project, to: Address, data: Hex, value = 0n) {
  return wait(await wallet.sendTransaction({ account, chain: null, to, data, value, maxFeePerGas: await gas(), maxPriorityFeePerGas: 0n }));
}
async function marketQuery(functionName: 'inventoryCount'): Promise<bigint> {
  const data = encodeFunctionData({ abi: marketAbi, functionName });
  const raw = await rpc.readContract({ address: market, abi: gatewayAbi, functionName: 'query', args: [data] }) as Hex;
  return decodeFunctionResult({ abi: marketAbi, functionName, data: raw }) as bigint;
}
function check(ok: boolean, statement: string) { if (!ok) throw new Error(`Check failed: ${statement}`); console.log(`  ✓ ${statement}`); }

console.log('\nVOID V6 — ZERO-ETH SPONSORED NFT MARKET PROOF\n');
console.log('[1/5] fund a temporary genesis buyer and mint the next Deed');
const supplyBefore = await rpc.readContract({ address: mint, abi: parseAbi(['function totalMinted() view returns(uint256)']), functionName: 'totalMinted' }) as bigint;
const deedId = supplyBefore + 1n;
await send(projectWallet, project, buyer.address, '0x', parseEther('0.003'));
await send(buyerWallet, buyer, mint, encodeFunctionData({ abi: mintAbi, functionName: 'mint' }), mintPrice);
check((await rpc.readContract({ address: deed, abi: deedAbi, functionName: 'ownerOf', args: [deedId] }) as Address).toLowerCase() === buyer.address.toLowerCase(), `Deed #${deedId} reached the temporary buyer`);

console.log('[2/5] acquire VOID through the explicit ETH onboarding pool');
const [voidReserve, ethReserve] = await Promise.all([
  rpc.readContract({ address: pool, abi: poolAbi, functionName: 'reserveVoid' }) as Promise<bigint>,
  rpc.readContract({ address: pool, abi: poolAbi, functionName: 'reserveEth' }) as Promise<bigint>,
]);
const ethIn = parseEther('0.00005');
const expected = (ethIn * 9970n / 10_000n) * voidReserve / (ethReserve + (ethIn * 9970n / 10_000n));
await send(buyerWallet, buyer, pool, encodeFunctionData({ abi: poolAbi, functionName: 'swapEthForVoid', args: [expected * 98n / 100n] }), ethIn);
const buyerVoid = await rpc.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [buyer.address] }) as bigint;
check(buyerVoid > parseEther('20000'), 'onboarding returned enough VOID for a sponsored transaction');

console.log('[3/5] hand the Deed and VOID to a wallet with zero ETH');
await send(buyerWallet, buyer, deed, encodeFunctionData({ abi: deedAbi, functionName: 'transferFrom', args: [buyer.address, zeroEthSeller.address, deedId] }));
const starterVoid = parseEther('20000');
await send(buyerWallet, buyer, token, encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [zeroEthSeller.address, starterVoid] }));
check(await rpc.getBalance({ address: zeroEthSeller.address }) === 0n, 'the signing seller has exactly zero ETH');

console.log('[4/5] sign Deed permit + sponsored VOID sale; project wallet relays');
const [fee, requestNonce, voidNonce, deedNonce, beforeStats, beforeInventory] = await Promise.all([
  rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'feeOf', args: [1n] }) as Promise<bigint>,
  rpc.readContract({ address: paymaster, abi: paymasterAbi, functionName: 'nonces', args: [zeroEthSeller.address] }) as Promise<bigint>,
  rpc.readContract({ address: token, abi: tokenAbi, functionName: 'nonces', args: [zeroEthSeller.address] }) as Promise<bigint>,
  rpc.readContract({ address: deed, abi: deedAbi, functionName: 'nonces', args: [deedId] }) as Promise<bigint>,
  rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'statsOf', args: [1n] }) as Promise<readonly [boolean, bigint, bigint, bigint, bigint]>,
  marketQuery('inventoryCount'),
]);
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
const deedSignature = await zeroEthSeller.signTypedData({ domain: { name: 'VOIDS Chain Deed', version: '1', chainId: 46630, verifyingContract: deed }, types: deedPermitTypes, primaryType: 'Permit', message: { spender: runtime, tokenId: deedId, nonce: deedNonce, deadline } });
const d = split(deedSignature);
const appData = encodeFunctionData({ abi: marketAbi, functionName: 'sellWithPermit', args: [deedId, deadline, d.v, d.r, d.s] });
const maxGasVoid = parseEther('10000');
const request = { user: zeroEthSeller.address, tokenId: 1n, target: market, data: appData, maxToll: fee, maxGasVoid, callGasLimit: 1_500_000n, spends: [], nftSpends: [{ collection: deed, tokenId: deedId }], nonce: requestNonce, deadline };
const voidPermitSignature = await zeroEthSeller.signTypedData({ domain: { name: 'VOID', version: '1', chainId: 46630, verifyingContract: token }, types: permitTypes, primaryType: 'Permit', message: { owner: zeroEthSeller.address, spender: paymaster, value: fee + maxGasVoid, nonce: voidNonce, deadline } });
const requestSignature = await zeroEthSeller.signTypedData({ domain: { name: 'VoidPaymaster', version: '1', chainId: 46630, verifyingContract: paymaster }, types: sponsoredTypes, primaryType: 'SponsoredCall', message: request });
const relayReceipt = await send(projectWallet, project, paymaster, encodeFunctionData({ abi: paymasterAbi, functionName: 'sponsorWithAssetPermits', args: [request, requestSignature, [{ token, spender: paymaster, value: fee + maxGasVoid, deadline, ...split(voidPermitSignature) }]] }));

console.log('[5/5] verify ownership, payout and chain revenue');
const [afterStats, afterInventory, sellerEth, deedOwner, sellerVoid] = await Promise.all([
  rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'statsOf', args: [1n] }) as Promise<readonly [boolean, bigint, bigint, bigint, bigint]>,
  marketQuery('inventoryCount'),
  rpc.getBalance({ address: zeroEthSeller.address }),
  rpc.readContract({ address: deed, abi: deedAbi, functionName: 'ownerOf', args: [deedId] }) as Promise<Address>,
  rpc.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [zeroEthSeller.address] }) as Promise<bigint>,
]);
check(sellerEth === 0n, 'seller stayed at zero ETH through the signed app action');
check(deedOwner.toLowerCase() === market.toLowerCase() && afterInventory === beforeInventory + 1n, 'the NFT entered the Chain #1 market vault');
check(afterStats[4] === beforeStats[4] + 1n && afterStats[3] === beforeStats[3] + fee, 'Chain #1 recorded the VOID transaction fee and revenue');
check(sellerVoid > starterVoid, 'seller received the VOID pool payout');
console.log(`✓ sponsored sale transaction: ${relayReceipt.transactionHash}`);
