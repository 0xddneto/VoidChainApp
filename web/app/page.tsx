import styles from "./page.module.css";
import {
  PROTOCOL,
  TOTAL_CHAINS,
  allChainStates,
  allChains,
  chainIdForToken,
  recentEvents,
  statusCounts,
  totalExecutions,
  type ChainStatus,
} from "@/lib/chains";
import { ChainsCard } from "./ChainsCard";
import { Copyable } from "./Copyable";
import { ExplorerSearch } from "./ExplorerSearch";
import { Ticker } from "./Ticker";
import { WalletProfileButton } from "./WalletProfileButton";

// The data comes from the Postgres the indexer keeps current, so the page has
// to render per request — prerendering would freeze the feed at build time.
export const dynamic = "force-dynamic";

const nf = new Intl.NumberFormat("en-US");

// A chainapp has neither a node nor blocks of its own: either the runtime
// accepts transactions for it, or it does not. "Producing blocks" measured something
// the L3 model had and this one does not.
const STATUS_LABEL: Record<ChainStatus, string> = {
  live: "Active",
  created: "Created",
  paused: "Paused",
  reserved: "Reserved",
};

const CELL_CLASS: Record<ChainStatus, string> = {
  live: styles.cellLive,
  created: styles.cellCreated,
  paused: styles.cellPaused,
  reserved: "",
};

export default async function Home() {
  const [counts, states, chains, events, totalCalls] = await Promise.all([
    statusCounts(),
    allChainStates(),
    allChains(),
    recentEvents(30),
    totalExecutions(),
  ]);

  return (
    <>
      <header className={styles.header}>
        <div className={`${styles.wrap} ${styles.bar}`}>
          <div className={styles.logo}>
            VOID<span>SCAN</span>
          </div>

          <ExplorerSearch />

          <div className={styles.actions}>
            <WalletProfileButton />
          </div>
        </div>
      </header>

      <main className={styles.wrap}>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>
              <span className={styles.pulse} aria-hidden="true" /> Robinhood Chain testnet · live registry
            </p>
            <h1>
              The explorer for deeds that <em>run</em>.
            </h1>
            <p className={styles.heroText}>
              VoidScan makes the collection legible: who holds each deed, which applications
              run inside it, and what its execution space has earned. Every entry is isolated
              in the Void runtime and settled on Robinhood Chain.
            </p>
            <div className={styles.heroLinks}>
              <a className={`${styles.btn} ${styles.btnPrimary}`} href="/mint">Mint VOID Deed <span>↗</span></a>
              <a className={styles.heroLink} href="#chain-directory">Browse the registry <span>↓</span></a>
            </div>
          </div>

          <aside className={styles.signalCard} aria-label="Network status">
            <div className={styles.signalTop}>
              <span>VOID / NETWORK</span>
              <span className={styles.signalLive}>LIVE</span>
            </div>
            <div className={styles.signalNumber}>{nf.format(counts.live).padStart(4, "0")}</div>
            <p>active VOID Chains</p>
            <div className={styles.signalRule} />
            <div className={styles.signalFoot}>
              <span>Supply</span>
              <b>{TOTAL_CHAINS.toLocaleString('en-US')} deeds</b>
              <span>Transactions</span>
              <b>{nf.format(totalCalls)}</b>
            </div>
          </aside>
        </section>

        <div className={styles.summary}>
          <Stat label="Deeds in registry" value={nf.format(TOTAL_CHAINS)} unit="fixed supply" />
          <Stat label="Live spaces" value={nf.format(counts.live)} unit="accepting transactions" />
          <Stat label="Transactions" value={nf.format(totalCalls)} unit="paid runtime transactions" />
          <Stat
            label="Activation cost"
            value={PROTOCOL.activationCost.toLocaleString("en-US", {
              maximumSignificantDigits: 3,
            })}
            unit="ETH"
          />
        </div>

        <Ticker events={events} />

        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <h2><span className={styles.sectionIndex}>01</span> Registry atlas</h2>
            <span className={styles.note}>
              {nf.format(TOTAL_CHAINS)} deed-bound execution spaces · {PROTOCOL.parentChainName} {PROTOCOL.parentChainId}
            </span>
          </div>
          <div className={styles.panelBody}>
            <div
              className={styles.constellation}
              role="img"
              aria-label={`State map of the ${TOTAL_CHAINS} execution spaces: ${counts.live} active, ${counts.reserved} reserved`}
            >
              {states.map((status, i) => (
                <div
                  key={i}
                  className={`${styles.cell} ${CELL_CLASS[status]}`}
                  title={`VOID Chain #${i + 1} — runtime ID ${chainIdForToken(i + 1)} — ${STATUS_LABEL[status].toLowerCase()}`}
                />
              ))}
            </div>

            <div className={styles.legend}>
              <LegendItem
                swatch={<span className={`${styles.swatch} ${styles.cellLive}`} />}
                text={`Active — ${nf.format(counts.live)}`}
              />
              <LegendItem
                swatch={<span className={`${styles.swatch} ${styles.cellPaused}`} />}
                text={`Paused by the owner — ${nf.format(counts.paused)}`}
              />
              <LegendItem
                swatch={<span className={`${styles.swatch} ${styles.swatchReserved}`} />}
                text={`Reserved — ${nf.format(counts.reserved)}`}
              />
            </div>
          </div>
        </section>

        <ChainsCard chains={chains} />

        <footer className={styles.footer}>
          <span>
            Token <b>VOID</b> · <Copyable value={PROTOCOL.voidToken} short />
          </span>
          <span>
            Runtime <Copyable value={PROTOCOL.runtime} short />
          </span>
          <span>
            Deed <Copyable value={PROTOCOL.deed} short />
          </span>
          <span>
            Paymaster <Copyable value={PROTOCOL.paymaster} short />
          </span>
          <span>
            Parent chain <b>{PROTOCOL.parentChainName}</b> ·{" "}
            <Copyable value={String(PROTOCOL.parentChainId)} />
          </span>
        </footer>
      </main>
    </>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>
        {value} <span className={styles.statUnit}>{unit}</span>
      </div>
    </div>
  );
}

function LegendItem({ swatch, text }: { swatch: React.ReactNode; text: string }) {
  return (
    <div className={styles.legendItem}>
      {swatch}
      {text}
    </div>
  );
}
