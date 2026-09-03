/**
 * Tests the exact purchase sequence used by /mint on the deployed testnet.
 *
 * The temporary wallet claims test VOID, sends one exact approval to the
 * Paymaster, signs one EIP-712 purchase and receives the deed through the
 * local VoidScan relay. It returns the deed at the end, keeping the public
 * test pool at 1,111 available deeds.
 *
 * Usage: npm run prove:purchase
 * Requires the local web server with PAYMASTER_RELAYER_PRIVATE_KEY configured.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  http,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.PARENT_RPC ?? 'https://robinhood-testnet.drpc.org';
const VOIDSCAN_URL = process.env.VOIDSCAN_URL ?? 'http://localhost:3000';
const here = dirname(fileURLToPath(import.meta.url));
const d = JSON.parse(readFileSync(resolve(here, 'deployments/testnet.json'), 'utf8'));
const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(deployerKey ?? '')) {
  throw new Error('DEPLOYER_PRIVATE_KEY is required to fund the temporary test wallet.');
}

const parent = createPublicClient({ transport: http(RPC) });
const deployer = privateKeyToAccount(deployerKey as Hex);
const deployerWallet = createWalletClient({ account: deployer, transport: http(RPC) });

const token = d.testnet.VoidTestToken as Address;
const amm = d.testnet.VoidNftAmm as Address;
const deed = d.production.VoidChainDeed as Address;
const paymaster = d.production.VoidCollectionMintPaymaster as Address;
const collectionMarket = d.testnet.VoidCollectionMarket as Address;
const chainId = Number(d.network.chainId);

const MAX_GAS_VOID = 10_000n * 10n ** 18n;
const CALL_GAS_LIMIT = 1_500_000n;
const FAUCET_AMOUNT = 2_500_000n * 10n ** 18n;
const SIGNATURE_LIFETIME_SECONDS = 10n * 60n;

const tokenAbi = parseAbi([
  'function mintTo(address,uint256)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
const ammAbi = parseAbi([
  'function available() view returns (uint256)',
  'function peek(uint256) view returns (uint256[])',
  'function priceToBuy(bool) view returns (uint256)',
  'function payoutToSell() view returns (uint256)',
  'function sell(uint256,uint256) returns (uint256)',
]);
const deedAbi = parseAbi([
  'function ownerOf(uint256) view returns (address)',
  'function setApprovalForAll(address,bool)',
]);
const paymasterAbi = parseAbi(['function nonces(address) view returns (uint256)']);
const marketAbi = parseAbi([
  'function hasMinted(address) view returns (bool)',
]);

const ceiling = async () => (await parent.getGasPrice()) * 3n;

async function send(
  wallet: ReturnType<typeof createWalletClient>,
  account: any,
  to: Address,
  abi: any,
  functionName: string,
  args: readonly unknown[],
) {
  const hash = await wallet.sendTransaction({
    account,
    chain: null,
    to,
    data: encodeFunctionData({ abi, functionName, args }),
    maxFeePerGas: await ceiling(),
    maxPriorityFeePerGas: 0n,
  });
  const receipt = await parent.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted.`);
  return receipt;
}

function check(condition: boolean, detail: string) {
  if (!condition) throw new Error(`Check failed: ${detail}`);
  console.log(`  ✓ ${detail}`);
}

console.log('\n  VOIDSCAN — REAL SPONSORED MINT PROOF\n');
const user = privateKeyToAccount(generatePrivateKey());
const userWallet = createWalletClient({ account: user, transport: http(RPC) });
console.log(`  temporary wallet: ${user.address}`);

// Only faucet, the explicit approval and cleanup sale need test ETH. The mint
// itself is sent by the relay and paid from the Paymaster ETH reserve.
const fundingHash = await deployerWallet.sendTransaction({
  account: deployer,
  chain: null,
  to: user.address,
  value: parseEther('0.001'),
  maxFeePerGas: await ceiling(),
  maxPriorityFeePerGas: 0n,
});
const fundingReceipt = await parent.waitForTransactionReceipt({ hash: fundingHash });
if (fundingReceipt.status !== 'success') throw new Error('Could not fund the temporary test wallet.');

console.log('\n  [1/4] faucet VOID');
await send(userWallet, user, token, tokenAbi, 'mintTo', [user.address, FAUCET_AMOUNT]);
const voidBalance = await parent.readContract({
  address: token, abi: tokenAbi, functionName: 'balanceOf', args: [user.address],
}) as bigint;
check(voidBalance === FAUCET_AMOUNT, `received ${formatEther(voidBalance)} VOID`);

console.log('\n  [2/4] one exact VOID approval');
const [price, nonce, stockBefore, nextIds] = await Promise.all([
  parent.readContract({ address: amm, abi: ammAbi, functionName: 'priceToBuy', args: [false] }) as Promise<bigint>,
  parent.readContract({ address: paymaster, abi: paymasterAbi, functionName: 'nonces', args: [user.address] }) as Promise<bigint>,
  parent.readContract({ address: amm, abi: ammAbi, functionName: 'available' }) as Promise<bigint>,
  parent.readContract({ address: amm, abi: ammAbi, functionName: 'peek', args: [1n] }) as Promise<readonly bigint[]>,
]);
const boughtId = nextIds[0];
if (boughtId === undefined) throw new Error('The pool was empty before the proof started.');
const approval = price + MAX_GAS_VOID;
await send(userWallet, user, token, tokenAbi, 'approve', [paymaster, approval]);
console.log(`    approved exactly ${formatEther(approval)} VOID to the Paymaster`);

console.log('\n  [3/4] one signed Mint, relayed by VoidScan');
const deadline = BigInt(Math.floor(Date.now() / 1000)) + SIGNATURE_LIFETIME_SECONDS;
const typedRequest = {
  user: user.address,
  market: collectionMarket,
  paymentToken: token,
  paymentSymbol: 'VOID',
  purchaseLabel: 'VOID deed mint',
  appSpend: price,
  maxGasVoid: MAX_GAS_VOID,
  callGasLimit: CALL_GAS_LIMIT,
  nonce,
  deadline,
};
const signature = await user.signTypedData({
  domain: { name: 'VoidCollectionMintPaymaster', version: '1', chainId, verifyingContract: paymaster },
  primaryType: 'MarketPrepaidCall',
  types: {
    MarketPrepaidCall: [
      { name: 'user', type: 'address' }, { name: 'market', type: 'address' },
      { name: 'paymentToken', type: 'address' }, { name: 'paymentSymbol', type: 'string' },
      { name: 'purchaseLabel', type: 'string' }, { name: 'appSpend', type: 'uint256' },
      { name: 'maxGasVoid', type: 'uint256' },
      { name: 'callGasLimit', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  },
  message: typedRequest,
});
const request = {
  user: typedRequest.user,
  market: typedRequest.market,
  paymentToken: typedRequest.paymentToken,
  paymentSymbol: typedRequest.paymentSymbol,
  purchaseLabel: typedRequest.purchaseLabel,
  appSpend: typedRequest.appSpend.toString(),
  maxGasVoid: typedRequest.maxGasVoid.toString(),
  callGasLimit: typedRequest.callGasLimit.toString(),
  nonce: typedRequest.nonce.toString(),
  deadline: typedRequest.deadline.toString(),
};
const relay = await fetch(`${VOIDSCAN_URL}/api/market/sponsor`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ request, signature }),
});
const relayBody = await relay.json() as { hash?: Hex; error?: string };
if (!relay.ok || !relayBody.hash) throw new Error(relayBody.error ?? 'The local relay refused the signed Mint.');
const mintReceipt = await parent.waitForTransactionReceipt({ hash: relayBody.hash });
check(mintReceipt.status === 'success', `relay mined ${relayBody.hash}`);

const [stockAfterMint, hasMinted] = await Promise.all([
  parent.readContract({ address: amm, abi: ammAbi, functionName: 'available' }) as Promise<bigint>,
  parent.readContract({ address: collectionMarket, abi: marketAbi, functionName: 'hasMinted', args: [user.address] }) as Promise<boolean>,
]);
check(stockAfterMint === stockBefore - 1n, `pool moved ${stockBefore} → ${stockAfterMint}`);
check(hasMinted, 'market recorded this wallet\'s permanent one-mint limit');

const owner = await parent.readContract({ address: deed, abi: deedAbi, functionName: 'ownerOf', args: [boughtId] }) as Address;
check(owner.toLowerCase() === user.address.toLowerCase(), 'the deed reached the signing wallet');

console.log('\n  [4/4] return the test deed to keep the pool full');
const payout = await parent.readContract({ address: amm, abi: ammAbi, functionName: 'payoutToSell' }) as bigint;
await send(userWallet, user, deed, deedAbi, 'setApprovalForAll', [amm, true]);
await send(userWallet, user, amm, ammAbi, 'sell', [boughtId, payout]);
const stockAfterCleanup = await parent.readContract({ address: amm, abi: ammAbi, functionName: 'available' }) as bigint;
check(stockAfterCleanup === stockBefore, `pool restored to ${stockAfterCleanup}/${d.parameters.nfts}`);

// Do not leave a funded throwaway wallet behind after the proof. Keep a small
// buffer solely for the transfer's gas; the deployment wallet receives the
// remainder before this process forgets the temporary key.
const recoveryBuffer = parseEther('0.00005');
const userEth = await parent.getBalance({ address: user.address });
if (userEth > recoveryBuffer) {
  const recoveryHash = await userWallet.sendTransaction({
    account: user,
    chain: null,
    to: deployer.address,
    value: userEth - recoveryBuffer,
    maxFeePerGas: await ceiling(),
    maxPriorityFeePerGas: 0n,
  });
  const recovery = await parent.waitForTransactionReceipt({ hash: recoveryHash });
  check(recovery.status === 'success', 'unused test ETH returned to the project wallet');
}

console.log('\n  ✓ COMPLETE: one VOID approval + one EIP-712 signature minted through the live Paymaster relay.\n');
