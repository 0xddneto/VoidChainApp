import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// V4 retains V3's direct-execution block and adds only static app reads in
// the gateway. It must be explicitly promoted by the Deed holder.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pending = resolve(root, 'script/deployments/testnet-v4-pending.json');
if (existsSync(pending) && process.env.ALLOW_REPLACE_STAGED_V4 !== 'true') {
  throw new Error('V4 is already staged. Refusing to replace a holder-activation candidate.');
}
process.env.RUNTIME_ARTIFACT = 'VoidChainAppRuntimeV4';
process.env.RUNTIME_VERSION = 'V4';
await import('./deploy-testnet-v2.js');
