'use client';

/**
 * Claim a deed and activate its execution space — on testnet, for free.
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
  type Hex,
} from 'viem';
import { ABI, DEPLOY, RH_TESTNET, chainIdForToken, fmt } from '@/lib/testnet';
import {
  MARKET_CALL_GAS_LIMIT,
  MARKET_MAX_GAS_VOID,
  MARKET_SIGNATURE_LIFETIME_SECONDS,
  marketDeployment,
} from '@/lib/market';
import { WalletProfileButton } from '../WalletProfileButton';
import styles from './page.module.css';

const rpc = createPublicClient({ transport: http(RH_TESTNET.rpcUrls[0]) });

/** Enough VOID to buy two deeds and cover test transaction fees. */
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
  const [marketStatus, setMarketStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [deeds, setDeeds] = useState<Deed[]>([]);
  const [alreadyMinted, setAlreadyMinted] = useState(false);

  const T = DEPLOY.testnet;
  const P = DEPLOY.production;

  // ---- reading the chain -------------------------------------------------
  const refresh = useCallback(async (who: Address | null) => {
    // The collection market is the public purchase entry point. Reading its
    // quote keeps the stock and price shown here identical to the mint route,
    // rather than treating an RPC hiccup as an empty pool.
    setMarketStatus('loading');
    try {
      const market = marketDeployment();
      let quote: readonly [bigint, bigint] | null = null;
      let lastError: unknown;

      for (const retryDelay of [0, 250, 750]) {
        if (retryDelay) await new Promise((resolve) => setTimeout(resolve, retryDelay));
        try {
          quote = market
            ? await rpc.readContract({
              address: market.market, abi: ABI.collectionMarket, functionName: 'quoteRandom',
            }) as readonly [bigint, bigint]
            : [
              await rpc.readContract({ address: T.VoidNftAmm as Address, abi: ABI.amm, functionName: 'priceToBuy', args: [false] }) as bigint,
              await rpc.readContract({ address: T.VoidNftAmm as Address, abi: ABI.amm, functionName: 'available' }) as bigint,
            ];
          break;
        } catch (error) {
          lastError = error;
        }
      }

      if (!quote) throw lastError;
      const [quotedPrice, quotedAvailable] = quote;
      setPrice(quotedPrice);
      setAvailable(quotedAvailable);
      setMarketStatus('ready');
    } catch {
      // Keep the previously confirmed quote on screen. A failed read must not
      // falsely tell visitors that every deed has sold out.
      setMarketStatus('unavailable');
    }

    if (!who) { setVoidBal(0n); setEthBal(0n); setDeeds([]); setAlreadyMinted(false); return; }

    // The purchase is relayed by the Paymaster. Its one explicit VOID approval
    // is a normal wallet transaction, so it needs a small amount of test ETH.
    setEthBal(await rpc.getBalance({ address: who }));

    const bal = await rpc.readContract({
      address: T.VoidTestToken as Address, abi: ABI.token, functionName: 'balanceOf', args: [who],
    });
    setVoidBal(bal as bigint);

    const market = marketDeployment();
    if (market) {
      const minted = await rpc.readContract({
        address: market.market, abi: ABI.collectionMarket, functionName: 'hasMinted', args: [who],
      }).catch(() => false);
      setAlreadyMinted(minted as boolean);
    }

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
    const market = marketDeployment();
    const p = eth();
    if (!market || !p) {
      setMsg({ kind: 'err', text: 'The sponsored market is not ready on this testnet yet.' });
      return;
    }

    try {
      const [currentPrice, paymasterNonce, currentAllowance] = await Promise.all([
        rpc.readContract({ address: T.VoidNftAmm as Address, abi: ABI.amm, functionName: 'priceToBuy', args: [false] }) as Promise<bigint>,
        rpc.readContract({ address: P.VoidCollectionMintPaymaster as Address, abi: ABI.mintPaymaster, functionName: 'nonces', args: [account] }) as Promise<bigint>,
        rpc.readContract({ address: T.VoidTestToken as Address, abi: ABI.token, functionName: 'allowance', args: [account, P.VoidCollectionMintPaymaster as Address] }) as Promise<bigint>,
      ]);
      if (currentPrice !== price) throw new Error('The pool price changed. Review the updated quote and try again.');

      const deadline = BigInt(Math.floor(Date.now() / 1000)) + MARKET_SIGNATURE_LIFETIME_SECONDS;
      const totalApproval = currentPrice + MARKET_MAX_GAS_VOID;

      // The only wallet transaction in a purchase. It is a standard ERC-20
      // approval, so the wallet shows VOID, the Paymaster recipient and this
      // exact cap. The Paymaster consumes it in full or refunds unused VOID.
      if (currentAllowance < totalApproval) {
        if (ethBal === 0n) {
          throw new Error('A small amount of Robinhood test ETH is needed for the one VOID approval. The purchase itself is still sponsored in VOID.');
        }
        setBusy('approval');
        setMsg({ kind: 'info', text: `Approve exactly ${fmt(totalApproval, 18, 3)} VOID for this mint. Your wallet will show VOID and the Mint Paymaster.` });
        const wallet = createWalletClient({ account, transport: custom(p) });
        const hash = await wallet.sendTransaction({
          account, chain: null, to: T.VoidTestToken as Address,
          data: encodeFunctionData({ abi: ABI.token, functionName: 'approve', args: [P.VoidCollectionMintPaymaster as Address, totalApproval] }),
        });
        const approval = await rpc.waitForTransactionReceipt({ hash });
        if (approval.status !== 'success') throw new Error('The VOID approval was not confirmed.');
      }

      const request = {
        user: account, market: market.market,
        paymentToken: T.VoidTestToken, paymentSymbol: 'VOID', purchaseLabel: 'VOID deed mint',
        appSpend: currentPrice.toString(),
        maxGasVoid: MARKET_MAX_GAS_VOID.toString(),
        callGasLimit: MARKET_CALL_GAS_LIMIT.toString(),
        nonce: paymasterNonce.toString(), deadline: deadline.toString(),
      };
      const domainFields = [
        { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
      ];
      const typedCall = {
        domain: { name: 'VoidCollectionMintPaymaster', version: '1', chainId: RH_TESTNET.chainId, verifyingContract: P.VoidCollectionMintPaymaster },
        primaryType: 'MarketPrepaidCall',
        types: {
          EIP712Domain: domainFields,
          MarketPrepaidCall: [
            { name: 'user', type: 'address' }, { name: 'market', type: 'address' },
            { name: 'paymentToken', type: 'address' }, { name: 'paymentSymbol', type: 'string' },
            { name: 'purchaseLabel', type: 'string' }, { name: 'appSpend', type: 'uint256' },
            { name: 'maxGasVoid', type: 'uint256' }, { name: 'callGasLimit', type: 'uint256' },
            { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
          ],
        },
        message: request,
      };

      setBusy('signing');
      setMsg({ kind: 'info', text: `Sign one mint: ${fmt(currentPrice, 18, 3)} VOID for the deed and a ${fmt(MARKET_MAX_GAS_VOID, 18, 0)} VOID maximum for sponsored gas. Unused VOID is refunded.` });
      const signature = await p.request({
        method: 'eth_signTypedData_v4', params: [account, JSON.stringify(typedCall)],
      }) as Promise<Hex>;

      setBusy('buy');
      setMsg({ kind: 'info', text: 'Submitting the signed purchase through the Paymaster…' });
      const result = await fetch('/api/market/sponsor', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request, signature }),
      });
      const body = await result.json() as { hash?: Hex; error?: string };
      if (!result.ok || !body.hash) throw new Error(body.error ?? 'The relayer refused the purchase.');
      const receipt = await rpc.waitForTransactionReceipt({ hash: body.hash });
      if (receipt.status !== 'success') throw new Error('The sponsored transaction reverted.');
      setMsg({ kind: 'ok', text: 'The deed is yours. VOID paid the pool price and sponsored execution. Activate your chain when you are ready.' });
      await refresh(account);
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.shortMessage ?? e?.message ?? 'Sponsored purchase failed.' });
    } finally { setBusy(null); }
  }

  // The signed ceiling covers the pool price and
  // sponsored gas. The Paymaster refunds every unused unit after settlement.
  const requiredVoid = price + MARKET_MAX_GAS_VOID;
  const hasVoid = voidBal >= requiredVoid;
  const connected = Boolean(account && chainOk);
  const sponsoredMarketReady = Boolean(marketDeployment());
  const canMint = !alreadyMinted;

  return (
    <>
      <header className={styles.header}>
        <div className={styles.bar}>
          <div className={styles.logo}>Void<span>Scan</span></div>
          <a className={styles.back} href="/">← explorer</a>
          <WalletProfileButton />
        </div>
      </header>

      <main className={styles.wrap}>
        <div className={styles.hero}>
          <div className={styles.testnet}>● Robinhood testnet · no real value</div>
          <h1>Mint a VOID Deed. Open a chain.</h1>
          <p>
            The deed binds an isolated execution space in the VOID runtime to your wallet.
            You set its transaction fee, collect what it earns, and anyone can publish an application
            without asking you. This testnet release settles on Robinhood Chain; it is not
            an independent L3 or RPC network yet.
          </p>
        </div>

        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt>For sale in the pool</dt>
            <dd>{marketStatus === 'ready' ? available.toString() : '—'}<small> / {DEPLOY.parameters.nfts}</small></dd>
          </div>
          <div className={styles.fact}>
            <dt>Deed price</dt>
            <dd>{marketStatus === 'ready' ? fmt(price, 18, 0) : '—'}<small> VOID</small></dd>
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
                Robinhood Chain testnet is registered automatically if you do not have it yet.
                Connecting only lets this page read your address. Minting a deed is
                relayed by the Paymaster. The mint is paid in VOID after one
                explicit, exact VOID approval in your wallet.
              </p>
              {connected && (
                <p className={ethBal === 0n ? styles.noEth : undefined}>
                  Test ETH: <b className={styles.mono}>{fmt(ethBal, 18, 5)} ETH</b>
                  {ethBal === 0n && ' — a small amount is needed for the one VOID approval.'}
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
                VOID pays the pool price and sponsored execution. The test faucet is
                free and unlimited, but its claim is still a normal testnet transaction.
              </p>
              <button className={styles.btn} onClick={getVoid} disabled={!connected || busy !== null}>
                {busy === 'faucet' ? 'Getting…' : `Get ${fmt(FAUCET_AMOUNT, 18, 0)} VOID`}
              </button>
            </div>
          </section>

          <section className={styles.step} data-blocked={!hasVoid}>
            <div className={styles.num}>3</div>
            <div className={styles.stepBody}>
              <h2>Mint a deed with VOID</h2>
              <p>
                Mint receives the next available VOID Deed. Approve one exact VOID limit to the
                Paymaster, then sign the mint. The signature shows the VOID token, deed price,
                collection market and gas limit. Your chain starts inactive; you choose its fee when you activate it.
                Unused VOID returns to your wallet.
              </p>
              <div className={styles.row}>
                <button className={styles.btn} onClick={buy} disabled={!sponsoredMarketReady || marketStatus !== 'ready' || !canMint || !hasVoid || busy !== null || available === 0n}>
                  {busy === 'approval' ? 'Approving VOID…' : busy === 'signing' ? 'Sign mint…' : busy === 'buy' ? 'Minting…' : 'Mint'}
                </button>
                <span className={styles.mono}>
                  {marketStatus === 'loading' ? 'loading market…' : marketStatus === 'unavailable' ? 'market temporarily unavailable — try again shortly' : !canMint ? 'mint limit reached for this wallet' : available === 0n ? 'sold out' : `${fmt(price, 18, 0)} VOID + refunded unused gas`}
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
            <h2>Your execution spaces</h2>
            <p>Each deed has its own runtime identifier, application registry and accounting.</p>
            <div className={styles.deeds}>
              {deeds.map((d) => (
                <article key={d.id} className={styles.deed}>
                  <p className={styles.deedId}>VOID #{d.id}</p>
                  <p className={styles.deedChain}>runtime {d.chainId}</p>
                  <div className={styles.deedRow}><span>State</span><b>{d.active ? 'active' : 'dormant'}</b></div>
                  <div className={styles.deedRow}><span>Transaction fee</span><b>{fmt(d.feeVoid, 18, 2)} VOID</b></div>
                  <div className={styles.deedRow}><span>Transactions</span><b>{d.calls.toString()}</b></div>
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
            The deployed test stack is real code: <code>VoidChainDeed</code>,{' '}
            <code>VoidChainAppRuntime</code>, <code>VoidChainTreasury</code> and{' '}
            <code>VoidPaymaster</code>. It has not been audited or approved for mainnet use.
          </p>
        </div>
      </main>
    </>
  );
}
