// Dependency-free so each independently installed frontend can share this
// validator without resolving packages from the other frontend's directory.
// Keccak topics are checked against viem's ABI encoder in the regression test.
const FAILED = '0x2516fb0bd9f7c697ea0f317084f0b61f0ac888c0ed5f36163004bbcb825b3179';
const SPONSORED = '0xd5ddfbd4137590b60c9557a1a80c599fdfd87911a3afc5be780e01989402c5a6';
type Receipt = {
  status: string;
  logs: readonly { address: string; topics: readonly string[]; data: string }[];
};

/** An outer success receipt does not imply that the sponsored app succeeded. */
export function requireSponsoredSuccess(receipt: Receipt, paymaster: string, user: string, tokenId: bigint) {
  if (receipt.status !== 'success') throw new Error('Sponsored transaction reverted.');
  let confirmed = false;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== paymaster.toLowerCase()) continue;
    const [signature, userTopic] = log.topics;
    if (signature !== FAILED && signature !== SPONSORED) continue;
    if (userTopic?.toLowerCase() !== `0x${user.slice(2).toLowerCase().padStart(64, '0')}`) continue;
    const chainTopic = log.topics[signature === FAILED ? 2 : 3];
    if (!chainTopic || !/^0x[0-9a-fA-F]{64}$/.test(chainTopic) || BigInt(chainTopic) !== tokenId) continue;
    if (signature === FAILED) {
      throw new Error('The app operation failed. The NFT or swap did not complete; a VOID execution charge may still apply.');
    }
    if (log.topics.length === 4 && /^0x[0-9a-fA-F]{256}$/.test(log.data)) confirmed = true;
  }
  if (!confirmed) throw new Error('No matching Paymaster confirmation was found. Check the transaction before retrying.');
}
