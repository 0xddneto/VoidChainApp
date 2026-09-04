import deployment from '@/lib/deployment.json';
import styles from './page.module.css';
import { WalletProfileButton } from '../WalletProfileButton';

const contracts = [
  ['Deed NFT', deployment.production.VoidChainDeed],
  ['VOID token', deployment.testnet.VoidTestToken],
  ['Runtime', deployment.production.VoidChainAppRuntime],
  ['Protocol timelock', deployment.production.VoidProtocolTimelock],
  ['Paymaster', deployment.production.VoidPaymaster],
  ['Treasury', deployment.production.VoidChainTreasury],
  ['DAO factory', deployment.production.VoidChainDaoFactory],
  ['Application factory', deployment.production.VoidChainAppFactoryV3],
  ['ETH mint', deployment.production.VoidEthGenesisMintV6],
  ['NFT / VOID market', deployment.testnet.VoidGenesisNftAmmV6],
  ['VOID / ETH pool', deployment.testnet.VoidEthPoolV6],
  ['TWAP oracle', deployment.testnet.VoidTwapOracleV6],
];

export default function DocsPage() {
  return <>
    <header className={styles.header}>
      <div className={styles.bar}>
        <a className={styles.logo} href="/">VOID<span>SCAN</span></a>
        <a className={styles.back} href="/">← Explorer</a>
        <WalletProfileButton />
      </div>
    </header>
    <main className={styles.wrap}>
      <aside className={styles.nav} aria-label="Documentation sections">
        <b>DOCUMENTATION</b>
        <a href="#overview">Overview</a><a href="#ownership">Ownership</a>
        <a href="#transactions">Transactions</a><a href="#revenue">Revenue</a>
        <a href="#governance">Governance</a><a href="#genesis">Genesis</a>
        <a href="#l3">Independent L3</a><a href="#contracts">Contracts</a>
        <a href="#status">Safety status</a>
      </aside>
      <article className={styles.docs}>
        <p className={styles.kicker}>VOIDCHAINAPP · TESTNET DOCUMENTATION</p>
        <h1>1,111 deeds for programmable execution spaces.</h1>
        <p className={styles.lead}>VoidChainApp lets an NFT holder own the identity and economics of an application space. Applications execute through a shared, isolated-by-token runtime on Robinhood Chain Testnet and pay their chain fee in VOID.</p>

        <section id="overview"><h2>What exists today</h2><p>Each Deed maps to one runtime ID, one application registry, one fee account, one owner-revenue account and one DAO. These spaces share the same internally tested contracts and parent chain. They are not yet 1,111 independent blockchains: they do not have separate blocks, consensus, sequencers, RPC endpoints or bridges.</p><div className={styles.flow}>Wallet signature <i>→</i> Relayer <i>→</i> Paymaster <i>→</i> Deed runtime <i>→</i> Registered application</div></section>

        <section id="ownership"><h2>What the Deed owner controls</h2><p>The current NFT owner may edit the chain name and identity, activate or pause the execution space, create DAO proposals and claim the owner share of transaction fees. Selling the Deed transfers those future rights. Revenue earned before a sale remains assigned to the owner who generated it.</p><p>The owner cannot take application funds, rewrite activity, change another chain, replace shared protocol contracts or bypass the DAO after the initial economic settings are committed.</p></section>

        <section id="transactions"><h2>VOID-sponsored transactions</h2><p>Robinhood Testnet uses ETH as its native gas token. An official app never asks its user to send that ETH transaction. The user signs an exact authorization; a relayer submits it and the Paymaster charges the chain fee plus the measured gas reimbursement in VOID.</p><p>The signature binds the user, chain, application, calldata, token budgets, maximum chain fee, maximum gas charge, nonce and deadline. Unused gas budget is returned. A token permission is not a transaction instruction: the signed runtime request is what limits a particular action.</p><p>The public relays atomically reserve each wallet nonce in the shared database and rate-limit requests before spending relayer ETH. VoidScan waits for confirmed parent blocks before publishing activity, so the newest unconfirmed tip is not shown as settled history.</p><div className={styles.callout}><b>Wallet prompts</b><span>V10 makes the Runtime and Paymaster permanent VOID operators, so a normal VOID-only app action needs one bounded SponsoredCall signature and no approval. Moving an NFT still needs its token-specific ERC-4494 authorization. External ERC-20 assets need their own authorization unless the app uses a smart-account or Permit2 adapter.</span></div></section>

        <section id="revenue"><h2>Revenue and claims</h2><p>Every successful application transaction pays the selected chain fee in VOID. The runtime separates 98% for the Deed owner and 2% for the protocol at the moment of execution. Gas reimbursement is operating capital for the Paymaster, not chain revenue.</p><p>The owner panel shows three buckets: pending revenue inside the runtime, preserved revenue from a previous ownership period and revenue ready in the Treasury. Claim Revenue settles the necessary buckets and sends the final VOID to the connected owner wallet. No caller can redirect another holder's claim.</p></section>

        <section id="governance"><h2>One DAO per Deed</h2><p>The first owner sets the initial chain transaction fee during activation. From that point onward, only the chain DAO may change the fee or application publishing policy. This cannot be returned to unilateral owner control.</p><p>The current owner may propose any on-chain action a target contract accepts. Voting lasts five days. Voting power is the wallet's VOID balance at the previous-block snapshot; VOID is never staked or locked. A proposal needs 10% quorum and more votes for than against.</p></section>

        <section id="genesis"><h2>ETH genesis, then VOID</h2><p>The collection mint is paid in ETH because it creates the initial NFT and token economy. Genesis allocates 500,000 VOID per Deed and maintains separate escrow, liquidity, protocol and builder buckets. After mint, official application actions and the NFT market use VOID through the sponsored route.</p><p>The permanent VOID/ETH pool supplies price discovery and the controlled Paymaster refill route. Refill runs separately from user transactions, uses TWAP protection and is permissionless only within the on-chain threshold, target and slippage limits.</p></section>

        <section id="l3"><h2>Path to an independent L3</h2><p>The Deed owner may choose to fund a future migration to an independent rollup. That decision is not forced by the DAO because the owner bears its infrastructure cost. A real L3 still requires a supported rollup stack, data availability, sequencing, proofs or dispute rules, RPC, explorer, bridge, monitoring and independent security review. The current runtime ID is not a wallet network ID.</p></section>

        <section id="contracts"><h2>Current testnet contracts</h2><dl className={styles.contracts}>{contracts.map(([name, address]) => <div key={name}><dt>{name}</dt><dd>{address}</dd></div>)}</dl><p>Network: Robinhood Chain Testnet · EIP-155 chain ID 46630. Addresses are read from the same deployment manifest used by VoidScan.</p></section>

        <section id="status"><h2>Safety status</h2><p>This is pre-audit testnet software. V10 freezes the runtime oracle and VOID protocol operators after initial configuration and places Paymaster and Treasury administration behind a public 48-hour timelock. The relays use persistent nonce admission and the explorer delays publication for parent-chain confirmations. Local tests, verified bytecode and live acceptance transactions are engineering evidence, not a third-party security audit or a mainnet-readiness statement. Testnet VOID has no monetary value. Production still requires an external audit, a hardware-backed multisig proposer, independent monitoring, tested backups and a fresh deployment review.</p></section>
      </article>
    </main>
  </>;
}
