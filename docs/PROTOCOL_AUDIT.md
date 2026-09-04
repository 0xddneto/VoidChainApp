# Protocol review — 2026-09-03

## Scope and evidence

This review covered every tracked source area: Solidity contracts, Foundry
tests, deployment/proof scripts, both relay endpoints, VoidScan, VoidDEX,
indexer, database schema, infrastructure, manifests and public documentation.
It is an internal engineering review, not an independent security audit.

Evidence collected after the changes:

- 287 Foundry tests pass, including fuzz, invariant, red-team and scale suites.
- VoidScan and VoidDEX production builds pass; script and indexer typechecks pass.
- The read-only V7 live audit reconciles 1,111 DAOs, 22 paid executions, runtime
  custody and the 98%/2% revenue split.
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

## Wallet prompt invariant

The action signature is always one EIP-712 `SponsoredCall`. It binds user,
chain, app, calldata, exact fungible/NFT budgets, fee cap, gas cap, nonce and
deadline. The Runtime creates those spend budgets only for the duration of that
call.

EIP-2612 permissions belong to token contracts, each with its own signing
domain. They cannot be cryptographically collapsed into the Paymaster signature
without a new token/Permit2 or smart-account architecture. V7 therefore treats
them as one-time setup: only a missing allowance asks for its token permit. A
fresh wallet may see setup prompts on its first operation; repeating the same
operation must show only the action signature. NFT sales still require a
Deed-specific permit because an ERC-721 token ID cannot be inferred from a
fungible allowance.

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
4. The public RPC, Vercel relayer and single database are availability
   dependencies. Production needs independent providers, rate limiting,
   monitoring, backups and incident response.
5. The testnet's five-minute TWAP and shallow valueless liquidity do not prove
   manipulation resistance under real capital.
6. The indexer mirrors parent-chain events and does not itself prove L3 state.
   Production indexing needs a reviewed confirmation/reorg policy.
7. A universal first-use single prompt for arbitrary ERC-20 and ERC-721 assets
   requires a separately audited Permit2, account-abstraction or native
   intent-token design. V7 safely reduces repeated prompts; it does not pretend
   different token signature domains are one signature.

## Release decision

Suitable for continued public **testnet** testing after deployment of this
frontend revision. Not approved for mainnet or for marketing as independent
blockchains. Any Solidity change requires a new deployment, bytecode
verification and full live acceptance run; this pass intentionally does not
silently replace the proven V7 contracts.
