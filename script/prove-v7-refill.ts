/** Prove the production cron actually refills, then restore original policy. */
import 'dotenv/config';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createPublicClient,createWalletClient,http,parseEther,type Abi,type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
const d=JSON.parse(readFileSync('deployments/testnet-v7-pending.json','utf8')),pm=d.contracts.paymaster;
const abi:Abi=JSON.parse(readFileSync('../out/VoidPaymaster.sol/VoidPaymaster.json','utf8')).abi;
const key=process.env.DEPLOYER_PRIVATE_KEY as Hex;
if(!/^0x[0-9a-fA-F]{64}$/.test(key??''))throw Error('Missing testnet key');
const account=privateKeyToAccount(key),rpc=createPublicClient({transport:http(process.env.PARENT_RPC??d.network.rpc)}),wallet=createWalletClient({account,transport:http(process.env.PARENT_RPC??d.network.rpc)});
const path='deployments/testnet-v7-refill-proof.json';
const proof:any=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{paymaster:pm};
const save=()=>writeFileSync(path,JSON.stringify(proof,(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
const read=(functionName:string,args:readonly unknown[]=[])=>rpc.readContract({address:pm,abi,functionName,args});
async function policy(args:readonly unknown[]){const hash=await wallet.writeContract({account,chain:null,address:pm,abi,functionName:'setRefillPolicy',args});const r=await rpc.waitForTransactionReceipt({hash});if(r.status!=='success')throw Error('Policy reverted');return hash;}
async function main(){
 if(await rpc.getChainId()!==46630||proof.paymaster!==pm)throw Error('Wrong network/deployment');
 if(proof.status==='passed'){console.log('Refill already proved',proof.refillHash);return;}
 if(!proof.original){proof.original=await Promise.all(['refillThreshold','refillTarget','refillSlippageBps'].map(n=>read(n)));save();}
 try {
  if(!proof.prepared){
   const reserve=await rpc.getBalance({address:pm});proof.beforeReserve=reserve.toString();proof.beforeVoid=String(await read('reimbursableVoid'));proof.fromBlock=String(await rpc.getBlockNumber());save();
   proof.policyHash=await policy([reserve+1n,reserve+parseEther('0.0001'),500n]);proof.prepared=true;save();
  }
  const plan=await read('refillPlan') as [boolean,bigint,bigint];
  if(plan[0])await rpc.simulateContract({account,address:pm,abi,functionName:'refill',args:[plan[1],plan[2]]});
  console.log('Awaiting production cron: bounded refill of up to 0.0001 ETH; original policy will be restored.');
  for(let i=0;i<24;i++){
   const logs=await rpc.getContractEvents({address:pm,abi,eventName:'Refilled',fromBlock:BigInt(proof.fromBlock)});
   if(logs.length){proof.refillHash=logs[0].transactionHash;proof.afterReserve=String(await rpc.getBalance({address:pm}));proof.afterVoid=String(await read('reimbursableVoid'));proof.status='passed';save();console.log('PASS production cron refill',proof.refillHash);return;}
   await new Promise(r=>setTimeout(r,20000));
  }
  throw Error('Production cron did not refill within the test window');
 } finally {
  proof.restoreHash=await policy(proof.original.map(BigInt));proof.restored=true;save();console.log('Original refill policy restored.');
 }
}
main().catch(e=>{console.error('Refill proof stopped:',e?.shortMessage??e?.message??'unknown');process.exitCode=1;});
