# V11 testnet validation — 2026-09-05

## Verified locally

- Full Foundry suite: 338 tests across 40 suites passed, including the 1,111-chain
  isolation/revenue tests, 256 users making 1,024 signed actions without ETH or
  allowances, and 128,000 invariant actions in this run.
- Three additional claim integration tests use the real Runtime and Treasury:
  permissionless payout cannot redirect funds, sales preserve seller revenue,
  and parked pre-sale credit remains withdrawable without a second fee split.
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

Session-level advisory locks now use direct Postgres connections. For Neon,
the known `-pooler` hostname suffix is removed; other pooler providers must set
`DATABASE_URL_UNPOOLED` to their direct endpoint. Production currently uses a
direct endpoint; a two-session read-only lock exclusion check passed. Sessions
are destroyed after release so a failed unlock cannot leak a reusable lock.
See [Neon connection pooling](https://neon.com/docs/connect/connection-pooling).

The fresh block-pinned inventory at block 113118929 reconciled all 1 billion
VOID and six minted Deeds. It is an inventory, not a complete migration bundle:
LP shares, app custody, staking and proposal payloads still require adapters.

The canonical V11 manifest is now the only public manifest used by VoidScan,
VoidDEX and the indexer; the superseded V10 deployment remains historical and
unpublished. V11 Runtime emergency roles, 1% circulating-supply DAO quorum,
Treasury `claimFor`, the claim aggregator, emission vault and L3 registry are
deployed, verified and covered by the live acceptance audit. The Paymaster
keeps the bounded `sponsor`, `sponsorWithPermit` and
`sponsorWithAssetPermits` paths.

The Paymaster daily budget uses the smaller of its configured absolute ceiling
and one quarter of the current ETH reserve. Usage reserves the signed worst
case, so it is conservative. Epochs are aligned to UTC days, not rolling
24-hour windows. The absolute constructor default is 2 ETH; testnet deployment
must explicitly calibrate the ceiling to actual funded capacity. Zero is
rejected by the setter.

## Operational gates that remain before mainnet

1. A registration alone does not deploy an external L3; each holder still
   funds and operates that optional rollup migration separately.
2. Historical Paymaster backfill completed: 13 receipts scanned through block
   113115513 without changing the live indexer cursor. Both indexers correlate
   failures within each sponsorship log window, including batched relayers.
3. Confirm provider PITR and encrypted off-provider backups. CI and the local
   restore drill validate the procedure only.
4. Complete independent audit, production signer setup and real-liquidity
   oracle review before mainnet. No mainnet readiness is claimed.

For third-party external assets, the existing first-use permit requirement
still applies. A single VOID action signature does not replace an unrelated
ERC-20/ERC-721 authorization domain.
