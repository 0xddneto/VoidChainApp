/** Deliver earned testnet fees to the real holder and public protocol address. */
import 'dotenv/config';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createPublicClient,createWalletClient,http,type Abi,type Hex,type Address} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
const d=JSON.parse(readFileSync('deployments/testnet-v7-pending.json','utf8')),c=d.contracts;
const protocol='0x892F840aF9CFE78D4FF91D8e6D0F783264388A78' as Address;
const key=process.env.DEPLOYER_PRIVATE_KEY as Hex;
if(!/^0x[0-9a-fA-F]{64}$/.test(key??''))throw Error('Missing testnet key');
const account=privateKeyToAccount(key),rpc=createPublicClient({transport:http(process.env.PARENT_RPC??d.network.rpc)}),wallet=createWalletClient({account,transport:http(process.env.PARENT_RPC??d.network.rpc)});
const path='deployments/testnet-v7-fees-proof.json';
const proof:any=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{runtime:c.runtime,steps:{}};
const abi=(name:string):Abi=>JSON.parse(readFileSync(`../out/${name}.sol/${name}.json`,'utf8')).abi;
const read=(address:Address,name:string,functionName:string,args:readonly unknown[]=[])=>rpc.readContract({address,abi:abi(name),functionName,args});
const balance=(address:Address)=>read(c.token,'VoidTokenV6','balanceOf',[address]) as Promise<bigint>;
const save=()=>writeFileSync(path,JSON.stringify(proof,(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
async function send(label:string,address:Address,name:string,functionName:string,args:readonly unknown[]=[]){
 if(!proof.steps[label]){proof.steps[label]=await wallet.writeContract({account,chain:null,address,abi:abi(name),functionName,args});save();}
 const r=await rpc.waitForTransactionReceipt({hash:proof.steps[label]});if(r.status!=='success')throw Error(`Reverted ${label}`);
}
async function main(){
 if(await rpc.getChainId()!==46630||proof.runtime!==c.runtime)throw Error('Wrong deployment');
 if(proof.status==='passed'){console.log('Fee payouts already proved');return;}
 if(!proof.before){
  const stats=await read(c.runtime,'VoidChainAppRuntimeV4','statsOf',[1n]) as bigint[];
  const owner=await read(c.deed,'VoidChainDeed','ownerOf',[1n]) as string;if(owner.toLowerCase()!==account.address.toLowerCase())throw Error('Project no longer owns chain 1');
  proof.before={holder:await balance(account.address),protocol:await balance(protocol)};
  proof.holderAmount=stats[2];proof.protocolAmount=await read(c.runtime,'VoidChainAppRuntimeV4','protocolAccrued');save();
 }
 await send('flush',c.runtime,'VoidChainAppRuntimeV4','flush',[1n]);
 await send('sweep',c.runtime,'VoidChainAppRuntimeV4','sweepProtocol');
 await send('claim',c.treasury,'VoidChainTreasury','claim');
 const holderDelta=await balance(account.address)-BigInt(proof.before.holder),protocolDelta=await balance(protocol)-BigInt(proof.before.protocol);
 if(holderDelta!==BigInt(proof.holderAmount)||protocolDelta!==BigInt(proof.protocolAmount))throw Error('Payout delta mismatch');
 proof.status='passed';save();console.log('PASS real fee delivery',JSON.stringify({holderDelta:String(holderDelta),protocolDelta:String(protocolDelta),...proof.steps}));
}
main().catch(e=>{console.error('Fee proof stopped:',e?.shortMessage??e?.message??'unknown');process.exitCode=1;});
