/** Pins a fail-closed freshness guard in front of the V6 Runtime and Paymaster. */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, encodeDeployData, encodeFunctionData, http, parseAbi, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const recordPath = resolve(root, 'script/deployments/testnet-v6-pending.json');
const record = JSON.parse(readFileSync(recordPath, 'utf8'));
if (record.testnet.VoidTwapFreshnessGuardV6) throw new Error('V6 TWAP guard is already pinned.');
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw new Error('DEPLOYER_PRIVATE_KEY is required.');
const account = privateKeyToAccount(key as Hex);
const rpcUrl = process.env.PARENT_RPC ?? record.network.rpc;
const rpc = createPublicClient({ transport: http(rpcUrl) });
const wallet = createWalletClient({ account, transport: http(rpcUrl) });
const out = resolve(root, 'out');
function artifact(name: string): { abi: Abi; bytecode: Hex } { const raw = JSON.parse(readFileSync(resolve(out, `${name}.sol/${name}.json`), 'utf8')); const code = raw.bytecode.object as string; return { abi: raw.abi as Abi, bytecode: (code.startsWith('0x') ? code : `0x${code}`) as Hex }; }
async function gas() { return (await rpc.getGasPrice()) * 3n; }
async function send(to: Address, data: Hex) { const h = await wallet.sendTransaction({ account, chain: null, to, data, maxFeePerGas: await gas(), maxPriorityFeePerGas: 0n }); const r = await rpc.waitForTransactionReceipt({ hash: h }); if (r.status !== 'success') throw new Error(`reverted: ${h}`); return h; }
const source = record.testnet.VoidTwapOracleV6 as Address;
const runtime = record.production.VoidChainAppRuntime as Address;
const paymaster = record.production.VoidPaymaster as Address;
const item = artifact('VoidTwapFreshnessGuardV6');
const deployed = await wallet.sendTransaction({
  account, chain: null, data: encodeDeployData({ abi: item.abi, bytecode: item.bytecode, args: [source, 900] }),
  maxFeePerGas: await gas(), maxPriorityFeePerGas: 0n,
});
const receipt = await rpc.getTransactionReceipt({ hash: deployed });
if (!receipt.contractAddress) throw new Error('Guard deployment did not return an address.');
const guard = receipt.contractAddress;
const runtimeAbi = parseAbi(['function setOracle(address)']);
const paymasterAbi = parseAbi(['function setOracle(address)', 'function voidPerEth() view returns(uint256)']);
await send(runtime, encodeFunctionData({ abi: runtimeAbi, functionName: 'setOracle', args: [guard] }));
await send(paymaster, encodeFunctionData({ abi: paymasterAbi, functionName: 'setOracle', args: [guard] }));
const rate = await rpc.readContract({ address: paymaster, abi: paymasterAbi, functionName: 'voidPerEth' }) as bigint;
if (rate === 0n) throw new Error('Fresh guard did not expose the active TWAP.');
record.testnet.VoidTwapFreshnessGuardV6 = guard;
record.parameters.twapMaxAgeSeconds = 900;
record.hardening = { twapGuardDeployment: deployed, status: 'runtime-and-paymaster-fail-closed-after-15-minutes' };
writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(`✓ TWAP freshness guard: ${guard}`);
console.log('✓ Runtime and Paymaster now reject a TWAP older than 15 minutes.');
