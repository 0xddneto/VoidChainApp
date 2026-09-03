'use client';

import { useEffect, useState } from 'react';
import { createPublicClient, createWalletClient, custom, encodeFunctionData, http, type Address } from 'viem';
import pending from '@/lib/deployment-v2-pending.json';
import { ABI, DEPLOY, RH_TESTNET } from '@/lib/testnet';
import styles from '../page.module.css';

type Provider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
const rpc = createPublicClient({ transport: http(RH_TESTNET.rpcUrls[0]) });
const v2Runtime = pending.production.VoidChainAppRuntime as Address;
const holder = pending.migration.chainOneHolder.toLowerCase();

function provider(): Provider | undefined {
  return typeof window === 'undefined' ? undefined : (window as Window & { ethereum?: Provider }).ethereum;
}

function firstAddress(value: unknown): Address | null {
  const account = Array.isArray(value) ? value[0] : undefined;
  return typeof account === 'string' && /^0x[\da-f]{40}$/i.test(account) ? account as Address : null;
}

export default function V2MigrationPage() {
  const [account, setAccount] = useState<Address | null>(null);
  const [fee, setFee] = useState<bigint | null>(null);
  const [active, setActive] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const isHolder = account?.toLowerCase() === holder;

  useEffect(() => {
    const wallet = provider();
    void wallet?.request({ method: 'eth_accounts' }).then((accounts) => setAccount(firstAddress(accounts))).catch(() => undefined);
    void Promise.all([
      rpc.readContract({ address: DEPLOY.production.VoidChainAppRuntime as Address, abi: ABI.runtime, functionName: 'feeOf', args: [1n] }),
      rpc.readContract({ address: v2Runtime, abi: ABI.runtime, functionName: 'statsOf', args: [1n] }),
    ]).then(([oldFee, stats]) => {
      setFee(oldFee as bigint);
      setActive(Boolean((stats as readonly unknown[])[0]));
    }).catch(() => setNotice('Could not read the migration state from Robinhood testnet.'));
  }, []);

  async function activate() {
    const wallet = provider();
    if (!wallet) return setNotice('Connect the wallet that owns VOID Chain #1.');
    const current = firstAddress(await wallet.request({ method: 'eth_requestAccounts' }));
    setAccount(current);
    if (!current || current.toLowerCase() !== holder) return setNotice('Only the current Deed holder can activate V2.');
    if (fee === null) return setNotice('The existing Chain #1 fee is still loading.');

    setBusy(true);
    setNotice('Confirm the V2 activation in your wallet…');
    try {
      const chain = await wallet.request({ method: 'eth_chainId' });
      if (chain !== RH_TESTNET.chainIdHex) {
        try { await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: RH_TESTNET.chainIdHex }] }); }
        catch { await wallet.request({ method: 'wallet_addEthereumChain', params: [RH_TESTNET] }); }
      }
      const client = createWalletClient({ account: current, transport: custom(wallet) });
      const data = encodeFunctionData({ abi: ABI.runtime, functionName: 'activate', args: [1n, fee] });
      const hash = await client.sendTransaction({ account: current, chain: null, to: v2Runtime, data });
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('V2 activation reverted.');
      setActive(true);
      setNotice(`V2 activated: ${hash.slice(0, 10)}…${hash.slice(-8)}. The final promotion can now run.`);
    } catch (error: any) {
      setNotice(error?.shortMessage ?? error?.message ?? 'Could not activate V2.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.wrap}>
      <header className={`${styles.header} ${styles.bar}`}><a className={styles.logo} href="/">VOID<span>SCAN</span></a></header>
      <section className={styles.panel}>
        <div className={styles.panelHead}><h2><span className={styles.sectionIndex}>V2</span> Chain #1 migration</h2><span className={styles.note}>testnet handoff</span></div>
        <div className={styles.panelBody}>
          <div className={styles.activationCritical}>
            <div>
              <p className={styles.criticalKicker}>IMMUTABLE PAYMASTER REPLACEMENT</p>
              <h3>Activate Chain #1 on the V2 runtime</h3>
              <p>The Deed, VOID token, treasury and Chain #1 owner stay unchanged. This single holder-only activation preserves the existing fee, binds the new immutable Paymaster and creates the new DAO path.</p>
            </div>
            <dl className={styles.detailFacts}>
              <div><dt>Current holder</dt><dd>{pending.migration.chainOneHolder}</dd></div>
              <div><dt>V2 runtime</dt><dd>{v2Runtime}</dd></div>
              <div><dt>V2 paymaster</dt><dd>{pending.production.VoidPaymaster}</dd></div>
              <div><dt>State</dt><dd>{active === true ? 'Activated' : active === false ? 'Waiting for holder' : 'Loading…'}</dd></div>
            </dl>
            {active !== true && <button className={styles.criticalActivate} disabled={busy || fee === null} onClick={() => void activate()}>{busy ? 'Activating…' : isHolder ? 'Activate V2' : 'Connect Chain #1 holder'}</button>}
            {active === true && <p className={styles.criticalNotice}>V2 is active. The deployment can now be promoted and its DEX can be redeployed on the V2 runtime.</p>}
            {notice && <p className={styles.criticalNotice} role="status">{notice}</p>}
          </div>
        </div>
      </section>
    </main>
  );
}
