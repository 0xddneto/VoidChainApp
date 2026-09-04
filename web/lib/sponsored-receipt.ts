import { decodeEventLog, parseAbi, type Address, type TransactionReceipt } from 'viem';

const events = parseAbi([
  'event ExecutionFailed(address indexed user,uint256 indexed tokenId,address target,bytes reason)',
  'event Sponsored(address indexed user,address indexed relayer,uint256 indexed tokenId,uint256 toll,uint256 gasVoid,uint256 marginVoid,uint256 ethReimbursed)',
]);

/** An outer success receipt does not imply that the sponsored app succeeded. */
export function requireSponsoredSuccess(receipt: TransactionReceipt, paymaster: Address, user: Address, tokenId: bigint) {
  if (receipt.status !== 'success') throw new Error('Sponsored transaction reverted.');
  let confirmed = false;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== paymaster.toLowerCase()) continue;
    let event;
    try { event = decodeEventLog({ abi: events, data: log.data, topics: log.topics }); }
    catch { continue; }
    if (event.args.user.toLowerCase() !== user.toLowerCase() || event.args.tokenId !== tokenId) continue;
    if (event.eventName === 'ExecutionFailed') {
      throw new Error('The app operation failed. The NFT or swap did not complete; a VOID execution charge may still apply.');
    }
    if (event.eventName === 'Sponsored') confirmed = true;
  }
  if (!confirmed) throw new Error('No matching Paymaster confirmation was found. Check the transaction before retrying.');
}
