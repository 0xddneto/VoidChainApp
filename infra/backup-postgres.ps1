param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
if (-not $env:DATABASE_URL) { throw 'DATABASE_URL is required.' }
if (-not (Get-Command pg_dump -ErrorAction SilentlyContinue)) { throw 'pg_dump is required.' }

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$dump = Join-Path $resolvedOutput "voidscan-$stamp.dump"
$checksum = "$dump.sha256"

& pg_dump --format=custom --no-owner --no-privileges --file=$dump $env:DATABASE_URL
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }
(Get-FileHash -Algorithm SHA256 -LiteralPath $dump).Hash.ToLowerInvariant() |
    Set-Content -LiteralPath $checksum -Encoding ascii
Write-Output $dump
