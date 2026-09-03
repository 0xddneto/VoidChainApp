import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// V3 is the direct-execution-disabled runtime. See deploy-testnet-v2.ts for
// the shared, fail-closed migration and reserve-transfer procedure. A staged
// V3 must never be silently replaced: it may already hold the ETH reserve.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publishedPending = resolve(root, 'web/lib/deployment-v3-pending.json');
if (existsSync(publishedPending) && process.env.ALLOW_REPLACE_STAGED_V3 !== 'true') {
  throw new Error('V3 is already staged. Refusing to deploy another runtime; activate or explicitly replace the staged record first.');
}
process.env.RUNTIME_ARTIFACT = 'VoidChainAppRuntimeV3';
process.env.RUNTIME_VERSION = 'V3';
await import('./deploy-testnet-v2.js');
