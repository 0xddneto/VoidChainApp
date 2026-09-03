'use client';

/**
 * The governance module for one execution space.
 *
 * The DAO is shown as this space's system application in VoidScan, but it is
 * intentionally not an ordinary runtime app: it must keep direct, narrow
 * authority to set only this space's toll ceiling. Routing it through the
 * general app executor would change `msg.sender`, make voters invisible, and
 * let an owner disable governance by changing normal app policy.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
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
  ceilingUsd: bigint;
  deadline: bigint;
  forVotes: bigint;
  againstVotes: bigint;
  state: number;
  voted: boolean;
  locked: bigint;
};

type Governance = {
  dao: Address;
  proposalCount: number;
  quorumBps: bigint;
  thresholdBps: bigint;
  tokenSupply: bigint;
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

function portionCeil(total: bigint, bps: bigint): bigint {
  return (total * bps + 9_999n) / 10_000n;
}

export function DaoPanel({ tokenId }: { tokenId: number }) {
  const [account, setAccount] = useState<Address | null>(null);
  const [data, setData] = useState<Governance | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [ceiling, setCeiling] = useState('0.001');
  const [proposalWeight, setProposalWeight] = useState('');
  const [voteWeights, setVoteWeights] = useState<Record<number, string>>({});

  const refresh = useCallback(async (who: Address | null) => {
    const factory = DEPLOY.production.VoidChainDaoFactory as Address;
    const dao = await rpc.readContract({
      address: factory, abi: ABI.daoFactory, functionName: 'daoOf', args: [BigInt(tokenId)],
    }) as Address;
    const [count, quorumBps, thresholdBps, tokenSupply] = await Promise.all([
      rpc.readContract({ address: dao, abi: ABI.dao, functionName: 'proposalCount' }) as Promise<bigint>,
      rpc.readContract({ address: dao, abi: ABI.dao, functionName: 'QUORUM_BPS' }) as Promise<bigint>,
      rpc.readContract({ address: dao, abi: ABI.dao, functionName: 'PROPOSAL_THRESHOLD_BPS' }) as Promise<bigint>,
      rpc.readContract({ address: DEPLOY.testnet.VoidTestToken as Address, abi: ABI.token, functionName: 'totalSupply' }) as Promise<bigint>,
    ]);

    // A wallet cannot be asked to render an unbounded historical list. The DAO
    // remains fully readable on the explorer; the card keeps the 25 newest
    // proposals actionable in the product itself.
    const latest = Math.min(Number(count), 25);
    const ids = Array.from({ length: latest }, (_, i) => Number(count) - i);
    const proposals = await Promise.all(ids.map(async (id) => {
      const [p, state, voted, locked] = await Promise.all([
        rpc.readContract({ address: dao, abi: ABI.dao, functionName: 'proposals', args: [BigInt(id)] }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint, boolean]>,
        rpc.readContract({ address: dao, abi: ABI.dao, functionName: 'state', args: [BigInt(id)] }) as Promise<number>,
        who
          ? rpc.readContract({ address: dao, abi: ABI.dao, functionName: 'hasVoted', args: [BigInt(id), who] }) as Promise<boolean>
          : Promise.resolve(false),
        who
          ? rpc.readContract({ address: dao, abi: ABI.dao, functionName: 'lockedVotes', args: [BigInt(id), who] }) as Promise<bigint>
          : Promise.resolve(0n),
      ]);
      return { id, ceilingUsd: p[0], deadline: p[2], forVotes: p[3], againstVotes: p[4], state, voted, locked };
    }));

    setData({ dao, proposalCount: Number(count), quorumBps, thresholdBps, tokenSupply, proposals });
  }, [tokenId]);

  useEffect(() => {
    const p = wallet();
    if (!p) return;
    const changed = (accounts: unknown) => setAccount(firstAccount(accounts));
    void p.request({ method: 'eth_accounts' }).then(changed).catch(() => undefined);
    p.on?.('accountsChanged', changed);
    return () => p.removeListener?.('accountsChanged', changed);
  }, []);

  useEffect(() => { void refresh(account).catch((error) => setNotice(messageOf(error))); }, [account, refresh]);

  const threshold = useMemo(
    () => data ? portionCeil(data.tokenSupply, data.thresholdBps) : 0n,
    [data],
  );
  const quorum = useMemo(
    () => data ? portionCeil(data.tokenSupply, data.quorumBps) : 0n,
    [data],
  );

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

  async function send(label: string, address: Address, abi: any, functionName: string, args: unknown[]) {
    setBusy(label);
    setNotice('Confirm the transaction in your wallet…');
    try {
      const { provider, account: sender } = await connectedWallet();
      const client = createWalletClient({ account: sender, transport: custom(provider as any) });
      const hash = await client.sendTransaction({
        account: sender,
        chain: null,
        to: address,
        data: encodeFunctionData({ abi, functionName, args } as any),
      });
      setNotice('Sent. Waiting for Robinhood testnet confirmation…');
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('The transaction reverted.');
      setNotice('Confirmed. Governance state refreshed.');
      await refresh(sender);
    } catch (error) {
      setNotice(messageOf(error).slice(0, 180));
    } finally {
      setBusy(null);
    }
  }

  function units(value: string): bigint | null {
    try {
      const parsed = parseUnits(value.trim(), 18);
      return parsed > 0n ? parsed : null;
    } catch {
      return null;
    }
  }

  async function approveIfNeeded(weight: bigint): Promise<boolean> {
    if (!data) return false;
    const { provider, account: sender } = await connectedWallet();
    const allowance = await rpc.readContract({
      address: DEPLOY.testnet.VoidTestToken as Address, abi: ABI.token, functionName: 'allowance', args: [sender, data.dao],
    }) as bigint;
    if (allowance >= weight) return true;
    setBusy('approve');
    setNotice('Approve the exact VOID voting weight in your wallet…');
    try {
      const client = createWalletClient({ account: sender, transport: custom(provider as any) });
      const hash = await client.sendTransaction({
        account: sender, chain: null, to: DEPLOY.testnet.VoidTestToken as Address,
        data: encodeFunctionData({ abi: ABI.token, functionName: 'approve', args: [data.dao, weight] }),
      });
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('VOID approval reverted.');
      setNotice('VOID approved. Submit the governance action once more to lock the vote.');
    } catch (error) {
      setNotice(messageOf(error).slice(0, 180));
    } finally {
      setBusy(null);
    }
    return false;
  }

  async function propose() {
    if (!data) return;
    const ceilingUsd = units(ceiling);
    const weight = units(proposalWeight);
    if (!ceilingUsd || !weight) {
      setNotice('Enter a positive USD ceiling and a positive VOID weight.');
      return;
    }
    if (weight < threshold) {
      setNotice(`A proposal needs at least ${fmt(threshold, 18, 2)} VOID locked (1% of current supply).`);
      return;
    }
    if (!(await approveIfNeeded(weight))) return;
    await send('propose', data.dao, ABI.dao, 'propose', [ceilingUsd, weight]);
  }

  async function vote(id: number, support: boolean) {
    if (!data) return;
    const weight = units(voteWeights[id] ?? '');
    if (!weight) {
      setNotice('Enter a positive VOID voting weight.');
      return;
    }
    if (!(await approveIfNeeded(weight))) return;
    await send(`vote-${id}`, data.dao, ABI.dao, 'castVote', [BigInt(id), support, weight]);
  }

  if (!data) {
    return <section className={styles.daoPanel}><p className={styles.daoLoading}>Loading this space’s DAO…</p></section>;
  }

  return (
    <section className={styles.daoPanel} aria-label={`DAO governance for VOID Chain ${tokenId}`}>
      <div className={styles.daoHead}>
        <div>
          <p className={styles.daoKicker}>System app · governance</p>
          <h3>DAO for VOID Chain #{tokenId}</h3>
        </div>
        <a className={styles.daoExplorer} href={`https://explorer.testnet.chain.robinhood.com/address/${data.dao}`} target="_blank" rel="noreferrer">open bytecode ↗</a>
      </div>

      <p className={styles.daoScope}>
        This DAO can only cap this space’s toll. It cannot seize assets, alter other spaces,
        rewrite history, or control permissionless applications.
      </p>

      <dl className={styles.daoFacts}>
        <div><dt>DAO contract</dt><dd><Copyable value={data.dao} short /></dd></div>
        <div><dt>Proposals</dt><dd>{data.proposalCount}</dd></div>
        <div><dt>Quorum</dt><dd>{Number(data.quorumBps) / 100}% · {fmt(quorum, 18, 2)} VOID</dd></div>
        <div><dt>Proposal threshold</dt><dd>{Number(data.thresholdBps) / 100}% · {fmt(threshold, 18, 2)} VOID</dd></div>
      </dl>

      <div className={styles.daoCompose}>
        <div>
          <h4>Propose a maximum toll</h4>
          <p>Voting locks VOID for five days. The proposal sets a ceiling, not the current toll.</p>
        </div>
        <label>
          Maximum toll, USD
          <input value={ceiling} inputMode="decimal" onChange={(event) => setCeiling(event.target.value)} placeholder="0.001" />
        </label>
        <label>
          VOID to lock
          <input value={proposalWeight} inputMode="decimal" onChange={(event) => setProposalWeight(event.target.value)} placeholder={fmt(threshold, 18, 2)} />
        </label>
        <button type="button" className={styles.daoPrimary} disabled={busy !== null} onClick={propose}>
          {busy === 'propose' ? 'Proposing…' : busy === 'approve' ? 'Approving VOID…' : account ? 'Submit proposal' : 'Connect to propose'}
        </button>
      </div>

      {notice && <p className={styles.daoNotice} role="status">{notice}</p>}

      <div className={styles.daoProposals}>
        <div className={styles.daoProposalHead}>
          <h4>Proposals</h4>
          <span>{data.proposalCount > 25 ? 'latest 25 shown' : 'on-chain state'}</span>
        </div>
        {data.proposals.length === 0 ? (
          <p className={styles.daoEmpty}>No proposal yet. The DAO is deployed, registered, and ready for its first vote.</p>
        ) : data.proposals.map((proposal) => {
          const state = STATES[proposal.state] ?? 'Unknown';
          const canVote = proposal.state === 1 && !proposal.voted;
          const canExecute = proposal.state === 3;
          const canWithdraw = proposal.locked > 0n && proposal.state !== 1;
          return (
            <article className={styles.proposal} key={proposal.id}>
              <div className={styles.proposalTop}>
                <span>#{proposal.id} · maximum {usd(proposal.ceilingUsd)}</span>
                <span className={`${styles.proposalState} ${proposal.state === 1 ? styles.proposalActive : ''}`}>{state}</span>
              </div>
              <div className={styles.proposalMeta}>
                <span>For {fmt(proposal.forVotes, 18, 2)} VOID</span>
                <span>Against {fmt(proposal.againstVotes, 18, 2)} VOID</span>
                <span>{proposal.state === 1 ? `Closes ${date(proposal.deadline)}` : `Closed ${date(proposal.deadline)}`}</span>
              </div>
              {proposal.voted && <p className={styles.proposalVote}>Your locked vote: {fmt(proposal.locked, 18, 2)} VOID</p>}
              {canVote && (
                <div className={styles.proposalActions}>
                  <input value={voteWeights[proposal.id] ?? ''} inputMode="decimal" placeholder="VOID weight" onChange={(event) => setVoteWeights((old) => ({ ...old, [proposal.id]: event.target.value }))} />
                  <button type="button" disabled={busy !== null} onClick={() => vote(proposal.id, true)}>Vote for</button>
                  <button type="button" disabled={busy !== null} onClick={() => vote(proposal.id, false)}>Vote against</button>
                </div>
              )}
              {(canExecute || canWithdraw) && (
                <div className={styles.proposalActions}>
                  {canExecute && <button type="button" disabled={busy !== null} onClick={() => send(`execute-${proposal.id}`, data.dao, ABI.dao, 'execute', [BigInt(proposal.id)])}>Execute ceiling</button>}
                  {canWithdraw && <button type="button" disabled={busy !== null} onClick={() => send(`withdraw-${proposal.id}`, data.dao, ABI.dao, 'withdrawVote', [BigInt(proposal.id)])}>Withdraw locked VOID</button>}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
