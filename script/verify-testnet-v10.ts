/** Submit the exact V10 compiler input to Blockscout and confirm every deployed contract. */
import { readFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import solc from 'solc';

const deployment = JSON.parse(readFileSync('deployments/testnet-v10-pending.json', 'utf8'));
const sourceCode = readFileSync('../out/standard-input.json', 'utf8');
const explorer = 'https://explorer.testnet.chain.robinhood.com';
const rpc = createPublicClient({ transport: http(deployment.network.rpc) });
const compiled = JSON.parse(solc.compile(sourceCode, {
  import: (path: string) => ({ error: `Unexpected compiler import: ${path}` }),
}));
const contracts: Record<string, string> = {
  protocolTimelock: 'contracts/parent/VoidProtocolTimelock.sol:VoidProtocolTimelock',
  escrow: 'contracts/genesis/VoidGenesisEscrowV10.sol:VoidGenesisEscrowV10',
  token: 'contracts/genesis/VoidTokenV9.sol:VoidTokenV9',
  deed: 'contracts/parent/VoidChainDeed.sol:VoidChainDeed',
  builder: 'contracts/genesis/VoidTimelockVaultV6.sol:VoidTimelockVaultV6',
  protocol: 'contracts/genesis/VoidTimelockVaultV6.sol:VoidTimelockVaultV6',
  lpLock: 'contracts/genesis/VoidPermanentLpLockV6.sol:VoidPermanentLpLockV6',
  pool: 'contracts/genesis/VoidEthPoolV6.sol:VoidEthPoolV6',
  feed: 'contracts/genesis/VoidFixedEthUsdFeedV6.sol:VoidFixedEthUsdFeedV6',
  twap: 'contracts/genesis/VoidTwapOracleV6.sol:VoidTwapOracleV6',
  oracle: 'contracts/genesis/VoidTwapFreshnessGuardV6.sol:VoidTwapFreshnessGuardV6',
  treasury: 'contracts/parent/VoidChainTreasury.sol:VoidChainTreasury',
  runtime: 'contracts/parent/VoidChainAppRuntimeV6.sol:VoidChainAppRuntimeV6',
  paymaster: 'contracts/parent/VoidPaymaster.sol:VoidPaymaster',
  appFactory: 'contracts/parent/VoidChainAppFactoryV3.sol:VoidChainAppFactoryV3',
  governanceVotes: 'contracts/parent/VoidGovernanceVotesV9.sol:VoidGovernanceVotesV9',
  daoFactory: 'contracts/parent/VoidChainDaoFactory.sol:VoidChainDaoFactory',
  nftImplementation: 'contracts/genesis/VoidGenesisNftAmmV6.sol:VoidGenesisNftAmmV6',
  stakingImplementation: 'contracts/genesis/VoidSoftStakingV9.sol:VoidSoftStakingV9',
  softStaking: 'contracts/parent/VoidChainAppFactoryV3.sol:VoidChainAppGateway',
  nftAmm: 'contracts/parent/VoidChainAppFactoryV3.sol:VoidChainAppGateway',
  mint: 'contracts/genesis/VoidEthGenesisMintV10.sol:VoidEthGenesisMintV10',
};

async function verified(address: string) {
  const response = await fetch(`${explorer}/api/v2/addresses/${address}`);
  if (!response.ok) throw Error(`Explorer read failed for ${address}: ${response.status}`);
  return Boolean((await response.json() as { is_verified?: boolean }).is_verified);
}
async function submit(label: string, address: string, contractName: string) {
  const body = new URLSearchParams({
    module: 'contract', action: 'verifysourcecode', codeformat: 'solidity-standard-json-input',
    contractaddress: address, contractname: contractName,
    compilerversion: 'v0.8.28+commit.7893614a', sourceCode,
  });
  const deployHash = deployment.steps[`deploy:${label}`];
  if (deployHash) {
    const transaction = await rpc.getTransaction({ hash: deployHash });
    const [source, name] = contractName.split(':');
    const creationCode = compiled.contracts[source][name].evm.bytecode.object as string;
    const input = transaction.input.slice(2);
    if (!input.startsWith(creationCode)) throw Error(`Creation bytecode mismatch for ${label}`);
    body.set('constructorArguements', input.slice(creationCode.length));
  }
  const response = await fetch(`${explorer}/api`, { method: 'POST', body });
  const result = await response.json() as { status?: string; result?: string };
  if (/already verified/i.test(result.result ?? '')) return null;
  if (!response.ok || result.status !== '1' || !result.result) {
    throw Error(`Verification rejected for ${address}: ${JSON.stringify(result)}`);
  }
  return result.result;
}
async function status(guid: string) {
  const response = await fetch(`${explorer}/api?module=contract&action=checkverifystatus&guid=${encodeURIComponent(guid)}`);
  return ((await response.json()) as { result?: string }).result ?? 'Unknown verification result';
}

const pending = new Map<string, { address: string; guid: string }>();
for (const [label, contractName] of Object.entries(contracts)) {
  const address = deployment.contracts[label];
  if (!address) throw Error(`Missing ${label}`);
  if (await verified(address)) { console.log(`verified ${label}`); continue; }
  const guid = await submit(label, address, contractName);
  if (guid) pending.set(label, { address, guid });
  console.log(`submitted ${label}`);
}
for (let attempt = 0; pending.size && attempt < 40; ++attempt) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  for (const [label, item] of pending) {
    const result = await status(item.guid);
    if (/pass|already verified/i.test(result) || await verified(item.address)) {
      pending.delete(label); console.log(`verified ${label}`);
    } else if (/fail|unable|error/i.test(result)) throw Error(`Verification failed for ${label}: ${result}`);
  }
}
if (pending.size) throw Error(`Verification timed out: ${[...pending.keys()].join(', ')}`);
console.log(`PASS: ${Object.keys(contracts).length} V10 contracts verified.`);
