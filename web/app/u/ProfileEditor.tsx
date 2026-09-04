'use client';

/**
 * Editing a profile, for the wallet that owns it.
 *
 * The button only appears once a wallet is connected and matches the address on
 * the page, and saving asks for a signature over the exact payload. That
 * signature is what the server checks — nothing here is trusted for identity,
 * because a request body can claim any address.
 */

import { useEffect, useState } from 'react';
import type { Profile, Social } from '@/lib/chains';
import styles from './editor.module.css';

type State = 'idle' | 'connecting' | 'signing' | 'saving';
const LINK_PLATFORMS = ['X', 'Discord'] as const;

function fixedLinks(socials: Social[]): Social[] {
  return LINK_PLATFORMS.map((platform) => ({
    platform,
    handle: socials.find((item) => item.platform.toLowerCase() === platform.toLowerCase())?.handle ?? '',
  }));
}

function profileMessage(address: string, nonce: string): string {
  return [
    'VoidScan — update profile',
    '',
    `address: ${address.toLowerCase()}`,
    `nonce: ${nonce}`,
    '',
    'Signing this proves the wallet is yours. It costs no gas and moves nothing.',
  ].join('\n');
}

export function ProfileEditor({ address, profile }: { address: string; profile: Profile }) {
  const [wallet, setWallet] = useState<string | null>(null);
  const [walletReady, setWalletReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>('idle');
  const [msg, setMsg] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState(profile.displayName ?? '');
  const [avatarUri] = useState(profile.avatarUri ?? '');
  const [bio, setBio] = useState(profile.bio ?? '');
  const [socials, setSocials] = useState<Social[]>(fixedLinks(profile.socials));

  const eth = () => (typeof window !== 'undefined' ? (window as any).ethereum : undefined);
  const isOwner = wallet?.toLowerCase() === address.toLowerCase();

  // The header has already connected this browser wallet. A separate editor
  // must read that approved account instead of making the holder connect twice.
  useEffect(() => {
    const p = eth();
    if (!p) {
      setWalletReady(true);
      return;
    }
    const update = (accounts: unknown) => {
      const next = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : null;
      setWallet(next);
      setWalletReady(true);
    };
    void p.request({ method: 'eth_accounts' }).then(update).catch(() => setWalletReady(true));
    p.on?.('accountsChanged', update);
    return () => p.removeListener?.('accountsChanged', update);
  }, []);

  async function save() {
    const p = eth();
    if (!p || !wallet) return;
    setMsg(null);

    // The timestamp is inside the nonce, and the server refuses a stale one, so
    // a signature captured from the network cannot be replayed later.
    const nonce = `${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;

    try {
      setState('signing');
      const signature = await p.request({
        method: 'personal_sign',
        params: [profileMessage(wallet, nonce), wallet],
      });

      setState('saving');
      const r = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address: wallet, nonce, signature,
          displayName, avatarUri, bio,
          socials: socials.filter((s) => s.platform.trim() && s.handle.trim()),
        }),
      });

      if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? `HTTP ${r.status}`);

      setMsg('Saved.');
      setOpen(false);
      // The page is server-rendered from the database, so the new values only
      // appear on a fresh render.
      window.location.reload();
    } catch (e: any) {
      setMsg(e?.shortMessage ?? e?.message ?? 'Could not save.');
    } finally {
      setState('idle');
    }
  }

  if (!open) {
    return (
      <div className={styles.profileEditor}>
        {walletReady && wallet && isOwner && (
          <button type="button" className={styles.pencil} onClick={() => setOpen(true)} aria-label="Edit profile" title="Edit profile">
            ✎
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={`${styles.profileEditor} ${styles.profileEditorOpen}`}>
      <div className={styles.form}>
      <label>
        Name
        <input value={displayName} maxLength={64}
               onChange={(e) => setDisplayName(e.target.value)} />
      </label>

      <label>
        Bio
        <textarea value={bio} maxLength={500} rows={3}
                  onChange={(e) => setBio(e.target.value)} />
      </label>

      <div className={styles.socials}>
        <span className={styles.legend}>Links</span>
        {socials.map((s, i) => (
          <div className={styles.social} key={i}>
            <span className={styles.socialLabel}>{s.platform}</span>
            <input value={s.handle} placeholder={s.platform === 'X' ? '@handle or x.com URL' : 'username or invite URL'} maxLength={128}
                   onChange={(e) => setSocials(socials.map((x, j) =>
                     j === i ? { ...x, handle: e.target.value } : x))} />
          </div>
        ))}
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.btn} onClick={save} disabled={state !== 'idle'}>
          {state === 'signing' ? 'Sign in your wallet…' : state === 'saving' ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className={styles.ghost} onClick={() => setOpen(false)}>
          Cancel
        </button>
        {msg && <span className={styles.msg}>{msg}</span>}
      </div>

      <p className={styles.note}>
        Saving asks for a signature, not a transaction. It costs no gas and moves nothing —
        it only proves the wallet is yours.
      </p>
      </div>
    </div>
  );
}
