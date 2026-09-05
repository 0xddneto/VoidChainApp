import { getAddress } from 'viem';
import { EXPLORER, RELEASE, MANIFEST_HASH } from '@/lib/public-release';

export function TransactionIdentity({ address, action, value }: { address: string; action: string; value: string }) {
  return <section aria-label="Transaction details" style={{border:'1px solid #343344',padding:'16px',margin:'16px 0',fontSize:13,overflowWrap:'anywhere'}}>
    <strong>{action}</strong> · Robinhood Chain Testnet · Chain ID 46630
    <p>To: <a href={`${EXPLORER}/address/${getAddress(address)}`} target="_blank" rel="noopener noreferrer"><code>{getAddress(address)}</code></a></p>
    <p>Value: <strong>{value}</strong></p>
    <small>{RELEASE} · Manifest {MANIFEST_HASH.slice(0, 12)} · <a href="/contracts">Contracts</a> · <a href="/security">Security</a> · <a href="/docs">Docs</a></small>
  </section>;
}
