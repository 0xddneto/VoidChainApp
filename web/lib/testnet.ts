/**
 * The addresses and ABIs of the stack on testnet.
 *
 * `deployment.json` is written by `deploy-testnet-completo.ts` in the contracts
 * repository, never by hand. If someone redeploys, the file changes and this
 * layer follows — no address is hardcoded.
 */
import deployment from './deployment.json';

export const DEPLOY = deployment as typeof deployment & {
  production: typeof deployment.production & { VoidCollectionMintPaymaster?: string };
};

export const RH_TESTNET = {
  chainIdHex: '0xb626', // 46630
  chainId: 46630,
  chainName: 'Robinhood Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://robinhood-testnet.drpc.org'],
} as const;

/** Only what the page calls. A lean ABI is an ABI you can read. */
export const ABI = {
  token: [
    { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'getPastVotes', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'getPastTotalSupply', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
    { type: 'function', name: 'mintTo', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] },
  ],
  amm: [
    { type: 'function', name: 'available', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'priceToBuy', stateMutability: 'view', inputs: [{ type: 'bool' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'payoutToSell', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'peek', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256[]' }] },
    { type: 'function', name: 'buyRandom', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'sell', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  ],
  collectionMarket: [
    { type: 'function', name: 'quoteRandom', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }, { type: 'uint256' }] },
    { type: 'function', name: 'hasMinted', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
    { type: 'function', name: 'buyRandomFor', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  ],
  deed: [
    { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
    { type: 'function', name: 'identityOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'tuple', components: [
      { name: 'name', type: 'string' }, { name: 'description', type: 'string' },
      { name: 'imageURI', type: 'string' }, { name: 'externalURL', type: 'string' },
      { name: 'socials', type: 'string[]' },
    ] }] },
    { type: 'function', name: 'isApprovedForAll', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
    { type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'bool' }], outputs: [] },
    { type: 'function', name: 'rename', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }, { type: 'string' }], outputs: [] },
  ],
  runtime: [
    { type: 'function', name: 'statsOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }] },
    { type: 'function', name: 'activate', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }, { type: 'uint256' }], outputs: [] },
    { type: 'function', name: 'feeOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'setTollCeiling', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }, { type: 'uint256' }], outputs: [] },
    { type: 'function', name: 'setFee', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }, { type: 'uint256' }], outputs: [] },
    { type: 'function', name: 'setPermissionlessDeploy', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }, { type: 'bool' }], outputs: [] },
    { type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes' }, { type: 'uint256' }], outputs: [{ type: 'bytes' }] },
  ],
  paymaster: [
    { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  ],
  mintPaymaster: [
    { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  ],
  daoFactory: [
    { type: 'function', name: 'daoOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  ],
  dao: [
    { type: 'function', name: 'proposalCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'QUORUM_BPS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'VOTING_PERIOD', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'proposals', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [
      { name: 'actionsHash', type: 'bytes32' }, { name: 'descriptionHash', type: 'bytes32' },
      { name: 'snapshotBlock', type: 'uint256' }, { name: 'snapshotSupply', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }, { name: 'forVotes', type: 'uint256' },
      { name: 'againstVotes', type: 'uint256' }, { name: 'actionCount', type: 'uint256' },
      { name: 'executed', type: 'bool' },
    ] },
    { type: 'function', name: 'proposalDescription', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'string' }] },
    { type: 'function', name: 'proposalAction', stateMutability: 'view', inputs: [{ type: 'uint256' }, { type: 'uint256' }], outputs: [{ name: 'target', type: 'address' }, { name: 'data', type: 'bytes' }] },
    { type: 'function', name: 'state', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint8' }] },
    { type: 'function', name: 'hasVoted', stateMutability: 'view', inputs: [{ type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
    { type: 'function', name: 'propose', stateMutability: 'nonpayable', inputs: [
      { name: 'actions', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'data', type: 'bytes' }] },
      { name: 'description', type: 'string' },
    ], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'castVote', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }, { type: 'bool' }], outputs: [] },
    { type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
  ],
  // Read-only compatibility for the test stack deployed before general DAO proposals.
  daoLegacy: [
    { type: 'function', name: 'proposalCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'QUORUM_BPS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'VOTING_PERIOD', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'proposals', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [
      { name: 'feeLimitUsd', type: 'uint256' }, { name: 'snapshotBlock', type: 'uint256' },
      { name: 'snapshotSupply', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
      { name: 'forVotes', type: 'uint256' }, { name: 'againstVotes', type: 'uint256' },
      { name: 'executed', type: 'bool' },
    ] },
    { type: 'function', name: 'state', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint8' }] },
    { type: 'function', name: 'hasVoted', stateMutability: 'view', inputs: [{ type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
    { type: 'function', name: 'propose', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'castVote', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }, { type: 'bool' }], outputs: [] },
    { type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
  ],
  counter: [
    { type: 'function', name: 'count', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'bump', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  ],
} as const;

export const chainIdForToken = (tokenId: number) =>
  Number(BigInt(DEPLOY.chainIdBase) + BigInt(tokenId) - 1n);

/** Formats wei with enough places to read, without turning into noise. */
export function fmt(v: bigint, decimals = 18, places = 4): string {
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  if (frac === 0n) return whole.toLocaleString('en-US');
  const s = frac.toString().padStart(decimals, '0').slice(0, places).replace(/0+$/, '');
  return s ? `${whole.toLocaleString('en-US')}.${s}` : whole.toLocaleString('en-US');
}
