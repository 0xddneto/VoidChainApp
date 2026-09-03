# VoidChainApp

**A testnet runtime for 1,111 NFT-bound execution spaces.**

> **Current truth:** this is not 1,111 independent blockchains today. The
> application executes in one `VoidChainAppRuntime` on Robinhood Chain testnet
> (EIP-155 chain ID `46630`). A deed isolates an application registry, transaction fee,
> revenue accounting and owner authority by `tokenId`. It does not yet provide
> its own blocks, consensus, sequencer, RPC endpoint, bridge or native network
> gas token.

That distinction is intentional and public. The runtime is a testable first
product; an independent rollup is a separate future system, not a label applied
to a shared contract.

## What a deed controls

Each of the 1,111 `VoidChainDeed` NFTs binds its current holder to one isolated
execution space in the runtime.

- The holder configures its own space. Its DAO can pass proposals for that
  same space without reaching other deeds or protocol roles.
- Transactions only reach applications registered for the supplied `tokenId`; the
  runtime accounts for fees and revenue per deed.
- Anyone may publish an application to an open space. The holder can close new
  publication, but cannot seize a publisher's contract or its withdrawal right.
- Ownership is read from `ownerOf()` at execution time, so a deed transfer moves
  the allowed configuration authority without a migration step.
- Each deed has a deterministic DAO clone. The NFT holder creates a proposal
  with a description and optional zero-ETH actions; every wallet votes with the
  VOID it held at the previous-block snapshot. VOID stays in the wallet and the
  vote lasts five days. Each target contract keeps the DAO scoped to that deed.

VOID pays runtime transaction fees. Robinhood testnet ETH remains the native
asset used by a parent-chain transaction. `VoidPaymaster` sponsors a signed
runtime transaction, charges the signer in VOID, and lets a relayer pay that
ETH. The protocol's 2% share is sent directly to its configured public treasury
address; the deed holder's 98% remains individually claimable.

The test collection market is itself a registered app: a buyer signs the exact
VOID price and one-use permissions, while the Paymaster submits the parent-chain
transaction. The market route is intentionally closed to arbitrary targets and
permits. A chain can also vote to require its DAO before fee, activation or
new-app-policy changes; the holder keeps proposal rights but cannot bypass that
vote.

Read the precise boundary and the requirements for a future rollup in
[docs/architecture.md](docs/architecture.md). Operational gates live in
[docs/release-checklist.md](docs/release-checklist.md), the DAO rules live in
[docs/governance.md](docs/governance.md), and the tracked folder layout is
documented in [docs/repository-map.md](docs/repository-map.md).

## Components

| Path | Responsibility |
| --- | --- |
| `contracts/parent/VoidChainDeed.sol` | The fixed 1,111-deed ERC-721 collection and holder authority. |
| `contracts/parent/VoidChainAppRuntime.sol` | Token-scoped app registry, execution boundary, fee collection and revenue accounting. |
| `contracts/parent/VoidChainDao*.sol` | Deterministic per-deed DAO factory and general, deed-scoped governance. |
| `contracts/parent/VoidPaymaster.sol` | Signed, budgeted sponsorship of runtime transactions. |
| `contracts/apps/` | Example permissionless apps (swap, market and launchpad). |
| `indexer/` | Robinhood event indexer and Postgres projection. |
| `infra/` | Versioned local Postgres infrastructure and operator instructions. |
| `web/` | VoidScan explorer, profile and test-deed claim interface. |
| `script/deploy-testnet.ts` | Reproducible testnet deployment, including all 1,111 DAO clones. |

## Local development

Prerequisites: Node.js, Foundry and Docker (only for Postgres/indexer work).

```bash
npm ci
forge install foundry-rs/forge-std --no-commit
forge test
```

For the explorer:

```bash
docker compose -f infra/docker-compose.yml up -d
cd indexer && npm ci && npm run dev
cd ../web && npm ci && npm run dev
```

Open `http://localhost:3000`. The frontend reads deployment addresses from
`web/lib/deployment.json`; the deployment script refreshes that file when a
testnet stack is deployed.

For deployment and recovery utilities, install the separately scoped script
dependencies once with `cd script && npm install`. `npm run deploy:testnet`
refuses an RPC whose chain ID is not `46630`. The ETH recovery utility starts
as a dry run, requires explicit `--execute`, and likewise refuses any other
network; it never prints a private key.

The `MegaLoadTest` deliberately constructs 100 spaces and executes 4,800
signed sponsored calls in one test transaction. Its higher Foundry harness gas
limit is only for test scaffolding, not a production block-size claim.

## Status and safety

This repository is **pre-audit testnet software**. Testnet VOID has no value;
the faucet and price oracle are test fixtures. Do not treat a passing local
suite as an audit, a mainnet readiness claim or evidence of an independent
network. The release checklist requires an external security audit, verified
deployments and a real operations plan before any value-bearing launch.

## License

MIT
