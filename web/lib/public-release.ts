import { getAddress, keccak256, toHex } from 'viem';
import deployment from './deployment.json';
import genesis from './genesis-v11.json';

export const EXPLORER = 'https://explorer.testnet.chain.robinhood.com';
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
export const MANIFEST_HASH = keccak256(toHex(JSON.stringify({ chainId: deployment.network.chainId, version: RELEASE, contracts: CONTRACTS })));
const expected = { mint: CONTRACTS['ETH mint'], deed: CONTRACTS['Deed NFT'], token: CONTRACTS['VOID token'],
  pool: CONTRACTS['VOID / ETH pool'], oracle: CONTRACTS['Oracle freshness guard'], paymaster: CONTRACTS.Paymaster,
  nftAmm: CONTRACTS['NFT / VOID market'], twapSource: CONTRACTS['TWAP oracle'] };
if (deployment.network.chainId !== 46630 || genesis.network.chainId !== 46630
  || Object.entries(expected).some(([key, value]) => getAddress(genesis.contracts[key as keyof typeof genesis.contracts]) !== getAddress(value))) {
  throw new Error('Public deployment manifests disagree. Release blocked.');
}
