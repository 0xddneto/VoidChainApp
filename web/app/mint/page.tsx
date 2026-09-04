'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  createPublicClient, createWalletClient, custom, encodeFunctionData, formatEther,
  http, parseEther, type Address, type Hex,
} from 'viem';
import { RH_TESTNET } from '@/lib/testnet';
import GENESIS from '@/lib/genesis-v6.json';
import { WalletProfileButton } from '../WalletProfileButton';
import styles from './page.module.css';

const rpc = createPublicClient({ transport: http(GENESIS.network.rpc) });
const C = GENESIS.contracts as Record<string, Address>;
const P = GENESIS.parameters;
const mintAbi = [
  { type: 'function', name: 'mint', stateMutability: 'payable', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'mintPriceWei', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalMinted', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'hasMinted', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
] as const;
const poolAbi = [
  { type: 'function', name: 'reserveVoid', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint112' }] },
  { type: 'function', name: 'reserveEth', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint112' }] },
  { type: 'function', name: 'swapEthForVoid', stateMutability: 'payable', inputs: [{ name: 'minVoidOut', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
] as const;
const oracleAbi = [{ type: 'function', name: 'voidPerEth', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }] as const;
const tokenAbi = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
type Message = { kind: 'ok' | 'err' | 'info'; text: string } | null;
const ethText = (value: bigint, places = 5) => Number(formatEther(value)).toLocaleString('en-US', { maximumFractionDigits: places });
const voidText = (value: bigint, places = 0) => Number(formatEther(value)).toLocaleString('en-US', { maximumFractionDigits: places });

export default function MintPage() {
  const [account, setAccount] = useState<Address | null>(null);
  const [chainOk, setChainOk] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [minted, setMinted] = useState<bigint | null>(null);
  const [hasMinted, setHasMinted] = useState(false);
  const [mintPrice, setMintPrice] = useState(BigInt(P.mintPriceWei));
  const [ethBalance, setEthBalance] = useState(0n);
  const [voidBalance, setVoidBalance] = useState(0n);
  const [reserveVoid, setReserveVoid] = useState(0n);
  const [reserveEth, setReserveEth] = useState(0n);
  const [twapRate, setTwapRate] = useState(0n);
  const [onboardingEth, setOnboardingEth] = useState('0.0001');
  let onboardingWei = 0n;
  try { onboardingWei = parseEther(onboardingEth); } catch { /* Invalid input disables the swap. */ }
  const effectiveOnboarding = onboardingWei * BigInt(10_000 - P.poolFeeBps) / 10_000n;
  const onboardingQuote = effectiveOnboarding > 0n && reserveEth > 0n ? effectiveOnboarding * reserveVoid / (reserveEth + effectiveOnboarding) : 0n;

  const refresh = useCallback(async (wallet: Address | null) => {
    const [supply, price, voidReserve, ethReserve] = await Promise.all([
      rpc.readContract({ address: C.mint, abi: mintAbi, functionName: 'totalMinted' }),
      rpc.readContract({ address: C.mint, abi: mintAbi, functionName: 'mintPriceWei' }),
      rpc.readContract({ address: C.pool, abi: poolAbi, functionName: 'reserveVoid' }),
      rpc.readContract({ address: C.pool, abi: poolAbi, functionName: 'reserveEth' }),
    ]);
    setMinted(supply); setMintPrice(price); setReserveVoid(voidReserve); setReserveEth(ethReserve);
    try {
      const rate = await rpc.readContract({ address: C.oracle, abi: oracleAbi, functionName: 'voidPerEth' });
      setTwapRate(rate);
    } catch {
      // A stale price pauses sponsorship, but it must never hide mint supply,
      // wallet balances, or the locked pool from the user.
      setTwapRate(0n);
    }
    if (!wallet) { setHasMinted(false); setEthBalance(0n); setVoidBalance(0n); return; }
    const [already, eth, token] = await Promise.all([
      rpc.readContract({ address: C.mint, abi: mintAbi, functionName: 'hasMinted', args: [wallet] }),
      rpc.getBalance({ address: wallet }),
      rpc.readContract({ address: C.token, abi: tokenAbi, functionName: 'balanceOf', args: [wallet] }),
    ]);
    setHasMinted(already); setEthBalance(eth); setVoidBalance(token);
  }, []);
  useEffect(() => { void refresh(account).catch(() => setMessage({ kind: 'err', text: 'Could not read the testnet. Try again shortly.' })); }, [account, refresh]);

  const provider = () => typeof window === 'undefined' ? undefined : (window as any).ethereum;
  useEffect(() => {
    const eth = provider(); if (!eth) return;
    const accountsChanged = (accounts: Address[]) => setAccount(accounts[0] ?? null);
    const chainChanged = (chain: string) => setChainOk(chain.toLowerCase() === RH_TESTNET.chainIdHex);
    void eth.request({ method: 'eth_accounts' }).then(accountsChanged).catch(() => undefined);
    void eth.request({ method: 'eth_chainId' }).then(chainChanged).catch(() => undefined);
    eth.on?.('accountsChanged', accountsChanged); eth.on?.('chainChanged', chainChanged);
    return () => { eth.removeListener?.('accountsChanged', accountsChanged); eth.removeListener?.('chainChanged', chainChanged); };
  }, []);
  async function connect() {
    const eth = provider();
    if (!eth) { setMessage({ kind: 'err', text: 'No wallet found. Install a compatible wallet and reload.' }); return; }
    setBusy('connect');
    try {
      const [address] = await eth.request({ method: 'eth_requestAccounts' }) as Address[];
      const current = await eth.request({ method: 'eth_chainId' }) as Hex;
      if (current.toLowerCase() !== RH_TESTNET.chainIdHex.toLowerCase()) {
        try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: RH_TESTNET.chainIdHex }] }); }
        catch { await eth.request({ method: 'wallet_addEthereumChain', params: [RH_TESTNET] }); }
      }
      setAccount(address); setChainOk(true); setMessage(null);
    } catch (error: any) { setMessage({ kind: 'err', text: error?.shortMessage ?? error?.message ?? 'Wallet connection was refused.' }); }
    finally { setBusy(null); }
  }
  async function send(label: string, to: Address, data: Hex, value: bigint, success: string) {
    const eth = provider(); if (!eth || !account) return;
    setBusy(label); setMessage({ kind: 'info', text: 'Confirm the exact ETH amount in your wallet…' });
    try {
      const current = await eth.request({ method: 'eth_chainId' });
      if (current.toLowerCase() !== RH_TESTNET.chainIdHex) throw new Error('Switch your wallet to Robinhood Chain Testnet.');
      const wallet = createWalletClient({ account, transport: custom(eth) });
      const hash = await wallet.sendTransaction({ account, chain: null, to, data, value });
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('The transaction reverted.');
      setMessage({ kind: 'ok', text: success }); await refresh(account);
    } catch (error: any) { setMessage({ kind: 'err', text: error?.shortMessage ?? error?.message ?? 'Transaction failed.' }); }
    finally { setBusy(null); }
  }
  const mint = () => send('mint', C.mint, encodeFunctionData({ abi: mintAbi, functionName: 'mint' }), mintPrice,
    'Mint confirmed. Your Deed is yours; its chain begins inactive until you choose its initial fee.');
  const buyVoid = () => {
    const ethIn = onboardingWei;
    if (ethIn <= 0n || reserveVoid === 0n || reserveEth === 0n) return;
    const effective = ethIn * BigInt(10_000 - P.poolFeeBps) / 10_000n;
    const expected = effective * reserveVoid / (reserveEth + effective);
    const minOut = expected * 98n / 100n;
    return send('void', C.pool, encodeFunctionData({ abi: poolAbi, functionName: 'swapEthForVoid', args: [minOut] }), ethIn,
      'VOID acquired from the locked genesis pool. Future app actions use signed VOID through the Paymaster.');
  };
  const connected = Boolean(account && chainOk); const twapReady = twapRate > 0n;
  const soldOut = minted !== null && minted >= BigInt(P.maxSupply); const canMint = minted !== null && connected && !hasMinted && !soldOut && ethBalance >= mintPrice && busy === null;

  return <>
    <header className={styles.header}><div className={styles.bar}><div className={styles.logo}>Void<span>Scan</span></div><a className={styles.back} href="/">← explorer</a><a className={styles.docsLink} href="/docs">Docs</a><WalletProfileButton /></div></header>
    <main className={styles.wrap}>
      <div className={styles.hero}><div className={styles.testnet}>● Robinhood testnet · V7 genesis</div><h1>Mint a VOID Deed with ETH.</h1><p>Mint one Deed with ETH. Each mint locks VOID/ETH liquidity and funds the Paymaster. Apps and NFT trades use VOID.</p><a href="/market">Trade NFTs ↔ VOID →</a></div>
      <dl className={styles.facts}>
        <div className={styles.fact}><dt>Minted</dt><dd>{minted?.toString() ?? '—'}<small> / {P.maxSupply}</small></dd></div>
        <div className={styles.fact}><dt>Mint price</dt><dd>{ethText(mintPrice, 4)}<small> ETH</small></dd></div>
        <div className={styles.fact}><dt>Locked pool</dt><dd>{voidText(reserveVoid)}<small> VOID</small></dd></div>
        <div className={styles.fact}><dt>TWAP</dt><dd>{twapReady ? 'ready' : 'unavailable'}<small>{twapReady ? ' · price available' : ' · sponsorship paused'}</small></dd></div>
      </dl>
      <div className={styles.steps}>
        <section className={styles.step} data-done={connected}><div className={styles.num}>{connected ? '✓' : '1'}</div><div className={styles.stepBody}><h2>Connect wallet</h2><p>Use Robinhood Chain testnet. Connecting never spends anything.</p><button className={styles.btn} onClick={connect} disabled={busy !== null || connected}>{connected ? `${account!.slice(0, 6)}…${account!.slice(-4)}` : 'Connect wallet'}</button></div></section>
        <section className={styles.step} data-done={hasMinted} data-blocked={!connected}><div className={styles.num}>{hasMinted ? '✓' : '2'}</div><div className={styles.stepBody}><h2>Mint</h2><p>Your wallet will show exactly <b>{ethText(mintPrice, 4)} ETH</b> sent to the genesis mint contract. There is no VOID approval and no hidden relayer fee. One Deed per wallet.</p>{connected && <p className={ethBalance < mintPrice ? styles.noEth : undefined}>Wallet balance: <b className={styles.mono}>{ethText(ethBalance, 5)} ETH</b>{ethBalance < mintPrice && ' — insufficient for the mint.'}</p>}<div className={styles.row}><button className={styles.btn} onClick={mint} disabled={!canMint}>{busy === 'mint' ? 'Minting…' : hasMinted ? 'Mint complete' : soldOut ? 'Sold out' : 'Mint'}</button><span className={styles.mono}>40% locked LP · 20% Paymaster · 40% protocol</span></div></div></section>
        <section id="get-void" className={styles.step} data-done={voidBalance > 0n} data-blocked={!twapReady}><div className={styles.num}>{voidBalance > 0n ? '✓' : '3'}</div><div className={styles.stepBody}><h2>Get VOID for apps</h2><p>Optional onboarding swap from the locked VOID/ETH pool. This intentionally uses ETH because it acquires the token that pays later sponsored app transactions. Pool fee: {P.poolFeeBps / 100}%.</p>{connected && <p>Your VOID: <b className={styles.mono}>{voidText(voidBalance)} VOID</b></p>}<label className={styles.swapAmount}>ETH amount<input value={onboardingEth} onChange={(event) => setOnboardingEth(event.target.value)} inputMode="decimal" aria-label="ETH to swap for VOID" /></label><p>Estimated output: <b>{voidText(onboardingQuote, 2)} VOID</b> · 2% max slippage. Large swaps have price impact.</p><button className={`${styles.btn} ${styles.btnGhost}`} onClick={buyVoid} disabled={!connected || !twapReady || busy !== null || onboardingWei <= 0n || ethBalance <= onboardingWei || reserveVoid === 0n}>Buy VOID</button></div></section>
      </div>
      {message && <div className={`${styles.msg} ${message.kind === 'ok' ? styles.msgOk : message.kind === 'err' ? styles.msgErr : styles.msgInfo}`}>{message.text}</div>}
      <div className={styles.note}><p><strong>Testnet only.</strong> V7 starts a new VOID economy with a fixed supply of 1,000,000,000 VOID. The five existing Deeds were reissued to their recorded owners or the replacement pool. Old VOID is not used by this deployment.</p><p>The NFT/VOID pool runs inside Chain #1. Buy random: 1%. Buy selected: 2%. Sell: 1.5%. Each fee includes a 0.5% protocol share. NFTs can be bought and sold repeatedly; their 500,000 VOID backing is released only once.</p></div>
    </main>
  </>;
}
