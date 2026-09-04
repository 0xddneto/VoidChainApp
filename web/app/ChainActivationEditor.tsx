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
const provider = () => typeof window === 'undefined' ? undefined : (window as Window & { ethereum?: Provider }).ethereum;

function firstAddress(accounts: unknown): Address | null {
  const first = Array.isArray(accounts) ? accounts[0] : null;
  return typeof first === 'string' && /^0x[0-9a-fA-F]{40}$/.test(first) ? first as Address : null;
}

function usdToWad(value: string): bigint | null {
  if (!/^\d+(?:\.\d{0,18})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt((fraction + '0'.repeat(18)).slice(0, 18));
}

/** A permanent status control: initial activation asks a fee; later toggles retain it. */
export function ChainActivationEditor({ tokenId, onActiveChanged }: { tokenId: number; onActiveChanged: (active: boolean) => void }) {
  const [account, setAccount] = useState<Address | null>(null);
  const [owner, setOwner] = useState<Address | null>(null);
  const [active, setActive] = useState<boolean | null>(null);
  const [configured, setConfigured] = useState(false);
  const [fee, setFee] = useState('0.001');
  const [settingFee, setSettingFee] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const wallet = provider();
    const accountsChanged = (accounts: unknown) => setAccount(firstAddress(accounts));
    if (wallet) {
      void wallet.request({ method: 'eth_accounts' }).then(accountsChanged).catch(() => undefined);
      wallet.on?.('accountsChanged', accountsChanged);
    }
    let alive = true;
    void Promise.all([
      rpc.readContract({ address: DEPLOY.production.VoidChainDeed as Address, abi: ABI.deed, functionName: 'ownerOf', args: [BigInt(tokenId)] }),
      rpc.readContract({ address: DEPLOY.production.VoidChainAppRuntime as Address, abi: ABI.runtime, functionName: 'statsOf', args: [BigInt(tokenId)] }),
      rpc.readContract({ address: DEPLOY.production.VoidChainAppRuntime as Address, abi: ABI.runtime, functionName: 'configured', args: [BigInt(tokenId)] }),
    ]).then(([currentOwner, stats, isConfigured]) => {
      if (!alive) return;
      setOwner(currentOwner as Address);
      setActive(Boolean((stats as readonly unknown[])[0]));
      setConfigured(Boolean(isConfigured));
    }).catch(() => setActive(null));
    return () => { alive = false; wallet?.removeListener?.('accountsChanged', accountsChanged); };
  }, [tokenId]);

  const holder = Boolean(account && owner && account.toLowerCase() === owner.toLowerCase());

  async function changeState(nextActive: boolean) {
    const wallet = provider();
    if (!wallet || !account) return;
    const firstActivation = nextActive && !configured;
    const feeWad = firstActivation ? usdToWad(fee) : null;
    if (firstActivation && feeWad === null) return setNotice('Enter a valid initial fee.');
    if (firstActivation && !acknowledged) return setNotice('Confirm that this fee can only be changed by the DAO after activation.');

    setBusy(true);
    setNotice('Confirm in wallet…');
    try {
      const network = await wallet.request({ method: 'eth_chainId' });
      if (network !== RH_TESTNET.chainIdHex) {
        try { await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: RH_TESTNET.chainIdHex }] }); }
        catch { await wallet.request({ method: 'wallet_addEthereumChain', params: [RH_TESTNET] }); }
      }
      const client = createWalletClient({ account, transport: custom(wallet) });
      const data = firstActivation
        ? encodeFunctionData({ abi: ABI.runtime, functionName: 'activate', args: [BigInt(tokenId), feeWad!] })
        : encodeFunctionData({ abi: ABI.runtime, functionName: 'setActive', args: [BigInt(tokenId), nextActive] });
      const hash = await client.sendTransaction({ account, chain: null, to: DEPLOY.production.VoidChainAppRuntime as Address, data });
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('Chain status transaction reverted.');
      setActive(nextActive);
      setConfigured(true);
      setSettingFee(false);
      setAcknowledged(false);
      setNotice(null);
      onActiveChanged(nextActive);
    } catch (error: any) {
      setNotice(error?.shortMessage ?? error?.message ?? 'Could not change chain status.');
    } finally {
      setBusy(false);
    }
  }

  const status = active === true ? 'Active' : active === false ? 'Inactive' : 'Loading…';
  if (holder && active === false && !configured && settingFee) {
    return (
      <div className={styles.activationCritical}>
        <div>
          <p className={styles.criticalKicker}>⚠ CRITICAL · ON-CHAIN CONFIGURATION</p>
          <h3>Set the chain&apos;s initial transaction fee</h3>
          <p>This fee is written on-chain when you activate the chain. No current or future owner can change it directly; every later change must pass the chain DAO.</p>
        </div>

        <label className={styles.criticalFee}>
          <span>Transaction fee · USD</span>
          <input
            value={fee}
            inputMode="decimal"
            onChange={(event) => { setFee(event.target.value); setAcknowledged(false); }}
            aria-label="Initial transaction fee in USD"
          />
          <small>This is the initial fee charged for every app transaction on this chain.</small>
        </label>

        <label className={styles.criticalCheck}>
          <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
          <span>I understand that after activation this fee can only change through a DAO vote.</span>
        </label>

        <div className={styles.criticalActions}>
          <button type="button" className={styles.criticalActivate} disabled={busy || !acknowledged} onClick={() => void changeState(true)}>
            {busy ? 'Activating…' : 'Confirm fee and activate'}
          </button>
          <button type="button" className={styles.factCancel} disabled={busy} onClick={() => { setSettingFee(false); setAcknowledged(false); setNotice(null); }}>Cancel</button>
        </div>
        {notice && <small className={styles.criticalNotice} role="status">{notice}</small>}
      </div>
    );
  }

  return (
    <div className={styles.editableFact}>
      <span className={styles.factLabel}>Chain status</span>
      <span className={styles.factValueWithAction}>
        <span>{status}</span>
        {holder && active === true && <button type="button" className={styles.factButton} disabled={busy} onClick={() => void changeState(false)}>Deactivate</button>}
        {holder && active === false && configured && <button type="button" className={styles.factButton} disabled={busy} onClick={() => void changeState(true)}>Activate</button>}
        {holder && active === false && !configured && !settingFee && <button type="button" className={styles.factButton} onClick={() => { setSettingFee(true); setAcknowledged(false); setNotice(null); }}>Activate</button>}
      </span>
      {notice && <small className={styles.factNotice} role="status">{notice}</small>}
    </div>
  );
}
