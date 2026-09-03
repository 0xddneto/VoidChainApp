'use client';

/**
 * A value you can click to copy.
 *
 * Every address, hash and runtime identifier on this site is something a reader will want
 * in a wallet or a terminal, and selecting a truncated address with the mouse
 * gets you the ellipsis. The element carries the full value and copies the full
 * value even when it renders shortened.
 */

import { useEffect, useState } from 'react';
import styles from './page.module.css';

export function Copyable({
  value,
  short = false,
  head = 8,
  tail = 6,
}: {
  value: string;
  short?: boolean;
  head?: number;
  tail?: number;
}) {
  const [copied, setCopied] = useState(false);

  // The tick has to be cleared if the element goes away first, or React warns
  // about a state update on an unmounted component.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);

  if (!value) return <span className={styles.copyable}>—</span>;

  const label = short && value.length > head + tail + 1
    ? `${value.slice(0, head)}…${value.slice(-tail)}`
    : value;

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // A denied clipboard is the browser's decision, not a failure to report
      // in the interface. Selecting the title attribute still works.
    }
  }

  return (
    <button
      type="button"
      className={styles.copyable}
      onClick={copy}
      title={copied ? 'Copied' : `Copy ${value}`}
      aria-label={`Copy ${value}`}
    >
      {label}
      <span className={styles.copyMark} aria-hidden="true">{copied ? '✓' : '⧉'}</span>
    </button>
  );
}
