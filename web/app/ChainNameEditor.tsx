'use client';

import { useEffect, useState } from 'react';
import { createPublicClient, createWalletClient, custom, encodeFunctionData, http, type Address } from 'viem';
import { ABI, DEPLOY, RH_TESTNET } from '@/lib/testnet';
import styles from './page.module.css';

type Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?: (event: string, listener: (value: unknown) => void) => void;
  removeListener?: (event: string, listener: (value: unknown) => void) => void;
};

const rpc = createPublicClient({ transport: http(RH_TESTNET.rpcUrls[0]) });
const walletProvider = () =>
  typeof window === 'undefined' ? undefined : (window as Window & { ethereum?: Provider }).ethereum;

function addressFrom(accounts: unknown): Address | null {
  const first = Array.isArray(accounts) ? accounts[0] : null;
  return typeof first === 'string' && /^0x[0-9a-fA-F]{40}$/.test(first) ? first as Address : null;
}

function nameFromIdentity(value: unknown): string {
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  if (value && typeof value === 'object' && 'name' in value && typeof (value as { name?: unknown }).name === 'string') {
    return (value as { name: string }).name;
  }
  return '';
}

function nameProblem(value: string): string | null {
  if (!value) return 'Enter a name.';
  if (value.length > 32) return 'Use up to 32 characters.';
  if (!/^[A-Za-z0-9._ -]+$/.test(value) || value.trim() !== value || value.includes('  ')) {
    return 'Use letters, numbers, spaces, hyphens, periods or underscores.';
  }
  return null;
}

/** The name field itself becomes editable for the current holder. */
export function ChainNameEditor({
  tokenId,
  fallbackName,
  onNameChanged,
}: {
  tokenId: number;
  fallbackName: string | null;
  onNameChanged: (name: string) => void;
}) {
  const [wallet, setWallet] = useState<Address | null>(null);
  const [owner, setOwner] = useState<Address | null>(null);
  const [name, setName] = useState(fallbackName ?? '');
  const [draft, setDraft] = useState(fallbackName ?? '');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const provider = walletProvider();
    const update = (accounts: unknown) => setWallet(addressFrom(accounts));
    if (provider) {
      void provider.request({ method: 'eth_accounts' }).then(update).catch(() => undefined);
      provider.on?.('accountsChanged', update);
    }

    let alive = true;
    void Promise.all([
      rpc.readContract({ address: DEPLOY.production.VoidChainDeed as Address, abi: ABI.deed, functionName: 'ownerOf', args: [BigInt(tokenId)] }),
      rpc.readContract({ address: DEPLOY.production.VoidChainDeed as Address, abi: ABI.deed, functionName: 'identityOf', args: [BigInt(tokenId)] }),
    ]).then(([currentOwner, identity]) => {
      if (!alive) return;
      setOwner(currentOwner as Address);
      const onchainName = nameFromIdentity(identity);
      setName(onchainName || fallbackName || '');
      setDraft(onchainName || fallbackName || '');
      if (onchainName) onNameChanged(onchainName);
    }).catch(() => undefined);

    return () => {
      alive = false;
      provider?.removeListener?.('accountsChanged', update);
    };
  }, [fallbackName, onNameChanged, tokenId]);

  const holder = Boolean(wallet && owner && wallet.toLowerCase() === owner.toLowerCase());

  async function save() {
    const provider = walletProvider();
    if (!provider || !wallet) return;
    const next = draft.trim();
    const problem = nameProblem(next);
    if (problem) return setNotice(problem);

    setBusy(true);
    setNotice('Confirm in wallet…');
    try {
      const network = await provider.request({ method: 'eth_chainId' });
      if (network !== RH_TESTNET.chainIdHex) {
        try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: RH_TESTNET.chainIdHex }] }); }
        catch { await provider.request({ method: 'wallet_addEthereumChain', params: [RH_TESTNET] }); }
      }
      const client = createWalletClient({ account: wallet, transport: custom(provider) });
      const hash = await client.sendTransaction({
        account: wallet,
        chain: null,
        to: DEPLOY.production.VoidChainDeed as Address,
        data: encodeFunctionData({ abi: ABI.deed, functionName: 'rename', args: [BigInt(tokenId), next] }),
      });
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('Name transaction reverted.');
      setName(next);
      onNameChanged(next);
      setEditing(false);
      setNotice(null);
    } catch (error: any) {
      setNotice(error?.shortMessage ?? error?.message ?? 'Could not change name.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.editableFact}>
      <dt>Name</dt>
      {!editing ? (
        <dd className={styles.factValueWithAction}>
          <span>{name || 'no name set'}</span>
          {holder && <button type="button" className={styles.factButton} onClick={() => { setDraft(name); setEditing(true); setNotice(null); }}>Mudar nome</button>}
        </dd>
      ) : (
        <dd className={styles.factEdit}>
          <input value={draft} maxLength={32} onChange={(event) => setDraft(event.target.value)} aria-label="Chain name" />
          <button type="button" className={styles.factButton} disabled={busy} onClick={save}>{busy ? 'Salvando…' : 'Salvar'}</button>
          <button type="button" className={styles.factCancel} disabled={busy} onClick={() => { setEditing(false); setDraft(name); setNotice(null); }}>Cancelar</button>
        </dd>
      )}
      {notice && <small className={styles.factNotice} role="status">{notice}</small>}
    </div>
  );
}
