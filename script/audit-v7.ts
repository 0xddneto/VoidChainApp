/** Read-only acceptance audit of all DAO creation and actual revenue events. */
import {readFileSync,writeFileSync} from 'node:fs';
import {createPublicClient,http,type Abi,type Address} from 'viem';
const d=JSON.parse(readFileSync('deployments/testnet-v7-pending.json','utf8')),c=d.contracts;
const snapshot=JSON.parse(readFileSync('deployments/testnet-v7-snapshot.json','utf8'));
const rpc=createPublicClient({transport:http(d.network.rpc)});
const abi=(n:string):Abi=>JSON.parse(readFileSync(`../out/${n}.sol/${n}.json`,'utf8')).abi;
async function events(address:Address,name:string,eventName:string){
 const logs=[];const head=await rpc.getBlockNumber();
 for(let from=BigInt(d.network.deployBlock);from<=head;from+=5000n){const to=from+4999n<head?from+4999n:head;logs.push(...await rpc.getContractEvents({address,abi:abi(name),eventName,fromBlock:from,toBlock:to}));}
 return logs;
}
async function main(){
 if(await rpc.getChainId()!==46630)throw Error('Wrong network');
 const daos=await events(c.daoFactory,'VoidChainDaoFactory','DaoCreated');
 const ids=new Set(daos.map(l=>String((l.args as any).tokenId)));
 if(ids.size!==1111||Array.from({length:1111},(_,i)=>String(i+1)).some(id=>!ids.has(id)))throw Error('DAO coverage mismatch');
 const revenue=await events(c.runtime,'VoidChainAppRuntimeV4','Executed');
 if(revenue.length===0)throw Error('No real fee events to audit');
 let gross=0n,holder=0n,protocol=0n;
 for(const log of revenue){const a=log.args as any; const g=a.fee as bigint,p=g*200n/10000n,h=g-p;
  if(a.tokenId!==1n||g===0n)throw Error('Unexpected chain or zero fee');gross+=g;holder+=h;protocol+=p;
 }
 const stats=await rpc.readContract({address:c.runtime,abi:abi('VoidChainAppRuntimeV4'),functionName:'statsOf',args:[1n]}) as readonly [boolean,bigint,bigint,bigint,bigint];
 const accrued=await rpc.readContract({address:c.runtime,abi:abi('VoidChainAppRuntimeV4'),functionName:'protocolAccrued'});
 const flushed=(await events(c.runtime,'VoidChainAppRuntimeV4','RevenueFlushed')).reduce((sum,l)=>sum+((l.args as any).amount as bigint),0n);
 const swept=(await events(c.runtime,'VoidChainAppRuntimeV4','ProtocolSwept')).reduce((sum,l)=>sum+((l.args as any).amount as bigint),0n);
 if(stats[3]!==gross||stats[2]+flushed!==holder||(accrued as bigint)+swept!==protocol||stats[4]!==BigInt(revenue.length))throw Error('Runtime fee liabilities mismatch');
 const custody=await rpc.readContract({address:c.token,abi:abi('VoidTokenV6'),functionName:'balanceOf',args:[c.runtime]});
 if(custody!==gross-flushed-swept)throw Error('Fee custody does not back liabilities');
 // Ownership is checked at the migration cutoff, not against today's owners.
 // A successful marketplace transfer is expected to change ownerOf later and
 // must never make the deployment audit fail.
 const importedAt=(await rpc.getTransactionReceipt({hash:d.steps['owner:5']})).blockNumber;
 for(const nft of snapshot.deeds.filter((n:any)=>!n.inLegacyPool)){
  const sourceOwner=await rpc.readContract({address:snapshot.source.production.VoidChainDeed,abi:abi('VoidChainDeed'),functionName:'ownerOf',args:[BigInt(nft.id)],blockNumber:BigInt(snapshot.block)}) as string;
  const importedOwner=await rpc.readContract({address:c.deed,abi:abi('VoidChainDeed'),functionName:'ownerOf',args:[BigInt(nft.id)],blockNumber:importedAt}) as string;
  if(sourceOwner.toLowerCase()!==nft.owner.toLowerCase()||importedOwner.toLowerCase()!==nft.owner.toLowerCase())throw Error(`Snapshot import mismatch for #${nft.id}`);
 }
 const proof={daoCount:ids.size,settlements:revenue.length,gross,holder,protocol,snapshotHoldersImported:true,ownershipTransfersAllowed:true};
 writeFileSync('deployments/testnet-v7-audit.json',JSON.stringify(proof,(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');console.log('PASS',JSON.stringify(proof,(_k,v)=>typeof v==='bigint'?v.toString():v));
}
main().catch(e=>{console.error('Audit stopped:',e?.shortMessage??e?.message??'unknown');process.exitCode=1;});
