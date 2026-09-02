'use client';

/**
 * Acquire a deed and watch the chain answer to you — on testnet, for free.
 *
 * The page is entirely client-side because everything here depends on the
 * wallet of whoever is looking: the balance, what they own, what they can buy.
 * None of that exists on the server.
 *
 * The flow mirrors the market the collection launches into: the pool prices
 * every deed at a fixed ratio in VOID, plus the fee. The only thing testnet
 * changes is where the VOID comes from — here the tap is open.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  http,
  type Address,
} from 'viem';
import { ABI, DEPLOY, RH_TESTNET, chainIdForToken, fmt } from '@/lib/testnet';
import styles from './page.module.css';

const rpc = createPublicClient({ transport: http(RH_TESTNET.rpcUrls[0]) });

/** Enough VOID to buy two deeds and still pay tolls freely. */
const FAUCET_AMOUNT = 2_500_000n * 10n ** 18n;

type Deed = { id: number; chainId: number; feeVoid: bigint; calls: bigint; active: boolean };
type Msg = { kind: 'ok' | 'err' | 'info'; text: string } | null;

export default function Mint() {
  const [account, setAccount] = useState<Address | null>(null);
  const [chainOk, setChainOk] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  const [voidBal, setVoidBal] = useState(0n);
  const [ethBal, setEthBal] = useState(0n);
  const [available, setAvailable] = useState(0n);
  const [price, setPrice] = useState(0n);
  const [deeds, setDeeds] = useState<Deed[]>([]);

  const T = DEPLOY.testnet;
  const P = DEPLOY.production;

  // ---- reading the chain -------------------------------------------------
  const refresh = useCallback(async (who: Address | null) => {
    const [avail, p] = await Promise.all([
      rpc.readContract({ address: T.VoidNftAmm as Address, abi: ABI.amm, functionName: 'available' }),
      rpc.readContract({ address: T.VoidNftAmm as Address, abi: ABI.amm, functionName: 'priceToBuy', args: [false] }),
    ]);
    setAvailable(avail as bigint);
    setPrice(p as bigint);

    if (!who) { setVoidBal(0n); setEthBal(0n); setDeeds([]); return; }

    // Gas for all three steps comes out of the visitor's wallet, in Robinhood
    // ETH. Showing the balance is what keeps them from discovering that through
    // a wallet error after they already clicked.
    setEthBal(await rpc.getBalance({ address: who }));

    const bal = await rpc.readContract({
      address: T.VoidTestToken as Address, abi: ABI.token, functionName: 'balanceOf', args: [who],
    });
    setVoidBal(bal as bigint);

    // Which deeds are theirs. The deed exposes no enumeration, so we sweep all
    // 1,111 in parallel — it is a read, it is cheap, and it keeps a page that
    // must work on its own from depending on the indexer.
    const owners = await Promise.all(
      Array.from({ length: DEPLOY.parameters.nfts }, (_, i) =>
        rpc.readContract({
          address: P.VoidChainDeed as Address, abi: ABI.deed,
          functionName: 'ownerOf', args: [BigInt(i + 1)],
        }).catch(() => null),
      ),
    );
    const mine = owners
      .map((o, i) => (o && (o as string).toLowerCase() === who.toLowerCase() ? i + 1 : 0))
      .filter(Boolean);

    const detail = await Promise.all(mine.map(async (id) => {
      const [stats, fee] = await Promise.all([
        rpc.readContract({ address: P.VoidChainAppRuntime as Address, abi: ABI.runtime, functionName: 'statsOf', args: [BigInt(id)] }),
        rpc.readContract({ address: P.VoidChainAppRuntime as Address, abi: ABI.runtime, functionName: 'feeOf', args: [BigInt(id)] }).catch(() => 0n),
      ]);
      const s = stats as readonly [boolean, bigint, bigint, bigint, bigint];
      return { id, chainId: chainIdForToken(id), feeVoid: fee as bigint, calls: s[4], active: s[0] };
    }));
    setDeeds(detail);
  }, [T.VoidNftAmm, T.VoidTestToken, P.VoidChainDeed, P.VoidChainAppRuntime]);

  useEffect(() => { void refresh(account); }, [account, refresh]);

  // ---- wallet ------------------------------------------------------------
  const eth = () => (typeof window !== 'undefined' ? (window as any).ethereum : undefined);

  async function connect() {
    const p = eth();
    if (!p) {
      setMsg({ kind: 'err', text: 'No wallet found. Install MetaMask and reload.' });
      return;
    }
    setBusy('connect');
    try {
      const [addr] = await p.request({ method: 'eth_requestAccounts' });
      setAccount(addr as Address);

      const current = await p.request({ method: 'eth_chainId' });
      if (current !== RH_TESTNET.chainIdHex) {
        try {
          await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: RH_TESTNET.chainIdHex }] });
        } catch {
          // 4902 and friends: the network is not registered. Registering it is
          // the natural next step, not an error to show the user.
          await p.request({ method: 'wallet_addEthereumChain', params: [RH_TESTNET] });
        }
      }
      setChainOk(true);
      setMsg(null);
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.shortMessage ?? e?.message ?? 'Connection refused.' });
    } finally { setBusy(null); }
  }

  async function tx(label: string, to: Address, abi: any, fn: string, args: unknown[], ok: string) {
    const p = eth();
    if (!p || !account) return;
    setBusy(label);
    setMsg({ kind: 'info', text: 'Confirm in your wallet…' });
    try {
      const w = createWalletClient({ account, transport: custom(p) });
      const hash = await w.sendTransaction({
        account, chain: null, to,
        data: encodeFunctionData({ abi, functionName: fn, args }),
      });
      setMsg({ kind: 'info', text: 'Sent. Waiting for confirmation…' });
      const r = await rpc.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error('The transaction reverted.');
      setMsg({ kind: 'ok', text: ok });
      await refresh(account);
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.shortMessage ?? e?.message ?? 'Failed.' });
    } finally { setBusy(null); }
  }

  const getVoid = () =>
    tx('faucet', T.VoidTestToken as Address, ABI.token, 'mintTo',
      [account, FAUCET_AMOUNT], `${fmt(FAUCET_AMOUNT, 18, 0)} VOID in your wallet.`);

  async function buy() {
    if (!account) return;
    const allowance = await rpc.readContract({
      address: T.VoidTestToken as Address, abi: ABI.token,
      functionName: 'allowance', args: [account, T.VoidNftAmm as Address],
    }) as bigint;

    if (allowance < price) {
      await tx('approve', T.VoidTestToken as Address, ABI.token, 'approve',
        [T.VoidNftAmm, price * 10n], 'Approved. Now buy the deed.');
      return;
    }
    await tx('buy', T.VoidNftAmm as Address, ABI.amm, 'buyRandom',
      [price], 'The deed is yours. The chain now answers to you.');
  }

  const hasVoid = voidBal >= price;
  const connected = Boolean(account && chainOk);

  return (
    <>
      <header className={styles.header}>
        <div className={styles.bar}>
          <div className={styles.logo}>Void<span>Scan</span></div>
          <a className={styles.back} href="/">← explorer</a>
        </div>
      </header>

      <main className={styles.wrap}>
        <div className={styles.hero}>
          <div className={styles.testnet}>● Robinhood testnet · no real value</div>
          <h1>Buy a deed. Own a blockchain.</h1>
          <p>
            The deed <em>is</em> the chain. You set what it costs to use, you collect
            what it earns, and anyone can build on it without asking you. It starts
            answering to you the moment the NFT lands in your wallet — no setup, no
            handover, nothing to configure.
          </p>
        </div>

        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt>For sale in the pool</dt>
            <dd>{available.toString()}<small> / {DEPLOY.parameters.nfts}</small></dd>
          </div>
          <div className={styles.fact}>
            <dt>Deed price</dt>
            <dd>{fmt(price, 18, 0)}<small> VOID</small></dd>
          </div>
          <div className={styles.fact}>
            <dt>Toll per call</dt>
            <dd>$0.001</dd>
          </div>
          <div className={styles.fact}>
            <dt>Your balance</dt>
            <dd>{fmt(voidBal, 18, 0)}<small> VOID</small></dd>
          </div>
        </dl>

        <div className={styles.steps}>
          <section className={styles.step} data-done={connected}>
            <div className={styles.num}>{connected ? '✓' : '1'}</div>
            <div className={styles.stepBody}>
              <h2>Connect your wallet</h2>
              <p>
                The network is registered automatically if you do not have it yet.
                The VOID on this page is free, but all three steps are transactions
                sent by you: Robinhood charges gas for them in testnet ETH. A few
                thousandths cover the whole flow.
              </p>
              {connected && (
                <p className={ethBal === 0n ? styles.noEth : undefined}>
                  Gas balance: <b className={styles.mono}>{fmt(ethBal, 18, 5)} ETH</b>
                  {ethBal === 0n && ' — without it your wallet will refuse the transactions.'}
                </p>
              )}
              <button className={styles.btn} onClick={connect} disabled={busy !== null || connected}>
                {connected ? `${account!.slice(0, 6)}…${account!.slice(-4)}` : 'Connect'}
              </button>
            </div>
          </section>

          <section className={styles.step} data-done={hasVoid} data-blocked={!connected}>
            <div className={styles.num}>{hasVoid ? '✓' : '2'}</div>
            <div className={styles.stepBody}>
              <h2>Get VOID</h2>
              <p>
                VOID is the gas of the chainapps. Here it is free and unlimited, because
                this is testnet. On mainnet it comes from the open market.
              </p>
              <button className={styles.btn} onClick={getVoid} disabled={!connected || busy !== null}>
                {busy === 'faucet' ? 'Getting…' : `Get ${fmt(FAUCET_AMOUNT, 18, 0)} VOID`}
              </button>
            </div>
          </section>

          <section className={styles.step} data-blocked={!hasVoid}>
            <div className={styles.num}>3</div>
            <div className={styles.stepBody}>
              <h2>Buy a deed</h2>
              <p>
                The pool hands over the next one in line — buying at random is cheaper
                than picking. From the next block, that chain is yours: you set its toll
                and you collect its revenue.
              </p>
              <div className={styles.row}>
                <button className={styles.btn} onClick={buy} disabled={!hasVoid || busy !== null || available === 0n}>
                  {busy === 'approve' ? 'Approving…' : busy === 'buy' ? 'Buying…' : 'Buy deed'}
                </button>
                <span className={styles.mono}>
                  {available === 0n ? 'sold out' : `${fmt(price, 18, 0)} VOID`}
                </span>
              </div>
            </div>
          </section>
        </div>

        {msg && (
          <div className={`${styles.msg} ${msg.kind === 'ok' ? styles.msgOk : msg.kind === 'err' ? styles.msgErr : styles.msgInfo}`}>
            {msg.text}
          </div>
        )}

        {deeds.length > 0 && (
          <section className={styles.owned}>
            <h2>Your chains</h2>
            <p>Each deed is a network with its own identifier and a separate economy.</p>
            <div className={styles.deeds}>
              {deeds.map((d) => (
                <article key={d.id} className={styles.deed}>
                  <p className={styles.deedId}>VOID #{d.id}</p>
                  <p className={styles.deedChain}>chain {d.chainId}</p>
                  <div className={styles.deedRow}><span>State</span><b>{d.active ? 'active' : 'dormant'}</b></div>
                  <div className={styles.deedRow}><span>Toll</span><b>{fmt(d.feeVoid, 18, 2)} VOID</b></div>
                  <div className={styles.deedRow}><span>Calls</span><b>{d.calls.toString()}</b></div>
                </article>
              ))}
            </div>
          </section>
        )}

        <div className={styles.note}>
          <p>
            <strong>This is testnet.</strong> The VOID here has no value, the tap is open,
            and the oracle returns a declared price instead of reading a market — there is
            no deep VOID/ETH pool nor a Chainlink feed on this network.
          </p>
          <p>
            Everything else is the real thing. <code>VoidChainDeed</code>,{' '}
            <code>VoidChainAppRuntime</code>, <code>VoidChainTreasury</code> and{' '}
            <code>VoidPaymaster</code> are the contracts that go to mainnet, and the
            dollar toll, the revenue going to the owner and the isolation between
            chains work here exactly as they will there.
          </p>
        </div>
      </main>
    </>
  );
}
