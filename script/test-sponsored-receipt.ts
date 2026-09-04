import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, parseAbi, type TransactionReceipt } from 'viem';
import { requireSponsoredSuccess } from '../web/lib/sponsored-receipt.js';

const paymaster = '0x1111111111111111111111111111111111111111';
const user = '0x2222222222222222222222222222222222222222';
const abi = parseAbi([
  'event Sponsored(address indexed user,address indexed relayer,uint256 indexed tokenId,uint256 toll,uint256 gasVoid,uint256 marginVoid,uint256 ethReimbursed)',
  'event ExecutionFailed(address indexed user,uint256 indexed tokenId,address target,bytes reason)',
]);
const success = {
  address: paymaster,
  topics: encodeEventTopics({ abi, eventName: 'Sponsored', args: { user, relayer: paymaster, tokenId: 1n } }),
  data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [1n, 1n, 1n, 1n]),
};
const failure = {
  address: paymaster,
  topics: encodeEventTopics({ abi, eventName: 'ExecutionFailed', args: { user, tokenId: 1n } }),
  data: encodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], [paymaster, '0x12345678']),
};
const receipt = (logs: unknown[], status = 'success') => ({ logs, status }) as TransactionReceipt;
assert.doesNotThrow(() => requireSponsoredSuccess(receipt([success]), paymaster, user, 1n));
assert.throws(() => requireSponsoredSuccess(receipt([failure, success]), paymaster, user, 1n), /operation failed/);
assert.throws(() => requireSponsoredSuccess(receipt([success, failure]), paymaster, user, 1n), /operation failed/);
assert.throws(() => requireSponsoredSuccess(receipt([]), paymaster, user, 1n), /No matching/);
assert.throws(() => requireSponsoredSuccess(receipt([success], 'reverted'), paymaster, user, 1n), /reverted/);
assert.throws(() => requireSponsoredSuccess(receipt([success]), paymaster, user, 2n), /No matching/);
assert.throws(() => requireSponsoredSuccess(receipt([{ ...success, address: user }]), paymaster, user, 1n), /No matching/);
assert.throws(() => requireSponsoredSuccess(receipt([success]), paymaster, paymaster, 1n), /No matching/);
assert.throws(() => requireSponsoredSuccess(receipt([{ ...success, data: '0x' }]), paymaster, user, 1n), /No matching/);
console.log('PASS: nine sponsored receipt cases, including wrong emitter, wrong user and malformed confirmation.');
