'use client';

import { useEffect, useState } from 'react';
import { createPublicClient, createWalletClient, custom, encodeFunctionData, type Address } from 'viem';
import { ABI, DEPLOY, RH_TESTNET, rhTransport } from '@/lib/testnet';
import styles from './page.module.css';

type Provider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
type Identity = { description: string; imageURI: string; externalURL: string; socials: string[] };
const rpc = createPublicClient({ transport: rhTransport() });
const EMPTY: Identity = { description: '', imageURI: '', externalURL: '', socials: [] };

function unpack(value: unknown): Identity {
  const row = value as readonly unknown[];
  if (Array.isArray(row)) return {
    description: typeof row[1] === 'string' ? row[1] : '', imageURI: typeof row[2] === 'string' ? row[2] : '',
    externalURL: typeof row[3] === 'string' ? row[3] : '', socials: Array.isArray(row[4]) ? row[4].filter((v): v is string => typeof v === 'string') : [],
  };
  const object = value as { description?: unknown; imageURI?: unknown; externalURL?: unknown; socials?: unknown } | null;
  return { description: typeof object?.description === 'string' ? object.description : '', imageURI: typeof object?.imageURI === 'string' ? object.imageURI : '', externalURL: typeof object?.externalURL === 'string' ? object.externalURL : '', socials: Array.isArray(object?.socials) ? object.socials.filter((v: unknown): v is string => typeof v === 'string') : [] };
}

const social = (items: string[], key: string) => items.find((item) => item.startsWith(`${key}:`))?.slice(key.length + 1) ?? '';
const validUri = (value: string) => !value || /^(https:\/\/|ipfs:\/\/)/i.test(value);

export function ChainIdentityEditor({ tokenId }: { tokenId: number }) {
  const [owner, setOwner] = useState<Address | null>(null);
  const [wallet, setWallet] = useState<Address | null>(null);
  const [identity, setIdentity] = useState<Identity>(EMPTY);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [x, setX] = useState('');
  const [discord, setDiscord] = useState('');

  useEffect(() => {
    const provider = (window as Window & { ethereum?: Provider }).ethereum;
    void provider?.request({ method: 'eth_accounts' }).then((accounts) => {
      const first = Array.isArray(accounts) ? accounts[0] : null;
      if (typeof first === 'string') setWallet(first as Address);
    });
    void Promise.all([
      rpc.readContract({ address: DEPLOY.production.VoidChainDeed as Address, abi: ABI.deed, functionName: 'ownerOf', args: [BigInt(tokenId)] }),
      rpc.readContract({ address: DEPLOY.production.VoidChainDeed as Address, abi: ABI.deed, functionName: 'identityOf', args: [BigInt(tokenId)] }),
    ]).then(([currentOwner, raw]) => {
      const next = unpack(raw); setOwner(currentOwner as Address); setIdentity(next);
      setX(social(next.socials, 'x')); setDiscord(social(next.socials, 'discord'));
    }).catch(() => setNotice('Could not read identity metadata.'));
  }, [tokenId]);

  const holder = Boolean(owner && wallet && owner.toLowerCase() === wallet.toLowerCase());
  async function save() {
    const provider = (window as Window & { ethereum?: Provider }).ethereum;
    if (!provider || !wallet) return;
    if (!validUri(identity.imageURI) || !validUri(identity.externalURL) || !validUri(x) || !validUri(discord)) {
      setNotice('Use an https:// or ipfs:// address.'); return;
    }
    const socials = [`x:${x}`, `discord:${discord}`].filter((item) => item.split(':').slice(1).join(':'));
    setBusy(true); setNotice('Confirm the metadata update in your wallet…');
    try {
      const network = await provider.request({ method: 'eth_chainId' });
      if (network !== RH_TESTNET.chainIdHex) {
        try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: RH_TESTNET.chainIdHex }] }); }
        catch { await provider.request({ method: 'wallet_addEthereumChain', params: [RH_TESTNET] }); }
      }
      const target = DEPLOY.production.VoidChainDeed as Address;
      const data = encodeFunctionData({ abi: ABI.deed, functionName: 'setIdentity', args: [BigInt(tokenId), identity.description, identity.imageURI, identity.externalURL, socials] });
      await rpc.call({ account: wallet, to: target, data });
      const client = createWalletClient({ account: wallet, transport: custom(provider) });
      const hash = await client.sendTransaction({ account: wallet, chain: null, to: target, data });
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('Metadata transaction reverted.');
      setIdentity({ ...identity, socials }); setOpen(false); setNotice('Identity metadata updated on-chain.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not update identity metadata.');
    } finally { setBusy(false); }
  }

  return <section className={styles.identityEditor}>
    <div><h3>Deed identity</h3><p>Description, artwork and official links stored on the NFT.</p></div>
    {holder && !open && <button className={styles.factButton} type="button" onClick={() => setOpen(true)}>Edit identity</button>}
    {open && <div className={styles.identityForm}>
      <label>Description<textarea maxLength={1024} value={identity.description} onChange={(e) => setIdentity({ ...identity, description: e.target.value })} /></label>
      <label>Image URI<input maxLength={512} placeholder="ipfs://… or https://…" value={identity.imageURI} onChange={(e) => setIdentity({ ...identity, imageURI: e.target.value })} /></label>
      <label>Website<input maxLength={512} placeholder="https://…" value={identity.externalURL} onChange={(e) => setIdentity({ ...identity, externalURL: e.target.value })} /></label>
      <label>X<input maxLength={254} placeholder="https://x.com/…" value={x} onChange={(e) => setX(e.target.value)} /></label>
      <label>Discord<input maxLength={248} placeholder="https://discord.gg/…" value={discord} onChange={(e) => setDiscord(e.target.value)} /></label>
      <div><button className={styles.factButton} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save on-chain'}</button><button className={styles.factCancel} disabled={busy} onClick={() => setOpen(false)}>Cancel</button></div>
    </div>}
    {notice && <small className={styles.factNotice}>{notice}</small>}
  </section>;
}
