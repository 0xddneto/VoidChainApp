import { createPublicClient, getAddress, type Address } from 'viem';
import { CONTRACTS } from './public-release';
import { DEPLOY, rhTransport } from './testnet';

const addressRead = (name: string) => [{ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const;
const uintRead = (name: string) => [{ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }] as const;
const boolRead = (name: string) => [{ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] }] as const;
const same = (a: Address, b: string) => a.toLowerCase() === b.toLowerCase();

export type SecurityCheck = { label: string; actual: string; expected: string; ok: boolean };
export type SecurityState = { checked: boolean; checkedAt: string; checks: SecurityCheck[]; bytecode: SecurityCheck[]; error?: string };

export async function readSecurityState(): Promise<SecurityState> {
  const client = createPublicClient({ transport: rhTransport() });
  const runtime = getAddress(CONTRACTS.Runtime);
  const paymaster = getAddress(CONTRACTS.Paymaster);
  const treasury = getAddress(CONTRACTS.Treasury);
  const timelock = getAddress(CONTRACTS['Protocol timelock']);
  const token = getAddress(CONTRACTS['VOID token']);
  try {
    const reads = await Promise.all([
      client.readContract({ address: timelock, abi: addressRead('proposer'), functionName: 'proposer' }),
      client.readContract({ address: timelock, abi: uintRead('delay'), functionName: 'delay' }),
      client.readContract({ address: paymaster, abi: addressRead('governor'), functionName: 'governor' }),
      client.readContract({ address: treasury, abi: addressRead('governance'), functionName: 'governance' }),
      client.readContract({ address: runtime, abi: addressRead('forwarder'), functionName: 'forwarder' }),
      client.readContract({ address: runtime, abi: addressRead('daoFactory'), functionName: 'daoFactory' }),
      client.readContract({ address: runtime, abi: addressRead('oracle'), functionName: 'oracle' }),
      client.readContract({ address: runtime, abi: addressRead('emergencyGuardian'), functionName: 'emergencyGuardian' }),
      client.readContract({ address: runtime, abi: addressRead('recoveryGovernor'), functionName: 'recoveryGovernor' }),
      client.readContract({ address: token, abi: addressRead('runtimeOperator'), functionName: 'runtimeOperator' }),
      client.readContract({ address: token, abi: addressRead('paymasterOperator'), functionName: 'paymasterOperator' }),
      client.readContract({ address: token, abi: boolRead('operatorsFrozen'), functionName: 'operatorsFrozen' }),
      client.readContract({ address: paymaster, abi: uintRead('dailyChainEthLimit'), functionName: 'dailyChainEthLimit' }),
    ]);
    const [proposer, paymasterGovernor, treasuryGovernor, forwarder, daoFactory, runtimeOracle,
      guardian, recovery, runtimeOperator, paymasterOperator] = [reads[0], reads[2], reads[3], reads[4], reads[5], reads[6], reads[7], reads[8], reads[9], reads[10]] as Address[];
    const delay = reads[1] as bigint;
    const operatorsFrozen = reads[11] as boolean;
    const dailyLimit = reads[12] as bigint;
    const codes = await Promise.all(Object.values(CONTRACTS).map((address) => client.getBytecode({ address: getAddress(address) })));
    const expected = DEPLOY.governance;
    const checks: SecurityCheck[] = [
      { label: 'Timelock proposer', actual: getAddress(proposer), expected: getAddress(expected.proposer), ok: same(proposer, expected.proposer) },
      { label: 'Timelock delay', actual: `${delay.toString()} seconds`, expected: `${expected.delaySeconds} seconds`, ok: delay === BigInt(expected.delaySeconds) },
      { label: 'Paymaster governor', actual: getAddress(paymasterGovernor), expected: timelock, ok: same(paymasterGovernor, timelock) },
      { label: 'Treasury governance', actual: getAddress(treasuryGovernor), expected: timelock, ok: same(treasuryGovernor, timelock) },
      { label: 'Runtime forwarder', actual: getAddress(forwarder), expected: paymaster, ok: same(forwarder, paymaster) },
      { label: 'Runtime DAO factory', actual: getAddress(daoFactory), expected: getAddress(CONTRACTS['DAO factory']), ok: same(daoFactory, CONTRACTS['DAO factory']) },
      { label: 'Runtime oracle', actual: getAddress(runtimeOracle), expected: getAddress(CONTRACTS['Oracle freshness guard']), ok: same(runtimeOracle, CONTRACTS['Oracle freshness guard']) },
      { label: 'Emergency guardian', actual: getAddress(guardian), expected: getAddress(expected.guardian), ok: same(guardian, expected.guardian) },
      { label: 'Recovery governor', actual: getAddress(recovery), expected: getAddress(expected.recovery), ok: same(recovery, expected.recovery) },
      { label: 'VOID Runtime operator', actual: getAddress(runtimeOperator), expected: runtime, ok: same(runtimeOperator, runtime) },
      { label: 'VOID Paymaster operator', actual: getAddress(paymasterOperator), expected: paymaster, ok: same(paymasterOperator, paymaster) },
      { label: 'VOID operators frozen', actual: String(operatorsFrozen), expected: 'true', ok: operatorsFrozen },
      { label: 'Per-chain daily ETH cap', actual: dailyLimit.toString(), expected: DEPLOY.parameters.paymasterDailyEthLimit, ok: dailyLimit === BigInt(DEPLOY.parameters.paymasterDailyEthLimit) },
    ];
    const bytecode = Object.entries(CONTRACTS).map(([label, address], index) => ({
      label: `${label} bytecode`, actual: codes[index] && codes[index] !== '0x' ? 'deployed' : 'missing',
      expected: getAddress(address), ok: Boolean(codes[index] && codes[index] !== '0x'),
    }));
    return { checked: checks.every((check) => check.ok) && bytecode.every((check) => check.ok), checkedAt: new Date().toISOString(), checks, bytecode };
  } catch {
    return { checked: false, checkedAt: new Date().toISOString(), checks: [], bytecode: [], error: 'Live RPC verification is temporarily unavailable.' };
  }
}
