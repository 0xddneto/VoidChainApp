'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPublicClient, createWalletClient, custom, encodeFunctionData, formatUnits, http, parseAbi, parseUnits, type Address, type Hex } from 'viem';
import { DEX, MAX_GAS_VOID, CALL_GAS_LIMIT } from './dex-config';
import { requireSponsoredSuccess } from '../../web/lib/sponsored-receipt';

const RPC = 'https://robinhood-testnet.drpc.org';
const CHAIN_ID = 46_630;
const RUNTIME = DEX.runtime;
const PAYMASTER = DEX.paymaster;
const VOID = DEX.voidToken;
const FAUCET = DEX.faucet;
const PAIRS = DEX.pools;
const RH = { chainId:'0xb626', chainName:'Robinhood Chain Testnet', nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18}, rpcUrls:[RPC], blockExplorerUrls:['https://testnet-explorer.chain.robinhood.com'] };
const rpc = createPublicClient({ transport:http(RPC) }); const zero=0n;
const erc20=parseAbi(['function nonces(address) view returns(uint256)']);
const paymasterAbi=parseAbi(['function nonces(address) view returns(uint256)']);
const pairAbi=parseAbi(['function reserve0() view returns(uint256)','function reserve1() view returns(uint256)','function totalSupply() view returns(uint256)','function balanceOf(address) view returns(uint256)','function quote(bool,uint256) view returns(uint256)','function swap(bool,uint256,uint256) returns(uint256)','function addLiquidity(uint256,uint256,uint256) returns(uint256)','function removeLiquidity(uint256,uint256,uint256) returns(uint256,uint256)']);
const faucetAbi=parseAbi(['function claim()']);
type Provider={request:(args:{method:string;params?:unknown[]})=>Promise<unknown>;on?:(e:string,l:(a:unknown)=>void)=>void;removeListener?:(e:string,l:(a:unknown)=>void)=>void}; const provider=()=>typeof window==='undefined'?undefined:(window as Window & {ethereum?:Provider}).ethereum;
const addr=(v:unknown)=>Array.isArray(v)&&typeof v[0]==='string'&&/^0x[\da-f]{40}$/i.test(v[0])?v[0] as Address:null; const units=(v:string)=>{try{return v&&Number(v)>0?parseUnits(v,18):zero}catch{return zero}}; const show=(v:bigint)=>Number(formatUnits(v,18)).toLocaleString('en-US',{maximumFractionDigits:4});
export type DexPoolState={fee:string|null;reserve0:string;reserve1:string;totalSupply:string;balance:string};
const tokenNames:Record<string,string> = Object.fromEntries([[VOID.toLowerCase(), 'VOID'], ...PAIRS.map(pool => [pool.asset.toLowerCase(), pool.name])]);
const permitTypes={Permit:[{name:'owner',type:'address'},{name:'spender',type:'address'},{name:'value',type:'uint256'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'}]} as const;
const sponsoredTypes={Spend:[{name:'token',type:'address'},{name:'amount',type:'uint256'}],SpendNft:[{name:'collection',type:'address'},{name:'tokenId',type:'uint256'}],SponsoredCall:[{name:'user',type:'address'},{name:'tokenId',type:'uint256'},{name:'target',type:'address'},{name:'data',type:'bytes'},{name:'maxToll',type:'uint256'},{name:'maxGasVoid',type:'uint256'},{name:'callGasLimit',type:'uint256'},{name:'spends',type:'Spend[]'},{name:'nftSpends',type:'SpendNft[]'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'}]} as const;
const split=(signature:Hex)=>({v:Number.parseInt(signature.slice(130,132),16),r:signature.slice(0,66) as Hex,s:`0x${signature.slice(66,130)}` as Hex});

export default function VoidDex({initialStates}:{initialStates:DexPoolState[]}){
 const initial=initialStates[0]!; const [account,setAccount]=useState<Address|null>(null),[pairI,setPairI]=useState(0),[fee,setFee]=useState(()=>BigInt(initial.fee ?? '0')),[r0,setR0]=useState(()=>BigInt(initial.reserve0)),[r1,setR1]=useState(()=>BigInt(initial.reserve1)),[lp,setLp]=useState(()=>BigInt(initial.totalSupply)),[mine,setMine]=useState(zero),[dir,setDir]=useState(true),[amount,setAmount]=useState('10'),[a0,setA0]=useState('100'),[a1,setA1]=useState('100'),[burn,setBurn]=useState(''),[busy,setBusy]=useState(''),[note,setNote]=useState(''),[feeReady,setFeeReady]=useState(initial.fee !== null);
 const pair=PAIRS[pairI]; const input=dir?pair.token0:pair.token1; const out=dir?pair.token1:pair.token0; const [s0,s1]=useMemo(()=>[pair.token0===VOID?'VOID':pairI===0?'tUSD':'tLINK',pair.token1===VOID?'VOID':pairI===0?'tUSD':'tLINK'],[pair,pairI]); const quote=useMemo(()=>{const x=units(amount),ri=dir?r0:r1,ro=dir?r1:r0; if(!x||!ri||!ro)return zero;const xf=x*997n;return xf*ro/(ri*1000n+xf)},[amount,dir,r0,r1]);
 useEffect(()=>{const p=provider();if(!p)return;const u=(x:unknown)=>setAccount(addr(x));void p.request({method:'eth_accounts'}).then(u).catch(()=>undefined);p.on?.('accountsChanged',u);return()=>p.removeListener?.('accountsChanged',u)},[]);
 function selectPair(index:number){const state=initialStates[index]!;setPairI(index);setDir(true);setFeeReady(state.fee !== null);setFee(BigInt(state.fee ?? '0'));setR0(BigInt(state.reserve0));setR1(BigInt(state.reserve1));setLp(BigInt(state.totalSupply));setMine(zero)}
 async function refresh(){
  const response = await fetch(`/state?pair=${pairI}${account ? `&account=${account}` : ''}`, {cache:'no-store'});
  const state = await response.json();
  if (!response.ok) throw Error(state.error ?? 'Pool refresh failed.');
  setFeeReady(state.fee !== null);setFee(BigInt(state.fee ?? '0'));setR0(BigInt(state.reserve0));setR1(BigInt(state.reserve1));setLp(BigInt(state.totalSupply));setMine(BigInt(state.balance));
 }
 useEffect(()=>{let current=true;fetch(`/state?pair=${pairI}${account ? `&account=${account}` : ''}`,{cache:'no-store'}).then(async response=>{const state=await response.json();if(!response.ok)throw Error(state.error);if(current){setFeeReady(state.fee !== null);setFee(BigInt(state.fee ?? '0'));setR0(BigInt(state.reserve0));setR1(BigInt(state.reserve1));setLp(BigInt(state.totalSupply));setMine(BigInt(state.balance))}}).catch(error=>{if(current)setNote(error.message)});return()=>{current=false}},[account,pairI]);
 async function connect(){const p=provider();if(!p)return setNote('Open an EVM wallet first.');setAccount(addr(await p.request({method:'eth_requestAccounts'})));} async function network(p:Provider){if(await p.request({method:'eth_chainId'})==='0xb626')return;try{await p.request({method:'wallet_switchEthereumChain',params:[{chainId:'0xb626'}]})}catch{await p.request({method:'wallet_addEthereumChain',params:[RH]})}}
 async function sponsor(label:string,target:Address,data:Hex,spends:Array<{token:Address;amount:bigint}>){
  const p=provider(); if(!p||!account) throw Error('Connect wallet.');
  await network(p); setBusy(label);
  try {
   const wallet=createWalletClient({account,transport:custom(p)});
   const [nonce,currentFee]=await Promise.all([
    rpc.readContract({address:PAYMASTER,abi:paymasterAbi,functionName:'nonces',args:[account]}),
    rpc.readContract({address:RUNTIME,abi:parseAbi(['function feeOf(uint256) view returns(uint256)']),functionName:'feeOf',args:[1n]}),
   ]);
   const deadline=BigInt(Math.floor(Date.now()/1000)+600);
   const request={user:account,tokenId:1n,target,data,maxToll:currentFee,maxGasVoid:MAX_GAS_VOID,callGasLimit:CALL_GAS_LIMIT,spends,nftSpends:[],nonce,deadline};
   const limits=new Map<string,{token:Address;spender:Address;value:bigint}>();
   limits.set(`${VOID}:${PAYMASTER}`.toLowerCase(),{token:VOID,spender:PAYMASTER,value:currentFee+MAX_GAS_VOID});
   for(const spend of spends) limits.set(`${spend.token}:${RUNTIME}`.toLowerCase(),{token:spend.token,spender:RUNTIME,value:spend.amount});
   const permits = [];
   const nextNonces = new Map<string, bigint>();
   for (const limit of limits.values()) {
    const name=tokenNames[limit.token.toLowerCase()]; if(!name) throw Error('Unsupported DEX token.');
    const tokenKey = limit.token.toLowerCase();
    const permitNonce = nextNonces.get(tokenKey) ?? await rpc.readContract({address:limit.token,abi:erc20,functionName:'nonces',args:[account]});
    nextNonces.set(tokenKey, permitNonce + 1n);
    const permitSignature=await wallet.signTypedData({account,domain:{name,version:'1',chainId:CHAIN_ID,verifyingContract:limit.token},types:permitTypes,primaryType:'Permit',message:{owner:account,spender:limit.spender,value:limit.value,nonce:permitNonce,deadline}});
    permits.push({token:limit.token,spender:limit.spender,value:limit.value,deadline,...split(permitSignature)});
   }
   const signature=await wallet.signTypedData({account,domain:{name:'VoidPaymaster',version:'1',chainId:CHAIN_ID,verifyingContract:PAYMASTER},types:sponsoredTypes,primaryType:'SponsoredCall',message:request});
   const relayRequest={
    request:{...request,tokenId:'1',maxToll:currentFee.toString(),maxGasVoid:MAX_GAS_VOID.toString(),callGasLimit:CALL_GAS_LIMIT.toString(),nonce:nonce.toString(),deadline:deadline.toString(),spends:spends.map(x=>({token:x.token,amount:x.amount.toString()}))},
    signature,
    permits:permits.map(x=>({...x,value:x.value.toString(),deadline:x.deadline.toString()})),
   };
   const response=await fetch('/relay',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(relayRequest)});
   const body=await response.json() as {hash?:Hex;error?:string};
   if(!response.ok||!body.hash) throw Error(body.error??'Relay rejected the signed action.');
   requireSponsoredSuccess(await rpc.waitForTransactionReceipt({hash:body.hash}), PAYMASTER, account, 1n);
   setNote(`Confirmed. Chain fee: ${show(currentFee)} VOID, plus Paymaster execution costs within the signed ${show(MAX_GAS_VOID)} VOID limit. No ETH transaction was sent from your wallet.`); await refresh();
  } finally { setBusy(''); }
 }
 async function claim(){try{await sponsor('claim',FAUCET,encodeFunctionData({abi:faucetAbi,functionName:'claim'}),[])}catch(e:any){setNote(e.shortMessage??e.message)}}
 async function swap(){const x=units(amount);if(!x||!quote)return setNote('Enter a valid swap amount.');try{await sponsor('swap',pair.address,encodeFunctionData({abi:pairAbi,functionName:'swap',args:[dir,x,quote*9950n/10000n]}),[{token:input,amount:x}])}catch(e:any){setNote(e.shortMessage??e.message)}}
 async function add(){const x=units(a0),y=units(a1);if(!x||!y)return setNote('Enter both pool amounts.');try{const minted=lp===zero?x<y?x:y:(x*lp/r0)<(y*lp/r1)?x*lp/r0:y*lp/r1;await sponsor('liquidity',pair.address,encodeFunctionData({abi:pairAbi,functionName:'addLiquidity',args:[x,y,minted*9950n/10000n]}),[{token:pair.token0,amount:x},{token:pair.token1,amount:y}])}catch(e:any){setNote(e.shortMessage??e.message)}}
 async function remove(){const x=units(burn);if(!x||x>mine)return setNote('Enter LP shares you own.');try{await sponsor('remove',pair.address,encodeFunctionData({abi:pairAbi,functionName:'removeLiquidity',args:[x,(x*r0/lp)*9950n/10000n,(x*r1/lp)*9950n/10000n]}),[])}catch(e:any){setNote(e.shortMessage??e.message)}}
 return <main className="shell"><header className="top"><a className="brand" href="/">VOID<b>DEX</b></a><button className="wallet" onClick={connect}>{account?`${account.slice(0,6)}…${account.slice(-4)}`:'Connect wallet'}</button></header><section className="hero"><div><div className="tag">UNISWAP V2 · VOID CHAIN #1 · TESTNET</div><h1>Swap on<br/>your <b>chain.</b></h1><p>Every action below is a signed VOID-sponsored request. Your wallet signs bounded permits; it never sends an ETH transaction. The relayer pays parent-chain gas and the Paymaster charges the chain fee in VOID: 98% to the Deed holder and 2% to the protocol.</p></div><aside className="fee"><span className="label">Chain fee per action</span><strong>{feeReady ? `${show(fee)} VOID` : 'Unavailable'}</strong><small>Gas budget: up to {show(MAX_GAS_VOID)} VOID in addition to the chain fee. Unused gas budget is refunded. The cap is not the final charge.</small></aside></section>{!feeReady && <p className="status">Trading paused: the fee oracle is unavailable. Pool balances remain visible.</p>}<section className="grid"><div className="main"><nav className="tabs">{PAIRS.map((p,i)=><button className={i===pairI?'on':''} onClick={()=>selectPair(i)} key={p.address}>{p.label}</button>)}</nav><section className="card"><div className="head"><h2>Swap</h2><span>0.50% max slippage</span></div><label className="input"><span className="label">You pay · {dir?s0:s1}</span><input value={amount} onChange={e=>setAmount(e.target.value)} inputMode="decimal"/></label><button className="mutedBtn" onClick={()=>setDir(!dir)}>Reverse direction</button><div className="input"><span className="label">You receive · {dir?s1:s0}</span><strong>{show(quote)}</strong><small>Minimum {show(quote*9950n/10000n)}</small></div><button className="action" disabled={!!busy || !feeReady} onClick={swap}>{busy==='swap'?'Confirming…':`Sign swap · ${show(fee)} VOID`}</button></section><section className="card"><div className="head"><h2>Pool</h2><span>LPs retain 0.30% swap fee</span></div><div className="two"><input value={a0} onChange={e=>setA0(e.target.value)} inputMode="decimal" aria-label={s0}/><input value={a1} onChange={e=>setA1(e.target.value)} inputMode="decimal" aria-label={s1}/></div><button className="action" disabled={!!busy || !feeReady} onClick={add}>{busy==='liquidity'?'Confirming…':`Sign liquidity · ${show(fee)} VOID`}</button><div className="remove"><input value={burn} onChange={e=>setBurn(e.target.value)} placeholder="LP shares to remove" inputMode="decimal"/><button className="mutedBtn" disabled={!!busy || !feeReady} onClick={remove}>{busy==='remove'?'Confirming…':'Sign remove'}</button></div></section></div><aside className="side"><section className="card"><div className="head"><h2>Pool state</h2><span>live</span></div><div className="metric"><span>{s0} reserve</span><b>{show(r0)}</b></div><div className="metric"><span>{s1} reserve</span><b>{show(r1)}</b></div><div className="metric"><span>Total LP</span><b>{show(lp)}</b></div><div className="metric"><span>Your LP</span><b>{show(mine)}</b></div></section><section className="card notice"><b>Test assets</b><p>tUSD and tLINK are local test tokens. Claiming them is a paid Chain #1 action, so it appears in VoidScan and pays the VOID fee.</p><button className="mutedBtn" disabled={!!busy || !feeReady} onClick={claim}>{busy==='claim'?'Confirming…':`Sign claim · ${show(fee)} VOID`}</button></section></aside></section>{note&&<p className="status">{note}</p>}<footer className="foot"><span>Factory 0xB559…9010</span><span>Runtime {RUNTIME}</span><a href="https://voidscan-nu.vercel.app">Open VoidScan →</a></footer></main>;
}
