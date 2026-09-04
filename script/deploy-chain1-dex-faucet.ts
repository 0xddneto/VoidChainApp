/** Publishes the paid tUSD/tLINK claim app for the current Chain #1 DEX. */
import { config } from 'dotenv';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, decodeEventLog, encodeDeployData, http, parseEther, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
// Scripts are launched both from the repository root and through npm's
// `--prefix script` command. Load the project-scoped secret file explicitly
// so deployment never depends on the caller's working directory.
config({ path: resolve(root, 'script/.env') });
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
const factory = deployment.production.VoidChainAppFactoryV3 as Address;
const factoryAbi = JSON.parse(readFileSync(resolve(root, 'out/VoidChainAppFactoryV3.sol/VoidChainAppFactoryV3.json'), 'utf8')).abi as Abi;
const registered = await wallet.writeContract({ account, chain: null, address: factory, abi: factoryAbi, functionName: 'publish', args: [BigInt(dex.chainTokenId), receipt.contractAddress, '0x', `0x${Date.now().toString(16).padStart(64, '0')}`], maxFeePerGas: await gas(), maxPriorityFeePerGas: 0n });
const published = await rpc.waitForTransactionReceipt({ hash: registered });
if (published.status !== 'success') throw new Error(`Faucet publication failed: ${registered}`);
const eventLog = published.logs.find(log => log.address.toLowerCase() === factory.toLowerCase());
if (!eventLog) throw new Error('Missing faucet gateway event.');
const event = decodeEventLog({ abi: factoryAbi, data: eventLog.data, topics: eventLog.topics });
dex.faucet = (event.args as unknown as { app: Address }).app;
writeFileSync(configPath, `${JSON.stringify(dex, null, 2)}\n`);
console.log(`Paid Chain #${dex.chainTokenId} test-asset faucet: ${receipt.contractAddress}`);
