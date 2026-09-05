import styles from '../docs/page.module.css';
export default function SecurityPage() {
  return <><header className={styles.header}><div className={styles.bar}><a href="/">VOIDSCAN</a><a href="/docs">Docs</a><a href="/contracts">Contracts</a></div></header>
    <main className={styles.wrap}><article className={styles.docs}><h1>Security and trust</h1>
      <p>Pre-audit testnet software. Do not deposit real-value assets. Local tests and verified source code do not replace an independent audit.</p>
      <h2>Who can change what?</h2><p>Each chain's initial fee is set by its first owner. Later fee and publishing-policy changes require its DAO. Shared Paymaster and Treasury administration is delayed by a 48-hour timelock, currently proposed by one test wallet—not a multisig.</p>
      <h2>Your signature</h2><p>The on-chain Paymaster checks the signed user, chain, app, calldata, spend limits, fee caps, nonce and deadline. It rejects replay independently of the database. Database reservations reduce wasted relay submissions; they are not the replay-security authority.</p>
      <h2>Remaining risks</h2><p>Voting uses historical wallet balances with no lock. Concentrated or borrowed voting power can influence governance. The shared runtime, public RPC, hosted relayers and database are availability dependencies. Testnet liquidity and TWAP settings are not evidence of mainnet manipulation resistance.</p>
      <p>V11 emergency controls and other contract changes remain pending migration. The current deployment is V10. See <a href="/contracts">active addresses</a> before signing.</p>
      <h2>Report privately</h2><a href="https://github.com/0xddneto/VoidChainApp/security/advisories/new">Report a vulnerability on GitHub</a><p>Never send seed phrases or private keys.</p>
    </article></main></>;
}
