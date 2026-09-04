/** Permissionless one-shot refresh for the live V6 VOID/ETH TWAP. */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deployment = JSON.parse(readFileSync(resolve(root, 'web/lib/deployment.json'), 'utf8'));
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw new Error('DEPLOYER_PRIVATE_KEY is required.');
const rpcUrl = process.env.PARENT_RPC ?? deployment.network.rpc;
const oracle = deployment.testnet.VoidTwapOracleV6 as Address;
const abi = parseAbi([
  'function update() returns(uint256)',
  'function lastTimestamp() view returns(uint32)',
  'function minInterval() view returns(uint32)',
  'function voidPerEth() view returns(uint256)',
]);
const rpc = createPublicClient({ transport: http(rpcUrl) });
const account = privateKeyToAccount(key as Hex);
const wallet = createWalletClient({ account, transport: http(rpcUrl) });
const [last, minimum, block] = await Promise.all([
  rpc.readContract({ address: oracle, abi, functionName: 'lastTimestamp' }),
  rpc.readContract({ address: oracle, abi, functionName: 'minInterval' }),
  rpc.getBlock(),
]);
const elapsed = block.timestamp - BigInt(last);
if (elapsed < BigInt(minimum)) {
  console.log(`TWAP is already current (${elapsed}/${minimum} seconds).`);
} else {
const hash = await wallet.sendTransaction({
  account,
  chain: null,
  to: oracle,
  data: encodeFunctionData({ abi, functionName: 'update' }),
  maxFeePerGas: (await rpc.getGasPrice()) * 3n,
  maxPriorityFeePerGas: 0n,
});
const receipt = await rpc.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success') throw new Error(`TWAP update reverted: ${hash}`);
const rate = await rpc.readContract({ address: oracle, abi, functionName: 'voidPerEth' });
console.log(`TWAP refreshed: ${hash}`);
console.log(`VOID per ETH: ${rate}`);
}
