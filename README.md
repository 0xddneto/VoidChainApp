# VoidChainApp

VoidChainApp is a Robinhood Chain Testnet protocol for **1,111 NFT-owned
execution spaces**. Each `VoidChainDeed` owns a separate application registry,
transaction-fee policy, revenue account, identity and DAO inside a shared EVM
runtime.

> This is pre-audit testnet software. The current spaces are not independent
> blockchains: they share Robinhood Chain Testnet, one runtime and one RPC.
> Separate sequencing, blocks, state, bridges and RPCs belong to the future L3
> migration described below.

## Current testnet product

- **ETH genesis:** minting a Deed uses ETH because it creates the NFT and starts
  the VOID token/liquidity economy. A wallet can mint only once.
- **VOID application fees:** every official application action enters through
  `VoidPaymaster`. A relayer pays parent-chain ETH and the user pays the measured
  reimbursement and chain fee in VOID.
- **Owner revenue:** 98% of each successful chain transaction fee belongs to the
  Deed owner who generated it. The remaining 2% goes to the protocol. Gas
  reimbursement is Paymaster operating capital, not revenue.
- **Owner claim:** VoidScan displays pending, preserved and Treasury-ready
  revenue and gives the connected owner a fixed Claim Revenue control.
- **Permanent governance boundary:** the first owner sets the initial fee during
  activation. Every later fee or app-publishing-policy change requires that
  Deed's DAO; a later owner cannot bypass it.
- **Wallet-balance voting:** the owner creates proposals, voting lasts exactly
  five days, and each wallet votes with its previous-block VOID balance. Tokens
  are never deposited or locked in the DAO.
- **Permissionless apps:** an open chain accepts applications from any builder.
  An app is registered only for its selected Deed and cannot execute as another
  chain.
- **NFT/VOID market and VoidDEX:** Chain 1 currently hosts the NFT market,
  Uniswap-V2-style pools and a test-token faucet as registered applications.

The official frontend checks existing token permissions before asking the
wallet for another one. A token's first use may require one-time EIP-2612 setup;
after that, a normal app action requires only the single bounded
`SponsoredCall` signature. That action binds the chain, app, calldata, exact
spend limits, transaction-fee cap, gas cap, nonce and deadline. The contract,
not the interface text, enforces those limits.

## Architecture

```text
wallet signs one bounded action
             |
             v
permissionless relayer -- pays ETH --> VoidPaymaster
                                      | charges/refunds VOID gas budget
                                      v
                              VoidChainAppRuntime + Deed ID
                                      | 98% owner / 2% protocol
                                      v
                              registered chain application
```

The runtime provides application-level tenant separation. It does not create
separate consensus domains. An independent L3 needs its own rollup stack, data
availability, sequencer, proof or dispute system, RPC, explorer, bridge,
monitoring and audit. The Deed owner may fund that migration; it is not a
mandatory DAO proposal because the owner bears the deployment cost.

## Repository map

| Path | Purpose |
| --- | --- |
| `contracts/parent/` | Deed, runtime, Paymaster, Treasury, DAO and app factory. |
| `contracts/genesis/` | VOID supply, ETH mint, escrow, permanent LP lock, NFT/VOID AMM and TWAP. |
| `contracts/apps/` | Registered application gateways, including the V4 DEX. |
| `contracts/child/` | Research scaffold for a future independent L3; not part of the live runtime. |
| `test/` | Unit, fuzz, invariant, red-team, scale and integration tests. |
| `script/` | V7 deployment, proof, snapshot, audit, DEX and keeper operations. |
| `indexer/` | Event indexer and Postgres projection used by VoidScan. |
| `db/` | Versioned database schema and migrations. |
| `infra/` | Local Postgres/runtime infrastructure and operator notes. |
| `web/` | VoidScan, mint, market, profiles, DAO, owner controls and `/docs`. |
| `voiddex/` | Separately deployed VoidDEX frontend and relay endpoint. |
| `docs/` | Architecture, governance, operations and live validation evidence. |

The canonical public addresses live in `web/lib/deployment.json`; DEX addresses
live in `web/lib/dex-chain1.json`. Deployment scripts stage manifests and never
silently change the public frontend pointer.

## Local verification

Prerequisites: Node.js, Foundry and Docker when running Postgres.

```bash
npm ci
forge install foundry-rs/forge-std --no-commit
forge test

cd script && npm ci && npm run typecheck
cd ../indexer && npm ci && npm run typecheck
cd ../web && npm ci && npm run build
cd ../voiddex && npm ci && npm run build
```

Run the local indexer and explorer:

```bash
docker compose -f infra/docker-compose.yml up -d
cd indexer && npm run dev
cd ../web && npm run dev
```

V7 testnet operations are intentionally explicit:

```bash
cd script
npm run snapshot:testnet-v7
npm run deploy:testnet-v7
npm run audit:testnet-v7
npm run paymaster:keeper -- --once
```

Private keys and authenticated RPC endpoints belong only in ignored local or
hosting environment variables. The repository contains examples with variable
names, never secrets.

## Documentation

- [Architecture boundary](docs/architecture.md)
- [DAO rules](docs/governance.md)
- [Paymaster operations](docs/paymaster-operations.md)
- [Repository map](docs/repository-map.md)
- [Release checklist](docs/release-checklist.md)
- [V7 live validation](docs/TESTNET_V7_VALIDATION.md)
- [Full protocol review](docs/PROTOCOL_AUDIT.md)

The same product explanation is available in the VoidScan `/docs` page from
the header.

## Safety status

The local suite includes unit, fuzz, invariant, attack and high-load tests, and
the current V7 deployment has live testnet acceptance evidence. Neither is an
external audit. Before a value-bearing deployment the project still requires
independent security review, multisig governance, dedicated RPC/indexer
operations, monitoring, incident procedures and a fresh release audit.

## License

MIT
