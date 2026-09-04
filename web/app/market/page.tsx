'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  createPublicClient, createWalletClient, custom, encodeFunctionData, formatEther,
  getAddress, parseAbi, type Address, type Hex,
} from 'viem';
import { DEPLOY, RH_TESTNET, rhTransport } from '@/lib/testnet';
import { requireSponsoredSuccess } from '@/lib/sponsored-receipt';
import { WalletProfileButton } from '../WalletProfileButton';
import styles from './page.module.css';

const MARKET = getAddress(DEPLOY.testnet.VoidGenesisNftAmmV6);
const VOID = getAddress(DEPLOY.testnet.VoidTestToken);
const DEED = getAddress(DEPLOY.production.VoidChainDeed);
const RUNTIME = getAddress(DEPLOY.production.VoidChainAppRuntime);
const PAYMASTER = getAddress(DEPLOY.production.VoidPaymaster);
const MAX_GAS_VOID = 10_000n * 10n ** 18n;
const CALL_GAS_LIMIT = 1_500_000n;
const rpc = createPublicClient({ transport: rhTransport() });
const marketAbi = parseAbi(['function buyRandom(uint256) returns(uint256)', 'function buySpecific(uint256,uint256)', 'function sellWithPermit(uint256,uint256,bytes)']);
const nonceAbi = parseAbi(['function nonces(address) view returns(uint256)', 'function nonces(uint256) view returns(uint256)']);
const deedPermitTypes = { Permit: [
  { name: 'spender', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
] } as const;
const sponsoredTypes = {
  Spend: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
  SpendNft: [{ name: 'collection', type: 'address' }, { name: 'tokenId', type: 'uint256' }],
  SponsoredCall: [
    { name: 'user', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'target', type: 'address' }, { name: 'data', type: 'bytes' },
    { name: 'maxToll', type: 'uint256' }, { name: 'maxGasVoid', type: 'uint256' }, { name: 'callGasLimit', type: 'uint256' },
    { name: 'spends', type: 'Spend[]' }, { name: 'nftSpends', type: 'SpendNft[]' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
} as const;
type MarketState = { inventory: string[]; randomQuote: string; specificQuote: string; sellQuote: string; transactionFee: string | null; minted: string; balance: string; owned: string[]; sellable: string[] };
type Permit = { token: Address; spender: Address; value: bigint; deadline: bigint; v: number; r: Hex; s: Hex };
const split = (signature: Hex) => ({ v: Number.parseInt(signature.slice(130, 132), 16), r: signature.slice(0, 66) as Hex, s: `0x${signature.slice(66, 130)}` as Hex });
const showVoid = (value: string | bigint) => Number(formatEther(BigInt(value))).toLocaleString('en-US', { maximumFractionDigits: 2 });

export default function MarketPage() {
  const [account, setAccount] = useState<Address | null>(null);
  const [state, setState] = useState<MarketState | null>(null);
  const [specificId, setSpecificId] = useState('');
  const [sellId, setSellId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const provider = () => typeof window === 'undefined' ? undefined : (window as any).ethereum;

  const refresh = useCallback(async (wallet: Address | null) => {
    const response = await fetch(`/api/market/state${wallet ? `?account=${wallet}` : ''}`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? 'Could not load market.');
    setState(body);
  }, []);
  useEffect(() => { void refresh(account).catch((error) => setMessage(error.message)); }, [account, refresh]);
  useEffect(() => {
    const eth = provider();
    if (!eth) return;
    const update = (accounts: Address[]) => setAccount(accounts[0] ? getAddress(accounts[0]) : null);
    void eth.request({ method: 'eth_accounts' }).then(update).catch(() => undefined);
    eth.on?.('accountsChanged', update);
    return () => eth.removeListener?.('accountsChanged', update);
  }, []);

  async function connect() {
    const eth = provider();
    if (!eth) return setMessage('No compatible wallet found.');
    const [wallet] = await eth.request({ method: 'eth_requestAccounts' }) as Address[];
    const network = await eth.request({ method: 'eth_chainId' }) as string;
    if (network.toLowerCase() !== RH_TESTNET.chainIdHex) {
      try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: RH_TESTNET.chainIdHex }] }); }
      catch { await eth.request({ method: 'wallet_addEthereumChain', params: [RH_TESTNET] }); }
    }
    setAccount(getAddress(wallet)); setMessage(null);
  }

  async function submit(kind: 'random' | 'specific' | 'sell') {
    if (!account || !state || state.transactionFee === null) return;
    const eth = provider(); if (!eth) return;
    setBusy(true); setMessage('Review the VOID amounts and sign in your wallet. No ETH will be charged to you.');
    try {
      const price = kind === 'sell' ? 0n : BigInt(kind === 'random' ? state.randomQuote : state.specificQuote);
      const required = price + BigInt(state.transactionFee) + MAX_GAS_VOID;
      if (BigInt(state.balance) < required) throw new Error(`You need at least ${showVoid(required)} VOID for this trade, including the refundable gas budget. Get VOID before signing.`);
      const network = await eth.request({ method: 'eth_chainId' });
      if (network.toLowerCase() !== RH_TESTNET.chainIdHex) throw new Error('Switch your wallet to Robinhood Chain Testnet.');
      const client = createWalletClient({ account, transport: custom(eth) });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const requestNonce = await rpc.readContract({ address: PAYMASTER, abi: nonceAbi, functionName: 'nonces', args: [account] });
      const fee = BigInt(state.transactionFee);
      let data: Hex;
      let spends: Array<{ token: Address; amount: bigint }> = [];
      let nftSpends: Array<{ collection: Address; tokenId: bigint }> = [];
      const permits: Permit[] = [];
      if (kind === 'sell') {
        const deedId = BigInt(sellId);
        if (!state.sellable.includes(deedId.toString())) throw new Error('Select a Deed owned by your connected wallet.');
        const deedNonce = await rpc.readContract({ address: DEED, abi: nonceAbi, functionName: 'nonces', args: [deedId] });
        const deedSignature = await client.signTypedData({ account, domain: { name: 'VOIDS Chain Deed', version: '1', chainId: RH_TESTNET.chainId, verifyingContract: DEED }, types: deedPermitTypes, primaryType: 'Permit', message: { spender: RUNTIME, tokenId: deedId, nonce: deedNonce, deadline } });
        data = encodeFunctionData({ abi: marketAbi, functionName: 'sellWithPermit', args: [deedId, deadline, deedSignature] });
        nftSpends = [{ collection: DEED, tokenId: deedId }];
      } else {
        const quote = BigInt(kind === 'random' ? state.randomQuote : state.specificQuote);
        if (BigInt(state.balance) < quote + fee + MAX_GAS_VOID) throw new Error('Insufficient VOID for the NFT price and transaction budget.');
        data = kind === 'random'
          ? encodeFunctionData({ abi: marketAbi, functionName: 'buyRandom', args: [quote] })
          : encodeFunctionData({ abi: marketAbi, functionName: 'buySpecific', args: [BigInt(specificId), quote] });
        spends = [{ token: VOID, amount: quote }];
      }
      const sponsored = { user: account, tokenId: 1n, target: MARKET, data, maxToll: fee, maxGasVoid: MAX_GAS_VOID, callGasLimit: CALL_GAS_LIMIT, spends, nftSpends, nonce: requestNonce, deadline };
      setMessage('Sign this exact market action. Deed, price, chain, fee cap, gas cap and expiry are bound to it.');
      const signature = await client.signTypedData({ account, domain: { name: 'VoidPaymaster', version: '1', chainId: RH_TESTNET.chainId, verifyingContract: PAYMASTER }, types: sponsoredTypes, primaryType: 'SponsoredCall', message: sponsored });
      const serialise = (_key: string, value: unknown) => typeof value === 'bigint' ? value.toString() : value;
      const response = await fetch('/api/market/sponsor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: sponsored, signature, permits }, serialise) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Relay rejected the action.');
      const receipt = await rpc.waitForTransactionReceipt({ hash: body.hash });
      requireSponsoredSuccess(receipt, PAYMASTER, account, 1n);
      setMessage(`Confirmed: ${body.hash}`); await refresh(account);
    } catch (error: any) {
      setMessage(error?.shortMessage ?? error?.message ?? 'Market action failed.');
    } finally { setBusy(false); }
  }

  return <>
    <header className={styles.header}><div className={styles.bar}><div className={styles.logo}>VOID<span>MARKET</span></div><a href="/">← VoidScan</a><a className={styles.docsLink} href="/docs">Docs</a><WalletProfileButton /></div></header>
    <main className={styles.wrap}>
      <section className={styles.hero}><p>CHAIN 1 · NFT / VOID AMM</p><h1>Trade Deeds directly in VOID.</h1><span>Every trade enters through the Chain 1 Runtime. Your wallet signs exact VOID and NFT budgets; the Paymaster submits the transaction and pays parent-chain gas.</span><p><a href="/mint#get-void">Get VOID →</a></p></section>
      <div className={styles.stats}>
        <div><small>Minted</small><strong>{state?.minted ?? '—'} / 1,111</strong></div>
        <div><small>Pool inventory</small><strong>{state?.inventory.length ?? '—'} Deeds</strong></div>
        <div><small>Your balance</small><strong>{state ? showVoid(state.balance) : '—'} VOID</strong></div>
        <div><small>Chain transaction fee</small><strong>{state?.transactionFee != null ? `${showVoid(state.transactionFee)} VOID` : 'Unavailable'}</strong></div>
      </div>
      {state?.transactionFee === null && <p className={styles.message}>Trading is paused while the fee oracle is unavailable. Inventory and mint supply remain visible.</p>}
      {!account && <button className={styles.primary} onClick={connect}>Connect wallet</button>}
      <div className={styles.grid}>
        <section className={styles.card}><div className={styles.tag}>BUY</div><h2>Random Deed</h2><p>Buy any Deed held by the pool at the lowest published fee.</p><strong>{state ? showVoid(state.randomQuote) : '—'} VOID</strong><button className={styles.primary} disabled={!account || busy || state?.transactionFee == null || !state?.inventory.length} onClick={() => void submit('random')}>Buy random</button></section>
        <section className={styles.card}><div className={styles.tag}>BUY</div><h2>Choose a Deed</h2><p>Current inventory: {state?.inventory.length ? state.inventory.map((id) => `#${id}`).join(', ') : 'empty'}</p><input value={specificId} onChange={(event) => setSpecificId(event.target.value.replace(/\D/g, ''))} aria-label="Deed to buy" placeholder="Deed ID" /><strong>{state ? showVoid(state.specificQuote) : '—'} VOID</strong><button className={styles.primary} disabled={!account || busy || state?.transactionFee == null || !specificId || !state?.inventory.includes(specificId)} onClick={() => void submit('specific')}>Buy selected</button></section>
        <section className={styles.card}><div className={styles.tag}>SELL</div><h2>Sell to the pool</h2><p>Your Deeds: {state?.owned.length ? state.owned.map((id) => `#${id}`).join(', ') : 'none'}</p><input value={sellId} onChange={(event) => setSellId(event.target.value.replace(/\D/g, ''))} aria-label="Deed to sell" placeholder="Deed ID" /><strong>{state ? showVoid(state.sellQuote) : '—'} VOID payout</strong><button className={styles.primary} disabled={!account || busy || state?.transactionFee == null || !sellId || !state?.sellable.includes(sellId)} onClick={() => void submit('sell')}>Sell Deed</button></section>
      </div>
      {message && <div className={styles.message}>{message}</div>}
      <p className={styles.foot}>Random buy/sell 1% market fee · selected buy 2% market fee · fixed 0.5% protocol fee. Each trade also reserves the Chain 1 fee plus up to {showVoid(MAX_GAS_VOID)} VOID for gas. Unused gas budget is refunded. The gas cap is not the final charge.</p>
    </main>
  </>;
}
