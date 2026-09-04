import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createPublicClient, http, parseAbi } from 'viem';
const source=JSON.parse(readFileSync('../web/lib/deployment.json','utf8'));
const path='deployments/testnet-v7-snapshot.json';
if(existsSync(path)) throw Error('Snapshot already exists; do not silently replace the ownership cutoff.');
const rpc=createPublicClient({transport:http(process.env.PARENT_RPC??source.network.rpc)});
if(await rpc.getChainId()!==46630)throw Error('Testnet only');
const block=await rpc.getBlock();
const mintAbi=parseAbi(['function totalMinted() view returns(uint256)']);
const deedAbi=parseAbi(['function ownerOf(uint256) view returns(address)','function identityOf(uint256) view returns((string name,string description,string imageURI,string externalURL,string[] socials))']);
const runtimeAbi=parseAbi(['function statsOf(uint256) view returns(bool,uint256,uint256,uint256,uint256)']);
const minted=await rpc.readContract({address:source.production.VoidEthGenesisMintV6,abi:mintAbi,functionName:'totalMinted',blockNumber:block.number});
if(minted!==5n)throw Error(`Expected the approved five NFTs, found ${minted}`);
const deeds=[];
for(let id=1n;id<=minted;id++){
 const [owner,identity,stats]=await Promise.all([
  rpc.readContract({address:source.production.VoidChainDeed,abi:deedAbi,functionName:'ownerOf',args:[id],blockNumber:block.number}),
  rpc.readContract({address:source.production.VoidChainDeed,abi:deedAbi,functionName:'identityOf',args:[id],blockNumber:block.number}),
  rpc.readContract({address:source.production.VoidChainAppRuntime,abi:runtimeAbi,functionName:'statsOf',args:[id],blockNumber:block.number}),
 ]);
 deeds.push({id,owner,identity,stats,inLegacyPool:owner.toLowerCase()===source.testnet.VoidGenesisNftAmmV6.toLowerCase()});
}
const snapshot={network:46630,block:block.number,blockHash:block.hash,source,deeds,policy:'New testnet VOID economy; preserve NFT IDs and current ownership. Legacy pool custody maps to replacement pool. Old contracts remain unchanged.'};
writeFileSync(path,JSON.stringify(snapshot,(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
console.log(JSON.stringify({block:String(block.number),deeds},(_k,v)=>typeof v==='bigint'?v.toString():v,2));
