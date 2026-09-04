/** Exercise the published HTTP relay using the authorized project test wallet. */
import { requireSponsoredSuccess } from "../web/lib/sponsored-receipt";
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, parseAbi, parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deploy = JSON.parse(readFileSync(resolve(root, 'web/lib/deployment.json'), 'utf8'));
const dex = JSON.parse(readFileSync(resolve(root, 'web/lib/dex-chain1.json'), 'utf8'));
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) throw new Error('DEPLOYER_PRIVATE_KEY is required.');
const rpc = createPublicClient({ transport: http(process.env.PARENT_RPC ?? deploy.network.rpc) });
const project = privateKeyToAccount(key as Hex);
const user = project;
const runtime = deploy.production.VoidChainAppRuntime as Address;
const paymaster = deploy.production.VoidPaymaster as Address;
const voidToken = deploy.testnet.VoidTestToken as Address;
const pool = dex.pools[0].address as Address;
const asset = dex.pools[0].asset as Address;
const zeroForOne = asset.toLowerCase() === dex.pools[0].token0.toLowerCase();
const CHAIN = 1n; const amountIn = parseEther('1'); const maxGasVoid = parseEther('10000');
const pairAbi = parseAbi(['function reserve0() view returns(uint112)','function reserve1() view returns(uint112)','function quote(bool,uint256) view returns(uint256)','function swap(bool,uint256,uint256) returns(uint256)']);
const gatewayAbi = parseAbi(['function query(bytes) view returns(bytes)']);
const tokenAbi = parseAbi(['function mintTo(address,uint256)','function transfer(address,uint256) returns(bool)','function nonces(address) view returns(uint256)']);
const runtimeAbi = parseAbi(['function feeOf(uint256) view returns(uint256)','function statsOf(uint256) view returns(bool,uint256,uint256,uint256,uint256)']);
const paymasterAbi = parseAbi(['function nonces(address) view returns(uint256)','function sponsorWithAssetPermits((address user,uint256 tokenId,address target,bytes data,uint256 maxToll,uint256 maxGasVoid,uint256 callGasLimit,(address token,uint256 amount)[] spends,(address collection,uint256 tokenId)[] nftSpends,uint256 nonce,uint256 deadline),bytes,(address token,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)[]) returns(bool,bytes)']);
const permitTypes={Permit:[{name:'owner',type:'address'},{name:'spender',type:'address'},{name:'value',type:'uint256'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'}]} as const;
const sponsoredTypes={Spend:[{name:'token',type:'address'},{name:'amount',type:'uint256'}],SpendNft:[{name:'collection',type:'address'},{name:'tokenId',type:'uint256'}],SponsoredCall:[{name:'user',type:'address'},{name:'tokenId',type:'uint256'},{name:'target',type:'address'},{name:'data',type:'bytes'},{name:'maxToll',type:'uint256'},{name:'maxGasVoid',type:'uint256'},{name:'callGasLimit',type:'uint256'},{name:'spends',type:'Spend[]'},{name:'nftSpends',type:'SpendNft[]'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'}]} as const;
const split=(s:Hex)=>({v:Number.parseInt(s.slice(130,132),16),r:s.slice(0,66) as Hex,s:`0x${s.slice(66,130)}` as Hex});
async function wait(hash:Hex){const r=await rpc.waitForTransactionReceipt({hash});if(r.status!=='success')throw Error(`reverted ${hash}`);return r}
async function query(functionName:string,args:readonly unknown[]=[]){const data=encodeFunctionData({abi:pairAbi,functionName:functionName as never,args:args as never});const raw=await rpc.readContract({address:pool,abi:gatewayAbi,functionName:'query',args:[data]}) as Hex;return decodeFunctionResult({abi:pairAbi,functionName:functionName as never,data:raw})}
if(await rpc.getChainId()!==46630)throw Error('wrong network');
const [fee,requestNonce,beforeStats,quoted]=await Promise.all([rpc.readContract({address:runtime,abi:runtimeAbi,functionName:'feeOf',args:[CHAIN]}) as Promise<bigint>,rpc.readContract({address:paymaster,abi:paymasterAbi,functionName:'nonces',args:[user.address]}) as Promise<bigint>,rpc.readContract({address:runtime,abi:runtimeAbi,functionName:'statsOf',args:[CHAIN]}) as Promise<readonly[boolean,bigint,bigint,bigint,bigint]>,query('quote',[zeroForOne,amountIn]) as Promise<bigint>]);
if(quoted===0n)throw Error('pool has no quote'); const deadline=BigInt(Math.floor(Date.now()/1000)+600);const data=encodeFunctionData({abi:pairAbi,functionName:'swap',args:[zeroForOne,amountIn,quoted*9950n/10000n]});const request={user:user.address,tokenId:CHAIN,target:pool,data,maxToll:fee,maxGasVoid,callGasLimit:700000n,spends:[{token:asset,amount:amountIn}],nftSpends:[],nonce:requestNonce,deadline};
const nonceVoid=await rpc.readContract({address:voidToken,abi:tokenAbi,functionName:'nonces',args:[user.address]}) as bigint;const nonceAsset=await rpc.readContract({address:asset,abi:tokenAbi,functionName:'nonces',args:[user.address]}) as bigint;
const permitVoid=await user.signTypedData({domain:{name:'VOID',version:'1',chainId:46630,verifyingContract:voidToken},types:permitTypes,primaryType:'Permit',message:{owner:user.address,spender:paymaster,value:fee+maxGasVoid,nonce:nonceVoid,deadline}});const permitAsset=await user.signTypedData({domain:{name:'Void Test Dollar',version:'1',chainId:46630,verifyingContract:asset},types:permitTypes,primaryType:'Permit',message:{owner:user.address,spender:runtime,value:amountIn,nonce:nonceAsset,deadline}});const signature=await user.signTypedData({domain:{name:'VoidPaymaster',version:'1',chainId:46630,verifyingContract:paymaster},types:sponsoredTypes,primaryType:'SponsoredCall',message:request});

const permits=[{token:voidToken,spender:paymaster,value:fee+maxGasVoid,deadline,...split(permitVoid)},{token:asset,spender:runtime,value:amountIn,deadline,...split(permitAsset)}];
const response = await fetch('https://voiddex-alpha.vercel.app/relay', {
 method:'POST', headers:{'content-type':'application/json'},
 body:JSON.stringify({request,signature,permits},(_k,v)=>typeof v==='bigint'?v.toString():v),
});
const result=await response.json() as {hash?:Hex,error?:string};
if(!response.ok)console.log('Public relay response:',response.status,result.error);
if(!response.ok||!result.hash)throw Error(result.error??'HTTP relay failed');
const receipt=await wait(result.hash);
requireSponsoredSuccess(receipt,paymaster,user.address,CHAIN);
const afterStats=await rpc.readContract({address:runtime,abi:runtimeAbi,functionName:'statsOf',args:[CHAIN]}) as readonly[boolean,bigint,bigint,bigint,bigint];
if(afterStats[4]!==beforeStats[4]+1n||afterStats[3]!==beforeStats[3]+fee)throw Error('Runtime accounting did not match');
console.log('PASS: production HTTP relay, successful app event and exact runtime revenue');
console.log(result.hash);
