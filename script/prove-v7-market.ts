/** Staged testnet acceptance: real permits, repeated trades and fee accounting. */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, encodeFunctionData, decodeFunctionResult, parseEther, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { requireSponsoredSuccess } from '../web/lib/sponsored-receipt';

const staged = JSON.parse(readFileSync('deployments/testnet-v7-pending.json', 'utf8'));
const c = staged.contracts as Record<string, Address>;
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw Error('Missing project testnet key');
const account = privateKeyToAccount(key as Hex);
const rpc = createPublicClient({ transport: http(process.env.PARENT_RPC ?? staged.network.rpc) });
const wallet = createWalletClient({ account, transport: http(process.env.PARENT_RPC ?? staged.network.rpc) });
const proofPath = process.env.V7_PROOF_FILE ?? (process.env.V7_HTTP ? 'deployments/testnet-v7-http-proof.json' : 'deployments/testnet-v7-market-proof.json');
const proof: any = existsSync(proofPath) ? JSON.parse(readFileSync(proofPath, 'utf8')) : { runtime: c.runtime, steps: {}, trades: [] };
if (proof.runtime !== c.runtime) throw Error('Proof belongs to another runtime');
const abi = (name: string): Abi => JSON.parse(readFileSync(name === 'VoidChainAppGatewayV3' ? '../out/VoidChainAppFactoryV3.sol/VoidChainAppGateway.json' : `../out/${name}.sol/${name}.json`, 'utf8')).abi;
const pmAbi = abi('VoidPaymaster'), marketAbi = abi('VoidGenesisNftAmmV6'), tokenAbi = abi('VoidTokenV6'), deedAbi = abi('VoidChainDeed');
const save = () => writeFileSync(proofPath, JSON.stringify(proof, (_k,v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
async function read(address: Address, name: string, fn: string, args: readonly unknown[] = []) {
  return rpc.readContract({ address, abi: abi(name), functionName: fn, args });
}
async function wait(hash: Hex) { const r = await rpc.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw Error(`Reverted ${hash}`); return r; }
async function send(label: string, address: Address, name: string, fn: string, args: readonly unknown[] = [], value = 0n) {
  if (!proof.steps[label]) {
    proof.steps[label] = await wallet.sendTransaction({ account, chain: null, to: address, data: encodeFunctionData({ abi: abi(name), functionName: fn, args }), value, maxFeePerGas: (await rpc.getGasPrice()) * 3n, maxPriorityFeePerGas: 0n }); save();
  }
  return wait(proof.steps[label]);
}
async function query(fn: string) {
  const data = encodeFunctionData({ abi: marketAbi, functionName: fn });
  const raw = await read(c.nftAmm, 'VoidChainAppGatewayV3', 'query', [data]) as Hex;
  return decodeFunctionResult({ abi: marketAbi, functionName: fn, data: raw }) as bigint;
}
const permitTypes = { Permit: [{name:'owner',type:'address'},{name:'spender',type:'address'},{name:'value',type:'uint256'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'}] } as const;
const deedTypes = { Permit: [{name:'spender',type:'address'},{name:'tokenId',type:'uint256'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'}] } as const;
const sponsoredTypes = {
  Spend: [{name:'token',type:'address'},{name:'amount',type:'uint256'}], SpendNft: [{name:'collection',type:'address'},{name:'tokenId',type:'uint256'}],
  SponsoredCall: [{name:'user',type:'address'},{name:'tokenId',type:'uint256'},{name:'target',type:'address'},{name:'data',type:'bytes'},{name:'maxToll',type:'uint256'},{name:'maxGasVoid',type:'uint256'},{name:'callGasLimit',type:'uint256'},{name:'spends',type:'Spend[]'},{name:'nftSpends',type:'SpendNft[]'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'}],
} as const;
const split = (s: Hex) => ({ v: parseInt(s.slice(130,132),16), r: s.slice(0,66) as Hex, s: `0x${s.slice(66,130)}` as Hex });
async function trade(label: string, kind: 'donation' | 'buy' | 'sell') {
  if (proof.steps[label]) { requireSponsoredSuccess(await wait(proof.steps[label]), c.paymaster, account.address, 1n); return; }
  const deadline = BigInt(Math.floor(Date.now()/1000)+600), maxGasVoid = parseEther('10000');
  const [fee, nonce, tokenNonce, beforeStats, beforePool] = await Promise.all([
    read(c.runtime,'VoidChainAppRuntimeV4','feeOf',[1n]), read(c.paymaster,'VoidPaymaster','nonces',[account.address]),
    read(c.token,'VoidTokenV6','nonces',[account.address]), read(c.runtime,'VoidChainAppRuntimeV4','statsOf',[1n]), read(c.token,'VoidTokenV6','balanceOf',[c.nftAmm]),
  ]) as [bigint,bigint,bigint,readonly [boolean,bigint,bigint,bigint,bigint],bigint];
  let data: Hex;
  const spends: {token: Address;amount:bigint}[] = [], nftSpends: {collection:Address;tokenId:bigint}[] = [];
  if (kind === 'sell') {
    const n = await read(c.deed,'VoidChainDeed','nonces',[4n]) as bigint;
    const s = split(await account.signTypedData({ domain:{name:'VOIDS Chain Deed',version:'1',chainId:46630,verifyingContract:c.deed}, types:deedTypes,primaryType:'Permit',message:{spender:c.runtime,tokenId:4n,nonce:n,deadline} }));
    data = encodeFunctionData({abi:marketAbi,functionName:'sellWithPermit',args:[4n,deadline,s.v,s.r,s.s]}); nftSpends.push({collection:c.deed,tokenId:4n});
  } else if (kind === 'buy') {
    const amount = await query('randomBuyQuote'); spends.push({token:c.token,amount}); data=encodeFunctionData({abi:marketAbi,functionName:'buyRandom',args:[amount]});
  } else data=encodeFunctionData({abi:marketAbi,functionName:'acceptDonation',args:[4n]});
  const request = {user:account.address,tokenId:1n,target:c.nftAmm,data,maxToll:fee,maxGasVoid,callGasLimit:1500000n,spends,nftSpends,nonce,deadline};
  const permissions = [{spender:c.paymaster,value:fee+maxGasVoid},...spends.map(s=>({spender:c.runtime,value:s.amount}))];
  const permits=[];
  for (let i=0;i<permissions.length;i++) {
    const item=permissions[i]; const signed=await account.signTypedData({domain:{name:'VOID',version:'1',chainId:46630,verifyingContract:c.token},types:permitTypes,primaryType:'Permit',message:{owner:account.address,...item,nonce:tokenNonce+BigInt(i),deadline}});
    permits.push({token:c.token,...item,deadline,...split(signed)});
  }
  const signature=await account.signTypedData({domain:{name:'VoidPaymaster',version:'1',chainId:46630,verifyingContract:c.paymaster},types:sponsoredTypes,primaryType:'SponsoredCall',message:request});
  let hash: Hex;
  if (process.env.V7_HTTP && kind !== 'donation') {
    const response=await fetch('https://voidscan-nu.vercel.app/api/market/sponsor',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({request,signature,permits},(_k,v)=>typeof v==='bigint'?v.toString():v)});
    const body=await response.json() as {hash?:Hex,error?:string};
    if(!response.ok||!body.hash){
      const diagnostic=await rpc.simulateContract({account,address:c.paymaster,abi:pmAbi,functionName:'sponsorWithAssetPermits',args:[request,signature,permits]});
      console.log('Local relay simulation:',diagnostic.result);
      console.log('VOID balance:',String(await read(c.token,'VoidTokenV6','balanceOf',[account.address])));
      throw Error(body.error??'Public relay failed');
    } hash=body.hash;
  } else {
    const args=[request,signature,permits];
    const simulation=await rpc.simulateContract({account,address:c.paymaster,abi:pmAbi,functionName:'sponsorWithAssetPermits',args});
    if (!(simulation.result as [boolean,Hex])[0]) throw Error(`Inner execution failed: ${(simulation.result as [boolean,Hex])[1]}`);
    hash=await wallet.sendTransaction({account,chain:null,to:c.paymaster,data:encodeFunctionData({abi:pmAbi,functionName:'sponsorWithAssetPermits',args}),maxFeePerGas:(await rpc.getGasPrice())*3n,maxPriorityFeePerGas:0n});
  }
  proof.steps[label]=hash;save(); const receipt=await wait(hash);requireSponsoredSuccess(receipt,c.paymaster,account.address,1n);
  const afterStats=await read(c.runtime,'VoidChainAppRuntimeV4','statsOf',[1n]) as readonly [boolean,bigint,bigint,bigint,bigint];
  const owner=await read(c.deed,'VoidChainDeed','ownerOf',[4n]) as Address;
  const poolBalance=await read(c.token,'VoidTokenV6','balanceOf',[c.nftAmm]) as bigint;
  const expectedOwner=kind==='buy'?account.address:c.nftAmm;
  const expectedPoolDelta=parseEther(kind==='buy'?'502500':kind==='sell'?'-495000':'500000');
  if(owner.toLowerCase()!==expectedOwner.toLowerCase()||afterStats[4]!==beforeStats[4]+1n||afterStats[3]!==beforeStats[3]+fee||poolBalance-beforePool!==expectedPoolDelta)throw Error(`Accounting mismatch ${label}`);
  proof.trades.push({label,hash,owner,fee,poolDelta:poolBalance-beforePool,revenue:afterStats[3],transactions:afterStats[4]});save();console.log('PASS',label,hash);
}
async function main() {
  if(await rpc.getChainId()!==46630)throw Error('Testnet only');
  if(!process.env.V7_HTTP) {
    const balance=await read(c.token,'VoidTokenV6','balanceOf',[account.address]) as bigint;
    if(balance<parseEther('550000')&&!proof.steps.acquireVoid)await send('acquireVoid',c.pool,'VoidEthPoolV6','swapEthForVoid',[parseEther('590000')],parseEther('0.003'));
  } else if(!proof.steps.acquireHttpBudget) {
    const balance=await read(c.token,'VoidTokenV6','balanceOf',[account.address]) as bigint;
    const desired=parseEther('620000');
    if(balance<desired){
      const rv=await read(c.pool,'VoidEthPoolV6','reserveVoid') as bigint,re=await read(c.pool,'VoidEthPoolV6','reserveEth') as bigint;
      const needed=desired-balance;
      const ethIn=needed*re*10000n/((rv-needed)*9970n)+1n;
      if(ethIn>parseEther('0.002'))throw Error('Proof funding exceeds 0.002 ETH cap');
      await send('acquireHttpBudget',c.pool,'VoidEthPoolV6','swapEthForVoid',[needed*99n/100n],ethIn);
    }
  }
  const elapsed=Number((await rpc.getBlock()).timestamp)-Number(await read(c.twap,'VoidTwapOracleV6','lastTimestamp'));
  if(elapsed>=300)await send(`twap:${Math.floor(Date.now()/1000)}`,c.twap,'VoidTwapOracleV6','update');
  if(await read(c.oracle,'VoidTwapFreshnessGuardV6','voidPerEth')===0n)throw Error('TWAP window not ready');
  await send('margin',c.paymaster,'VoidPaymaster','setMargin',[500n]);
  if(!process.env.V7_HTTP) {
    await trade('donation','donation');
  }
  for(let i=1;i<=2;i++){await trade(`buy:${i}`,'buy');await trade(`sell:${i}`,'sell');}
  if(await read(c.deed,'VoidChainDeed','ownerOf',[5n])!=='0xA7a12A1D7000e40Ecc18a62Af456791b89cB2770')throw Error('Personal NFT owner changed');
  if(await query('inventoryCount')!==1n)throw Error('Inventory mismatch');
  proof.status='passed';save();console.log('PASS repeated NFT trades, exact VOID pool deltas, chain fee accounting, personal NFT preserved');
}
main().catch((e)=>{console.error('V7 proof stopped:',e?.shortMessage??e?.message??'unknown error');process.exitCode=1;});
