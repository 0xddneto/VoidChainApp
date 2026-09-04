/** Submit the exact deployment compiler input to Blockscout and confirm every contract. */
import { readFileSync } from 'node:fs';

const deployment = JSON.parse(readFileSync('deployments/testnet-v8-pending.json', 'utf8'));
const sourceCode = readFileSync('../out/standard-input.json', 'utf8');
const explorer = 'https://explorer.testnet.chain.robinhood.com';
const contracts: Record<string, string> = {
  protocolTimelock: 'contracts/parent/VoidProtocolTimelock.sol:VoidProtocolTimelock',
  escrow: 'contracts/genesis/VoidGenesisEscrowV6.sol:VoidGenesisEscrowV6',
  token: 'contracts/genesis/VoidTokenV6.sol:VoidTokenV6',
  deed: 'contracts/parent/VoidChainDeed.sol:VoidChainDeed',
  builder: 'contracts/genesis/VoidTimelockVaultV6.sol:VoidTimelockVaultV6',
  protocol: 'contracts/genesis/VoidTimelockVaultV6.sol:VoidTimelockVaultV6',
  lpLock: 'contracts/genesis/VoidPermanentLpLockV6.sol:VoidPermanentLpLockV6',
  pool: 'contracts/genesis/VoidEthPoolV6.sol:VoidEthPoolV6',
  feed: 'contracts/genesis/VoidFixedEthUsdFeedV6.sol:VoidFixedEthUsdFeedV6',
  twap: 'contracts/genesis/VoidTwapOracleV6.sol:VoidTwapOracleV6',
  oracle: 'contracts/genesis/VoidTwapFreshnessGuardV6.sol:VoidTwapFreshnessGuardV6',
  treasury: 'contracts/parent/VoidChainTreasury.sol:VoidChainTreasury',
  runtime: 'contracts/parent/VoidChainAppRuntimeV5.sol:VoidChainAppRuntimeV5',
  paymaster: 'contracts/parent/VoidPaymaster.sol:VoidPaymaster',
  daoFactory: 'contracts/parent/VoidChainDaoFactory.sol:VoidChainDaoFactory',
  appFactory: 'contracts/parent/VoidChainAppFactoryV3.sol:VoidChainAppFactoryV3',
  nftImplementation: 'contracts/genesis/VoidGenesisNftAmmV6.sol:VoidGenesisNftAmmV6',
  nftAmm: 'contracts/parent/VoidChainAppFactoryV3.sol:VoidChainAppGateway',
  mint: 'contracts/genesis/VoidEthGenesisMintV8.sol:VoidEthGenesisMintV8',
};

async function verified(address: string): Promise<boolean> {
  const response = await fetch(`${explorer}/api/v2/addresses/${address}`);
  if (!response.ok) throw Error(`Explorer read failed for ${address}: ${response.status}`);
  return Boolean((await response.json() as { is_verified?: boolean }).is_verified);
}

async function submit(address: string, contractName: string): Promise<string | null> {
  const body = new URLSearchParams({
    module: 'contract', action: 'verifysourcecode',
    codeformat: 'solidity-standard-json-input', contractaddress: address,
    contractname: contractName, compilerversion: 'v0.8.28+commit.7893614a', sourceCode,
  });
  const response = await fetch(`${explorer}/api`, { method: 'POST', body });
  const result = await response.json() as { status?: string; result?: string };
  if (/already verified/i.test(result.result ?? '')) return null;
  if (!response.ok || result.status !== '1' || !result.result) {
    throw Error(`Verification rejected for ${address}: ${JSON.stringify(result)}`);
  }
  return result.result;
}

async function status(guid: string): Promise<string> {
  const response = await fetch(`${explorer}/api?module=contract&action=checkverifystatus&guid=${encodeURIComponent(guid)}`);
  const result = await response.json() as { result?: string };
  return result.result ?? 'Unknown verification result';
}

const pending = new Map<string, { address: string; guid: string }>();
for (const [label, contractName] of Object.entries(contracts)) {
  const address = deployment.contracts[label];
  if (!address) throw Error(`Missing ${label}`);
  if (await verified(address)) { console.log(`verified ${label} ${address}`); continue; }
  const guid = await submit(address, contractName);
  if (guid === null) { console.log(`verified ${label} ${address}`); continue; }
  pending.set(label, { address, guid });
  console.log(`submitted ${label} ${address}`);
}

for (let attempt = 0; pending.size > 0 && attempt < 40; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  for (const [label, item] of pending) {
    const result = await status(item.guid);
    if (/pass|already verified/i.test(result) || await verified(item.address)) {
      pending.delete(label);
      console.log(`verified ${label} ${item.address}`);
    // Some Blockscout instances briefly return "Unknown UID" while the
    // verifier queue and API database converge. Only an explicit failure is
    // terminal; the final address check remains authoritative.
    } else if (/fail|unable|error/i.test(result)) {
      throw Error(`Verification failed for ${label}: ${result}`);
    }
  }
}
if (pending.size > 0) throw Error(`Verification timed out: ${[...pending.keys()].join(', ')}`);
console.log(`PASS: ${Object.keys(contracts).length} V8 contracts verified.`);
