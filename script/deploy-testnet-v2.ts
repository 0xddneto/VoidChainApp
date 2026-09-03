/**
 * Deploys the immutable V2 execution path without touching the existing Deeds.
 *
 * The first runtime intentionally froze its paymaster address. V2 therefore is
 * a new Runtime + Paymaster pair that reuses the original Deed, VOID token,
 * oracle and treasury. NFT ownership, prior claims and lifetime accounting stay
 * on their existing contracts.
 *
 * This script deliberately DOES NOT activate Chain #1 or switch the public
 * deployment pointer. `activate` is onlyDeedHolder, so the owner must sign that
 * transaction. Bypassing that rule during a migration would be a privilege
 * escalation, not a migration.
 *
 * Usage: npm run deploy:testnet-v2 --prefix script
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  formatEther,
  getAddress,
  http,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = resolve(root, 'out');
const previous = JSON.parse(readFileSync(resolve(root, 'web/lib/deployment.json'), 'utf8'));
const rpcUrl = process.env.PARENT_RPC ?? previous.network.rpc;
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
const expectedChainId = 46_630;
const chainOne = 1n;

if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? '')) {
  throw new Error('DEPLOYER_PRIVATE_KEY must be a 32-byte key in script/.env.');
}

const account = privateKeyToAccount(privateKey as Hex);
const rpc = createPublicClient({ transport: http(rpcUrl) });
const wallet = createWalletClient({ account, transport: http(rpcUrl) });

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const raw = JSON.parse(readFileSync(resolve(out, `${name}.sol/${name}.json`), 'utf8'));
  const object = raw.bytecode.object as string;
  return {
    abi: raw.abi as Abi,
    bytecode: (object.startsWith('0x') ? object : `0x${object}`) as Hex,
  };
}

async function gasCeiling() {
  return (await rpc.getGasPrice()) * 3n;
}

async function deploy(name: string, args: readonly unknown[]): Promise<Address> {
  const item = artifact(name);
  const hash = await wallet.sendTransaction({
    account,
    chain: null,
    data: encodeDeployData({ abi: item.abi, bytecode: item.bytecode, args }),
    maxFeePerGas: await gasCeiling(),
    maxPriorityFeePerGas: 0n,
  });
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`${name} deployment failed: ${hash}`);
  }
  console.log(`  ✓ ${name.padEnd(22)} ${receipt.contractAddress}`);
  return receipt.contractAddress;
}

async function send(address: Address, abi: Abi, functionName: string, args: readonly unknown[]) {
  const hash = await wallet.writeContract({
    address,
    abi,
    functionName,
    args,
    account,
    chain: null,
    maxFeePerGas: await gasCeiling(),
    maxPriorityFeePerGas: 0n,
  });
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
  return receipt;
}

const oldRuntime = getAddress(previous.production.VoidChainAppRuntime) as Address;
const oldPaymaster = getAddress(previous.production.VoidPaymaster) as Address;
const deed = getAddress(previous.production.VoidChainDeed) as Address;
const treasury = getAddress(previous.production.VoidChainTreasury) as Address;
const token = getAddress(previous.testnet.VoidTestToken) as Address;
const oracle = getAddress(previous.testnet.VoidTestOracle) as Address;
const protocolTreasury = getAddress(previous.governance.protocolTreasury) as Address;

const runtimeAbi = artifact('VoidChainAppRuntime').abi;
const paymasterAbi = artifact('VoidPaymaster').abi;
const treasuryAbi = artifact('VoidChainTreasury').abi;
const deedAbi = artifact('VoidChainDeed').abi;
const daoFactoryAbi = artifact('VoidChainDaoFactory').abi;

console.log('\nVOID CHAINS — TESTNET V2 IMMUTABLE RUNTIME MIGRATION\n');
if (await rpc.getChainId() !== expectedChainId) {
  throw new Error(`Refusing to deploy outside Robinhood testnet ${expectedChainId}.`);
}

const [oldForwarder, oldPaymasterRuntime, deedOwner, oldReserve, marginBps, limits, refillPolicy] = await Promise.all([
  rpc.readContract({ address: oldRuntime, abi: runtimeAbi, functionName: 'forwarder' }) as Promise<Address>,
  rpc.readContract({ address: oldPaymaster, abi: paymasterAbi, functionName: 'runtime' }) as Promise<Address>,
  rpc.readContract({ address: deed, abi: deedAbi, functionName: 'ownerOf', args: [chainOne] }) as Promise<Address>,
  rpc.getBalance({ address: oldPaymaster }),
  rpc.readContract({ address: oldPaymaster, abi: paymasterAbi, functionName: 'marginBps' }) as Promise<bigint>,
  Promise.all([
    rpc.readContract({ address: oldPaymaster, abi: paymasterAbi, functionName: 'ethFloor' }) as Promise<bigint>,
    rpc.readContract({ address: oldPaymaster, abi: paymasterAbi, functionName: 'gasOverhead' }) as Promise<bigint>,
    rpc.readContract({ address: oldPaymaster, abi: paymasterAbi, functionName: 'maxGasPrice' }) as Promise<bigint>,
    rpc.readContract({ address: oldPaymaster, abi: paymasterAbi, functionName: 'maxEthPerBlock' }) as Promise<bigint>,
  ]),
  Promise.all([
    rpc.readContract({ address: oldPaymaster, abi: paymasterAbi, functionName: 'refillThreshold' }) as Promise<bigint>,
    rpc.readContract({ address: oldPaymaster, abi: paymasterAbi, functionName: 'refillTarget' }) as Promise<bigint>,
    rpc.readContract({ address: oldPaymaster, abi: paymasterAbi, functionName: 'refillSlippageBps' }) as Promise<bigint>,
  ]),
]);

if (oldForwarder.toLowerCase() !== oldPaymaster.toLowerCase() || oldPaymasterRuntime.toLowerCase() !== oldRuntime.toLowerCase()) {
  throw new Error('The current runtime/paymaster pairing is not the expected immutable pair. Refusing migration.');
}

console.log(`  legacy runtime:   ${oldRuntime}`);
console.log(`  Chain #1 holder:   ${deedOwner}`);
console.log(`  legacy reserve:    ${formatEther(oldReserve)} ETH`);

console.log('\n[1/4] Deploying V2 runtime, paymaster and DAO factory');
const runtime = await deploy('VoidChainAppRuntime', [deed, token, treasury]);
const paymaster = await deploy('VoidPaymaster', [token, runtime, account.address, protocolTreasury, oracle]);
const daoFactory = await deploy('VoidChainDaoFactory', [runtime, token, deed]);

console.log('\n[2/4] Freezing the V2 trust boundary');
await send(runtime, runtimeAbi, 'setOracle', [oracle]);
await send(runtime, runtimeAbi, 'setForwarderOnce', [paymaster]);
await send(runtime, runtimeAbi, 'setDaoFactoryOnce', [daoFactory]);
await send(treasury, treasuryAbi, 'setAuthorizedSettler', [runtime, true]);
await send(paymaster, paymasterAbi, 'setMargin', [marginBps]);
await send(paymaster, paymasterAbi, 'setLimits', limits);
await send(paymaster, paymasterAbi, 'setRefillPolicy', refillPolicy);

console.log('\n[3/4] Moving the sponsored-gas reserve');
if (oldReserve > 0n) {
  await send(oldPaymaster, paymasterAbi, 'withdrawEth', [paymaster, oldReserve]);
  const v2Reserve = await rpc.getBalance({ address: paymaster });
  if (v2Reserve !== oldReserve) throw new Error('V2 paymaster reserve does not match the transferred legacy reserve.');
  console.log(`  ✓ ${formatEther(v2Reserve)} ETH moved to V2`);
} else {
  console.log('  ✓ no ETH reserve to move');
}

console.log('\n[4/4] Creating Chain #1 V2 DAO');
await send(daoFactory, daoFactoryAbi, 'create', [chainOne]);
const dao = await rpc.readContract({ address: daoFactory, abi: daoFactoryAbi, functionName: 'daoOf', args: [chainOne] }) as Address;
const registeredDao = await rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'daoOf', args: [chainOne] }) as Address;
if (dao.toLowerCase() !== registeredDao.toLowerCase()) throw new Error('V2 DAO was not registered by the V2 runtime.');

const record = {
  network: previous.network,
  migration: {
    version: 'v2-pending-holder-activation',
    createdAt: new Date().toISOString(),
    legacyRuntime: oldRuntime,
    legacyPaymaster: oldPaymaster,
    chainOneHolder: deedOwner,
    reserveMovedWei: oldReserve.toString(),
    note: 'Deeds, VOID token and treasury are reused. Chain #1 must be activated by its Deed holder before public promotion.',
  },
  production: {
    ...previous.production,
    VoidChainAppRuntime: runtime,
    VoidPaymaster: paymaster,
    VoidChainDaoFactory: daoFactory,
  },
  governance: previous.governance,
  testnet: previous.testnet,
  parameters: previous.parameters,
  demoApps: {},
  chainIdBase: previous.chainIdBase,
  chainOne: { deedOwner, dao },
};
const destination = resolve(here, 'deployments/testnet-v2-pending.json');
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, `${JSON.stringify(record, null, 2)}\n`);

console.log('\n✓ V2 foundation is deployed and verified.');
console.log(`  V2 runtime:   ${runtime}`);
console.log(`  V2 paymaster: ${paymaster}`);
console.log(`  V2 DAO #1:    ${dao}`);
console.log(`  record:       ${destination}`);
console.log('\nNEXT SECURITY GATE: the current holder signs V2 activate(1, existingFee).');
console.log('Only after that signature may the public VoidScan pointer leave the legacy runtime.\n');
