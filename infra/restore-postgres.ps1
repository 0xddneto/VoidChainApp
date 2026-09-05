param(
    [Parameter(Mandatory = $true)][string]$DumpFile,
    [Parameter(Mandatory = $true)][string]$RestoreDatabaseUrl
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $DumpFile -PathType Leaf)) { throw 'Dump file does not exist.' }
if (-not (Get-Command pg_restore -ErrorAction SilentlyContinue)) { throw 'pg_restore is required.' }
$dump = (Resolve-Path -LiteralPath $DumpFile).Path
$checksumFile = "$dump.sha256"
if (-not (Test-Path -LiteralPath $checksumFile -PathType Leaf)) { throw 'Checksum file is missing.' }
$expected = (Get-Content -LiteralPath $checksumFile -Raw).Trim().ToLowerInvariant()
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $dump).Hash.ToLowerInvariant()
if ($expected -ne $actual) { throw 'Backup checksum mismatch.' }

# Restore to a freshly created, isolated database. Never drop existing objects;
# an accidental nonempty target fails atomically instead of overwriting data.
& pg_restore --single-transaction --no-owner --no-privileges --exit-on-error --dbname=$RestoreDatabaseUrl $dump
if ($LASTEXITCODE -ne 0) { throw "pg_restore failed with exit code $LASTEXITCODE" }
Write-Output 'Restore completed. Run the application integrity checks before promotion.'
