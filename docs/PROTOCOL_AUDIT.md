# Protocol review — 2026-09-04

Follow-up findings and validation: [2026-09-05 review](ASTRA_REVIEW_2026_09_05.md).
Rows below describing V11 emergency controls, 1% quorum, emission vault or L3
registry are source changes, not active V10 protections. Emission and per-chain
budgets use fixed epochs, not rolling windows. L3 ID uniqueness is local to the
registry, not a global EIP-155 reservation authority.

## V10 deployment and V11 source hardening

The current public deployment supersedes the earlier V8 testnet control plane.
V10 makes the Runtime oracle one-time and immutable,
places Paymaster and Treasury administration behind a public 48-hour timelock,
preserves the block-pinned Deed owners and the exact one-billion-token ledger,
and verifies all 22 deployed contracts in the explorer. The proposer remains a
single test wallet; this is explicitly not the mainnet governance design.

## Scope and evidence

This review covered every tracked source area: Solidity contracts, Foundry
tests, deployment/proof scripts, both relay endpoints, VoidScan, VoidDEX,
indexer, database schema, infrastructure, manifests and public documentation.
It is an internal engineering review, not an independent security audit.

Evidence collected after the changes:

- Foundry validation includes fuzz, invariant, red-team and scale suites; the V11 validation record tracks the current run.
- VoidScan and VoidDEX production builds pass; script and indexer typechecks pass.
- The V10 migration tests reconcile the exact token ledger, migrated Deeds,
  resumed VOID/ETH pool and non-duplicated escrow liabilities.
- Two consecutive swaps through the production HTTP relay succeeded. The setup
  call supplied two missing token permits; the repeat call supplied zero permits
  and used only its fresh, bounded SponsoredCall signature.
- The keeper reports the Paymaster healthy, with its refill route pinned to the
  locked VOID/ETH pool.
- No private key, mnemonic, credential file or real `.env` is tracked. Only
  `.env.example` files are versioned.

## Findings fixed in this pass

| Severity | Finding | Resolution |
| --- | --- | --- |
| Critical | Profile signatures authenticated an address and timestamp but did not bind the profile content. A captured signature could change the submitted fields during its validity window. | Browser and server now sign/verify the same canonical profile hash before any database write. |
| High | Official DEX and market interfaces generated fresh permits on every action, causing up to three wallet signatures even when sufficient allowances already existed. | Interfaces now read allowances, request setup permits only when missing, and reuse them. After setup, a normal action has one bounded `SponsoredCall` signature. |
| High | Relay validation required an exact complete permit list, so the contract's safe existing-allowance path could never be used by the official interface. | All relays now accept zero or partial setup permits, reject unrelated/insufficient permits, and leave final allowance validation to the Paymaster. |
| High | The generic public relay sent a transaction without first simulating the inner result, unlike the DEX and market relays. | It now simulates and refuses a failing app action before spending relayer ETH. |
| Medium | Owners could see lifetime revenue but had no fixed claim control. | The chain owner panel now reads pending, preserved and Treasury-ready on-chain balances and exposes Claim Revenue only to the connected current owner. |
| Medium | The V7 audit compared snapshot owners with current owners, so a valid NFT sale made the audit fail. | It now verifies old ownership at the snapshot block and imported ownership at the migration-completion block; later transfers are explicitly allowed. |
| Medium | VoidScan shipped obsolete V2/V3/V4 pending manifests, a V4 activation screen and an unused old market resolver. | Pending manifests and resolver were removed; `/migrate` is a harmless redirect and no longer imports retired contracts. |
| Medium | README, architecture, Paymaster operations and release steps described the pre-genesis VOID mint flow and obsolete deploy command. | Documentation now describes V7 ETH genesis, the NFT/VOID market, five-minute testnet TWAP, owner claim and the canonical V7 deployment/audit flow. |
| Low | VoidDEX let Next.js guess the monorepo root and emitted a multiple-lockfile warning. | Its Turbopack root is now explicit. |
| High | Concurrent HTTP submissions could relay the same signed user nonce from separate serverless instances before either transaction mined. | Both public relays now reserve `(paymaster, user, nonce)` atomically across products, serialize each relayer EOA nonce with a database advisory lock, record broadcast outcomes, rate-limit by wallet and hashed client identifier, and fail closed when admission control is unavailable. |
| Medium | The explorer indexed the parent-chain tip immediately and had no explicit confirmation policy. | Both indexer implementations now hold back 20 parent blocks by default; the depth is configurable with `INDEXER_CONFIRMATIONS`. |
| High | One compromised or abusive ChainApp could consume the shared ETH reserve while staying inside per-call limits. | The V11 Paymaster source adds a governance-bounded 24-hour ETH budget per Deed in addition to the existing per-block, gas-price and signed user caps. A zero policy fails closed. |
| High | The DEX pair trusted requested token amounts and could mint phantom LP or corrupt reserves with fee-on-transfer tokens. | V4 measures balance deltas on deposits and swaps, checks actual output deltas, updates from canonical balances and explicitly rejects fee-on-transfer assets. |
| High | Runtime incident response depended on ordinary governance paths. | A one-time pause-only guardian can halt the protocol or an app; only the recovery governor resumes the protocol and only the affected chain DAO resumes that app. The guardian cannot resume or change policy. |
| Medium | Successful execution events hid failed inner app calls and gas cost. | Both indexers now correlate Paymaster `Sponsored` and `ExecutionFailed` events and persist success, toll, gas VOID, margin, ETH reimbursement and failure bytes. |
| Medium | Reorg/deployment resets used destructive cascades that could erase wallet profiles. | Projection resets now delete only derived chain data and preserve wallet-authored profile records. |
| Medium | The 10% DAO quorum used total supply and was unreachable while most VOID remained in escrow. | Governance supply excludes constructor-fixed reserves and each chain uses 1% of eligible circulating supply; voting remains wallet balance with no token lock and lasts five days. |
| Medium | Emission inventory had no rolling release ceiling. | `VoidEmissionVaultV11` enforces both a timelock and immutable per-epoch cap. |
| Medium | An L3 handoff was only a downloaded checklist. | `VoidL3MigrationRegistry` records a holder-controlled, collision-free EIP-155 reservation and hashes of the audited configuration, RPC and explorer. It explicitly does not attest external safety. |
| Medium | Profile upload size relied on a declared header and accepted content by label alone. | The API measures the actual request and decoded image bytes, verifies PNG/JPEG/WebP magic, rate-limits through the shared server path and verifies EOA or ERC-1271 signatures. |

## Wallet prompt invariant

The action signature is always one EIP-712 `SponsoredCall`. It binds user,
chain, app, calldata, exact fungible/NFT budgets, fee cap, gas cap, nonce and
deadline. The Runtime creates those spend budgets only for the duration of that
call.

V10 VOID grants authority only to the permanently frozen Runtime and Paymaster,
so a VOID-only first use needs no approval and only the SponsoredCall signature.
External EIP-2612 tokens have independent signing domains and still require a
permit when allowance is absent. NFT sales still require a Deed-specific
ERC-4494 permit because transferring the asset is separate from paying the
chain fee.

## High-severity linter triage

Foundry's high-severity lint reports deliberate low-level transfers and the app
gateway delegatecall. Each active case was inspected:

- Genesis ETH transfers are to constructor-pinned Paymaster and protocol
  recipients and execute under `nonReentrant`; a failure reverts the full mint.
- The VOID/ETH pool returns ETH only to `msg.sender`, updates reserves before
  the call and is `nonReentrant`.
- Paymaster ETH withdrawal is governance-only, bounded by its balance and
  `nonReentrant`. Relayer reimbursement has a fixed recipient from `msg.sender`.
- Runtime and Paymaster `transferFrom` sources come from an EIP-712 recovered
  user plus an exact in-call budget; arbitrary callers cannot choose another
  user's funds.
- The gateway delegatecall is isolated to the newly created gateway's own
  storage and balance. A malicious initializer can break its publisher's new
  gateway, but registration occurs only after construction and it cannot gain
  Runtime, Deed, Treasury or another gateway storage.
- Warnings in retired testnet/controller code are not public V7 entrypoints and
  remain only where regression or future-L3 tests still import them.

## Remaining gates and architectural limits

These are not presented as solved:

1. The shared Runtime is application isolation, not 1,111 independent L3s.
2. The contracts have no external audit. Mainnet deployment remains blocked.
3. Testnet governance is a single test wallet. Production needs a multisig,
   timelock policy, rotation procedure and public role inventory.
4. The public RPC, Vercel relayers and single database remain availability
   dependencies. RPC fallback, persistent relayer coordination, independent
   service keys, monitoring and a reproducible restore drill now exist;
   production still needs provider PITR and an encrypted off-provider backup.
5. The testnet's five-minute TWAP and shallow valueless liquidity do not prove
   manipulation resistance under real capital.
6. The indexer mirrors parent-chain events and does not itself prove L3 state.
   Production indexing needs a reviewed confirmation/reorg policy.
7. A universal first-use single prompt for arbitrary ERC-20 and ERC-721 assets
   requires a separately audited Permit2, account-abstraction or native
   intent-token design. V10 safely removes VOID setup prompts; it does not pretend
   different token signature domains are one signature.

## Release decision

The currently published V10 addresses remain suitable for continued public
**testnet** testing. V11 source is not a live deployment yet and must pass a new
snapshot, deployment, explorer verification and live acceptance run before the
site points at it. Neither version is approved for mainnet or for marketing as
1,111 independent blockchains.
