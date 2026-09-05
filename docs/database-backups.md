# Database backup and restore

Postgres is a rebuildable projection of chain events, but wallet profiles and
declared metadata are not fully reconstructable on-chain. They require real
backups.

For production, enable the database provider's point-in-time recovery and a
second encrypted backup destination with retention appropriate to the launch.
Provider settings cannot be proven by this repository and remain a release
gate.

The repository supplies two operator commands:

```powershell
$env:DATABASE_URL = '<source connection string>'
.\infra\backup-postgres.ps1 -OutputDirectory .\infra\backups

.\infra\restore-postgres.ps1 `
  -DumpFile .\infra\backups\voidscan-YYYYMMDDTHHMMSSZ.dump `
  -RestoreDatabaseUrl '<isolated restore database>'
```

The backup is a custom-format `pg_dump` with a SHA-256 sidecar. Restore refuses
a missing or mismatched checksum and uses `--exit-on-error`. Never run a restore
drill against the live database URL. The weekly CI drill creates an isolated
database, restores a fixture and verifies data; it validates the procedure, not
the existence of production provider backups.
