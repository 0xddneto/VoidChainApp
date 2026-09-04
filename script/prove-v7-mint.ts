/** Real testnet mint from a separate, reproducible project test wallet. */
import 'dotenv/config';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createPublicClient,createWalletClient,http,keccak256,concatHex,toHex,parseEther,encodeFunctionData,ContractFunctionRevertedError,type Abi,type Hex,type Address} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
const d=JSON.parse(readFileSync('deployments/testnet-v7-pending.json','utf8')),c=d.contracts;
const key=process.env.DEPLOYER_PRIVATE_KEY as Hex;
if(!/^0x[0-9a-fA-F]{64}$/.test(key??''))throw Error('Missing testnet key');
const gov=privateKeyToAccount(key);
// Domain-separated deterministic test key, never printed or written to disk.
const user=privateKeyToAccount(keccak256(concatHex([key,toHex('VOID V7 mint acceptance wallet')])));
const rpc=createPublicClient({transport:http(process.env.PARENT_RPC??d.network.rpc)});
const wallet=createWalletClient({account:user,transport:http(process.env.PARENT_RPC??d.network.rpc)});
const admin=createWalletClient({account:gov,transport:http(process.env.PARENT_RPC??d.network.rpc)});
const path='deployments/testnet-v7-mint-proof.json';
const proof:any=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{user:user.address,mint:c.mint,steps:{}};
if(proof.user!==user.address||proof.mint!==c.mint)throw Error('Proof mismatch');
const abi=(name:string):Abi=>JSON.parse(readFileSync(`../out/${name}.sol/${name}.json`,'utf8')).abi;
const mintAbi=abi('VoidEthGenesisMintV7');
const save=()=>writeFileSync(path,JSON.stringify(proof,null,2)+'\n');
const read=(address:Address,name:string,functionName:string,args:readonly unknown[]=[])=>rpc.readContract({address,abi:abi(name),functionName,args});
async function wait(hash:Hex){const r=await rpc.waitForTransactionReceipt({hash});if(r.status!=='success')throw Error(`Reverted ${hash}`);return r;}
async function main(){
 if(await rpc.getChainId()!==46630)throw Error('Testnet only');
 if(!proof.steps.fund){proof.steps.fund=await admin.sendTransaction({account:gov,chain:null,to:user.address,value:parseEther('0.00102')});save();}await wait(proof.steps.fund);
 if(!proof.steps.mint){
  proof.before={supply:String(await read(c.mint,'VoidEthGenesisMintV7','totalMinted')),poolEth:String(await rpc.getBalance({address:c.pool})),paymasterEth:String(await rpc.getBalance({address:c.paymaster}))};save();
  proof.steps.mint=await wallet.sendTransaction({account:user,chain:null,to:c.mint,data:encodeFunctionData({abi:mintAbi,functionName:'mint'}),value:parseEther('0.001')});save();
 }
 const receipt=await wait(proof.steps.mint);const id=BigInt(proof.before.supply)+1n;
 const [owner,minted,stats]=await Promise.all([read(c.deed,'VoidChainDeed','ownerOf',[id]),read(c.mint,'VoidEthGenesisMintV7','hasMinted',[user.address]),read(c.runtime,'VoidChainAppRuntimeV4','statsOf',[id])]);
 if((owner as string).toLowerCase()!==user.address.toLowerCase()||minted!==true||(stats as unknown[])[0]!==false)throw Error('Mint ownership/state mismatch');
 // Check the immutable 40/20/40 split in this receipt's events, not a later
 // balance potentially changed by another permissionless keeper transaction.
 const {decodeEventLog}=await import('viem');
 const events=receipt.logs.filter(l=>l.address.toLowerCase()===c.mint.toLowerCase()).map(l=>decodeEventLog({abi:mintAbi,data:l.data,topics:l.topics}));
 for(const [eventName,key,expected] of [['GenesisLiquiditySeeded','ethAmount',parseEther('0.0004')],['PaymasterFunded','ethAmount',parseEther('0.0002')],['ProtocolFunded','ethAmount',parseEther('0.0004')]] as const){
  const event=events.find(e=>e.eventName===eventName); if(!event||!Object.values(event.args??{}).includes(expected))throw Error(`Split mismatch ${eventName}`);
 }
 let rejected=false;
 // The limit is checked before price. A zero-value eth_call isolates that
 // guard without funding the wallet for an intentionally rejected second mint.
 try{await rpc.simulateContract({account:user.address,address:c.mint,abi:mintAbi,functionName:'mint',value:0n});}
 catch(e:any){const cause=e.walk?.((x:unknown)=>x instanceof ContractFunctionRevertedError);rejected=cause?.data?.errorName==='MintLimitReached';if(!rejected)console.log('Second mint diagnostic:',e.shortMessage,cause?.data?.errorName);}
 if(!rejected)throw Error('Second mint did not produce MintLimitReached');
 proof.id=String(id);proof.status='passed';proof.secondMintRejected=true;save();console.log('PASS real ETH mint, exact split, inactive chain, one mint per wallet',proof.id,user.address,proof.steps.mint);
}
main().catch(e=>{console.error('Mint proof stopped:',e?.shortMessage??e?.message??'unknown');process.exitCode=1;});
