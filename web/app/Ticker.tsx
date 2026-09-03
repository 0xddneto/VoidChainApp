'use client';

/**
 * A single line of activity, scrolling left.
 *
 * It replaces the separate panels for blocks and transactions. With 1,111
 * chains, no single list is the interesting thing — what a reader wants at a
 * glance is that something is happening, and where. A strip costs a fraction of
 * the height two tables did.
 *
 * The content is duplicated once and the track translated by exactly half its
 * width, so the wrap is seamless without measuring anything at runtime.
 */

import type { Event } from '@/lib/chains';
import styles from './page.module.css';

function line(e: Event): string {
  switch (e.kind) {
    case 'call': {
      // Only a paid transaction carries a number in `detail`. An app carries an address,
      // and parsing it as a BigInt throws — which is why this conversion lives
      // inside the branch that knows what the field holds.
      const v = Number(BigInt(e.detail || '0') / 10n ** 15n) / 1000;
      return `#${e.chainId} charged ${v.toLocaleString('en-US', { maximumFractionDigits: 3 })} VOID`;
    }
    case 'app':
      return `#${e.chainId} published an application`;
    case 'activated':
      return `#${e.chainId} went active`;
  }
}

export function Ticker({ events }: { events: Event[] }) {
  if (events.length === 0) {
    return (
      <div className={styles.ticker}>
        <span className={styles.tickerIdle}>waiting for the first transaction</span>
      </div>
    );
  }

  const items = events.map(line);

  return (
    <div className={styles.ticker} role="status" aria-label="Recent activity">
      <div className={styles.tickerTrack}>
        {/* Twice, so the second copy is entering as the first leaves. */}
        {[0, 1].map((copy) => (
          <div className={styles.tickerRun} key={copy} aria-hidden={copy === 1}>
            {items.map((text, i) => (
              <span className={styles.tickerItem} key={`${copy}-${i}`}>
                {text}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
