# V11 hardening status — 2026-09-04

## Verified locally

- Full Foundry suite: 320 tests across 37 suites passed, including the 1,111-chain
  isolation/revenue tests, 256 users making 1,024 signed actions without ETH or
  allowances, and 128,000 invariant actions in this run.
- Paymaster runtime bytecode: 20,756 bytes, leaving 3,820 bytes below EIP-170.
- VoidScan and VoidDEX production builds passed; script and indexer TypeScript
  checks passed.
- Disposable PostgreSQL 17: simultaneous VoidScan/DEX requests for the same
  Paymaster/user/nonce admitted exactly one; failed reservations were retryable;
  four simultaneous broadcasts using one relayer executed serially.
- A custom-format database backup restored into a separate empty database and
  preserved all four confirmed relay fixture records. This is a restore drill,
  not evidence of enabled Neon production backups.

## Source changes requiring contract deployment

The published manifest still identifies V10. V11 Runtime emergency roles,
1% circulating-supply DAO quorum, Treasury `claimFor`, the claim aggregator,
emission vault and L3 registry are source changes awaiting deployment and live
acceptance. The Paymaster source removes its unused legacy prepaid endpoint;
`sponsor`, `sponsorWithPermit` and the official `sponsorWithAssetPermits` remain.

The Paymaster daily budget uses the smaller of its configured absolute ceiling
and one quarter of the current ETH reserve. Usage reserves the signed worst
case, so it is conservative. Epochs are aligned to UTC days, not rolling
24-hour windows. The absolute constructor default is 2 ETH; testnet deployment
must explicitly calibrate the ceiling to actual funded capacity. Zero is
rejected by the setter.

## Work still required before V11 cutover

1. Build a fresh, block-pinned migration from the currently live V10 owners,
   balances, app custody, pool reserves, claims and active proposals. Do not
   replay the older V9/V10 deployment snapshots.
2. Deploy and verify the V11 contracts, connect emergency roles, aggregator,
   emission policy and L3 registry, then run live acceptance before changing
   public manifests. A registration alone does not deploy an external L3.
3. Retire the legacy DEX pool gateways whose publisher is the old factory.
   The current deployer cannot unregister another publisher's apps; the new
   emergency controls are not present in the immutable live Runtime.
4. Historical Paymaster backfill completed: 13 receipts scanned through block
   113115513 without changing the live indexer cursor. Both indexers correlate
   failures within each sponsorship log window, including batched relayers.
5. Confirm provider PITR and encrypted off-provider backups. CI and the local
   restore drill validate the procedure only.
6. Complete independent audit, production signer setup and real-liquidity
   oracle review before mainnet. No mainnet readiness is claimed.

For third-party external assets, the existing first-use permit requirement
still applies. A single VOID action signature does not replace an unrelated
ERC-20/ERC-721 authorization domain.
