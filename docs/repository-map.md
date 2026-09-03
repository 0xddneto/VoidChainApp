# Repository map

The folders in GitHub are not empty: the text beside a folder on the repository
home page is the latest commit message that touched it, not its contents. Open
the folder name to browse the files. This map makes the production boundary
explicit so a clean clone has the same layout as the working tree.

| Path | What belongs there |
| --- | --- |
| `contracts/parent/` | Deed NFT, shared runtime, treasury, paymaster, and the deterministic per-deed DAO factory. |
| `contracts/apps/` | Example permissionless applications that execute through the runtime. |
| `contracts/child/` and `contracts/testnet/` | Test-only adapters and fixtures; they are not an independent chain deployment. |
| `test/` | Foundry security, unit, integration, and load tests. |
| `script/` | Reproducible testnet deployment and proof scripts. Local `.env` keys and per-run records are deliberately ignored. |
| `infra/` | Runnable local infrastructure: the Postgres compose stack and its operator notes. |
| `db/` | Postgres schema and ordered migrations, including the indexer’s projected call records. |
| `indexer/` | The Robinhood testnet event-indexing service. |
| `web/` | The VoidScan explorer, wallet flow, and profile interface. |
| `docs/` | Architecture boundaries, release gates, and this repository map. |
| `.github/workflows/` | Build, contract-test, indexer-typecheck, and web-build gates. |

There is no hidden local production infrastructure outside these folders. The
only intentionally unversioned material is a local deployment key, deployment
run records, database volume, dependency/build output, and editor scratch data.

For the runtime-versus-independent-chain boundary, read
[architecture.md](architecture.md). For the required release controls, read
[release-checklist.md](release-checklist.md).
