'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  http,
  parseUnits,
  type Address,
} from 'viem';
import { ABI, DEPLOY, RH_TESTNET, fmt } from '@/lib/testnet';
import { Copyable } from './Copyable';
import styles from './page.module.css';

const rpc = createPublicClient({ transport: http(RH_TESTNET.rpcUrls[0]) });
const STATES = ['Pending', 'Active', 'Defeated', 'Succeeded', 'Executed'] as const;

type WalletProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?: (event: string, listener: (value: unknown) => void) => void;
  removeListener?: (event: string, listener: (value: unknown) => void) => void;
};

type Proposal = {
  id: number;
  feeLimitUsd: bigint;
  snapshotBlock: bigint;
  snapshotSupply: bigint;
  deadline: bigint;
  forVotes: bigint;
  againstVotes: bigint;
  state: number;
  voted: boolean;
};

type Governance = {
  dao: Address;
  proposalCount: number;
  quorumBps: bigint;
  votingPeriod: bigint;
  proposals: Proposal[];
};

const asAddress = (value: unknown): Address | null =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) ? value as Address : null;

function firstAccount(value: unknown): Address | null {
  return Array.isArray(value) ? asAddress(value[0]) : null;
}

function wallet(): WalletProvider | undefined {
  return (window as Window & { ethereum?: WalletProvider }).ethereum;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usd(value: bigint): string {
  return `$${fmt(value, 18, 4)}`;
}

function date(value: bigint): string {
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(Number(value) * 1000));
}

function days(value: bigint): string {
  return `${Number(value / 86_400n)} days`;
}

export function DaoPanel({ tokenId }: { tokenId: number }) {
  const [account, setAccount] = useState<Address | null>(null);
  const [data, setData] = useState<Governance | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [feeLimit, setFeeLimit] = useState('0.001');

  const refresh = useCallback(async (who: Address | null) => {
    const factory = DEPLOY.production.VoidChainDaoFactory as Address;
    const dao = await rpc.readContract({
      address: factory, abi: ABI.daoFactory, functionName: 'daoOf', args: [BigInt(tokenId)],
    }) as Address;
    const [count, quorumBps, votingPeriod] = await Promise.all([
      rpc.readContract({ address: dao, abi: ABI.dao, functionName: 'proposalCount' }) as Promise<bigint>,
      rpc.readContract({ address: dao, abi: ABI.dao, functionName: 'QUORUM_BPS' }) as Promise<bigint>,
      rpc.readContract({ address: dao, abi: ABI.dao, functionName: 'VOTING_PERIOD' }) as Promise<bigint>,
    ]);

    const latest = Math.min(Number(count), 25);
    const ids = Array.from({ length: latest }, (_, i) => Number(count) - i);
    const proposals = await Promise.all(ids.map(async (id) => {
      const [p, state, voted] = await Promise.all([
        rpc.readContract({ address: dao, abi: ABI.dao, functionName: 'proposals', args: [BigInt(id)] }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean]>,
        rpc.readContract({ address: dao, abi: ABI.dao, functionName: 'state', args: [BigInt(id)] }) as Promise<number>,
        who
          ? rpc.readContract({ address: dao, abi: ABI.dao, functionName: 'hasVoted', args: [BigInt(id), who] }) as Promise<boolean>
          : Promise.resolve(false),
      ]);
      return {
        id, feeLimitUsd: p[0], snapshotBlock: p[1], snapshotSupply: p[2], deadline: p[3],
        forVotes: p[4], againstVotes: p[5], state, voted,
      };
    }));

    setData({ dao, proposalCount: Number(count), quorumBps, votingPeriod, proposals });
  }, [tokenId]);

  useEffect(() => {
    const p = wallet();
    if (!p) return;
    const changed = (accounts: unknown) => setAccount(firstAccount(accounts));
    void p.request({ method: 'eth_accounts' }).then(changed).catch(() => undefined);
    p.on?.('accountsChanged', changed);
    return () => p.removeListener?.('accountsChanged', changed);
  }, []);

  useEffect(() => {
    void refresh(account).catch((error) => setNotice(messageOf(error)));
  }, [account, refresh]);

  async function connectedWallet(): Promise<{ provider: WalletProvider; account: Address }> {
    const provider = wallet();
    if (!provider) throw new Error('No browser wallet found.');
    const next = firstAccount(await provider.request({ method: 'eth_requestAccounts' }));
    if (!next) throw new Error('The wallet did not return an account.');

    const current = await provider.request({ method: 'eth_chainId' });
    if (current !== RH_TESTNET.chainIdHex) {
      try {
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: RH_TESTNET.chainIdHex }] });
      } catch {
        await provider.request({ method: 'wallet_addEthereumChain', params: [RH_TESTNET] });
      }
    }
    setAccount(next);
    return { provider, account: next };
  }

  async function send(label: string, functionName: string, args: unknown[]) {
    if (!data) return;
    setBusy(label);
    setNotice('Confirm the transaction in your wallet…');
    try {
      const { provider, account: sender } = await connectedWallet();
      const client = createWalletClient({ account: sender, transport: custom(provider as any) });
      const hash = await client.sendTransaction({
        account: sender,
        chain: null,
        to: data.dao,
        data: encodeFunctionData({ abi: ABI.dao, functionName, args } as any),
      });
      setNotice('Sent. Waiting for Robinhood testnet confirmation…');
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('The transaction reverted.');
      setNotice('Confirmed. DAO updated.');
      await refresh(sender);
    } catch (error) {
      setNotice(messageOf(error).slice(0, 180));
    } finally {
      setBusy(null);
    }
  }

  function feeInUsd(value: string): bigint | null {
    try {
      const parsed = parseUnits(value.trim(), 18);
      return parsed >= 0n ? parsed : null;
    } catch {
      return null;
    }
  }

  async function propose() {
    const parsed = feeInUsd(feeLimit);
    if (parsed === null) {
      setNotice('Enter a valid fee limit in USD.');
      return;
    }
    await send('propose', 'propose', [parsed]);
  }

  if (!data) {
    return <section className={styles.daoPanel}><p className={styles.daoLoading}>Loading DAO…</p></section>;
  }

  return (
    <section className={styles.daoPanel} aria-label={`DAO governance for VOID Chain ${tokenId}`}>
      <div className={styles.daoHead}>
        <div>
          <p className={styles.daoKicker}>DAO · governance</p>
          <h3>VOID Chain #{tokenId} DAO</h3>
        </div>
        <a className={styles.daoExplorer} href={`https://explorer.testnet.chain.robinhood.com/address/${data.dao}`} target="_blank" rel="noreferrer">view contract ↗</a>
      </div>

      <p className={styles.daoScope}>
        The NFT holder creates proposals. VOID stays in your wallet. Your wallet balance at the
        proposal snapshot is your voting power for the full five-day vote.
      </p>

      <dl className={styles.daoFacts}>
        <div><dt>DAO contract</dt><dd><Copyable value={data.dao} short /></dd></div>
        <div><dt>Proposals</dt><dd>{data.proposalCount}</dd></div>
        <div><dt>Quorum</dt><dd>{Number(data.quorumBps) / 100}%</dd></div>
        <div><dt>Voting period</dt><dd>{days(data.votingPeriod)}</dd></div>
      </dl>

      <div className={styles.daoCompose}>
        <div>
          <h4>Create fee-limit proposal</h4>
          <p>Only the current NFT holder can create it. No VOID approval or token lock is needed.</p>
        </div>
        <label>
          Fee limit, USD
          <input value={feeLimit} inputMode="decimal" onChange={(event) => setFeeLimit(event.target.value)} placeholder="0.001" />
        </label>
        <button type="button" className={styles.daoPrimary} disabled={busy !== null} onClick={propose}>
          {busy === 'propose' ? 'Creating…' : account ? 'Create proposal' : 'Connect to create'}
        </button>
      </div>

      {notice && <p className={styles.daoNotice} role="status">{notice}</p>}

      <div className={styles.daoProposals}>
        <div className={styles.daoProposalHead}>
          <h4>Proposals</h4>
          <span>{data.proposalCount > 25 ? 'latest 25' : 'on-chain'}</span>
        </div>
        {data.proposals.length === 0 ? (
          <p className={styles.daoEmpty}>No proposal yet.</p>
        ) : data.proposals.map((proposal) => {
          const state = STATES[proposal.state] ?? 'Unknown';
          const canVote = proposal.state === 1 && !proposal.voted;
          const canExecute = proposal.state === 3;
          return (
            <article className={styles.proposal} key={proposal.id}>
              <div className={styles.proposalTop}>
                <span>#{proposal.id} · fee limit {usd(proposal.feeLimitUsd)}</span>
                <span className={`${styles.proposalState} ${proposal.state === 1 ? styles.proposalActive : ''}`}>{state}</span>
              </div>
              <div className={styles.proposalMeta}>
                <span>For {fmt(proposal.forVotes, 18, 2)} VOID</span>
                <span>Against {fmt(proposal.againstVotes, 18, 2)} VOID</span>
                <span>Snapshot #{proposal.snapshotBlock.toString()}</span>
                <span>{proposal.state === 1 ? `Ends ${date(proposal.deadline)}` : `Ended ${date(proposal.deadline)}`}</span>
              </div>
              {proposal.voted && <p className={styles.proposalVote}>Vote recorded with your wallet snapshot balance.</p>}
              {canVote && (
                <div className={styles.proposalActions}>
                  <button type="button" disabled={busy !== null} onClick={() => send(`for-${proposal.id}`, 'castVote', [BigInt(proposal.id), true])}>Vote for</button>
                  <button type="button" disabled={busy !== null} onClick={() => send(`against-${proposal.id}`, 'castVote', [BigInt(proposal.id), false])}>Vote against</button>
                </div>
              )}
              {canExecute && (
                <div className={styles.proposalActions}>
                  <button type="button" disabled={busy !== null} onClick={() => send(`execute-${proposal.id}`, 'execute', [BigInt(proposal.id)])}>Execute proposal</button>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
