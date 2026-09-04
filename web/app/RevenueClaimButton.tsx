'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  formatEther,
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

type RevenueState = { pending: bigint; parked: bigint; ready: bigint };
const EMPTY: RevenueState = { pending: 0n, parked: 0n, ready: 0n };
const rpc = createPublicClient({ transport: http(RH_TESTNET.rpcUrls[0]) });
const getProvider = () => typeof window === 'undefined' ? undefined : (window as Window & { ethereum?: Provider }).ethereum;

function accountFrom(value: unknown): Address | null {
  const first = Array.isArray(value) ? value[0] : null;
  return typeof first === 'string' && /^0x[0-9a-fA-F]{40}$/.test(first) ? first as Address : null;
}

function show(value: bigint): string {
  return Number(formatEther(value)).toLocaleString('en-US', { maximumFractionDigits: 4 });
}

/** Settles every revenue bucket owned by the connected Deed holder, then pays it. */
export function RevenueClaimButton({ tokenId, owner }: { tokenId: number; owner: string | null }) {
  const [account, setAccount] = useState<Address | null>(null);
  const [revenue, setRevenue] = useState<RevenueState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (wallet: Address | null) => {
    if (!wallet) return setRevenue(EMPTY);
    const [stats, parked, ready] = await Promise.all([
      rpc.readContract({ address: DEPLOY.production.VoidChainAppRuntime as Address, abi: ABI.runtime, functionName: 'apps', args: [BigInt(tokenId)] }),
      rpc.readContract({ address: DEPLOY.production.VoidChainAppRuntime as Address, abi: ABI.runtime, functionName: 'owed', args: [wallet] }),
      rpc.readContract({ address: DEPLOY.production.VoidChainTreasury as Address, abi: ABI.treasury, functionName: 'claimable', args: [wallet] }),
    ]);
    const app = stats as readonly [boolean, bigint, boolean, bigint, Address, bigint, bigint];
    const pending = app[4].toLowerCase() === wallet.toLowerCase() ? app[3] : 0n;
    setRevenue({ pending, parked: parked as bigint, ready: ready as bigint });
  }, [tokenId]);

  useEffect(() => {
    const provider = getProvider();
    const update = (accounts: unknown) => {
      const wallet = accountFrom(accounts);
      setAccount(wallet);
      void refresh(wallet).catch(() => setNotice('Could not read revenue from the testnet.'));
    };
    void provider?.request({ method: 'eth_accounts' }).then(update).catch(() => undefined);
    provider?.on?.('accountsChanged', update);
    return () => provider?.removeListener?.('accountsChanged', update);
  }, [refresh]);

  const holder = Boolean(account && owner && account.toLowerCase() === owner.toLowerCase());
  if (!holder) return null;

  async function send(client: ReturnType<typeof createWalletClient>, to: Address, functionName: string, args: readonly unknown[] = []) {
    const abi = to.toLowerCase() === (DEPLOY.production.VoidChainTreasury as string).toLowerCase() ? ABI.treasury : ABI.runtime;
    const hash = await client.sendTransaction({
      account: account!, chain: null, to,
      data: encodeFunctionData({ abi, functionName, args } as never),
    });
    const receipt = await rpc.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted.`);
  }

  async function claim() {
    const provider = getProvider();
    if (!provider || !account) return;
    setBusy(true);
    setNotice('Preparing your on-chain revenue…');
    try {
      const network = await provider.request({ method: 'eth_chainId' });
      if (network !== RH_TESTNET.chainIdHex) {
        try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: RH_TESTNET.chainIdHex }] }); }
        catch { await provider.request({ method: 'wallet_addEthereumChain', params: [RH_TESTNET] }); }
      }
      const client = createWalletClient({ account, transport: custom(provider) });
      if (revenue.pending > 0n) {
        setNotice('Step 1: settle this chain\'s pending revenue.');
        await send(client, DEPLOY.production.VoidChainAppRuntime as Address, 'flush', [BigInt(tokenId)]);
      }
      if (revenue.parked > 0n) {
        setNotice('Step 2: settle revenue preserved from earlier ownership.');
        await send(client, DEPLOY.production.VoidChainAppRuntime as Address, 'claimOwed', [account]);
      }
      const ready = await rpc.readContract({ address: DEPLOY.production.VoidChainTreasury as Address, abi: ABI.treasury, functionName: 'claimable', args: [account] }) as bigint;
      if (ready === 0n) throw new Error('There is no revenue available to claim.');
      setNotice(`Final step: receive ${show(ready)} VOID.`);
      await send(client, DEPLOY.production.VoidChainTreasury as Address, 'claim');
      await refresh(account);
      setNotice(`${show(ready)} VOID sent to your wallet.`);
    } catch (error: any) {
      setNotice(error?.shortMessage ?? error?.message ?? 'Could not claim revenue.');
    } finally {
      setBusy(false);
    }
  }

  const total = revenue.pending + revenue.parked + revenue.ready;
  return (
    <section className={styles.revenueClaim} aria-label="Chain owner revenue">
      <div>
        <span className={styles.factLabel}>Owner revenue available</span>
        <strong>{show(total)} VOID</strong>
        <small>Pending {show(revenue.pending)} · preserved {show(revenue.parked)} · ready {show(revenue.ready)}</small>
      </div>
      <button type="button" className={styles.claimButton} disabled={busy || total === 0n} onClick={() => void claim()}>
        {busy ? 'Claiming…' : 'Claim revenue'}
      </button>
      {notice && <p className={styles.factNotice} role="status">{notice}</p>}
    </section>
  );
}
