/** First on-chain proof for the staged V6 genesis. */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, encodeFunctionData, http, keccak256,
  parseAbi, toHex, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const recordPath = resolve(root, 'script/deployments/testnet-v6-pending.json');
const record = JSON.parse(readFileSync(recordPath, 'utf8'));
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw new Error('DEPLOYER_PRIVATE_KEY is required.');
const account = privateKeyToAccount(key as Hex);
const rpcUrl = process.env.PARENT_RPC ?? record.network.rpc;
const rpc = createPublicClient({ transport: http(rpcUrl) });
const wallet = createWalletClient({ account, transport: http(rpcUrl) });

const mint = record.production.VoidEthGenesisMintV6 as Address;
const deed = record.production.VoidChainDeed as Address;
const runtime = record.production.VoidChainAppRuntime as Address;
const appFactory = record.production.VoidChainAppFactoryV3 as Address;
const escrow = record.testnet.VoidGenesisEscrowV6 as Address;
const pool = record.testnet.VoidEthPoolV6 as Address;
const oracle = record.testnet.VoidTwapOracleV6 as Address;
const marketImplementation = record.testnet.VoidGenesisNftAmmV6Implementation as Address;
const paymaster = record.production.VoidPaymaster as Address;
const mintPrice = BigInt(record.parameters.mintPriceWei);
const lpExpected = (mintPrice * 4000n) / 10000n;
const paymasterExpected = (mintPrice * 2000n) / 10000n;

const mintAbi = parseAbi([
  'function mint() payable returns (uint256)', 'function totalMinted() view returns (uint256)',
  'function hasMinted(address) view returns (bool)',
]);
const deedAbi = parseAbi(['function ownerOf(uint256) view returns (address)']);
const runtimeAbi = parseAbi(['function activate(uint256,uint256)', 'function statsOf(uint256) view returns(bool,uint256,uint256,uint256,uint256)']);
const factoryAbi = parseAbi(['function publish(uint256,address,bytes,bytes32) returns(address)', 'event AppPublished(uint256 indexed tokenId,address indexed app,address indexed publisher,address implementation,bytes32 salt)']);
const escrowAbi = parseAbi(['function setNftAmmOnce(address)', 'function nftAmm() view returns(address)']);
const poolAbi = parseAbi(['function reserveVoid() view returns(uint112)', 'function reserveEth() view returns(uint112)']);
const oracleAbi = parseAbi(['function bootstrap()', 'function lastTimestamp() view returns(uint32)', 'function voidPerEth() view returns(uint256)']);

async function gas() { return (await rpc.getGasPrice()) * 3n; }
async function wait(hash: Hex) {
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);
  return receipt;
}
async function send(to: Address, data: Hex, value = 0n) {
  return wait(await wallet.sendTransaction({ account, chain: null, to, data, value, maxFeePerGas: await gas(), maxPriorityFeePerGas: 0n }));
}
function check(condition: boolean, text: string) {
  if (!condition) throw new Error(`Check failed: ${text}`);
  console.log(`  ✓ ${text}`);
}

if (await rpc.getChainId() !== 46630) throw new Error('Wrong network.');
if (record.firstMintProof) throw new Error('First-mint proof already recorded; refusing to run twice.');

console.log('\nVOID V6 — FIRST ETH MINT AND GENESIS PROOF\n');
const [supplyBefore, paymasterBefore] = await Promise.all([
  rpc.readContract({ address: mint, abi: mintAbi, functionName: 'totalMinted' }) as Promise<bigint>,
  rpc.getBalance({ address: paymaster }),
]);
check(supplyBefore === 0n, 'no V6 Deed was minted before the proof');

console.log('\n[1/4] normal ETH mint');
const mintReceipt = await send(mint, encodeFunctionData({ abi: mintAbi, functionName: 'mint' }), mintPrice);
const [supplyAfter, mintedByGovernor, owner, poolVoid, poolEth, paymasterAfter] = await Promise.all([
  rpc.readContract({ address: mint, abi: mintAbi, functionName: 'totalMinted' }) as Promise<bigint>,
  rpc.readContract({ address: mint, abi: mintAbi, functionName: 'hasMinted', args: [account.address] }) as Promise<boolean>,
  rpc.readContract({ address: deed, abi: deedAbi, functionName: 'ownerOf', args: [1n] }) as Promise<Address>,
  rpc.readContract({ address: pool, abi: poolAbi, functionName: 'reserveVoid' }) as Promise<bigint>,
  rpc.readContract({ address: pool, abi: poolAbi, functionName: 'reserveEth' }) as Promise<bigint>,
  rpc.getBalance({ address: paymaster }),
]);
check(supplyAfter === 1n && mintedByGovernor, 'the one-per-wallet ETH mint was recorded');
check(owner.toLowerCase() === account.address.toLowerCase(), 'Deed #1 belongs to the testnet governance wallet');
check(poolVoid === 200_000n * 10n ** 18n && poolEth === lpExpected, 'the locked VOID/ETH LP received its exact 40% split');
check(paymasterAfter - paymasterBefore === paymasterExpected, 'the Paymaster reserve received its exact 20% split');

console.log('\n[2/4] activate Chain #1 with its published initial transaction fee');
await send(runtime, encodeFunctionData({ abi: runtimeAbi, functionName: 'activate', args: [1n, 1_000_000_000_000_000n] }));
const stats = await rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'statsOf', args: [1n] }) as readonly [boolean, bigint, bigint, bigint, bigint];
check(stats[0], 'Chain #1 is active; future app calls enter through the VOID-only Runtime');

console.log('\n[3/4] publish and pin the NFT/VOID AMM gateway');
const salt = keccak256(toHex('void-v6-genesis-nft-amm-chain-1'));
const publishReceipt = await send(appFactory, encodeFunctionData({
  abi: factoryAbi, functionName: 'publish', args: [1n, marketImplementation, '0x', salt],
}));
const published = publishReceipt.logs.find((log) => log.address.toLowerCase() === appFactory.toLowerCase());
if (!published || !published.topics[2]) throw new Error('Could not find the NFT AMM gateway address in AppPublished.');
const gateway = `0x${published.topics[2].slice(-40)}` as Address;
await send(escrow, encodeFunctionData({ abi: escrowAbi, functionName: 'setNftAmmOnce', args: [gateway] }));
const pinned = await rpc.readContract({ address: escrow, abi: escrowAbi, functionName: 'nftAmm' }) as Address;
check(pinned.toLowerCase() === gateway.toLowerCase(), 'the escrow permanently recognizes only this NFT/VOID market gateway');

console.log('\n[4/4] bootstrap the public five-minute TWAP window');
await send(oracle, encodeFunctionData({ abi: oracleAbi, functionName: 'bootstrap' }));
const [twapStart, currentRate] = await Promise.all([
  rpc.readContract({ address: oracle, abi: oracleAbi, functionName: 'lastTimestamp' }) as Promise<number>,
  rpc.readContract({ address: oracle, abi: oracleAbi, functionName: 'voidPerEth' }) as Promise<bigint>,
]);
check(twapStart > 0 && currentRate === 0n, 'the oracle refuses sponsorship until a full TWAP interval completes');

record.firstMintProof = {
  mintTransaction: mintReceipt.transactionHash, gateway, twapBootstrappedAt: twapStart,
  status: 'awaiting-five-minute-twap-update',
};
writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(`\n✓ first V6 mint: ${mintReceipt.transactionHash}`);
console.log(`✓ NFT/VOID market gateway: ${gateway}`);
console.log('  Wait for the five-minute observation window, then run prove:v6-twap.\n');
