import styles from "./page.module.css";
import {
  PROTOCOL,
  TOTAL_CHAINS,
  allChainStates,
  chainIdForToken,
  listChains,
  recentBlocks,
  recentTransactions,
  shortAddress,
  statusCounts,
  totalExecutions,
  type ChainStatus,
} from "@/lib/chains";

// The data comes from the Postgres the indexer keeps current, so the page has
// to render per request — prerendering would freeze the feed at build time.
export const dynamic = "force-dynamic";

const nf = new Intl.NumberFormat("en-US");

/**
 * A toll in VOID, readable.
 *
 * Integer division before becoming a Number: a toll can be large enough that
 * converting the wei directly would lose precision silently.
 */
function voidAmount(wei: bigint): string {
  const thousandths = wei / 10n ** 15n;
  return (Number(thousandths) / 1000).toLocaleString("en-US", { maximumFractionDigits: 3 });
}

// A chainapp has neither a node nor blocks of its own: either the runtime
// accepts calls for it, or it does not. "Producing blocks" measured something
// the L3 model had and this one does not.
const STATUS_LABEL: Record<ChainStatus, string> = {
  live: "Active",
  created: "Created",
  paused: "Paused",
  reserved: "Reserved",
};

const PILL_CLASS: Record<ChainStatus, string> = {
  live: styles.pillLive,
  created: styles.pillCreated,
  paused: styles.pillReserved,
  reserved: styles.pillReserved,
};

const CELL_CLASS: Record<ChainStatus, string> = {
  live: styles.cellLive,
  created: styles.cellCreated,
  paused: styles.cellPaused,
  reserved: "",
};

export default async function Home() {
  const [counts, states, chains, blocks, txs, totalCalls] = await Promise.all([
    statusCounts(),
    allChainStates(),
    listChains(10),
    recentBlocks(6),
    recentTransactions(6),
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
            <button type="button" className={styles.btn}>
              Bridge
            </button>
            <a className={`${styles.btn} ${styles.btnPrimary}`} href="/mint">
              Acquire a chain
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

        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <h2>All {nf.format(TOTAL_CHAINS)}</h2>
            <span className={styles.note}>
              each cell is a chain · {PROTOCOL.parentChainName} {PROTOCOL.parentChainId}
            </span>
          </div>
          <div className={styles.panelBody}>
            {/* Rendered on the server: the map comes straight from the indexer. */}
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

        <div className={styles.cols}>
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2>Recent blocks</h2>
              <span className={styles.note}>live</span>
            </div>
            {blocks.length === 0 ? (
              <Empty message="No blocks indexed yet." />
            ) : (
              <ul className={styles.feed}>
                {blocks.map((b) => (
                  <li key={`${b.tokenId}-${b.number}`}>
                    <span className={styles.feedMain}>#{b.number}</span>
                    <span className={styles.feedMeta}>VOID Chain #{b.tokenId}</span>
                    <span className={styles.feedRight}>
                      {b.txCount} {b.txCount === 1 ? "tx" : "txs"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2>Recent transactions</h2>
              <span className={styles.note}>live</span>
            </div>
            {txs.length === 0 ? (
              <Empty message="No transactions indexed yet." />
            ) : (
              <ul className={styles.feed}>
                {txs.map((t) => (
                  <li key={`${t.hash}-${t.tokenId}`}>
                    <span className={styles.feedMain}>{shortAddress(t.hash, 10, 6)}</span>
                    <span className={styles.feedMeta}>
                      {t.toll > 0n ? `toll ${voidAmount(t.toll)} VOID` : "no toll"}
                    </span>
                    <span className={styles.feedRight}>#{t.tokenId}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <h2>Chains</h2>
            <span className={styles.note}>sorted by activity</span>
          </div>
          <div className={styles.scroller}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>NFT</th>
                  <th>Chain ID</th>
                  <th>State</th>
                  <th className={styles.numCell}>Transactions</th>
                  <th className={styles.numCell}>Contracts</th>
                  <th className={styles.numCell}>Addresses</th>
                  <th className={styles.numCell}>Revenue</th>
                </tr>
              </thead>
              <tbody>
                {chains.map((chain) => (
                  <tr key={chain.tokenId}>
                    <td>
                      <div className={styles.chainName}>VOID Chain #{chain.tokenId}</div>
                      <div className={styles.chainSub}>
                        {chain.name ??
                          (chain.status === "reserved"
                            ? "chain ID reserved"
                            : "no name set")}
                      </div>
                    </td>
                    <td className={styles.chainId}>{chain.chainId}</td>
                    <td>
                      <span className={`${styles.pill} ${PILL_CLASS[chain.status]}`}>
                        {STATUS_LABEL[chain.status]}
                      </span>
                    </td>
                    <td className={styles.numCell}>
                      {chain.status === "reserved" ? "—" : nf.format(chain.txCount)}
                    </td>
                    <td className={styles.numCell}>
                      {chain.status === "reserved" ? "—" : nf.format(chain.contractCount)}
                    </td>
                    <td className={styles.numCell}>
                      {chain.status === "reserved" ? "—" : nf.format(chain.addressCount)}
                    </td>
                    <td className={styles.numCell}>—</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <footer className={styles.footer}>
          <span>
            Token <b>VOID</b> · {shortAddress(PROTOCOL.voidToken)}
          </span>
          <span>
            Runtime <b>{shortAddress(PROTOCOL.runtime)}</b>
          </span>
          <span>
            Deed <b>{shortAddress(PROTOCOL.deed)}</b>
          </span>
          <span>
            Parent chain <b>{PROTOCOL.parentChainName}</b>
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

/**
 * Empty state of the live feeds.
 *
 * Its own component because this is the state the interface will show most —
 * most of the 1,111 chains have no activity at any given moment. Treating it as
 * an edge case inside a list component would be designing for the exception.
 */
function Empty({ message }: { message: string }) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyGlyph}>— — — — —</div>
      <p>{message}</p>
    </div>
  );
}
