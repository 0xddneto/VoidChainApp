'use client';

import { useEffect, useState } from 'react';
import type { Profile } from '@/lib/chains';
import { canonicalProfile, profileMessage } from '@/lib/profile-signature';
import { ProfileAvatar } from '../../ProfileAvatar';
import styles from './page.module.css';

type Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?: (event: string, listener: (value: unknown) => void) => void;
  removeListener?: (event: string, listener: (value: unknown) => void) => void;
};

function wallet(): Provider | undefined {
  return typeof window === 'undefined' ? undefined : (window as Window & { ethereum?: Provider }).ethereum;
}

function accountFrom(accounts: unknown): string | null {
  return Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : null;
}

/** The avatar itself is the upload control; there is no detached upload button. */
export function ProfileAvatarEditor({ address, profile }: { address: string; profile: Profile }) {
  const [account, setAccount] = useState<string | null>(null);
  const [src, setSrc] = useState(profile.avatarUri);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const provider = wallet();
    if (!provider) return;
    const update = (accounts: unknown) => setAccount(accountFrom(accounts));
    void provider.request({ method: 'eth_accounts' }).then(update).catch(() => undefined);
    provider.on?.('accountsChanged', update);
    return () => provider.removeListener?.('accountsChanged', update);
  }, []);

  const editable = Boolean(account && account.toLowerCase() === address.toLowerCase());

  async function upload(file: File | undefined) {
    if (!file || !editable || !account) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      setMessage('Use PNG, JPEG, WEBP or GIF.');
      return;
    }
    if (file.size > 650 * 1024) {
      setMessage('Use an image smaller than 650 KB.');
      return;
    }

    const dataUri = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read image.'));
      reader.onerror = () => reject(new Error('Could not read image.'));
      reader.readAsDataURL(file);
    }).catch((error: Error) => {
      setMessage(error.message);
      return null;
    });
    if (!dataUri) return;

    const previous = src;
    setSrc(dataUri);
    setBusy(true);
    setMessage('Sign to save photo…');
    try {
      const provider = wallet();
      if (!provider) throw new Error('No browser wallet found.');
      const nonce = `${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
      const payload = canonicalProfile({
        displayName: profile.displayName ?? '', avatarUri: dataUri,
        bio: profile.bio ?? '', socials: profile.socials,
      });
      const signature = await provider.request({
        method: 'personal_sign', params: [profileMessage(account, nonce, payload), account],
      });
      const response = await fetch('/api/profile', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address: account, nonce, signature,
          ...payload,
        }),
      });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? 'Could not save photo.');
      // The profile form below was rendered with the old avatar. Reloading
      // after the signed save keeps a later display-name edit from overwriting
      // the new image with stale form state.
      window.location.reload();
    } catch (error: any) {
      setSrc(previous);
      setMessage(error?.shortMessage ?? error?.message ?? 'Could not save photo.');
    } finally {
      setBusy(false);
    }
  }

  if (!editable) {
    return <ProfileAvatar src={src} className={styles.avatar} blankClassName={styles.avatarBlank} alt="" />;
  }

  return (
    <div className={styles.avatarEditor}>
      <label className={styles.avatarUpload} aria-label={src ? 'Change profile photo' : 'Add profile photo'}>
        <ProfileAvatar src={src} className={styles.avatar} blankClassName={styles.avatarBlank} alt="" />
        <span className={src ? styles.avatarPlusCorner : styles.avatarPlusEmpty}>{busy ? '…' : '+'}</span>
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy}
          onChange={(event) => void upload(event.target.files?.[0])} />
      </label>
      {message && <span className={styles.avatarMessage}>{message}</span>}
    </div>
  );
}
