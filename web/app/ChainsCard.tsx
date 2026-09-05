'use client';

/**
 * The chains card: search, paging, and the detail of one chain in place.
 *
 * It is a client component because all three are interactions, and because a
 * chain's page opening inside the card is the point — a reader comparing chains
 * should not lose the list to see one of them.
 *
 * The full list arrives from the server in one piece. Searching a wallet has to
 * look at every chain, so paging on the server would mean a request per
 * keystroke for a dataset that fits in one response.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChainDetail, ChainRow, ChainStatus } from '@/lib/chains';
import { DEPLOY } from '@/lib/testnet';
import chainOneDex from '@/lib/dex-chain1-v11.json';
import genesis from '@/lib/genesis-v11.json';
import { Copyable } from './Copyable';
import { ChainActivationEditor } from './ChainActivationEditor';
import { ChainL3Migration } from './ChainL3Migration';
import { ChainNameEditor } from './ChainNameEditor';
import { ChainIdentityEditor } from './ChainIdentityEditor';
import { RevenueClaimButton } from './RevenueClaimButton';
import { DaoPanel } from './DaoPanel';
import styles from './page.module.css';

const PER_PAGE = 50;
type SortKey = 'state' | 'transactions' | 'apps' | 'revenue';
const STATUS_ORDER: Record<ChainStatus, number> = { live: 0, created: 1, paused: 2, reserved: 3 };

const STATUS_LABEL: Record<ChainStatus, string> = {
  live: 'Active',
  created: 'Created',
  paused: 'Paused',
  reserved: 'Reserved',
};

const PILL_CLASS: Record<ChainStatus, string> = {
  live: styles.pillLive,
  created: styles.pillCreated,
  paused: styles.pillReserved,
  reserved: styles.pillReserved,
};

const nf = new Intl.NumberFormat('en-US');

/** VOID from wei, readable. Integer division first: the amounts outgrow Number. */
function voidAmount(wei: string): string {
  const v = BigInt(wei || '0');
  if (v === 0n) return '0';
  const thousandths = v / 10n ** 15n;
  return (Number(thousandths) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 });
}

const short = (a: string | null, head = 6, tail = 4) =>
  a ? `${a.slice(0, head)}…${a.slice(-tail)}` : '—';

// Names are rendered for people ("VOID Chain # 20"), while the registry also
// exposes bare ids and wallet strings. Searching should not depend on whether
// someone typed a space, a hash, or an address separator.
const compactSearch = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

export function ChainsCard({ chains }: { chains: ChainRow[] }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<ChainRow | null>(null);
  const [sort, setSort] = useState<SortKey>('state');

  const found = useMemo(() => {
    const raw = query.trim().toLowerCase();
    if (!raw) return chains;

    // A bare number is overwhelmingly a token/chain id. Keep it exact so
    // searching `20` does not turn into an accidental list of #20, #200, #201…
    if (/^\d+$/.test(raw)) {
      return chains.filter((c) => String(c.id) === raw || String(c.chainId) === raw);
    }

    const q = compactSearch(raw);
    const deedName = q.match(/^voidchain(\d+)$/);
    if (deedName) {
      return chains.filter((c) => String(c.id) === deedName[1]);
    }

    return chains.filter(
      (c) => [
        `void chain ${c.id}`,
        String(c.chainId),
        c.name ?? '',
        c.owner ?? '',
      ].some((term) => compactSearch(term).includes(q)),
    );
  }, [chains, query]);

  const ordered = useMemo(() => [...found].sort((a, b) => {
    let difference = 0;
    if (sort === 'state') difference = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (sort === 'transactions') difference = b.txCount - a.txCount;
    if (sort === 'apps') difference = b.contractCount - a.contractCount;
    if (sort === 'revenue') {
      const revenueA = BigInt(a.revenue || '0');
      const revenueB = BigInt(b.revenue || '0');
      difference = revenueA === revenueB ? 0 : revenueA > revenueB ? -1 : 1;
    }
    return difference || a.id - b.id;
  }), [found, sort]);

  // A search that lands on page 9 of the old result shows an empty card. The
  // page belongs to the result, not to the session.
  useEffect(() => setPage(0), [query]);

  useEffect(() => {
    const receive = (event: Event) => setQuery((event as CustomEvent<string>).detail ?? '');
    window.addEventListener('voidscan:search', receive);
    return () => window.removeEventListener('voidscan:search', receive);
  }, []);

  // Profile pages and shared links can point directly to a particular chain
  // while keeping the explorer's in-place detail view.
  useEffect(() => {
    const requested = Number(new URLSearchParams(window.location.search).get('chain'));
    if (!Number.isInteger(requested) || requested < 1) return;
    const chain = chains.find((item) => item.id === requested);
    if (chain) setOpen(chain);
  }, [chains]);

  const pages = Math.max(1, Math.ceil(ordered.length / PER_PAGE));
  const current = Math.min(page, pages - 1);
  const shown = ordered.slice(current * PER_PAGE, current * PER_PAGE + PER_PAGE);

  if (open) return <Detail chain={open} onBack={() => setOpen(null)} />;

  return (
    <section className={styles.panel} id="chain-directory">
      <div className={styles.panelHead}>
        <h2><span className={styles.sectionIndex}>02</span> Execution-space directory</h2>
        <div className={styles.cardSearch}>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="name, runtime ID, or wallet"
            aria-label="Search execution spaces by name, runtime ID or wallet"
          />
        </div>
        <label className={styles.sortControl}>
          <span>Order by</span>
          <select value={sort} onChange={(event) => { setSort(event.target.value as SortKey); setPage(0); }}>
            <option value="state">State</option>
            <option value="transactions">Transactions</option>
            <option value="apps">Apps</option>
            <option value="revenue">Revenue</option>
          </select>
        </label>
        <Pager page={current} pages={pages} total={found.length} onChange={setPage} />
      </div>

      <div className={styles.scroller}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>NFT</th>
              <th>Runtime ID</th>
              <th>Owner</th>
              <th>State</th>
              <th className={styles.numCell}>Transactions</th>
              <th className={styles.numCell}>Apps</th>
              <th className={styles.numCell}>Addresses</th>
              <th className={styles.numCell}>Revenue</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.id} className={styles.rowLink} onClick={() => setOpen(c)}
                  tabIndex={0} role="button"
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(c); } }}>
                <td>
                  <div className={styles.chainName}>{c.name || `VOID Chain #${c.id}`}</div>
                  <div className={styles.chainSub}>{c.name ? `VOID Chain #${c.id}` : 'no name set'}</div>
                </td>
                <td className={styles.chainId}>{c.chainId}</td>
                <td className={styles.chainId}>{short(c.owner)}</td>
                <td>
                  <span className={`${styles.pill} ${PILL_CLASS[c.status]}`}>
                    {STATUS_LABEL[c.status]}
                  </span>
                </td>
                <td className={styles.numCell}>{nf.format(c.txCount)}</td>
                <td className={styles.numCell}>{nf.format(c.contractCount)}</td>
                <td className={styles.numCell}>{nf.format(c.addressCount)}</td>
                <td className={styles.numCell}>{voidAmount(c.revenue)} VOID</td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={8} className={styles.noHits}>
                  Nothing matches “{query}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Pager({
  page, pages, total, onChange,
}: { page: number; pages: number; total: number; onChange: (p: number) => void }) {
  return (
    <div className={styles.pager}>
      <span className={styles.note}>
        {nf.format(total)} {total === 1 ? 'space' : 'spaces'} · page {page + 1} of {pages}
      </span>
      <button type="button" aria-label="Previous page"
              disabled={page === 0} onClick={() => onChange(page - 1)}>←</button>
      <button type="button" aria-label="Next page"
              disabled={page >= pages - 1} onClick={() => onChange(page + 1)}>→</button>
    </div>
  );
}

/**
 * One chain, opened in place.
 *
 * It shows what the chain is and what has happened on it — not only who owns
 * it. Someone deciding whether to build on a chain, or to buy it, needs the
 * activity and the contracts, and those are the same facts either way.
 */
function Detail({ chain, onBack }: { chain: ChainRow; onBack: () => void }) {
  const [detail, setDetail] = useState<ChainDetail | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(chain.name ?? '');
  const [status, setStatus] = useState<ChainStatus>(chain.status);
  const nameChanged = useCallback((next: string) => setDisplayName(next), []);
  const dexApps = new Map<string, string>([
    [chainOneDex.factory.toLowerCase(), 'VoidDEX Factory'],
    ...chainOneDex.pools.map((pool) => [pool.address.toLowerCase(), `${pool.label} Pool`] as [string, string]),
    [chainOneDex.faucet.toLowerCase(), 'Test Token Faucet'],
  ]);
  const nftMarket = genesis.contracts.nftAmm.toLowerCase();

  useEffect(() => setDisplayName(chain.name ?? ''), [chain]);
  useEffect(() => setStatus(chain.status), [chain]);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setFailed(null);
    fetch(`/api/chain/${chain.id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (live) setDetail(d); })
      .catch((e: Error) => { if (live) setFailed(e.message); });
    return () => { live = false; };
  }, [chain.id]);

  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <button type="button" className={styles.back} onClick={onBack}>← all spaces</button>
        <h2>{displayName || `VOID Chain #${chain.id}`}</h2>
        <span className={`${styles.pill} ${PILL_CLASS[status]}`}>
          {STATUS_LABEL[status]}
        </span>
      </div>

      <div className={styles.detailBody}>
        <div className={styles.chainNameLine}>
          <span>Name</span>
          <ChainNameEditor tokenId={chain.id} fallbackName={displayName} onNameChanged={nameChanged} />
        </div>
        <dl className={styles.detailFacts}>
          <div><dt>Runtime ID</dt><dd><Copyable value={String(chain.chainId)} /></dd></div>
          <div><dt>VoidChain contract</dt><dd><Copyable value={DEPLOY.production.VoidChainAppRuntime} short /></dd></div>
          <div><dt>Deed contract</dt><dd><Copyable value={DEPLOY.production.VoidChainDeed} short /></dd></div>
          <div><dt>Owner</dt><dd><Copyable value={chain.owner ?? ''} short /></dd></div>
          <div><dt>Transactions</dt><dd>{nf.format(chain.txCount)}</dd></div>
          <div><dt>Apps</dt><dd>{nf.format(chain.contractCount)}</dd></div>
          <div><dt>Addresses</dt><dd>{nf.format(chain.addressCount)}</dd></div>
          <div><dt title="The chain owner's 98% share of all transaction fees. The protocol receives the other 2%.">Revenue</dt><dd>{voidAmount(chain.revenue)} VOID</dd></div>
        </dl>

        <ChainActivationEditor tokenId={chain.id} onActiveChanged={(next) => setStatus(next ? 'live' : 'paused')} />
        <ChainIdentityEditor tokenId={chain.id} />
        <RevenueClaimButton tokenId={chain.id} owner={chain.owner} />

        <ChainL3Migration tokenId={chain.id} runtimeId={chain.chainId} />
        <DaoPanel tokenId={chain.id} />

        {failed && <p className={styles.noHits}>Could not load this chain: {failed}</p>}
        {!failed && !detail && <p className={styles.noHits}>Loading…</p>}

        {detail && (
          <div className={styles.detailCols}>
            <div>
              <h3>Applications</h3>
              {detail.apps.length === 0 ? (
                <p className={styles.noHits}>No applications published yet.</p>
              ) : (
                <ul className={styles.detailList}>
                  {detail.apps.map((a) => (
                    <li key={a.address}>
                      <span className={styles.appIdentity}>
                        <strong>{a.address.toLowerCase() === nftMarket ? 'NFT / VOID Market' : dexApps.get(a.address.toLowerCase()) ?? 'Published app'}</strong>
                        <Copyable value={a.address} short />
                      </span>
                      {a.address.toLowerCase() === nftMarket && <a className={styles.chainLink} href="/market">Open market ↗</a>}
                      {chain.id === chainOneDex.chainTokenId && dexApps.has(a.address.toLowerCase()) && <a className={styles.chainLink} href="https://voiddex-alpha.vercel.app" target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>Open DEX ↗</a>}
                      <span className={styles.note}>by <Copyable value={a.publisher} short /></span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h3>Transactions</h3>
              {detail.calls.length === 0 ? (
                <p className={styles.noHits}>No paid transactions yet.</p>
              ) : (
                <ul className={styles.detailList}>
                  {detail.calls.map((c) => (
                    <li key={c.hash + c.at}>
                      <Copyable value={c.hash} short />
                      <span className={styles.note}>
                        {voidAmount(c.toll)} VOID · from <Copyable value={c.caller} short />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
