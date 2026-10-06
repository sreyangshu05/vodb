param(
  [Parameter(Mandatory = $true)]
  [string]$BackupFile,

  [string]$LocalPostgresUser = 'postgres',

  [ValidateRange(1, 65535)]
  [int]$LocalPostgresPort = 5432
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

foreach ($tool in @('createdb', 'pg_restore', 'psql', 'dropdb')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "$tool was not found. Install PostgreSQL client tools and add their bin directory to PATH."
  }
}

$resolvedBackup = (Resolve-Path -LiteralPath $BackupFile).Path
$checksumFile = "$resolvedBackup.sha256"
if (-not (Test-Path -LiteralPath $checksumFile)) {
  throw "Checksum sidecar not found: $checksumFile"
}

$expectedHash = (Get-Content -LiteralPath $checksumFile -TotalCount 1).Split(' ')[0].Trim().ToUpperInvariant()
$actualHash = (Get-FileHash -LiteralPath $resolvedBackup -Algorithm SHA256).Hash.ToUpperInvariant()
if ($actualHash -ne $expectedHash) {
  throw 'Backup checksum verification failed.'
}

$databaseName = 'vodb_restore_' + [Guid]::NewGuid().ToString('N')
$smokeTests = Join-Path $PSScriptRoot '..\..\database\tests\schema_smoke_tests.sql'
$postgresEnvironmentNames = @('PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGSSLMODE')
$previousPostgresEnvironment = @{}
foreach ($name in $postgresEnvironmentNames) {
  $previousPostgresEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$env:PGHOST = '127.0.0.1'
$env:PGPORT = [string]$LocalPostgresPort
$env:PGUSER = $LocalPostgresUser
$env:PGSSLMODE = 'disable'
if ($env:LOCAL_POSTGRES_PASSWORD) {
  $env:PGPASSWORD = $env:LOCAL_POSTGRES_PASSWORD
}

$databaseCreated = $false
try {
  & (Get-Command createdb).Source --maintenance-db=postgres $databaseName
  if ($LASTEXITCODE -ne 0) {
    throw "Could not create isolated restore-test database (exit code $LASTEXITCODE)."
  }
  $databaseCreated = $true

  & (Get-Command pg_restore).Source --exit-on-error --no-owner --no-acl --dbname=$databaseName $resolvedBackup
  if ($LASTEXITCODE -ne 0) {
    throw "pg_restore failed with exit code $LASTEXITCODE."
  }

  & (Get-Command psql).Source --dbname=$databaseName --no-psqlrc --set ON_ERROR_STOP=1 --file=$smokeTests
  if ($LASTEXITCODE -ne 0) {
    throw "Restored database schema smoke tests failed with exit code $LASTEXITCODE."
  }

  Write-Output "Restore verification passed for $resolvedBackup"
} finally {
  if ($databaseCreated) {
    & (Get-Command dropdb).Source --if-exists $databaseName
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Could not remove isolated restore-test database $databaseName."
    }
  }
  foreach ($name in $postgresEnvironmentNames) {
    if ($null -eq $previousPostgresEnvironment[$name]) {
      Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    } else {
      [Environment]::SetEnvironmentVariable($name, $previousPostgresEnvironment[$name], 'Process')
    }
  }
}
