/** Idempotent historical receipt backfill. Never rewinds the live indexer. */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createPublicClient, fallback, http, parseAbiItem, type Address } from 'viem';
import { pool } from '../web/lib/db';

const deployment = JSON.parse(readFileSync('../web/lib/deployment.json', 'utf8'));
const paymaster = deployment.production.VoidPaymaster as Address;
const rpc = createPublicClient({ transport: fallback([
  http(deployment.network.rpc), http('https://rpc.testnet.chain.robinhood.com'),
]) });
const sponsoredEvent = parseAbiItem('event Sponsored(address indexed user,address indexed relayer,uint256 indexed tokenId,uint256 toll,uint256 gasVoid,uint256 marginVoid,uint256 ethReimbursed)');
const failedEvent = parseAbiItem('event ExecutionFailed(address indexed user,uint256 indexed tokenId,address target,bytes reason)');
const bytes = (hex: string | undefined) => hex ? Buffer.from(hex.slice(2), 'hex') : null;
try {
  if (await rpc.getChainId() !== 46630) throw Error('Testnet only');
  const { rows } = await pool.query('SELECT last_indexed_block FROM indexer_state WHERE id=TRUE');
  if (!rows[0]) throw Error('Live indexer cursor is absent');
  const head = BigInt(rows[0].last_indexed_block);
  let count = 0;
  for (let from = BigInt(deployment.network.deployBlock); from <= head; from += 10_000n) {
    const to = from + 9_999n < head ? from + 9_999n : head;
    const range = { address: paymaster, fromBlock: from, toBlock: to };
    const sponsored = await rpc.getLogs({ ...range, event: sponsoredEvent });
    const failures = await rpc.getLogs({ ...range, event: failedEvent });
    const timestamps = new Map<bigint, bigint>();
    for (const log of sponsored) {
      if (!timestamps.has(log.blockNumber!)) {
        timestamps.set(log.blockNumber!, (await rpc.getBlock({ blockNumber: log.blockNumber! })).timestamp);
      }
      // A contract relayer may batch multiple sponsorships in one parent tx.
      // Match only the failure in this sponsorship's log window.
      const previous = sponsored.filter((other) => other.transactionHash === log.transactionHash && other.logIndex! < log.logIndex!)
        .reduce((index, other) => Math.max(index, other.logIndex!), -1);
      const failed = failures.find((other) => other.transactionHash === log.transactionHash
        && other.args.user === log.args.user && other.args.tokenId === log.args.tokenId
        && other.logIndex! > previous && other.logIndex! < log.logIndex!);
      await pool.query(
        `INSERT INTO sponsored_transactions
          (chain_id,tx_hash,log_index,block_number,user_address,relayer_address,target_address,
           success,toll,gas_void,margin_void,eth_reimbursed,failure_reason,timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,to_timestamp($14))
         ON CONFLICT (chain_id,tx_hash,log_index) DO NOTHING`,
        [Number(log.args.tokenId!), bytes(log.transactionHash!), log.logIndex,
          log.blockNumber!.toString(), bytes(log.args.user), bytes(log.args.relayer),
          bytes(failed?.args.target), !failed, log.args.toll!.toString(),
          log.args.gasVoid!.toString(), log.args.marginVoid!.toString(),
          log.args.ethReimbursed!.toString(), bytes(failed?.args.reason),
          timestamps.get(log.blockNumber!)!.toString()],
      );
      count += 1;
    }
    if (sponsored.length) console.log(`Indexed ${sponsored.length} receipts through ${to}`);
  }
  console.log(`PASS: scanned ${count} historical Paymaster receipts through ${head}; live cursor unchanged.`);
} finally { await pool.end(); }
