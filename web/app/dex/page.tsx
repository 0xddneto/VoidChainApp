'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  createPublicClient, createWalletClient, custom, encodeFunctionData, formatUnits,
  http, parseAbi, parseUnits, type Address,
} from 'viem';
import dex from '@/lib/dex-chain1.json';
import { DEPLOY, RH_TESTNET } from '@/lib/testnet';
import styles from './page.module.css';

type Provider = { request(args: { method: string; params?: unknown[] }): Promise<unknown>; on?: (event: string, listener: (value: unknown) => void) => void; removeListener?: (event: string, listener: (value: unknown) => void) => void };
type Pool = (typeof dex.pools)[number];
type PoolState = { reserve0: bigint; reserve1: bigint; shares: bigint; token0Symbol: string; token1Symbol: string };

const rpc = createPublicClient({ transport: http(RH_TESTNET.rpcUrls[0]) });
const runtime = DEPLOY.production.VoidChainAppRuntime as Address;
const voidToken = dex.baseToken as Address;
const runtimeAbi = parseAbi([
  'function feeOf(uint256) view returns (uint256)',
  'function execute(uint256,address,bytes,uint256) returns (bytes)',
  'function executeWithBudget(uint256,address,bytes,uint256,(address[] tokens,uint256[] limits,address[] collections,uint256[] nftIds)) returns (bytes)',
]);
const tokenAbi = parseAbi([
  'function symbol() view returns (string)', 'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)',
  'function faucet() returns (uint256)', 'function mint(uint256)',
]);
const pairAbi = parseAbi([
  'function token0() view returns (address)', 'function token1() view returns (address)',
  'function reserve0() view returns (uint256)', 'function reserve1() view returns (uint256)',
  'function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)',
  'function quote(bool,uint256) view returns (uint256)',
  'function swap(bool,uint256,uint256) returns (uint256)',
  'function addLiquidity(uint256,uint256,uint256) returns (uint256)',
  'function removeLiquidity(uint256,uint256,uint256) returns (uint256,uint256)',
]);
const dexFaucetAbi = parseAbi(['function claim()']);

const provider = () => typeof window === 'undefined' ? undefined : (window as Window & { ethereum?: Provider }).ethereum;
const zero = 0n;
const maxUint256 = 2n ** 256n - 1n;

function accountFrom(value: unknown): Address | null {
  const first = Array.isArray(value) ? value[0] : null;
  return typeof first === 'string' && /^0x[\da-f]{40}$/i.test(first) ? first as Address : null;
}
function amount(value: string) { try { return value && Number(value) > 0 ? parseUnits(value, 18) : 0n; } catch { return 0n; } }
function show(value: bigint, places = 4) { return Number(formatUnits(value, 18)).toLocaleString('en-US', { maximumFractionDigits: places }); }
function quoteOut(reserveIn: bigint, reserveOut: bigint, value: bigint) {
  if (!reserveIn || !reserveOut || !value) return 0n;
  const afterFee = value * 9_970n / 10_000n;
  return afterFee * reserveOut / (reserveIn + afterFee);
}
function sqrt(value: bigint): bigint { if (!value) return 0n; let x = value; let y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + value / x) / 2n; } return x; }

export default function ChainOneDex() {
  const [account, setAccount] = useState<Address | null>(null);
  const [poolIndex, setPoolIndex] = useState(0);
  const [state, setState] = useState<PoolState | null>(null);
  const [fee, setFee] = useState(0n);
  const [balances, setBalances] = useState<Record<string, bigint>>({});
  const [ownedShares, setOwnedShares] = useState(0n);
  const [direction, setDirection] = useState(true);
  const [swapValue, setSwapValue] = useState('10');
  const [liquidity0, setLiquidity0] = useState('100');
  const [liquidity1, setLiquidity1] = useState('100');
  const [shareValue, setShareValue] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const pool = dex.pools[poolIndex] as Pool;
  const poolAddress = pool.address as Address;
  const token0 = pool.token0 as Address;
  const token1 = pool.token1 as Address;
  const input = direction ? token0 : token1;
  const inputReserve = direction ? state?.reserve0 ?? zero : state?.reserve1 ?? zero;
  const outputReserve = direction ? state?.reserve1 ?? zero : state?.reserve0 ?? zero;
  const estimate = quoteOut(inputReserve, outputReserve, amount(swapValue));

  const load = useCallback(async () => {
    const [nextFee, reserve0, reserve1, shares, symbol0, symbol1] = await Promise.all([
      rpc.readContract({ address: runtime, abi: runtimeAbi, functionName: 'feeOf', args: [BigInt(dex.chainTokenId)] }) as Promise<bigint>,
      rpc.readContract({ address: poolAddress, abi: pairAbi, functionName: 'reserve0' }) as Promise<bigint>,
      rpc.readContract({ address: poolAddress, abi: pairAbi, functionName: 'reserve1' }) as Promise<bigint>,
      rpc.readContract({ address: poolAddress, abi: pairAbi, functionName: 'totalSupply' }) as Promise<bigint>,
      rpc.readContract({ address: token0, abi: tokenAbi, functionName: 'symbol' }) as Promise<string>,
      rpc.readContract({ address: token1, abi: tokenAbi, functionName: 'symbol' }) as Promise<string>,
    ]);
    setFee(nextFee); setState({ reserve0, reserve1, shares, token0Symbol: symbol0, token1Symbol: symbol1 });
    if (account) {
      const tracked = [...new Set([voidToken, token0, token1])];
      const values = await Promise.all(tracked.map((token) => rpc.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [account] }) as Promise<bigint>));
      setBalances(Object.fromEntries(tracked.map((token, i) => [token.toLowerCase(), values[i]])));
      setOwnedShares(await rpc.readContract({ address: poolAddress, abi: pairAbi, functionName: 'balanceOf', args: [account] }) as bigint);
    } else {
      setBalances({}); setOwnedShares(0n);
    }
  }, [account, poolAddress, token0, token1]);

  useEffect(() => { void load().catch((error) => setNotice(error.message)); }, [load]);
  useEffect(() => {
    const wallet = provider(); if (!wallet) return;
    const update = (items: unknown) => setAccount(accountFrom(items));
    void wallet.request({ method: 'eth_accounts' }).then(update).catch(() => undefined);
    wallet.on?.('accountsChanged', update); return () => wallet.removeListener?.('accountsChanged', update);
  }, []);

  async function connect() {
    const wallet = provider(); if (!wallet) return setNotice('Install or open an EVM wallet first.');
    try { setAccount(accountFrom(await wallet.request({ method: 'eth_requestAccounts' }))); }
    catch { setNotice('Wallet connection was cancelled.'); }
  }
  async function correctNetwork(wallet: Provider) {
    const current = await wallet.request({ method: 'eth_chainId' });
    if (current === RH_TESTNET.chainIdHex) return;
    try { await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: RH_TESTNET.chainIdHex }] }); }
    catch { await wallet.request({ method: 'wallet_addEthereumChain', params: [RH_TESTNET] }); }
  }
  async function write(label: string, to: Address, abi: typeof runtimeAbi | typeof tokenAbi | typeof pairAbi, functionName: string, args: unknown[]) {
    const wallet = provider(); if (!wallet || !account) throw new Error('Connect your wallet.');
    await correctNetwork(wallet); setBusy(label);
    try {
      const client = createWalletClient({ account, transport: custom(wallet) });
      const hash = await client.writeContract({ account, chain: null, address: to, abi, functionName, args } as never);
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('Transaction reverted.');
      return hash;
    } finally { setBusy(null); }
  }
  async function approveExact(token: Address, value: bigint) {
    const available = await rpc.readContract({ address: token, abi: tokenAbi, functionName: 'allowance', args: [account!, runtime] }) as bigint;
    if (available >= value) return;
    await write('approve', token, tokenAbi, 'approve', [runtime, value]);
  }
  async function getTestVoid() {
    if (!account) return void connect();
    try {
      await write('faucet', voidToken, tokenAbi, 'faucet', []);
      setNotice('Test VOID received. This external faucet is not a DEX transaction.'); await load();
    } catch (error: any) { setNotice(error?.shortMessage ?? error?.message ?? 'Could not receive test VOID.'); }
  }
  async function claimDexAssets() {
    if (!account) return void connect();
    try {
      await approveExact(voidToken, fee);
      const data = encodeFunctionData({ abi: dexFaucetAbi, functionName: 'claim' });
      await write('claim-assets', runtime, runtimeAbi, 'executeWithBudget', [BigInt(dex.chainTokenId), dex.faucet as Address, data, fee, { tokens: [], limits: [], collections: [], nftIds: [] }]);
      setNotice(`tUSD and tLINK claimed through VOID Chain #${dex.chainTokenId}. ${show(fee)} VOID was charged.`); await load();
    } catch (error: any) { setNotice(error?.shortMessage ?? error?.message ?? 'Could not claim DEX test assets.'); }
  }
  async function swap() {
    const inputAmount = amount(swapValue); if (!inputAmount || !estimate) return setNotice('Enter an amount that produces an output.');
    try {
      setNotice('Checking the exact runtime permissions…');
      const voidNeeded = input === voidToken ? inputAmount + fee : fee;
      await approveExact(voidToken, voidNeeded);
      if (input !== voidToken) await approveExact(input, inputAmount);
      const minOut = estimate * 9_950n / 10_000n;
      const data = encodeFunctionData({ abi: pairAbi, functionName: 'swap', args: [direction, inputAmount, minOut] });
      await write('swap', runtime, runtimeAbi, 'executeWithBudget', [BigInt(dex.chainTokenId), poolAddress, data, fee, { tokens: [input], limits: [inputAmount], collections: [], nftIds: [] }]);
      setNotice(`Swap confirmed. Minimum received was ${show(minOut)}.`); await load();
    } catch (error: any) { setNotice(error?.shortMessage ?? error?.message ?? 'Swap failed.'); }
  }
  async function addLiquidity() {
    const value0 = amount(liquidity0), value1 = amount(liquidity1); if (!value0 || !value1 || !state) return setNotice('Enter both liquidity amounts.');
    const minted = state.shares === 0n ? sqrt(value0 * value1) - 1_000n : [value0 * state.shares / state.reserve0, value1 * state.shares / state.reserve1].sort((a, b) => a < b ? -1 : 1)[0];
    if (minted <= 0n) return setNotice('Liquidity amount is too small.');
    try {
      await approveExact(voidToken, (token0 === voidToken ? value0 : token1 === voidToken ? value1 : 0n) + fee);
      if (token0 !== voidToken) await approveExact(token0, value0);
      if (token1 !== voidToken) await approveExact(token1, value1);
      const data = encodeFunctionData({ abi: pairAbi, functionName: 'addLiquidity', args: [value0, value1, minted * 9_950n / 10_000n] });
      await write('liquidity', runtime, runtimeAbi, 'executeWithBudget', [BigInt(dex.chainTokenId), poolAddress, data, fee, { tokens: [token0, token1], limits: [value0, value1], collections: [], nftIds: [] }]);
      setNotice('Liquidity added and LP shares issued.'); await load();
    } catch (error: any) { setNotice(error?.shortMessage ?? error?.message ?? 'Could not add liquidity.'); }
  }
  async function removeLiquidity() {
    const shares = amount(shareValue); if (!shares) return setNotice('Enter the LP-share amount to remove.');
    try {
      await approveExact(voidToken, fee);
      if (!state || shares > ownedShares) return setNotice('Enter LP shares you own.');
      const min0 = (shares * state.reserve0 / state.shares) * 9_950n / 10_000n;
      const min1 = (shares * state.reserve1 / state.shares) * 9_950n / 10_000n;
      const data = encodeFunctionData({ abi: pairAbi, functionName: 'removeLiquidity', args: [shares, min0, min1] });
      await write('remove', runtime, runtimeAbi, 'execute', [BigInt(dex.chainTokenId), poolAddress, data, fee]);
      setNotice('Liquidity removed.'); await load();
    } catch (error: any) { setNotice(error?.shortMessage ?? error?.message ?? 'Could not remove liquidity.'); }
  }

  const connected = account ? `${account.slice(0, 6)}…${account.slice(-4)}` : 'Connect wallet';
  const inputSymbol = direction ? state?.token0Symbol ?? 'token0' : state?.token1Symbol ?? 'token1';
  const outputSymbol = direction ? state?.token1Symbol ?? 'token1' : state?.token0Symbol ?? 'token0';

  return <main className={styles.page}>
    <header className={styles.header}><a href="/" className={styles.logo}>VOID<span>DEX</span></a><div className={styles.headerRight}><span>VOID CHAIN #1 · TESTNET</span><button onClick={connect} className={styles.wallet}>{connected}</button></div></header>
    <section className={styles.hero}><div><p className={styles.kicker}>AMM · 0.30% pool fee</p><h1>Trade inside<br />VOID Chain <em>#1</em></h1><p>The swap, pool shares and chain fee are separate: the AMM fee remains with LPs, while every DEX action pays the chain&apos;s fixed VOID transaction fee.</p></div><aside className={styles.chain}><span>CHAIN TRANSACTION FEE</span><strong>{show(fee)} VOID</strong><small>98% to the Deed holder · 2% protocol</small></aside></section>
    <section className={styles.layout}>
      <div className={styles.primary}>
        <nav className={styles.pools}>{dex.pools.map((item, index) => <button key={item.address} onClick={() => { setPoolIndex(index); setDirection(true); setNotice(null); }} className={index === poolIndex ? styles.poolActive : ''}>{item.label}</button>)}</nav>
        <section className={styles.card}>
          <div className={styles.cardHead}><h2>Swap</h2><span>0.50% max slippage</span></div>
          <label className={styles.amount}><span>You pay · {inputSymbol}</span><input inputMode="decimal" value={swapValue} onChange={(e) => setSwapValue(e.target.value)} /><small>Balance {show(balances[input.toLowerCase()] ?? zero)} {inputSymbol}</small></label>
          <button className={styles.flip} onClick={() => setDirection(!direction)} aria-label="Reverse swap direction">↓↑</button>
          <div className={styles.receive}><span>You receive · {outputSymbol}</span><b>{show(estimate)} {outputSymbol}</b><small>Minimum {show(estimate * 9_950n / 10_000n)} {outputSymbol}</small></div>
          <button className={styles.action} disabled={busy !== null} onClick={swap}>{busy === 'swap' ? 'Swapping…' : 'Swap'}</button>
        </section>
        <section className={styles.card}>
          <div className={styles.cardHead}><h2>Pool</h2><span>LPs earn 0.30% of swap volume</span></div>
          <div className={styles.two}><label><span>{state?.token0Symbol}</span><input inputMode="decimal" value={liquidity0} onChange={(e) => setLiquidity0(e.target.value)} /></label><label><span>{state?.token1Symbol}</span><input inputMode="decimal" value={liquidity1} onChange={(e) => setLiquidity1(e.target.value)} /></label></div>
          <button className={styles.action} disabled={busy !== null} onClick={addLiquidity}>{busy === 'liquidity' ? 'Adding…' : 'Add liquidity'}</button>
          <div className={styles.remove}><input inputMode="decimal" placeholder="LP shares to remove" value={shareValue} onChange={(e) => setShareValue(e.target.value)} /><button disabled={busy !== null} onClick={removeLiquidity}>Remove</button></div>
        </section>
      </div>
      <aside className={styles.side}>
        <section className={styles.card}><div className={styles.cardHead}><h2>Pool state</h2><span>live</span></div><dl><div><dt>{state?.token0Symbol} reserve</dt><dd>{show(state?.reserve0 ?? zero)}</dd></div><div><dt>{state?.token1Symbol} reserve</dt><dd>{show(state?.reserve1 ?? zero)}</dd></div><div><dt>Total LP shares</dt><dd>{show(state?.shares ?? zero)}</dd></div><div><dt>Your LP shares</dt><dd>{show(ownedShares)}</dd></div></dl></section>
        <section className={styles.notice}><b>Test assets only</b><p>tUSD and tLINK are local test assets, not Robinhood-issued assets. First get test VOID from the external faucet. Then claim tUSD and tLINK through this DEX: that is one paid chain transaction and charges VOID.</p><div><a href="https://faucet.testnet.chain.robinhood.com" target="_blank" rel="noreferrer">Robinhood faucet ↗</a><a href="https://faucets.chain.link/robinhood-testnet" target="_blank" rel="noreferrer">Chainlink faucet ↗</a></div><button onClick={getTestVoid} disabled={busy !== null}>{busy === 'faucet' ? 'Requesting…' : 'Get test VOID — external faucet'}</button><button onClick={claimDexAssets} disabled={busy !== null}>{busy === 'claim-assets' ? 'Claiming…' : `Claim tUSD + tLINK — ${show(fee)} VOID`}</button></section>
      </aside>
    </section>
    {notice && <p className={styles.status} role="status">{notice}</p>}
    <footer className={styles.footer}><span>Factory {dex.factory}</span><span>Runtime {runtime}</span><a href="/">Back to VoidScan →</a></footer>
  </main>;
}
