import styles from '../docs/page.module.css';
import { readSecurityState } from '@/lib/security-state';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function SecurityPage() {
  const state = await readSecurityState();
  return <><header className={styles.header}><div className={styles.bar}><a href="/">VOIDSCAN</a><a href="/docs">Docs</a><a href="/contracts">Contracts</a></div></header>
    <main className={styles.wrap}><article className={styles.docs}><h1>Security and trust</h1>
      <p>Pre-audit testnet software. Do not deposit real-value assets. Local tests and verified source code do not replace an independent audit.</p>
      <h2>Live authority check</h2><p><strong>{state.checked ? 'PASS' : 'NOT VERIFIED'}</strong> · checked {state.checkedAt}. This server-side check reads the active contracts instead of trusting documentation.</p>
      {state.error ? <p>{state.error} Transactions must remain disabled when mandatory reads fail.</p> : <dl className={styles.contracts}>{state.checks.map((check) => <div key={check.label}><dt>{check.label}</dt><dd>{check.ok ? 'PASS' : 'MISMATCH'} · {check.actual}</dd></div>)}</dl>}
      <p><a href="/api/security">Machine-readable live security state</a></p>
      <h2>Who can change what?</h2><p>Each chain's initial fee is set by its first owner. Later fee and publishing-policy changes require its DAO. Shared Paymaster and Treasury administration is delayed by a 48-hour timelock, currently proposed by one test wallet—not a multisig.</p>
      <h2>Your signature</h2><p>The on-chain Paymaster checks the signed user, chain, app, calldata, spend limits, fee caps, nonce and deadline. It rejects replay independently of the database. Database reservations reduce wasted relay submissions; they are not the replay-security authority.</p>
      <h2>DAO boundary</h2><p>The Deed owner may propose any subject and may include calls, but a DAO has no protocol-wide role. The Runtime accepts it only for its own Deed; the protocol timelock, Paymaster, Treasury and other chains reject it. React escapes indexed names and application metadata before rendering; metadata is never inserted as raw HTML.</p>
      <h2>Remaining risks</h2><p>Voting uses historical wallet balances with no lock, by explicit protocol design. A previous-block snapshot stops same-transaction flash voting and moving the same tokens between wallets, but concentrated or multi-block borrowed voting power can still influence governance. The shared runtime, public RPC, hosted relayers and database are availability dependencies. Testnet liquidity and TWAP settings are not evidence of mainnet manipulation resistance.</p>
      <p>V11 is the active canonical testnet deployment. See <a href="/contracts">active addresses</a> before signing; every address is linked to the Robinhood testnet explorer.</p>
      <h2>Report privately</h2><a href="https://github.com/0xddneto/VoidChainApp/security/advisories/new">Report a vulnerability on GitHub</a><p>Never send seed phrases or private keys.</p>
    </article></main></>;
}
