/** Finalize staged V8 inventory through the same sponsored path users invoke. */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, decodeFunctionResult, encodeFunctionData,
  fallback, http, parseEther, type Abi, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { requireSponsoredSuccess } from '../web/lib/sponsored-receipt';

const path = 'deployments/testnet-v8-pending.json';
const deployment = JSON.parse(readFileSync(path, 'utf8'));
const c = deployment.contracts as Record<string, Address>;
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw Error('Missing project testnet key');
const account = privateKeyToAccount(key as Hex);
const urls = [process.env.PARENT_RPC, deployment.network.rpc, 'https://rpc.testnet.chain.robinhood.com'].filter(Boolean) as string[];
const transport = fallback(urls.map((url) => http(url)));
const rpc = createPublicClient({ transport });
const wallet = createWalletClient({ account, transport });
const abi = (name: string): Abi => JSON.parse(readFileSync(
  name === 'VoidChainAppGateway'
    ? '../out/VoidChainAppFactoryV3.sol/VoidChainAppGateway.json'
    : `../out/${name}.sol/${name}.json`, 'utf8')).abi;
const marketAbi = abi('VoidGenesisNftAmmV6');
const paymasterAbi = abi('VoidPaymaster');
const tokenAbi = abi('VoidTokenV6');
const runtimeAbi = abi('VoidChainAppRuntimeV5');
const gatewayAbi = abi('VoidChainAppGateway');
const permitTypes = { Permit: [
  { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' },
  { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
] } as const;
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
const split = (signature: Hex) => ({
  v: Number.parseInt(signature.slice(130, 132), 16),
  r: signature.slice(0, 66) as Hex, s: `0x${signature.slice(66, 130)}` as Hex,
});
const save = () => writeFileSync(path, JSON.stringify(deployment, null, 2) + '\n');

async function inventoryIndex(id: bigint): Promise<bigint> {
  const data = encodeFunctionData({ abi: marketAbi, functionName: 'inventoryIndexPlusOne', args: [id] });
  const raw = await rpc.readContract({ address: c.nftAmm, abi: gatewayAbi, functionName: 'query', args: [data] }) as Hex;
  return decodeFunctionResult({ abi: marketAbi, functionName: 'inventoryIndexPlusOne', data: raw }) as bigint;
}

async function acceptDonation(id: bigint) {
  const label = `acceptDonation:${id}`;
  if (await inventoryIndex(id) !== 0n) return console.log(`inventory #${id} already active`);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const maxGasVoid = parseEther('10000');
  const [fee, nonce, permitNonce] = await Promise.all([
    rpc.readContract({ address: c.runtime, abi: runtimeAbi, functionName: 'feeOf', args: [1n] }),
    rpc.readContract({ address: c.paymaster, abi: paymasterAbi, functionName: 'nonces', args: [account.address] }),
    rpc.readContract({ address: c.token, abi: tokenAbi, functionName: 'nonces', args: [account.address] }),
  ]) as [bigint, bigint, bigint];
  const request = {
    user: account.address, tokenId: 1n, target: c.nftAmm,
    data: encodeFunctionData({ abi: marketAbi, functionName: 'acceptDonation', args: [id] }),
    maxToll: fee, maxGasVoid, callGasLimit: 1_500_000n,
    spends: [], nftSpends: [], nonce, deadline,
  };
  const value = fee + maxGasVoid;
  const permit = {
    token: c.token, spender: c.paymaster, value, deadline,
    ...split(await account.signTypedData({
      domain: { name: 'VOID', version: '1', chainId: 46630, verifyingContract: c.token },
      types: permitTypes, primaryType: 'Permit',
      message: { owner: account.address, spender: c.paymaster, value, nonce: permitNonce, deadline },
    })),
  };
  const signature = await account.signTypedData({
    domain: { name: 'VoidPaymaster', version: '1', chainId: 46630, verifyingContract: c.paymaster },
    types: sponsoredTypes, primaryType: 'SponsoredCall', message: request,
  });
  const args = [request, signature, [permit]] as const;
  const simulation = await rpc.simulateContract({
    account, address: c.paymaster, abi: paymasterAbi,
    functionName: 'sponsorWithAssetPermits', args,
  });
  if (!(simulation.result as readonly [boolean, Hex])[0]) throw Error(`Donation #${id} would fail`);
  const hash = await wallet.writeContract({
    account, chain: null, address: c.paymaster, abi: paymasterAbi,
    functionName: 'sponsorWithAssetPermits', args,
  });
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  requireSponsoredSuccess(receipt, c.paymaster, account.address, 1n);
  deployment.steps[label] = hash;
  save();
  console.log(`inventory #${id} accepted ${hash}`);
}

if (await rpc.getChainId() !== 46630) throw Error('Testnet only');
// Refresh the permissionless TWAP before asking the guard for a VOID quote.
// This is also the exact operation the production cron/keeper performs.
const twapHash = await wallet.writeContract({
  account, chain: null, address: c.twap, abi: abi('VoidTwapOracleV6'), functionName: 'update',
});
await rpc.waitForTransactionReceipt({ hash: twapHash });
deployment.steps[`twapFinalize:${Math.floor(Date.now() / 1000)}`] = twapHash;
save();
for (const id of [4n, 5n]) await acceptDonation(id);
deployment.status = 'awaiting-acceptance-audit';
save();
