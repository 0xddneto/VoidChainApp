# Repository map

The folders in GitHub are not empty: the text beside a folder on the repository
home page is the latest commit message that touched it, not its contents. Open
the folder name to browse the files. This map makes the production boundary
explicit so a clean clone has the same layout as the working tree.

| Path | What belongs there |
| --- | --- |
| `contracts/parent/` | Deed NFT, shared runtime, Treasury, Paymaster and deterministic per-deed DAO/app factories. |
| `contracts/genesis/` | Current V10 ETH mint, VOID allocation, migration escrow, locked VOID/ETH pool, NFT AMM, soft staking and TWAP components. |
| `contracts/apps/` | Protocol examples and generic test application gateways which execute through the runtime. |
| `contracts/child/` | Research scaffold for a future independent L3; not part of the current deployment. |
| `contracts/testnet/` | Earlier test fixtures retained only for regression tests; not public V10 entrypoints. |
| `test/` | Foundry security, unit, integration, and load tests. |
| `script/` | Reproducible V10 deployment, verification, audit and keeper scripts. Local `.env` keys are deliberately ignored. Versioned deployment evidence contains public data only. |
| `infra/` | Runnable local infrastructure: the Postgres compose stack and its operator notes. |
| `db/` | Postgres schema and ordered migrations, including the indexer’s projected call records. |
| `indexer/` | The Robinhood testnet event-indexing service. |
| `web/` | VoidScan explorer, mint, NFT market, profiles, DAO, owner controls and documentation. |
| `docs/` | Architecture boundaries, governance rules, release gates, and this repository map. |
| `.github/workflows/` | Build, contract-test, indexer-typecheck, and web-build gates. |

VoidDEX lives in its own `0xddneto/VoidDEX` repository and Vercel project. There
is no hidden local production infrastructure outside these folders. The
only intentionally unversioned material is a local deployment key, deployment
run records, database volume, dependency/build output, and editor scratch data.

For the runtime-versus-independent-chain boundary, read
[architecture.md](architecture.md). For the required release controls, read
[release-checklist.md](release-checklist.md). For the DAO rules, read
[governance.md](governance.md).
