import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
export const sponsoredTypes = {
  Spend: [{name:'token',type:'address'},{name:'amount',type:'uint256'}],
  SpendNft: [{name:'collection',type:'address'},{name:'tokenId',type:'uint256'}],
  SponsoredCall: [{name:'user',type:'address'},{name:'tokenId',type:'uint256'},{name:'target',type:'address'},
    {name:'data',type:'bytes'},{name:'maxToll',type:'uint256'},{name:'maxGasVoid',type:'uint256'},
    {name:'callGasLimit',type:'uint256'},{name:'spends',type:'Spend[]'},{name:'nftSpends',type:'SpendNft[]'},
    {name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'}],
} as const;
type Sponsored = { user: Address; tokenId: bigint; target: Address; data: Hex; maxToll: bigint; maxGasVoid: bigint;
  callGasLimit: bigint; spends: {token:Address;amount:bigint}[]; nftSpends:{collection:Address;tokenId:bigint}[]; nonce:bigint;deadline:bigint };
/** Authenticate before reserving a victim's nonce or consuming their quota. */
export async function authenticSponsored(message: Sponsored, signature: Hex, paymaster: Address): Promise<boolean> {
  try {
    const signer = await recoverTypedDataAddress({ domain:{name:'VoidPaymaster',version:'1',chainId:46630,verifyingContract:paymaster},
      types:sponsoredTypes, primaryType:'SponsoredCall',message,signature });
    return signer.toLowerCase() === message.user.toLowerCase();
  } catch { return false; }
}
