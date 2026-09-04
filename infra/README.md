# Infrastructure

This directory contains the runnable local infrastructure rather than hiding it
inside the application source tree.

- `docker-compose.yml` starts the persistent PostgreSQL projection used by
  VoidScan and the indexer.
- `../db/schema.sql` and `../db/migrations/` define that database. They remain
  next to the data model instead of being duplicated into a container folder.
- `../indexer/` is the event-processing service; it reads the deployment record
  written by `../script/deploy-testnet.ts`.
- `../db/migrations/003-relay-guard.sql` adds the shared, persistent nonce and
  rate-limit guard used by both public relays. Apply migrations to hosted
  Postgres before deploying a relay revision that depends on them.
- `../contracts/` is the on-chain protocol; `../script/` is reproducible
  testnet provisioning, including the 1,111 per-deed DAO clones.

Start the local database from the repository root:

```bash
docker compose -f infra/docker-compose.yml up -d
```

Then run `npm run dev` from `indexer/` and `web/` in separate terminals. The
full map of the repository is in [docs/repository-map.md](../docs/repository-map.md).
