'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  http,
  type Address,
} from 'viem';
import { ABI, DEPLOY, RH_TESTNET } from '@/lib/testnet';
import { Copyable } from './Copyable';
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

/**
 * The shared runtime cannot become an L3 through an EVM call. This panel makes
 * the real owner path visible without representing a signal proposal as a
 * chain deployment. The DAO records the decision; the external stack still
 * needs to be deployed, audited and connected afterwards.
 */
export function ChainL3Migration({ tokenId, runtimeId }: { tokenId: number; runtimeId: number }) {
  const [account, setAccount] = useState<Address | null>(null);
  const [owner, setOwner] = useState<Address | null>(null);
  const [dao, setDao] = useState<Address | null>(null);
  const [active, setActive] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const wallet = provider();
    const accountsChanged = (accounts: unknown) => setAccount(firstAddress(accounts));
    if (wallet) {
      void wallet.request({ method: 'eth_accounts' }).then(accountsChanged).catch(() => undefined);
      wallet.on?.('accountsChanged', accountsChanged);
    }

    let mounted = true;
    void Promise.all([
      rpc.readContract({
        address: DEPLOY.production.VoidChainDeed as Address,
        abi: ABI.deed,
        functionName: 'ownerOf',
        args: [BigInt(tokenId)],
      }),
      rpc.readContract({
        address: DEPLOY.production.VoidChainDaoFactory as Address,
        abi: ABI.daoFactory,
        functionName: 'daoOf',
        args: [BigInt(tokenId)],
      }),
      rpc.readContract({
        address: DEPLOY.production.VoidChainAppRuntime as Address,
        abi: ABI.runtime,
        functionName: 'statsOf',
        args: [BigInt(tokenId)],
      }),
    ]).then(([currentOwner, chainDao, stats]) => {
      if (!mounted) return;
      setOwner(currentOwner as Address);
      setDao(chainDao as Address);
      setActive(Boolean((stats as readonly unknown[])[0]));
    }).catch(() => setNotice('Could not read the L3 migration status from Robinhood testnet.'));

    return () => {
      mounted = false;
      wallet?.removeListener?.('accountsChanged', accountsChanged);
    };
  }, [tokenId]);

  const isHolder = Boolean(account && owner && account.toLowerCase() === owner.toLowerCase());

  const downloadHandoff = useCallback(() => {
    const handoff = {
      version: 1,
      purpose: 'VoidChain L3 migration handoff',
      deed: {
        tokenId,
        runtimeId,
        deedContract: DEPLOY.production.VoidChainDeed,
        currentOwner: owner,
      },
      currentRuntime: {
        parentChain: RH_TESTNET.chainName,
        parentChainId: RH_TESTNET.chainId,
        runtimeContract: DEPLOY.production.VoidChainAppRuntime,
        active,
      },
      governance: {
        dao,
        requiredDecision: 'Passed DAO proposal before migration work is authorized.',
      },
      requiredBeforeLaunch: [
        'Choose a supported L3/rollup stack and unique EIP-155 chain ID.',
        'Deploy and operate sequencer, batch submission, data availability and finality.',
        'Run public RPC, indexer and block explorer for this chain.',
        'Deploy and audit canonical bridge, asset rules and native gas policy.',
        'Migrate state with an auditable plan, monitoring, incident response and a new audit.',
      ],
      boundary: 'This file is a handoff checklist. It does not deploy an L3 or authorize a bridge.',
    };
    const blob = new Blob([`${JSON.stringify(handoff, null, 2)}\n`], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = `void-chain-${tokenId}-l3-handoff.json`;
    link.click();
    URL.revokeObjectURL(href);
  }, [active, dao, owner, runtimeId, tokenId]);

  async function createProposal() {
    const wallet = provider();
    if (!wallet || !dao) return;
    setBusy(true);
    setNotice('Confirm the L3 migration proposal in your wallet…');
    try {
      const accounts = await wallet.request({ method: 'eth_requestAccounts' });
      const sender = firstAddress(accounts);
      if (!sender || !owner || sender.toLowerCase() !== owner.toLowerCase()) {
        throw new Error('Only the current deed holder can create this proposal.');
      }
      const network = await wallet.request({ method: 'eth_chainId' });
      if (network !== RH_TESTNET.chainIdHex) {
        try {
          await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: RH_TESTNET.chainIdHex }] });
        } catch {
          await wallet.request({ method: 'wallet_addEthereumChain', params: [RH_TESTNET] });
        }
      }
      const client = createWalletClient({ account: sender, transport: custom(wallet) });
      const description = `Authorize L3 migration planning for VOID Chain #${tokenId}. No L3, bridge, or asset migration may launch until this DAO proposal passes and the required infrastructure is audited.`;
      const hash = await client.sendTransaction({
        account: sender,
        chain: null,
        to: dao,
        data: encodeFunctionData({ abi: ABI.dao, functionName: 'propose', args: [[], description] }),
      });
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('The DAO proposal reverted.');
      setNotice('L3 planning proposal created. The DAO vote is open for five days; VOID stays in voters’ wallets.');
    } catch (error: any) {
      setNotice(error?.shortMessage ?? error?.message ?? 'Could not create the L3 migration proposal.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.l3Panel} id="l3-migration" aria-label={`L3 migration for VOID Chain ${tokenId}`}>
      <div className={styles.l3Head}>
        <div>
          <p className={styles.l3Kicker}>L3 PATH · OWNER + DAO</p>
          <h3>Move this chain to its own L3</h3>
        </div>
        <span className={styles.l3State}>NOT DEPLOYED</span>
      </div>

      <p className={styles.l3Intro}>
        This deed currently uses the shared VOID runtime on Robinhood testnet. It has no separate RPC,
        blocks or EIP-155 chain ID yet. A passed DAO decision starts the migration work; it does not turn
        the runtime into an L3 by itself.
      </p>

      <ol className={styles.l3Steps}>
        <li>
          <span className={active ? styles.l3Done : styles.l3Pending}>{active ? 'DONE' : 'NEXT'}</span>
          <div><b>{active ? 'Chain is active' : 'Activate the chain when you are ready to use the runtime'}</b><small>{active ? 'The initial transaction fee is set. Later policy changes stay with this DAO.' : 'Activation is optional for planning, but it is the current on-chain mode before migration.'}</small></div>
        </li>
        <li>
          <span className={styles.l3Pending}>DAO</span>
          <div><b>Approve L3 migration planning</b><small>The deed holder creates the proposal; VOID holders vote for five days without locking VOID.</small></div>
        </li>
        <li>
          <span className={styles.l3Pending}>BUILD</span>
          <div><b>Deploy the chain infrastructure</b><small>Rollup stack, sequencer, data availability, finality, RPC, explorer and canonical bridge are separate deployments.</small></div>
        </li>
        <li>
          <span className={styles.l3Pending}>LAUNCH</span>
          <div><b>Audit, migrate and publish the new network</b><small>Assign a unique EIP-155 ID, define native gas and asset rules, audit the bridge, then publish the new RPC.</small></div>
        </li>
      </ol>

      <dl className={styles.l3Facts}>
        <div><dt>Current parent</dt><dd>{RH_TESTNET.chainName} · {RH_TESTNET.chainId}</dd></div>
        <div><dt>Current runtime ID</dt><dd>{runtimeId}</dd></div>
        <div><dt>DAO contract</dt><dd>{dao ? <Copyable value={dao} short /> : 'loading…'}</dd></div>
        <div><dt>Future EIP-155 ID</dt><dd>chosen at L3 deployment</dd></div>
      </dl>

      <div className={styles.l3Actions}>
        <button type="button" className={styles.editorCancel} onClick={downloadHandoff}>Download L3 handoff</button>
        {isHolder ? (
          <button type="button" className={styles.l3Primary} disabled={busy || !dao} onClick={createProposal}>
            {busy ? 'Creating proposal…' : 'Create L3 migration proposal'}
          </button>
        ) : (
          <span className={styles.l3OwnerNote}>Only the current deed holder can start this DAO proposal.</span>
        )}
      </div>
      {notice && <p className={styles.l3Notice} role="status">{notice}</p>}
    </section>
  );
}
