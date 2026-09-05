# Engineering review — 2026-09-05

This is an internal review, not an independent audit or a mainnet approval.
The public contract deployment remains V10. V11 migration is still incomplete.

## Confirmed findings and changes

| Finding | Change | Boundary |
| --- | --- | --- |
| Mint initially rendered zero liquidity and an unavailable TWAP before reads completed. | Explicit loading state; verified price/pool gates, expiring reads, transaction target/value shown before signature. | Web release |
| No stable contracts/security pages; address links absent beside documentation addresses. | `/contracts`, `/security`, checksummed explorer links and `/api/release`. | Web release |
| Multiple public manifests could drift. | Build-time address/chain consistency assertion and a shared manifest fingerprint checked before signing. | Detects mismatch, not a defense against a fully compromised origin |
| Market sale frontend encoded `sellWithPermit(uint256,uint256,bytes)` while the HTTP relay decoded the retired v/r/s selector. | Corrected relay ABI; regression test. | No contract redeploy needed |
| Failed state reads left old market quotes actionable. | Clear quotes during refresh/failure; expire reads; check current chain activation, registration and Paymaster reserve. | UI policy plus on-chain simulation |
| Retry updates overwrote the row used to count rate limits; distinct users raced the shared client limit. | Independent attempt ledger and client/user serialization across both products. | Database migration 008 |
| HTTP Content-Length could be omitted or forged. | Incremental byte-limited JSON reads; malformed top-level values rejected. | Profile and relay endpoints |
| Profile signatures could be replayed after a later update. | Consume signed nonce in the same transaction as the profile write. | Database migration 008 |
| Apps removed then registered in the same indexing batch disappeared. | Merge registration/removal events in block/log order in both indexers. | Regression verifies both event orders |
| Fresh schema omitted `indexer_state.last_indexed_hash`. | Added missing column to canonical schema. | Existing production migration already supplied it |
| RPC log/block disagreement could persist mixed-fork events. | Refuse a batch when any event hash differs from its retrieved block. | Does not replace parent-chain finality |
| Excluded governance reserves still returned voting power. | Zero voting power for constructor-excluded addresses. | V11 source only; live adapter remains unchanged |
| Receipt timeout told the user to sign again after broadcast. | Return the broadcast hash with submitted status instead. | The receipt remains the execution authority |
| A forged wallet signature could reserve a victim's relay nonce before rejection. | Authenticate the typed-data signer before database reservation in both products. | Contract replay protection remains authoritative |
| Private vulnerability reporting was documented but disabled. | Enabled on protocol and DEX repositories. | GitHub setting |
| Reference launchpad finalized using its entire token balance, including other sales. | Per-sale stock ledger, exact incoming amounts, reentrancy guard. | Source; regression covers two creators sharing one sale token |
| Optional L3 controller ignored token return values and retained obsolete scheduled increases. | Check transfers/approvals, clear residual approvals and superseded schedules, validate fee bounds. | Optional L3 source |
| Runtime and revenue router ignored approval failure. | Revert atomically before settlement; regression preserves unpaid revenue. | Replacement source, not an in-place edit of live bytecode |
| TWAP ETH/USD conversion accepted future timestamps or incomplete rounds. | Shared strict feed validation and four oracle regression tests. | Replacement oracle source |

## Feedback verification

A fresh browser load of the public mint displayed V10, then six minted Deeds,
960,620 VOID pool reserve and ready price status. The initial placeholders did
match the developer's report. No V7 response was observed in that check; that is
not proof that every CDN cache or old browser session was current.

Read-only market quotes were 507,500 VOID random buy, 512,500 VOID selected buy
and 492,500 VOID sale payout. Total fees are therefore 1.5%, 2.5%, and 1.5%,
including the 0.5% protocol fee, before the ChainApp transaction/gas charge.

## Validation

- Baseline local Foundry suite: 323 passing tests in 38 suites; security
  regressions add sale isolation, failed approvals and feed validation cases.
- Web, script and standalone indexer typechecks; production builds for both sites.
- Disposable Postgres regression tests: cross-product duplicate nonce,
  repeated failed attempts, 30 concurrent client requests with a 20-request cap,
  replayed profile nonce, and app remove/register order.
- Streamed oversized request cancellation, malformed profile fields,
  manifest consistency and NFT sale ABI regressions.
- Production database migration 008 only adds tables/indexes; no balances,
  profiles, tokens or NFTs were reset.
- GitHub's heavy Foundry run passed with 4,096 fuzz runs and the additional
  1,024-run RedTeam4 invariant job. The disposable database restore drill passed.
- The initial security-nightly workflow exposed static-analysis and secret-scan
  failures. Local historical Gitleaks now passes; exceptions require exact
  public-address formats AND known public-manifest paths, or the two exact test
  literals. A generated synthetic private-key positive control still fails as
  required. Slither's high-severity gate passes after fixes and individually
  documented intentional-operation annotations. Dependency internals are kept
  out of this first-party code gate, not removed from dependency audits.
  The original failed run remains [recorded](https://github.com/0xddneto/VoidChainApp/actions/runs/33945741192).

## Remaining work and recommended order

1. Finish the V11 exact-state migration adapters before changing public contract
   addresses: app custody and LP shares must be preserved, not just NFT owners
   and wallet VOID balances. Retire old DEX pools without stranding withdrawals.
2. Rehearse the full migration on a fork and compare conservation invariants,
   ownership epochs, claims, DAO state, escrow liabilities and external assets.
3. Test disaster recovery against an encrypted production backup and confirm
   provider PITR. A disposable-database drill is not production backup proof.
4. Use multisig governance before mainnet. A 48-hour EOA timelock is still a
   single-key trust dependency. Snapshot voting stops same-proposal double
   counting, but cannot eliminate concentrated/borrowed voting power.
5. Add independent relayer failover, nonce reconciliation after RPC broadcast
   uncertainty, pre-simulation admission limits and database availability tests.
6. Expand monitoring from Chain 1 to a bounded registry-wide verified-app scan;
   add alerts for indexer lag, failed sponsorship ratio and keeper wallets.
7. Consider a governance execution grace period and exit window. Do not change
   the five-day/no-token-lock rule without a documented product decision.
8. Obtain independent contract review and economic/oracle stress testing before
   real-value liquidity. Compiler or OpenZeppelin major upgrades require their
   own bytecode review; they are not routine dependency merges.
9. Preserve static-analysis reports and high-severity gating on subsequent
   changes. Reviewed annotations are operation-specific, not detector-wide.

The shared gateway cannot sanitize arbitrary malicious application logic.
It gates entry and scopes user budgets; builders must still audit their apps.
L3 deployment remains optional and holder-funded, not a completed feature of
this shared Runtime.
