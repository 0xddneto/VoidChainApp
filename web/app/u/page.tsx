'use client';

/**
 * The door to a profile.
 *
 * A profile belongs to an address, so this page has to learn which one before it
 * can show anything. It asks the wallet, then hands over to /u/<address> — which
 * is the shareable page, and works for anyone, connected or not.
 */

import { useState } from 'react';
import { isAddress } from 'viem';
import styles from '../page.module.css';
import { WalletProfileButton } from '../WalletProfileButton';
import own from './editor.module.css';

export default function ProfileDoor() {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  async function connect() {
    const p = typeof window !== 'undefined' ? (window as any).ethereum : undefined;
    if (!p) return setMsg('No wallet found. Install MetaMask, or paste an address below.');
    setBusy(true);
    try {
      const [addr] = await p.request({ method: 'eth_requestAccounts' });
      window.location.href = `/u/${addr}`;
    } catch (e: any) {
      setMsg(e?.shortMessage ?? e?.message ?? 'Connection refused.');
    } finally {
      setBusy(false);
    }
  }

  function open() {
    const a = typed.trim();
    if (!isAddress(a)) return setMsg('That is not an address.');
    window.location.href = `/u/${a}`;
  }

  return (
    <>
      <header className={styles.header}>
        <div className={`${styles.wrap} ${styles.bar}`}>
          <div className={styles.logo}>VOID<span>SCAN</span></div>
          <a className={styles.note} style={{ marginLeft: 'auto' }} href="/">← explorer</a>
          <a className={styles.note} href="/docs">Docs</a>
          <WalletProfileButton />
        </div>
      </header>

      <main className={styles.wrap}>
        <div style={{ maxWidth: 460, padding: '48px 0' }}>
          <h1 style={{ fontSize: 24, margin: '0 0 8px', letterSpacing: '-0.02em' }}>
            Your profile
          </h1>
          <p style={{ color: 'var(--ink-2)', fontSize: 14.5, margin: '0 0 22px' }}>
            Every address has one. It shows the execution spaces it owns, what they have earned, and
            whatever name, picture and links the holder set.
          </p>

          <div className={own.bar} style={{ padding: 0 }}>
            <button type="button" className={own.btn} onClick={connect} disabled={busy}>
              {busy ? 'Connecting…' : 'Connect wallet'}
            </button>
          </div>

          <div className={own.form} style={{ paddingTop: 24 }}>
            <label>
              Or open any address
              <input
                value={typed}
                placeholder="0x…"
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') open(); }}
              />
            </label>
            <div className={own.actions}>
              <button type="button" className={own.ghost} onClick={open}>Open</button>
              {msg && <span className={own.msg}>{msg}</span>}
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
