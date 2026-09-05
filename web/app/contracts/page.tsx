import { getAddress } from 'viem';
import { CONTRACTS, CONTRACT_SOURCES, EXPLORER, RELEASE, MANIFEST_HASH, SOURCE_REPOSITORY } from '@/lib/public-release';
import styles from '../docs/page.module.css';
export default function ContractsPage() {
  const sourceRef = process.env.VERCEL_GIT_COMMIT_SHA ?? 'main';
  return <><header className={styles.header}><div className={styles.bar}><a href="/">VOIDSCAN</a><a href="/docs">Docs</a><a href="/security">Security</a></div></header>
    <main className={styles.wrap}><article className={styles.docs}><h1>Active testnet contracts</h1><p>{RELEASE} · Robinhood Chain Testnet · Chain ID 46630</p>
      <p>V11 is the single canonical testnet deployment used by the public app. Every row links both to its testnet bytecode and to the exact public source revision that built this page. Source verification is not a substitute for an independent security audit.</p>
      {Object.entries(CONTRACTS).map(([name, address]) => <section key={name}><h2>{name}</h2><p><a style={{overflowWrap:'anywhere'}} href={`${EXPLORER}/address/${getAddress(address)}`} target="_blank" rel="noopener noreferrer">{getAddress(address)}</a></p><p><a href={`${SOURCE_REPOSITORY}/blob/${sourceRef}/${CONTRACT_SOURCES[name as keyof typeof CONTRACTS]}`} target="_blank" rel="noopener noreferrer">Source at {sourceRef.slice(0, 12)}</a></p></section>)}
      <p style={{overflowWrap:'anywhere'}}>Manifest fingerprint: <code>{MANIFEST_HASH}</code></p><p><a href="/api/release">Machine-readable release</a> · <a href={`${SOURCE_REPOSITORY}/tree/${sourceRef}`} target="_blank" rel="noopener noreferrer">Complete public source</a> · <a href="/api/security">Live authority check</a></p>
    </article></main></>;
}
