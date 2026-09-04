/** Resumable replacement genesis. Never switches the public site pointers. */
import 'dotenv/config';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createPublicClient,createWalletClient,http,encodeDeployData,encodeFunctionData,parseAbi,parseEther,keccak256,toHex,type Abi,type Address,type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
const snapshot=JSON.parse(readFileSync('deployments/testnet-v7-snapshot.json','utf8'));
const path='deployments/testnet-v7-pending.json';
const key=process.env.DEPLOYER_PRIVATE_KEY;
if(!/^0x[0-9a-fA-F]{64}$/.test(key??''))throw Error('Missing testnet key');
const account=privateKeyToAccount(key as Hex);
const rpcUrl=process.env.PARENT_RPC??snapshot.source.network.rpc;
const rpc=createPublicClient({transport:http(rpcUrl)});
const wallet=createWalletClient({account,transport:http(rpcUrl)});
if(await rpc.getChainId()!==46630)throw Error('Testnet only');
const record:any=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{version:'v7-migrated-testnet-staged',snapshotBlock:snapshot.block,network:{chainId:46630,rpc:snapshot.source.network.rpc,deployBlock:Number(await rpc.getBlockNumber())},contracts:{},steps:{},governor:account.address};
if(record.snapshotBlock!==snapshot.block||record.governor!==account.address)throw Error('Snapshot or deployer changed');
function save(){writeFileSync(path,JSON.stringify(record,null,2)+'\n');}
function artifact(name:string){const a=JSON.parse(readFileSync(`../out/${name}.sol/${name}.json`,'utf8'));return {abi:a.abi as Abi,bytecode:(a.bytecode.object.startsWith('0x')?a.bytecode.object:`0x${a.bytecode.object}`) as Hex};}
async function wait(hash:Hex){const r=await rpc.waitForTransactionReceipt({hash});if(r.status!=='success')throw Error(`Reverted ${hash}`);return r;}
async function guardBalance(){if(await rpc.getBalance({address:account.address})<parseEther('0.006'))throw Error('Low deployment balance; checkpoint saved');}
async function deploy(label:string,name:string,args:readonly unknown[]){
 if(record.contracts[label])return record.contracts[label] as Address;
 await guardBalance();const a=artifact(name);const data=encodeDeployData({...a,args});
 if(!record.steps[`deploy:${label}`]){const h=await wallet.sendTransaction({account,chain:null,data,maxFeePerGas:(await rpc.getGasPrice())*3n,maxPriorityFeePerGas:0n});record.steps[`deploy:${label}`]=h;save();}
 const r=await wait(record.steps[`deploy:${label}`]);if(!r.contractAddress)throw Error('Missing contract');record.contracts[label]=r.contractAddress;save();console.log(label,r.contractAddress);return r.contractAddress;
}
async function send(label:string,to:Address,name:string,fn:string,args:readonly unknown[]=[],value=0n){
 if(record.steps[label])return wait(record.steps[label]);await guardBalance();
 const h=await wallet.sendTransaction({account,chain:null,to,data:encodeFunctionData({abi:artifact(name).abi,functionName:fn,args}),value,maxFeePerGas:(await rpc.getGasPrice())*3n,maxPriorityFeePerGas:0n});
 record.steps[label]=h;save();return wait(h);
}
const recipient=snapshot.source.governance.protocolTreasury as Address;
const escrow=await deploy('escrow','VoidGenesisEscrowV6',[account.address]);
const token=await deploy('token','VoidTokenV6',[escrow]);
const deed=await deploy('deed','VoidChainDeed',[46630000n,account.address,recipient,500n]);
const builder=await deploy('builder','VoidTimelockVaultV6',[account.address,86400]);
const protocol=await deploy('protocol','VoidTimelockVaultV6',[account.address,86400]);
const lock=await deploy('lpLock','VoidPermanentLpLockV6',[]);
const pool=await deploy('pool','VoidEthPoolV6',[token,account.address,lock]);
const feed=await deploy('feed','VoidFixedEthUsdFeedV6',[240000000000n]);
const twap=await deploy('twap','VoidTwapOracleV6',[pool,feed,300,3600]);
const oracle=await deploy('oracle','VoidTwapFreshnessGuardV6',[twap,900]);
const treasury=await deploy('treasury','VoidChainTreasury',[deed,token,recipient,account.address]);
const runtime=await deploy('runtime','VoidChainAppRuntimeV4',[deed,token,treasury]);
const pm=await deploy('paymaster','VoidPaymaster',[token,runtime,account.address,recipient,oracle]);
const daos=await deploy('daoFactory','VoidChainDaoFactory',[runtime,token,deed]);
const factory=await deploy('appFactory','VoidChainAppFactoryV3',[runtime]);
await send('oracle',runtime,'VoidChainAppRuntimeV4','setOracle',[oracle]);
await send('forwarder',runtime,'VoidChainAppRuntimeV4','setForwarderOnce',[pm]);
await send('daoFactory',runtime,'VoidChainAppRuntimeV4','setDaoFactoryOnce',[daos]);
await send('appFactory',runtime,'VoidChainAppRuntimeV4','setAppFactoryOnce',[factory]);
await send('settler',treasury,'VoidChainTreasury','setAuthorizedSettler',[runtime,true]);
await send('refillPool',pm,'VoidPaymaster','setVoidEthPoolOnce',[pool]);
// setMargin emits the oracle price, so apply it after the first full TWAP
// window in the proof script. Never weaken the freshness guard to bootstrap.
await send('limits',pm,'VoidPaymaster','setLimits',[parseEther('0.00002'),60000n,(await rpc.getGasPrice())*3n,parseEther('0.005')]);
await send('refillPolicy',pm,'VoidPaymaster','setRefillPolicy',[parseEther('0.0001'),parseEther('0.0005'),500n]);
for(let start=1;start<=1111;start+=20){const end=Math.min(start+19,1111);await send(`daos:${start}`,daos,'VoidChainDaoFactory','createMany',[BigInt(start),BigInt(end)]);console.log(`DAOs ${end}/1111`);}
// Temporary bootstrap custody permits restoring identity and exactly the
// existing fee before transferring control to each recorded owner.
for(const item of snapshot.deeds){
 const id=BigInt(item.id);await send(`mint:${id}`,deed,'VoidChainDeed','mint',[account.address,id]);
 if(item.identity.name)await send(`name:${id}`,deed,'VoidChainDeed','rename',[id,item.identity.name]);
 if(item.stats[0])await send(`activate:${id}`,runtime,'VoidChainAppRuntimeV4','activate',[id,BigInt(item.stats[1])]);
}
const implementation=await deploy('nftImplementation','VoidGenesisNftAmmV6',[runtime,1n,token,deed,escrow,recipient]);
const pub=await send('publishNft',factory,'VoidChainAppFactoryV3','publish',[1n,implementation,'0x',keccak256(toHex('void-v7-nft-amm'))]);
if(!record.contracts.nftAmm){const l=pub.logs.find(l=>l.address.toLowerCase()===factory.toLowerCase());if(!l?.topics[2])throw Error('Gateway not found');record.contracts.nftAmm=`0x${l.topics[2].slice(-40)}`;save();}
const market=record.contracts.nftAmm as Address;
const holders:Address[]=[];
for(const item of snapshot.deeds){const owner=item.inLegacyPool?market:item.owner;holders.push(owner);if(owner.toLowerCase()!==account.address.toLowerCase())await send(`owner:${item.id}`,deed,'VoidChainDeed','transferFrom',[account.address,owner,BigInt(item.id)]);}
const mint=await deploy('mint','VoidEthGenesisMintV7',[deed,escrow,pool,pm,recipient,parseEther('0.001'),holders]);
await send('genesisController',pool,'VoidEthPoolV6','setGenesisControllerOnce',[mint]);
await send('escrowConfigured',escrow,'VoidGenesisEscrowV6','configureOnce',[token,mint,pool,builder,protocol]);
await send('escrowMarket',escrow,'VoidGenesisEscrowV6','setNftAmmOnce',[market]);
await send('minter',deed,'VoidChainDeed','transferMinter',[mint]);
await send('fundMigration',mint,'VoidEthGenesisMintV7','fundMigration',[],parseEther('0.005'));
await send('twapBootstrap',twap,'VoidTwapOracleV6','bootstrap');
record.status='awaiting-twap-and-market-proof';record.migratedOwners=holders;save();
console.log('V7 staged; sites unchanged. Five NFTs restored and migration liquidity funded.');
