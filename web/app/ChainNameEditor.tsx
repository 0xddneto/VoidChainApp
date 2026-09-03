'use client';

import { useEffect, useState } from 'react';
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  http,
  type Address,
} from 'viem';
import { ABI, DEPLOY, RH_TESTNET } from '@/lib/testnet';
import styles from './page.module.css';

type Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?: (event: string, listener: (value: unknown) => void) => void;
  removeListener?: (event: string, listener: (value: unknown) => void) => void;
};

const rpc = createPublicClient({ transport: http(RH_TESTNET.rpcUrls[0]) });

function walletProvider(): Provider | undefined {
  return typeof window === 'undefined' ? undefined : (window as Window & { ethereum?: Provider }).ethereum;
}

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
  if (!value) return 'Choose a name.';
  if (value.length > 32) return 'Use up to 32 characters.';
  if (!/^[A-Za-z0-9._ -]+$/.test(value) || value.trim() !== value || value.includes('  ')) {
    return 'Use letters, numbers, spaces, hyphens, periods or underscores.';
  }
  return null;
}

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

    let active = true;
    void Promise.all([
      rpc.readContract({
        address: DEPLOY.production.VoidChainDeed as Address,
        abi: ABI.deed,
        functionName: 'ownerOf',
        args: [BigInt(tokenId)],
      }),
      rpc.readContract({
        address: DEPLOY.production.VoidChainDeed as Address,
        abi: ABI.deed,
        functionName: 'identityOf',
        args: [BigInt(tokenId)],
      }),
    ]).then(([currentOwner, identity]) => {
      if (!active) return;
      setOwner(currentOwner as Address);
      const onchainName = nameFromIdentity(identity);
      if (onchainName) {
        setName(onchainName);
        setDraft(onchainName);
        onNameChanged(onchainName);
      }
    }).catch(() => undefined);

    return () => {
      active = false;
      provider?.removeListener?.('accountsChanged', update);
    };
  }, [onNameChanged, tokenId]);

  const holder = Boolean(wallet && owner && wallet.toLowerCase() === owner.toLowerCase());
  if (!holder) return null;

  async function save() {
    const provider = walletProvider();
    if (!provider || !wallet) return;
    const next = draft.trim();
    const problem = nameProblem(next);
    if (problem) return setNotice(problem);

    setBusy(true);
    setNotice('Confirm the name change in your wallet…');
    try {
      const network = await provider.request({ method: 'eth_chainId' });
      if (network !== RH_TESTNET.chainIdHex) {
        try {
          await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: RH_TESTNET.chainIdHex }] });
        } catch {
          // A first-time holder may not have Robinhood Testnet saved yet.
          await provider.request({ method: 'wallet_addEthereumChain', params: [RH_TESTNET] });
        }
      }
      const client = createWalletClient({ account: wallet, transport: custom(provider) });
      const hash = await client.sendTransaction({
        account: wallet,
        chain: null,
        to: DEPLOY.production.VoidChainDeed as Address,
        data: encodeFunctionData({ abi: ABI.deed, functionName: 'rename', args: [BigInt(tokenId), next] }),
      });
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('The rename transaction reverted.');
      setName(next);
      onNameChanged(next);
      setEditing(false);
      setNotice('Name saved on-chain.');
    } catch (error: any) {
      setNotice(error?.shortMessage ?? error?.message ?? 'Could not change the chain name.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.chainNameEditor} aria-label="Chain name editor">
      <div>
        <p className={styles.editorKicker}>OWNER SETTINGS · ON-CHAIN</p>
        <h3>{name || `VOID Chain #${tokenId}`}</h3>
        <p>Only the current deed holder can change this name. It follows the deed when ownership changes.</p>
      </div>
      {!editing ? (
        <button type="button" className={styles.editorButton} onClick={() => { setDraft(name); setEditing(true); setNotice(null); }}>
          Change name
        </button>
      ) : (
        <div className={styles.editorForm}>
          <input value={draft} maxLength={32} onChange={(event) => setDraft(event.target.value)} aria-label="Chain name" />
          <button type="button" className={styles.editorButton} onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save on-chain'}
          </button>
          <button type="button" className={styles.editorCancel} onClick={() => { setEditing(false); setDraft(name); }} disabled={busy}>Cancel</button>
        </div>
      )}
      {notice && <p className={styles.editorNotice}>{notice}</p>}
    </section>
  );
}
