import { getAddress, keccak256, toHex } from 'viem';
import deployment from './deployment.json';
import genesis from './genesis-v11.json';

export const EXPLORER = 'https://explorer.testnet.chain.robinhood.com';
export const SOURCE_REPOSITORY = 'https://github.com/0xddneto/VoidChainApp';
export const CANONICAL_ORIGIN = 'https://voidscan.voidshub.com';
export const RELEASE = deployment.version;
export const CONTRACTS = {
  'ETH mint': deployment.production.VoidEthGenesisMintV11,
  'Deed NFT': deployment.production.VoidChainDeed,
  'VOID token': deployment.testnet.VoidTestToken,
  Runtime: deployment.production.VoidChainAppRuntime,
  Paymaster: deployment.production.VoidPaymaster,
  Treasury: deployment.production.VoidChainTreasury,
  'Protocol timelock': deployment.production.VoidProtocolTimelock,
  'DAO factory': deployment.production.VoidChainDaoFactory,
  'Application factory': deployment.production.VoidChainAppFactoryV3,
  'NFT / VOID market': deployment.testnet.VoidGenesisNftAmmV6,
  'VOID / ETH pool': deployment.testnet.VoidEthPoolV6,
  'TWAP oracle': deployment.testnet.VoidTwapOracleV6,
  'Oracle freshness guard': deployment.testnet.VoidTwapFreshnessGuardV6,
};
export const CONTRACT_SOURCES: Record<keyof typeof CONTRACTS, string> = {
  'ETH mint': 'contracts/genesis/VoidEthGenesisMintV11.sol',
  'Deed NFT': 'contracts/parent/VoidChainDeed.sol',
  'VOID token': 'contracts/genesis/VoidTokenV11.sol',
  Runtime: 'contracts/parent/VoidChainAppRuntimeV11.sol',
  Paymaster: 'contracts/parent/VoidPaymaster.sol',
  Treasury: 'contracts/parent/VoidChainTreasury.sol',
  'Protocol timelock': 'contracts/parent/VoidProtocolTimelock.sol',
  'DAO factory': 'contracts/parent/VoidChainDaoFactory.sol',
  'Application factory': 'contracts/parent/VoidChainAppFactoryV3.sol',
  'NFT / VOID market': 'contracts/genesis/VoidGenesisNftAmmV6.sol',
  'VOID / ETH pool': 'contracts/genesis/VoidEthPoolV6.sol',
  'TWAP oracle': 'contracts/genesis/VoidTwapOracleV6.sol',
  'Oracle freshness guard': 'contracts/genesis/VoidTwapFreshnessGuardV6.sol',
};
export const MANIFEST_HASH = keccak256(toHex(JSON.stringify({ chainId: deployment.network.chainId, version: RELEASE, contracts: CONTRACTS })));
const expected = { mint: CONTRACTS['ETH mint'], deed: CONTRACTS['Deed NFT'], token: CONTRACTS['VOID token'],
  pool: CONTRACTS['VOID / ETH pool'], oracle: CONTRACTS['Oracle freshness guard'], paymaster: CONTRACTS.Paymaster,
  nftAmm: CONTRACTS['NFT / VOID market'], twapSource: CONTRACTS['TWAP oracle'] };
if (deployment.network.chainId !== 46630 || genesis.network.chainId !== 46630
  || Object.entries(expected).some(([key, value]) => getAddress(genesis.contracts[key as keyof typeof genesis.contracts]) !== getAddress(value))) {
  throw new Error('Public deployment manifests disagree. Release blocked.');
}
