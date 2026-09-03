/** Publishes the paid tUSD/tLINK claim app for the current Chain #1 DEX. */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, encodeDeployData, http, parseEther, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const deployment = JSON.parse(readFileSync(resolve(root, 'web/lib/deployment.json'), 'utf8'));
const configPath = resolve(root, 'web/lib/dex-chain1.json');
const dex = JSON.parse(readFileSync(configPath, 'utf8')) as { chainTokenId: number; runtime: Address; pools: Array<{ asset: Address }> ; faucet?: Address };
const key = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw new Error('DEPLOYER_PRIVATE_KEY is required.');
const account = privateKeyToAccount(key!);
const rpc = createPublicClient({ transport: http(process.env.PARENT_RPC ?? deployment.network.rpc) });
const wallet = createWalletClient({ account, transport: http(process.env.PARENT_RPC ?? deployment.network.rpc) });
const source = 'VoidDexTestFaucet.sol';
const raw = JSON.parse(readFileSync(resolve(root, `out/${source}/VoidDexTestFaucet.json`), 'utf8'));
const faucet = { abi: raw.abi as Abi, bytecode: `${raw.bytecode.object}`.replace(/^0x/, '0x') as Hex };
const runtimeAbi = [{ type: 'function', name: 'registerApp', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }, { type: 'address' }], outputs: [] }] as const;

if (await rpc.getChainId() !== 46_630) throw new Error('Refusing to deploy outside Robinhood testnet.');
const gas = () => rpc.getGasPrice().then((value) => value * 3n);
const tx = await wallet.sendTransaction({ account, chain: null, data: encodeDeployData({ abi: faucet.abi, bytecode: faucet.bytecode, args: [dex.runtime, BigInt(dex.chainTokenId), dex.pools[0].asset, dex.pools[1].asset, parseEther('100000')] }), maxFeePerGas: await gas(), maxPriorityFeePerGas: 0n });
const receipt = await rpc.waitForTransactionReceipt({ hash: tx });
if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`Faucet deployment failed: ${tx}`);
const registered = await wallet.writeContract({ account, chain: null, address: dex.runtime, abi: runtimeAbi, functionName: 'registerApp', args: [BigInt(dex.chainTokenId), receipt.contractAddress], maxFeePerGas: await gas(), maxPriorityFeePerGas: 0n });
if ((await rpc.waitForTransactionReceipt({ hash: registered })).status !== 'success') throw new Error(`Faucet registration failed: ${registered}`);
dex.faucet = receipt.contractAddress;
writeFileSync(configPath, `${JSON.stringify(dex, null, 2)}\n`);
console.log(`Paid Chain #${dex.chainTokenId} test-asset faucet: ${receipt.contractAddress}`);
