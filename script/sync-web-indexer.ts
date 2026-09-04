/** Rebuild only derived explorer data, using the current deployment manifest. */
import { createPublicClient, http } from 'viem';
import deployment from '../web/lib/deployment.json';
import { indexOnePass } from '../web/lib/chain-indexer';
import { pool } from '../web/lib/db';

try {
  const rpc = createPublicClient({ transport: http(process.env.PARENT_RPC ?? deployment.network.rpc) });
  const head = await rpc.getBlockNumber();
  for (let pass = 0; pass < 200; pass++) {
    const result = await indexOnePass();
    console.log(JSON.stringify(result));
    if (result.status === 'busy') throw new Error('Another indexer holds the lock.');
    if (result.to && BigInt(result.to) >= head) break;
    if (pass === 199) throw new Error('Pass limit reached; run again to continue.');
  }
} finally {
  await pool.end();
}
