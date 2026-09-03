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

function provider(): Provider | undefined {
  return typeof window === 'undefined' ? undefined : (window as Window & { ethereum?: Provider }).ethereum;
}

function firstAddress(accounts: unknown): Address | null {
  const first = Array.isArray(accounts) ? accounts[0] : null;
  return typeof first === 'string' && /^0x[0-9a-fA-F]{40}$/.test(first) ? first as Address : null;
}

function usdToWad(value: string): bigint | null {
  if (!/^\d+(?:\.\d{0,18})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt((fraction + '0'.repeat(18)).slice(0, 18));
}

/** First activation fixes only the original fee; future changes go through the DAO. */
export function ChainActivationEditor({ tokenId, onActivated }: { tokenId: number; onActivated: () => void }) {
  const [account, setAccount] = useState<Address | null>(null);
  const [owner, setOwner] = useState<Address | null>(null);
  const [active, setActive] = useState<boolean | null>(null);
  const [fee, setFee] = useState('0.001');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const wallet = provider();
    const accountsChanged = (accounts: unknown) => setAccount(firstAddress(accounts));
    if (wallet) {
      void wallet.request({ method: 'eth_accounts' }).then(accountsChanged).catch(() => undefined);
      wallet.on?.('accountsChanged', accountsChanged);
    }

    let live = true;
    void Promise.all([
      rpc.readContract({ address: DEPLOY.production.VoidChainDeed as Address, abi: ABI.deed, functionName: 'ownerOf', args: [BigInt(tokenId)] }),
      rpc.readContract({ address: DEPLOY.production.VoidChainAppRuntime as Address, abi: ABI.runtime, functionName: 'statsOf', args: [BigInt(tokenId)] }),
    ]).then(([currentOwner, stats]) => {
      if (!live) return;
      setOwner(currentOwner as Address);
      setActive(Boolean((stats as readonly unknown[])[0]));
    }).catch(() => setActive(null));

    return () => {
      live = false;
      wallet?.removeListener?.('accountsChanged', accountsChanged);
    };
  }, [tokenId]);

  const holder = Boolean(account && owner && account.toLowerCase() === owner.toLowerCase());
  if (!holder || active !== false) return null;

  async function activate() {
    const wallet = provider();
    if (!wallet || !account) return;
    const feeWad = usdToWad(fee);
    if (feeWad === null) {
      setNotice('Enter a USD fee with up to 18 decimal places.');
      return;
    }

    setBusy(true);
    setNotice('Confirm activation in your wallet…');
    try {
      const network = await wallet.request({ method: 'eth_chainId' });
      if (network !== RH_TESTNET.chainIdHex) {
        try {
          await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: RH_TESTNET.chainIdHex }] });
        } catch {
          await wallet.request({ method: 'wallet_addEthereumChain', params: [RH_TESTNET] });
        }
      }
      const client = createWalletClient({ account, transport: custom(wallet) });
      const hash = await client.sendTransaction({
        account, chain: null, to: DEPLOY.production.VoidChainAppRuntime as Address,
        data: encodeFunctionData({ abi: ABI.runtime, functionName: 'activate', args: [BigInt(tokenId), feeWad] }),
      });
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('Activation transaction reverted.');
      setActive(true);
      setOpen(false);
      setNotice('Chain activated. Future fee changes require its DAO.');
      onActivated();
    } catch (error: any) {
      setNotice(error?.shortMessage ?? error?.message ?? 'Could not activate this chain.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.activationEditor} aria-label="Chain activation">
      <div>
        <p className={styles.editorKicker}>OWNER SETUP</p>
        <h3>Activate this chain</h3>
        <p>Choose the first transaction fee. Once active, its fee and app policy can only change through this chain’s DAO.</p>
      </div>
      {!open ? (
        <button type="button" className={styles.editorButton} onClick={() => { setOpen(true); setNotice(null); }}>Activate</button>
      ) : (
        <div className={styles.editorForm}>
          <label className={styles.activationFee}>Initial transaction fee (USD)
            <input value={fee} inputMode="decimal" onChange={(event) => setFee(event.target.value)} aria-label="Initial transaction fee in USD" />
          </label>
          <button type="button" className={styles.editorButton} disabled={busy} onClick={activate}>{busy ? 'Activating…' : 'Confirm activation'}</button>
          <button type="button" className={styles.editorCancel} disabled={busy} onClick={() => { setOpen(false); setNotice(null); }}>Cancel</button>
        </div>
      )}
      {notice && <p className={styles.editorNotice}>{notice}</p>}
    </section>
  );
}
