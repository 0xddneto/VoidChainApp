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
  const [tollVoid, setTollVoid] = useState(0n);
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

    // What the dollar toll comes to in VOID right now. Read from a chain that is
    // already active rather than computed here, so the number on screen is the
    // one the contract would charge.
    const sample = Object.keys(DEPLOY.demoApps)[0];
    if (sample) {
      const t = await rpc
        .readContract({
          address: P.VoidChainAppRuntime as Address, abi: ABI.runtime,
          functionName: 'feeOf', args: [BigInt(sample)],
        })
        .catch(() => 0n);
      setTollVoid(t as bigint);
    }

    if (!who) { setVoidBal(0n); setEthBal(0n); setDeeds([]); return; }

    // Only the open test faucet is a normal wallet transaction. Buying a deed
    // goes through the Paymaster and does not require test ETH.
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
    const market = marketDeployment();
    const p = eth();
    if (!market || !p) {
      setMsg({ kind: 'err', text: 'The sponsored market is not ready on this testnet yet.' });
      return;
    }

    setBusy('signing');
    try {
      const [currentPrice, toll, permitNonce, paymasterNonce] = await Promise.all([
        rpc.readContract({ address: T.VoidNftAmm as Address, abi: ABI.amm, functionName: 'priceToBuy', args: [false] }) as Promise<bigint>,
        rpc.readContract({ address: P.VoidChainAppRuntime as Address, abi: ABI.runtime, functionName: 'feeOf', args: [market.chainId] }) as Promise<bigint>,
        rpc.readContract({ address: T.VoidTestToken as Address, abi: ABI.token, functionName: 'nonces', args: [account] }) as Promise<bigint>,
        rpc.readContract({ address: P.VoidPaymaster as Address, abi: ABI.paymaster, functionName: 'nonces', args: [account] }) as Promise<bigint>,
      ]);
      if (currentPrice !== price) throw new Error('The pool price changed. Review the updated quote and try again.');

      const deadline = BigInt(Math.floor(Date.now() / 1000)) + MARKET_SIGNATURE_LIFETIME_SECONDS;
      const data = encodeFunctionData({ abi: ABI.marketApp, functionName: 'buyRandom', args: [currentPrice] });
      const request = {
        user: account, tokenId: market.chainId.toString(), target: market.app, data,
        maxToll: toll.toString(), maxGasVoid: MARKET_MAX_GAS_VOID.toString(),
        callGasLimit: MARKET_CALL_GAS_LIMIT.toString(),
        spends: [{ token: T.VoidTestToken, amount: currentPrice.toString() }],
        nftSpends: [], nonce: paymasterNonce.toString(), deadline: deadline.toString(),
      };
      const permitTypes = {
        Permit: [
          { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
        ],
      };
      const domainFields = [
        { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
      ];
      const permitDomain = { name: 'VOID', version: '1', chainId: RH_TESTNET.chainId, verifyingContract: T.VoidTestToken };
      const typedCall = {
        domain: { name: 'VoidPaymaster', version: '1', chainId: RH_TESTNET.chainId, verifyingContract: P.VoidPaymaster },
        primaryType: 'SponsoredCall',
        types: {
          EIP712Domain: domainFields,
          Spend: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
          SpendNft: [{ name: 'collection', type: 'address' }, { name: 'tokenId', type: 'uint256' }],
          SponsoredCall: [
            { name: 'user', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'target', type: 'address' },
            { name: 'data', type: 'bytes' }, { name: 'maxToll', type: 'uint256' }, { name: 'maxGasVoid', type: 'uint256' },
            { name: 'callGasLimit', type: 'uint256' }, { name: 'spends', type: 'Spend[]' }, { name: 'nftSpends', type: 'SpendNft[]' },
            { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
          ],
        },
        message: request,
      };
      const sign = (typedData: unknown) => p.request({
        method: 'eth_signTypedData_v4', params: [account, JSON.stringify(typedData)],
      }) as Promise<Hex>;

      setMsg({ kind: 'info', text: 'Sign two one-use VOID permissions, then the exact market purchase. No ETH transaction is requested.' });
      const paymasterPermit = await sign({
        domain: permitDomain, primaryType: 'Permit', types: { EIP712Domain: domainFields, ...permitTypes },
        message: { owner: account, spender: P.VoidPaymaster, value: (toll + MARKET_MAX_GAS_VOID).toString(), nonce: permitNonce.toString(), deadline: deadline.toString() },
      });
      const runtimePermit = await sign({
        domain: permitDomain, primaryType: 'Permit', types: { EIP712Domain: domainFields, ...permitTypes },
        message: { owner: account, spender: P.VoidChainAppRuntime, value: currentPrice.toString(), nonce: (permitNonce + 1n).toString(), deadline: deadline.toString() },
      });
      const signature = await sign(typedCall);

      const splitSignature = (value: Hex) => ({
        v: Number.parseInt(value.slice(130, 132), 16), r: value.slice(0, 66), s: `0x${value.slice(66, 130)}`,
      });
      setBusy('buy');
      setMsg({ kind: 'info', text: 'Submitting the signed purchase through the Paymaster…' });
      const result = await fetch('/api/market/sponsor', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          request, signature,
          permissions: [
            { spender: P.VoidPaymaster, value: (toll + MARKET_MAX_GAS_VOID).toString(), deadline: deadline.toString(), ...splitSignature(paymasterPermit) },
            { spender: P.VoidChainAppRuntime, value: currentPrice.toString(), deadline: deadline.toString(), ...splitSignature(runtimePermit) },
          ],
        }),
      });
      const body = await result.json() as { hash?: Hex; error?: string };
      if (!result.ok || !body.hash) throw new Error(body.error ?? 'The relayer refused the purchase.');
      const receipt = await rpc.waitForTransactionReceipt({ hash: body.hash });
      if (receipt.status !== 'success') throw new Error('The sponsored transaction reverted.');
      setMsg({ kind: 'ok', text: 'The deed is yours. VOID paid the pool price, the chain fee, and sponsored execution.' });
      await refresh(account);
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.shortMessage ?? e?.message ?? 'Sponsored purchase failed.' });
    } finally { setBusy(null); }
  }

  // The signed ceiling covers the pool price plus the maximum chain fee and
  // sponsored gas. The Paymaster refunds every unused unit after settlement.
  const requiredVoid = price + tollVoid + MARKET_MAX_GAS_VOID;
  const hasVoid = voidBal >= requiredVoid;
  const connected = Boolean(account && chainOk);

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
          <h1>Claim a deed. Open a space.</h1>
          <p>
            The deed binds an isolated execution space in the VOID runtime to your wallet.
            You set its toll, collect what it earns, and anyone can publish an application
            without asking you. This testnet release settles on Robinhood Chain; it is not
            an independent L3 or RPC network yet.
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
            <dt>Transaction fee</dt>
            <dd>
              $0.001
              {tollVoid > 0n && <small> ≈ {fmt(tollVoid, 18, 3)} VOID</small>}
            </dd>
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
                Connecting only lets this page read your address. Buying a deed is
                relayed by the Paymaster: you sign a bounded purchase and pay in VOID,
                without sending ETH from your wallet.
              </p>
              {connected && (
                <p className={ethBal === 0n ? styles.noEth : undefined}>
                  Test ETH: <b className={styles.mono}>{fmt(ethBal, 18, 5)} ETH</b>
                  {ethBal === 0n && ' — not needed for the sponsored purchase.'}
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
                VOID pays the pool price, the chain fee, and sponsored execution. The test faucet is
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
              <h2>Buy a deed with VOID</h2>
              <p>
                The pool hands over the next one in line — buying at random is cheaper
                than picking. You sign the exact price and two one-use permissions; the Paymaster
                sends the transaction and pays parent-chain ETH. From the next block, the execution
                space is bound to your wallet.
              </p>
              <div className={styles.row}>
                <button className={styles.btn} onClick={buy} disabled={!hasVoid || busy !== null || available === 0n}>
                  {busy === 'signing' ? 'Awaiting signatures…' : busy === 'buy' ? 'Buying…' : 'Buy with VOID'}
                </button>
                <span className={styles.mono}>
                  {available === 0n ? 'sold out' : `${fmt(price, 18, 0)} VOID + refunded unused gas`}
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
