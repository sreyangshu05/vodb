param(
  [ValidateRange(1, 365)]
  [int]$RetentionDays = 7
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-DirectDatabaseUrl {
  $environmentUrl = $env:DIRECT_DATABASE_URL
  if (-not $environmentUrl) {
    $environmentUrl = $env:DATABASE_URL_UNPOOLED
  }

  if ($environmentUrl) {
    return $environmentUrl
  }

  $envFile = Join-Path $PSScriptRoot '..\.env'
  if (-not (Test-Path -LiteralPath $envFile)) {
    throw 'Set DIRECT_DATABASE_URL or DATABASE_URL_UNPOOLED, or provide backend\.env with a direct URL.'
  }

  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*(?:DIRECT_DATABASE_URL|DATABASE_URL_UNPOOLED)\s*=\s*(.*?)\s*$') {
      $value = $Matches[1].Trim()
      if ($value -match '^([''"])(.*)\1$') {
        $value = $Matches[2]
      }
      if ($value) {
        return $value
      }
    }
  }

  throw 'backend\.env does not contain DIRECT_DATABASE_URL or DATABASE_URL_UNPOOLED.'
}

function Set-PostgresConnectionEnvironment([string]$ConnectionString) {
  $connectionUri = [Uri]$ConnectionString
  if ($connectionUri.Scheme -notin @('postgres', 'postgresql')) {
    throw 'The direct database connection must use a PostgreSQL URI.'
  }
  if ($connectionUri.DnsSafeHost -match '-pooler(?:\.|$)') {
    throw 'Use a direct, non-pooled Neon connection for pg_dump.'
  }

  $userInfo = [Uri]::UnescapeDataString($connectionUri.UserInfo)
  $separator = $userInfo.IndexOf(':')
  if ($separator -lt 1) {
    throw 'The database URI must include a username and password.'
  }
  $database = [Uri]::UnescapeDataString($connectionUri.AbsolutePath.TrimStart('/'))
  if (-not $database) {
    throw 'The database URI must include a database name.'
  }

  $sslMode = 'verify-full'
  if ($connectionUri.Query -match '(?:\?|&)sslmode=([^&]+)') {
    $sslMode = [Uri]::UnescapeDataString($Matches[1])
  }
  if (-not $sslMode) {
    $sslMode = 'verify-full'
  } elseif ($sslMode -in @('require', 'prefer', 'allow')) {
    $sslMode = 'verify-full'
  } elseif ($sslMode -notin @('verify-full', 'verify-ca')) {
    throw 'Backups require a TLS-verified direct database connection.'
  }

  $env:PGHOST = $connectionUri.DnsSafeHost
  $env:PGPORT = if ($connectionUri.IsDefaultPort) { '5432' } else { [string]$connectionUri.Port }
  $env:PGUSER = $userInfo.Substring(0, $separator)
  $env:PGPASSWORD = $userInfo.Substring($separator + 1)
  $env:PGDATABASE = $database
  $env:PGSSLMODE = $sslMode
}

$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
if (-not $pgDump) {
  throw 'pg_dump was not found. Install the PostgreSQL client tools and add their bin directory to PATH.'
}

$connectionString = Get-DirectDatabaseUrl
$postgresEnvironmentNames = @('PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE', 'PGCHANNELBINDING')
$previousPostgresEnvironment = @{}
foreach ($name in $postgresEnvironmentNames) {
  $previousPostgresEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
Set-PostgresConnectionEnvironment $connectionString

$backupDirectory = Join-Path $env:LOCALAPPDATA 'Vodb\DatabaseBackups'
New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null

$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$backupPath = Join-Path $backupDirectory "vodb-$timestamp.dump"
$temporaryPath = "$backupPath.partial"

try {
  & $pgDump.Source --format=custom --no-owner --no-acl --file="$temporaryPath"
  if ($LASTEXITCODE -ne 0) {
    throw "pg_dump failed with exit code $LASTEXITCODE."
  }
  if (-not (Test-Path -LiteralPath $temporaryPath) -or (Get-Item -LiteralPath $temporaryPath).Length -eq 0) {
    throw 'pg_dump did not create a non-empty backup.'
  }

  $pgRestore = Get-Command pg_restore -ErrorAction SilentlyContinue
  if (-not $pgRestore) {
    throw 'pg_restore was not found. Install the PostgreSQL client tools before taking backups.'
  }
  & $pgRestore.Source --list "$temporaryPath" *> $null
  if ($LASTEXITCODE -ne 0) {
    throw 'pg_restore could not read the generated backup archive.'
  }

  Move-Item -LiteralPath $temporaryPath -Destination $backupPath
  $checksum = Get-FileHash -LiteralPath $backupPath -Algorithm SHA256
  Set-Content -LiteralPath "$backupPath.sha256" -Value "$($checksum.Hash.ToLowerInvariant())  $(Split-Path -Leaf $backupPath)" -Encoding ascii

  $cutoff = (Get-Date).AddDays(-$RetentionDays)
  Get-ChildItem -LiteralPath $backupDirectory -Filter 'vodb-*.dump' -File |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    ForEach-Object {
      Remove-Item -LiteralPath $_.FullName
      Remove-Item -LiteralPath "$($_.FullName).sha256" -ErrorAction SilentlyContinue
    }
  Get-ChildItem -LiteralPath $backupDirectory -Filter 'vodb-*.dump.partial' -File |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } |
    Remove-Item -ErrorAction SilentlyContinue

  Write-Output "Backup completed: $backupPath"
  Write-Output "SHA-256: $($checksum.Hash.ToLowerInvariant())"
} finally {
  Remove-Item -LiteralPath $temporaryPath -ErrorAction SilentlyContinue
  foreach ($name in $postgresEnvironmentNames) {
    if ($null -eq $previousPostgresEnvironment[$name]) {
      Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    } else {
      [Environment]::SetEnvironmentVariable($name, $previousPostgresEnvironment[$name], 'Process')
    }
  }
}
