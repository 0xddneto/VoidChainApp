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
import { Ticker } from "./Ticker";

// The data comes from the Postgres the indexer keeps current, so the page has
// to render per request — prerendering would freeze the feed at build time.
export const dynamic = "force-dynamic";

const nf = new Intl.NumberFormat("en-US");

// A chainapp has neither a node nor blocks of its own: either the runtime
// accepts calls for it, or it does not. "Producing blocks" measured something
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

          <div className={styles.search}>
            <svg
              className={styles.searchIcon}
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" />
            </svg>
            <input
              type="search"
              placeholder="chain, address, transaction hash or name"
              aria-label="Search"
            />
          </div>

          <div className={styles.actions}>
            <a className={styles.btn} href="/u">
              Profile
            </a>
            <a className={`${styles.btn} ${styles.btnPrimary}`} href="/mint">
              Mint NFTChain
            </a>
          </div>
        </div>
      </header>

      <main className={styles.wrap}>
        <div className={styles.summary}>
          <Stat label="Chains" value={nf.format(TOTAL_CHAINS)} unit="total" />
          <Stat label="Active" value={nf.format(counts.live)} unit="accepting calls" />
          <Stat label="Calls" value={nf.format(totalCalls)} unit="tolls charged" />
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
            <h2>All {nf.format(TOTAL_CHAINS)}</h2>
            <span className={styles.note}>
              each cell is a chain · {PROTOCOL.parentChainName} {PROTOCOL.parentChainId}
            </span>
          </div>
          <div className={styles.panelBody}>
            <div
              className={styles.constellation}
              role="img"
              aria-label={`State map of the ${TOTAL_CHAINS} chains: ${counts.live} active, ${counts.reserved} reserved`}
            >
              {states.map((status, i) => (
                <div
                  key={i}
                  className={`${styles.cell} ${CELL_CLASS[status]}`}
                  title={`VOID Chain #${i + 1} — chain ID ${chainIdForToken(i + 1)} — ${STATUS_LABEL[status].toLowerCase()}`}
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
