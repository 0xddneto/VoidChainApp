/** Completes and verifies the public V6 TWAP observation window. */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(root, 'script/deployments/testnet-v6-pending.json');
const record = JSON.parse(readFileSync(path, 'utf8'));
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw new Error('DEPLOYER_PRIVATE_KEY is required.');
const account = privateKeyToAccount(key as Hex);
const rpc = createPublicClient({ transport: http(process.env.PARENT_RPC ?? record.network.rpc) });
const wallet = createWalletClient({ account, transport: http(process.env.PARENT_RPC ?? record.network.rpc) });
const oracle = record.testnet.VoidTwapOracleV6 as Address;
const pool = record.testnet.VoidEthPoolV6 as Address;
const paymaster = record.production.VoidPaymaster as Address;
const oracleAbi = parseAbi(['function update() returns(uint256)','function voidPerEth() view returns(uint256)','function voidUsd() view returns(uint256)','function lastTimestamp() view returns(uint32)','function minInterval() view returns(uint32)']);
const poolAbi = parseAbi(['function reserveVoid() view returns(uint112)','function reserveEth() view returns(uint112)']);
const paymasterAbi = parseAbi(['function voidPerEth() view returns(uint256)', 'function needsRefill() view returns(bool)']);
async function gas() { return (await rpc.getGasPrice()) * 3n; }

if (!record.firstMintProof || record.firstMintProof.status !== 'awaiting-five-minute-twap-update') {
  throw new Error('V6 is not awaiting its first TWAP update.');
}
const [lastTimestamp, minInterval, latestBlock] = await Promise.all([
  rpc.readContract({ address: oracle, abi: oracleAbi, functionName: 'lastTimestamp' }) as Promise<number>,
  rpc.readContract({ address: oracle, abi: oracleAbi, functionName: 'minInterval' }) as Promise<number>,
  rpc.getBlock(),
]);
const elapsed = Number(latestBlock.timestamp) - lastTimestamp;
if (elapsed < minInterval) {
  throw new Error(`TWAP window is still warming: ${elapsed}/${minInterval} seconds. No transaction was sent.`);
}
const hash = await wallet.sendTransaction({
  account, chain: null, to: oracle, data: encodeFunctionData({ abi: oracleAbi, functionName: 'update' }),
  maxFeePerGas: await gas(), maxPriorityFeePerGas: 0n,
});
const receipt = await rpc.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success') throw new Error(`TWAP update reverted: ${hash}`);
const [rate, voidUsd, poolVoid, poolEth, paymasterRate, refillNeeded] = await Promise.all([
  rpc.readContract({ address: oracle, abi: oracleAbi, functionName: 'voidPerEth' }) as Promise<bigint>,
  rpc.readContract({ address: oracle, abi: oracleAbi, functionName: 'voidUsd' }) as Promise<bigint>,
  rpc.readContract({ address: pool, abi: poolAbi, functionName: 'reserveVoid' }) as Promise<bigint>,
  rpc.readContract({ address: pool, abi: poolAbi, functionName: 'reserveEth' }) as Promise<bigint>,
  rpc.readContract({ address: paymaster, abi: paymasterAbi, functionName: 'voidPerEth' }) as Promise<bigint>,
  rpc.readContract({ address: paymaster, abi: paymasterAbi, functionName: 'needsRefill' }) as Promise<boolean>,
]);
const expected = poolVoid * 10n ** 18n / poolEth;
if (rate !== expected || paymasterRate !== rate || rate === 0n || voidUsd === 0n) {
  throw new Error('TWAP/Paymaster rate mismatch.');
}
record.firstMintProof = { ...record.firstMintProof, twapUpdateTransaction: hash, voidPerEth: rate.toString(), voidUsd: voidUsd.toString(), status: 'twap-ready' };
writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
console.log('✓ five-minute VOID/ETH TWAP published');
console.log(`✓ rate: ${rate} VOID per ETH (18 decimals)`);
console.log(`✓ Paymaster reads the same rate; refill currently ${refillNeeded ? 'available' : 'not needed'}`);
console.log(`✓ update transaction: ${hash}`);
