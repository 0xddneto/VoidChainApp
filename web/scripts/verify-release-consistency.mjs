import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const deployment = JSON.parse(fs.readFileSync(path.join(root, 'lib/deployment.json'), 'utf8'));
const genesis = JSON.parse(fs.readFileSync(path.join(root, 'lib/genesis-v11.json'), 'utf8'));
const canonical = {
  mint: deployment.production.VoidEthGenesisMintV11,
  deed: deployment.production.VoidChainDeed,
  token: deployment.testnet.VoidTestToken,
  pool: deployment.testnet.VoidEthPoolV6,
  oracle: deployment.testnet.VoidTwapFreshnessGuardV6,
  twapSource: deployment.testnet.VoidTwapOracleV6,
  paymaster: deployment.production.VoidPaymaster,
  nftAmm: deployment.testnet.VoidGenesisNftAmmV6,
};
const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
if (deployment.version !== 'v11-canonical-chainapp-testnet' || genesis.version !== deployment.version) {
  throw new Error('Only the canonical V11 release may be built.');
}
if (deployment.network.chainId !== 46630 || genesis.network.chainId !== 46630) {
  throw new Error('Release chain ID mismatch.');
}
for (const [key, address] of Object.entries(canonical)) {
  if (!sameAddress(address, genesis.contracts[key])) throw new Error(`Manifest mismatch for ${key}.`);
}
for (const file of ['app/contracts/page.tsx', 'app/docs/page.tsx', 'app/security/page.tsx', 'app/mint/page.tsx', 'app/market/page.tsx']) {
  const content = fs.readFileSync(path.join(root, file), 'utf8');
  if (/\bV(?:7|8|9|10)\b/.test(content)) throw new Error(`Retired public release label found in ${file}.`);
}
console.log('Canonical release manifests and public routes agree.');
