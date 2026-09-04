/**
 * Permissionless reserve keeper for VoidPaymaster.
 *
 * The contract chooses when a refill is necessary, the maximum VOID input and
 * the oracle-bound minimum ETH output. This process only pays the parent-chain
 * gas to call that public function. It never handles user signatures, VOID,
 * governance privileges or a price quote of its own.
 *
 * `--once` is read-only when the reserve is healthy. When a refill is needed,
 * it requires KEEPER_PRIVATE_KEY: use a separate, low-funded hot wallet, never
 * the governor/treasury key.
 */
import 'dotenv/config';
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import deployment from '../web/lib/deployment.json' with { type: 'json' };

const rpcUrl = process.env.RPC_URL ?? deployment.network.rpc;
const paymaster = (process.env.PAYMASTER_ADDRESS ?? deployment.production.VoidPaymaster) as Address;
const once = process.argv.includes('--once');
const intervalMs = Math.max(15_000, Number(process.env.KEEPER_INTERVAL_MS ?? 60_000));
const key = process.env.KEEPER_PRIVATE_KEY as Hex | undefined;

const abi = parseAbi([
  'function refillPlan() view returns (bool shouldRefill, uint256 amountVoid, uint256 minEthOut)',
  'function refill(uint256 amountVoid, uint256 minEthOut) returns (uint256 ethOut)',
  'function refillThreshold() view returns (uint256)',
  'function refillTarget() view returns (uint256)',
  'function reimbursableVoid() view returns (uint256)',
  'function swapRouter() view returns (address)',
  'function voidEthPool() view returns (address)',
]);

const client = createPublicClient({ transport: http(rpcUrl) });
const account = key ? privateKeyToAccount(key) : undefined;
const wallet = account ? createWalletClient({ account, transport: http(rpcUrl) }) : undefined;

function text(value: bigint): string {
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}

async function tick(): Promise<void> {
  const [plan, reserve, threshold, target, reimbursable, router, lockedPool] = await Promise.all([
    client.readContract({ address: paymaster, abi, functionName: 'refillPlan' }),
    client.getBalance({ address: paymaster }),
    client.readContract({ address: paymaster, abi, functionName: 'refillThreshold' }),
    client.readContract({ address: paymaster, abi, functionName: 'refillTarget' }),
    client.readContract({ address: paymaster, abi, functionName: 'reimbursableVoid' }),
    client.readContract({ address: paymaster, abi, functionName: 'swapRouter' }),
    client.readContract({ address: paymaster, abi, functionName: 'voidEthPool' }),
  ]);
  const [shouldRefill, amountVoid, minEthOut] = plan;
  const timestamp = new Date().toISOString();
  const route = /^0x0{40}$/i.test(lockedPool) ? router : lockedPool;

  if (!shouldRefill) {
    console.log(`${timestamp} healthy/idle reserve=${text(reserve)} ETH threshold=${text(threshold)} target=${text(target)} reimbursable=${text(reimbursable)} VOID route=${route}`);
    return;
  }
  if (!wallet || !account) {
    throw new Error('A refill is needed. Set KEEPER_PRIVATE_KEY to a dedicated, low-funded keeper wallet before starting writes.');
  }

  const { request } = await client.simulateContract({
    account,
    address: paymaster,
    abi,
    functionName: 'refill',
    args: [amountVoid, minEthOut],
  });
  const hash = await wallet.writeContract(request);
  console.log(`${timestamp} submitted refill tx=${hash} void=${text(amountVoid)} minEth=${text(minEthOut)}`);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Refill reverted: ${hash}`);
  console.log(`${new Date().toISOString()} refill confirmed tx=${hash}`);
}

async function main(): Promise<void> {
  do {
    try {
      await tick();
    } catch (error) {
      console.error(`${new Date().toISOString()} keeper error: ${error instanceof Error ? error.message : String(error)}`);
      if (once) process.exitCode = 1;
    }
    if (!once) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (!once);
}

void main();
