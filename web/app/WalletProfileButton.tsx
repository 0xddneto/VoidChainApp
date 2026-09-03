'use client';

/**
 * The account control belongs at the end of the explorer header. It never asks
 * for an account until the visitor explicitly presses Connect wallet; on later
 * visits it only reads the wallet's already-approved account and turns into a
 * link to that account's profile.
 */

import { useEffect, useState } from 'react';
import styles from './page.module.css';
import { ProfileAvatar } from './ProfileAvatar';

type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?: (event: string, listener: (value: unknown) => void) => void;
  removeListener?: (event: string, listener: (value: unknown) => void) => void;
};

function provider(): Eip1193Provider | undefined {
  return (window as Window & { ethereum?: Eip1193Provider }).ethereum;
}

function firstAddress(value: unknown): string | null {
  if (!Array.isArray(value) || typeof value[0] !== 'string') return null;
  return /^0x[0-9a-fA-F]{40}$/.test(value[0]) ? value[0] : null;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletProfileButton() {
  const [account, setAccount] = useState<string | null>(null);
  const [profile, setProfile] = useState<{ displayName: string | null; avatarUri: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const wallet = provider();
    if (!wallet) return;

    const update = (accounts: unknown) => setAccount(firstAddress(accounts));
    void wallet.request({ method: 'eth_accounts' }).then(update).catch(() => undefined);
    wallet.on?.('accountsChanged', update);
    return () => wallet.removeListener?.('accountsChanged', update);
  }, []);

  useEffect(() => {
    if (!account) {
      setProfile(null);
      return;
    }

    let current = true;
    void fetch(`/api/profile?address=${encodeURIComponent(account)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((identity) => {
        if (current) setProfile(identity);
      })
      .catch(() => {
        if (current) setProfile(null);
      });
    return () => { current = false; };
  }, [account]);

  async function connectOrOpenProfile() {
    if (account) {
      window.location.assign(`/u/${account}`);
      return;
    }

    const wallet = provider();
    if (!wallet) {
      setMessage('No browser wallet found.');
      return;
    }

    setBusy(true);
    setMessage('');
    try {
      const next = firstAddress(await wallet.request({ method: 'eth_requestAccounts' }));
      if (!next) throw new Error('The wallet did not return an account.');
      setAccount(next);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Wallet connection was declined.';
      setMessage(reason.slice(0, 90));
    } finally {
      setBusy(false);
    }
  }

  const label = account ? profile?.displayName || shortAddress(account) : busy ? 'Connecting…' : 'Connect wallet';
  const description = account
    ? `Open profile for ${account}`
    : 'Connect a wallet to open your profile';

  return (
    <div className={styles.walletSlot}>
      <button
        type="button"
        className={styles.walletButton}
        onClick={connectOrOpenProfile}
        disabled={busy}
        title={description}
      >
        {account ? (
          <ProfileAvatar
            src={profile?.avatarUri}
            className={styles.walletAvatar}
            blankClassName={styles.walletAvatarBlank}
          />
        ) : (
          <span className={styles.walletMark} aria-hidden="true" />
        )}
        {label}
      </button>
      {message && <span className={styles.walletMessage} role="status">{message}</span>}
    </div>
  );
}
