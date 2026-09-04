# V10 load validation — 2026-09-04

This is testnet and deterministic local-EVM evidence, not an external audit or
a mainnet capacity claim.

## High-volume EVM run

- 308 test cases passed across 35 suites with zero failures.
- Fuzz cases ran 1,024 inputs per fuzz test.
- Stateful accounting invariants ran 512 sequences and 256,000 handler calls
  with zero reverts and no custody, fee-conservation, per-chain revenue or 2%
  protocol-split violation.
- `MegaLoadTest` provisioned 1,000 users across 100 chains and completed 4,800
  signed sponsored calls spanning swaps, launchpad purchases and NFT-market
  operations.
- `V10HundredsUsersTest` used 256 distinct zero-ETH wallets for 1,024 successful
  V10 calls. Every wallet retained zero Runtime and Paymaster allowance.
- The 1,111-chain scale suite passed both activation/isolation and independent
  revenue delivery checks.

## Live Robinhood testnet canary

Three deterministic disposable users, each holding zero ETH and granting zero
VOID allowance, signed independent faucet actions through the V10 Paymaster:

- `0x0fb9716292601aebfaeeffa6407379e2b07a267a21030f2954dff208598f51f0`
- `0x19db92079253800231f89dfbcc16c4c3ec5c90f799ba68cd5933d1559664a448`
- `0xd97523072a13df6490cd120c8b05dd5d66b7c8572292a8ddad6e88359f4ad82d`

The Runtime counter moved from 14 to 17. VoidScan indexed all three callers,
targets, transaction fees and timestamps. The Paymaster reserve moved from
`0.00103489129 ETH` to `0.00101966819 ETH`, remained above its
`0.0001 ETH` refill threshold, and the post-run public integrity monitor passed.

## Why the live canary is intentionally small

Testnet's shallow VOID/ETH pool currently prices a sponsored call at thousands
of VOID in gas reimbursement. The project wallet held about 46,751 liquid VOID
before this run. Manufacturing hundreds of public transactions would exhaust
that liquid test balance and could turn a validation exercise into a Paymaster
availability incident. High-volume correctness is therefore tested locally;
the public chain is used for bounded end-to-end confirmation against the real
RPC, oracle, Paymaster, Runtime, indexer and deployed interfaces.

Re-run locally with:

```bash
forge test --fuzz-runs 1024
```

Re-run the bounded public canary from `script/` with a new batch label:

```bash
CANARY_BATCH=unique-label CANARY_USERS=3 npm run canary:testnet-v10
```
