/**
 * Publishes a real V4 Uniswap-V2-style DEX for VOID Chain #1.
 *
 * Every user-facing DEX action below is submitted through VoidPaymaster with
 * EIP-712 permits. This deployer account only pays ETH for deployment of code
 * and gateway publication; swaps, pool creation and liquidity use VOID.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, decodeEventLog, decodeFunctionResult,
  encodeDeployData, encodeFunctionData, http, parseAbi, parseEther,
  type Abi, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const rawDeployment = JSON.parse(readFileSync(resolve(root, process.env.VOID_DEPLOYMENT_FILE ?? 'web/lib/deployment.json'), 'utf8'));
// A staged migration uses compact labels until acceptance. Normalize it here
// so apps can be proven before the public manifest is switched.
const deployment = rawDeployment.production ? rawDeployment : {
  version: rawDeployment.version,
  network: rawDeployment.network,
  production: {
    VoidChainAppRuntime: rawDeployment.contracts.runtime,
    VoidPaymaster: rawDeployment.contracts.paymaster,
    VoidChainAppFactoryV3: rawDeployment.contracts.appFactory,
  },
  testnet: {
    VoidTestToken: rawDeployment.contracts.token,
    VoidEthPoolV6: rawDeployment.contracts.pool,
  },
};
const out = resolve(root, 'out');
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw new Error('DEPLOYER_PRIVATE_KEY is required.');
const rpcUrl = process.env.PARENT_RPC ?? deployment.network.rpc;
const rpc = createPublicClient({ transport: http(rpcUrl) });
const account = privateKeyToAccount(key as Hex);
const wallet = createWalletClient({ account, transport: http(rpcUrl) });
const CHAIN = 1n;
const GAS_VOID = parseEther('20000');
// Pool publication creates a pair implementation and its guarded gateway in
// one runtime call. It needs materially more gas than a swap.
const GAS_LIMIT = 3_000_000n;
const runtime = deployment.production.VoidChainAppRuntime as Address;
const paymaster = deployment.production.VoidPaymaster as Address;
const appFactory = deployment.production.VoidChainAppFactoryV3 as Address;
const voidToken = deployment.testnet.VoidTestToken as Address;
const configPath = resolve(root, process.env.VOID_DEX_CONFIG_FILE ?? 'web/lib/dex-chain1.json');
const resumeDex = process.env.DEX_V4_FACTORY as Address | undefined;
const resumeUsd = process.env.DEX_V4_TUSD as Address | undefined;
const resumeLink = process.env.DEX_V4_TLINK as Address | undefined;
const resumePoolUsd = process.env.DEX_V4_POOL_USD as Address | undefined;
const resumePoolLink = process.env.DEX_V4_POOL_LINK as Address | undefined;

function artifact(name: string, source = `${name}.sol`): { abi: Abi; bytecode: Hex } {
  const raw = JSON.parse(readFileSync(resolve(out, `${source}/${name}.json`), 'utf8'));
  const code = raw.bytecode.object as string;
  return { abi: raw.abi as Abi, bytecode: (code.startsWith('0x') ? code : `0x${code}`) as Hex };
}
async function wait(hash: Hex) {
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Reverted: ${hash}`);
  return receipt;
}
async function gas() { return (await rpc.getGasPrice()) * 3n; }
async function deploy(label: string, art: { abi: Abi; bytecode: Hex }, args: readonly unknown[]) {
  const hash = await wallet.sendTransaction({ account, chain: null, data: encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args }), maxFeePerGas: await gas(), maxPriorityFeePerGas: 0n });
  const receipt = await wait(hash);
  if (!receipt.contractAddress) throw new Error(`${label} has no address.`);
  console.log(`  ${label}: ${receipt.contractAddress}`);
  return receipt.contractAddress;
}

const runtimeAbi = parseAbi(['function feeOf(uint256) view returns(uint256)', 'function statsOf(uint256) view returns(bool,uint256,uint256,uint256,uint256)']);
const paymasterAbi = parseAbi([
  'function nonces(address) view returns(uint256)',
  'function sponsorWithAssetPermits((address user,uint256 tokenId,address target,bytes data,uint256 maxToll,uint256 maxGasVoid,uint256 callGasLimit,(address token,uint256 amount)[] spends,(address collection,uint256 tokenId)[] nftSpends,uint256 nonce,uint256 deadline),bytes,(address token,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)[]) returns(bool,bytes)',
]);
const paymasterEvents = parseAbi(['event ExecutionFailed(address indexed user,uint256 indexed tokenId,address target,bytes reason)']);
const tokenAbi = parseAbi(['function balanceOf(address) view returns(uint256)', 'function mintTo(address,uint256)', 'function nonces(address) view returns(uint256)', 'function name() view returns(string)']);
const permitTypes = { Permit: [
  { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
] } as const;
const sponsoredTypes = {
  Spend: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
  SpendNft: [{ name: 'collection', type: 'address' }, { name: 'tokenId', type: 'uint256' }],
  SponsoredCall: [
    { name: 'user', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'target', type: 'address' }, { name: 'data', type: 'bytes' },
    { name: 'maxToll', type: 'uint256' }, { name: 'maxGasVoid', type: 'uint256' }, { name: 'callGasLimit', type: 'uint256' },
    { name: 'spends', type: 'Spend[]' }, { name: 'nftSpends', type: 'SpendNft[]' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
} as const;
const split = (signature: Hex) => ({ v: Number.parseInt(signature.slice(130, 132), 16), r: signature.slice(0, 66) as Hex, s: `0x${signature.slice(66, 130)}` as Hex });

async function sponsored(target: Address, data: Hex, spends: Array<{ token: Address; amount: bigint }>, names: Map<string, string>) {
  const [nonce, fee] = await Promise.all([
    rpc.readContract({ address: paymaster, abi: paymasterAbi, functionName: 'nonces', args: [account.address] }) as Promise<bigint>,
    rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'feeOf', args: [CHAIN] }) as Promise<bigint>,
  ]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const request = { user: account.address, tokenId: CHAIN, target, data, maxToll: fee, maxGasVoid: GAS_VOID, callGasLimit: GAS_LIMIT, spends, nftSpends: [], nonce, deadline };
  const permissionMap = new Map<string, { token: Address; spender: Address; value: bigint }>();
  permissionMap.set(`${voidToken}:${paymaster}`.toLowerCase(), { token: voidToken, spender: paymaster, value: fee + GAS_VOID });
  for (const spend of spends) permissionMap.set(`${spend.token}:${runtime}`.toLowerCase(), { token: spend.token, spender: runtime, value: spend.amount });
  const permits: Array<{ token: Address; spender: Address; value: bigint; deadline: bigint; v: number; r: Hex; s: Hex }> = [];
  const nextPermitNonce = new Map<string, bigint>();
  // Two permissions may be needed for VOID itself (Paymaster + Runtime). Both
  // signatures are delivered in one transaction, so the second one must use
  // the nonce that the first permit will consume, not a second RPC read.
  for (const item of permissionMap.values()) {
    const key = item.token.toLowerCase();
    const tokenNonce = nextPermitNonce.get(key) ?? await rpc.readContract({ address: item.token, abi: tokenAbi, functionName: 'nonces', args: [account.address] }) as bigint;
    nextPermitNonce.set(key, tokenNonce + 1n);
    const name = names.get(item.token.toLowerCase());
    if (!name) throw new Error(`No EIP-2612 name for ${item.token}.`);
    const sig = await account.signTypedData({ domain: { name, version: '1', chainId: 46_630, verifyingContract: item.token }, types: permitTypes, primaryType: 'Permit', message: { owner: account.address, spender: item.spender, value: item.value, nonce: tokenNonce, deadline } });
    permits.push({ ...item, deadline, ...split(sig) });
  }
  const signature = await account.signTypedData({ domain: { name: 'VoidPaymaster', version: '1', chainId: 46_630, verifyingContract: paymaster }, types: sponsoredTypes, primaryType: 'SponsoredCall', message: request });
  const hash = await wallet.writeContract({ account, chain: null, address: paymaster, abi: paymasterAbi, functionName: 'sponsorWithAssetPermits', args: [request, signature, permits], maxFeePerGas: await gas(), maxPriorityFeePerGas: 0n } as never);
  const receipt = await wait(hash);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== paymaster.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: paymasterEvents, data: log.data, topics: log.topics });
      if (event.eventName === 'ExecutionFailed') throw new Error(`Runtime execution failed: ${(event.args as { reason: Hex }).reason}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Runtime execution failed:')) throw error;
    }
  }
  return receipt;
}

function queryAbi(abi: Abi, functionName: string, data: Hex) {
  return decodeFunctionResult({ abi, functionName: functionName as never, data });
}
const gatewayAbi = parseAbi(['function query(bytes) view returns(bytes)']);
async function query(target: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
  const data = encodeFunctionData({ abi, functionName: functionName as never, args: args as never });
  const response = await rpc.readContract({ address: target, abi: gatewayAbi, functionName: 'query', args: [data] }) as Hex;
  return queryAbi(abi, functionName, response);
}

const factoryArt = artifact('VoidChainDexFactoryV4');
const pairArt = artifact('VoidUniswapV2Pair');
const tokenArt = artifact('TestToken');
const appFactoryArt = artifact('VoidChainAppFactoryV3');

if (await rpc.getChainId() !== 46_630) throw new Error('Refusing outside Robinhood testnet.');
const stats = await rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'statsOf', args: [CHAIN] }) as readonly [boolean, bigint, bigint, bigint, bigint];
if (!stats[0]) throw new Error('VOID Chain #1 is not active on V4.');

console.log('\nVOIDDEX — V4 UNISWAP V2 TESTNET DEPLOYMENT\n');
const liquidity = parseEther('10000');
const supply = parseEther('5000000');
let tUsd: Address;
let tLink: Address;
let dex: Address;
let poolUsd: Address;
let poolLink: Address;
if (resumeDex && resumeUsd && resumeLink) {
  console.log('[1/5] Resuming published V4 pools');
  tUsd = resumeUsd; tLink = resumeLink; dex = resumeDex;
  const names = new Map([[voidToken.toLowerCase(), 'VOID'], [tUsd.toLowerCase(), 'Void Test Dollar'], [tLink.toLowerCase(), 'Void Test Link']]);
  for (const asset of [tUsd, tLink]) {
    const existing = await query(dex, factoryArt.abi, 'poolFor', [voidToken, asset]) as Address;
    if (/^0x0{40}$/i.test(existing)) await sponsored(dex, encodeFunctionData({ abi: factoryArt.abi, functionName: 'createPool', args: [voidToken, asset] }), [], names);
  }
  poolUsd = await query(dex, factoryArt.abi, 'poolFor', [voidToken, tUsd]) as Address;
  poolLink = await query(dex, factoryArt.abi, 'poolFor', [voidToken, tLink]) as Address;
} else {
  console.log('[1/5] Deploying test assets and DEX implementation');
  tUsd = await deploy('tUSD', tokenArt, ['Void Test Dollar', 'tUSD', supply]);
  tLink = await deploy('tLINK', tokenArt, ['Void Test Link', 'tLINK', supply]);
  const implementation = await deploy('DEX implementation', factoryArt, [runtime, CHAIN, appFactory]);
  console.log('[2/5] Publishing the DEX factory through V4');
  const publishHash = await wallet.writeContract({ account, chain: null, address: appFactory, abi: appFactoryArt.abi, functionName: 'publish', args: [CHAIN, implementation, '0x', `0x${Date.now().toString(16).padStart(64, '0')}`], maxFeePerGas: await gas(), maxPriorityFeePerGas: 0n } as never);
  const published = await wait(publishHash);
  const log = published.logs.find((entry) => entry.address.toLowerCase() === appFactory.toLowerCase());
  if (!log) throw new Error('DEX factory gateway event missing.');
  const event = decodeEventLog({ abi: appFactoryArt.abi, data: log.data, topics: log.topics });
  if (event.eventName !== 'AppPublished') throw new Error('Unexpected app factory event.');
  dex = (event.args as unknown as { app: Address }).app;
  console.log('[3/5] Funding the liquidity provider and creating pools through VOID');
  if (/^v[678]/.test(deployment.version)) {
    const balance = await rpc.readContract({ address: voidToken, abi: tokenAbi, functionName: 'balanceOf', args: [account.address] });
    if (balance < liquidity * 2n + GAS_VOID * 4n) {
      // V6 VOID is fixed supply. Acquire test liquidity through its real pool;
      // never invoke a legacy token faucet or mint function.
      const poolAbi = parseAbi(['function reserveVoid() view returns(uint112)', 'function reserveEth() view returns(uint112)', 'function swapEthForVoid(uint256) payable returns(uint256)']);
      const pool = deployment.testnet.VoidEthPoolV6 as Address;
      const [rv, re] = await Promise.all([
        rpc.readContract({ address: pool, abi: poolAbi, functionName: 'reserveVoid' }),
        rpc.readContract({ address: pool, abi: poolAbi, functionName: 'reserveEth' }),
      ]);
      const ethIn = parseEther('0.0002');
      const effective = ethIn * 9970n / 10000n;
      const minimum = effective * rv / (re + effective) * 99n / 100n;
      await wait(await wallet.writeContract({ account, chain: null, address: pool, abi: poolAbi, functionName: 'swapEthForVoid', args: [minimum], value: ethIn, maxFeePerGas: await gas(), maxPriorityFeePerGas: 0n }));
    }
  } else {
    throw new Error('This liquidity deployment now requires the fixed-supply V6 stack.');
  }
  const namesForCreation = new Map<string, string>([[voidToken.toLowerCase(), 'VOID'], [tUsd.toLowerCase(), 'Void Test Dollar'], [tLink.toLowerCase(), 'Void Test Link']]);
  for (const asset of [tUsd, tLink]) {
    await sponsored(dex, encodeFunctionData({ abi: factoryArt.abi, functionName: 'createPool', args: [voidToken, asset] }), [], namesForCreation);
  }
  poolUsd = await query(dex, factoryArt.abi, 'poolFor', [voidToken, tUsd]) as Address;
  poolLink = await query(dex, factoryArt.abi, 'poolFor', [voidToken, tLink]) as Address;
  if (/^0x0{40}$/i.test(poolUsd) || /^0x0{40}$/i.test(poolLink)) throw new Error('Factory did not publish pools.');
}
const names = new Map<string, string>([[voidToken.toLowerCase(), 'VOID'], [tUsd.toLowerCase(), 'Void Test Dollar'], [tLink.toLowerCase(), 'Void Test Link']]);

console.log('[4/5] Seeding liquidity through signed VOID requests');
for (const pool of [poolUsd, poolLink]) {
  if ((await query(pool, pairArt.abi, 'totalSupply') as bigint) > 0n) continue;
  const [token0, token1] = await Promise.all([
    query(pool, pairArt.abi, 'token0') as Promise<Address>,
    query(pool, pairArt.abi, 'token1') as Promise<Address>,
  ]);
  await sponsored(pool, encodeFunctionData({ abi: pairArt.abi, functionName: 'addLiquidity', args: [liquidity, liquidity, liquidity - 1_000n] }), [{ token: token0, amount: liquidity }, { token: token1, amount: liquidity }], names);
}

console.log('[5/5] Writing VoidDEX configuration');
const pools = await Promise.all([
  [poolUsd, 'VOID / tUSD', tUsd], [poolLink, 'VOID / tLINK', tLink],
].map(async ([address, label, asset]) => ({ address, label, asset, token0: await query(address as Address, pairArt.abi, 'token0') as Address, token1: await query(address as Address, pairArt.abi, 'token1') as Address })));
writeFileSync(configPath, `${JSON.stringify({ version: deployment.version, chainTokenId: 1, runtime, paymaster, appFactory, factory: dex, baseToken: voidToken, pools }, null, 2)}\n`);
console.log(`✓ V4 DEX factory: ${dex}`);
console.log(`✓ pools: ${poolUsd}, ${poolLink}`);
