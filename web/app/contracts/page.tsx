import { getAddress } from 'viem';
import { CONTRACTS, EXPLORER, RELEASE, MANIFEST_HASH } from '@/lib/public-release';
import styles from '../docs/page.module.css';
export default function ContractsPage() {
  return <><header className={styles.header}><div className={styles.bar}><a href="/">VOIDSCAN</a><a href="/docs">Docs</a><a href="/security">Security</a></div></header>
    <main className={styles.wrap}><article className={styles.docs}><h1>Active testnet contracts</h1><p>{RELEASE} · Robinhood Chain Testnet · Chain ID 46630</p>
      <p>V11 source is not deployed. These are the addresses used by the public app. Explorer source verification is not a security audit.</p>
      {Object.entries(CONTRACTS).map(([name, address]) => <section key={name}><h2>{name}</h2><a style={{overflowWrap:'anywhere'}} href={`${EXPLORER}/address/${getAddress(address)}`} target="_blank" rel="noopener noreferrer">{getAddress(address)}</a></section>)}
      <p style={{overflowWrap:'anywhere'}}>Manifest fingerprint: <code>{MANIFEST_HASH}</code></p><a href="/api/release">Machine-readable release</a>
    </article></main></>;
}
