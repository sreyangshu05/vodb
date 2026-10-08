param(
  [string]$AdditionalCopyPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$backupScript = Join-Path $PSScriptRoot 'backup-database.ps1'
if (-not (Test-Path -LiteralPath $backupScript)) {
  throw "Backup script not found: $backupScript"
}

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$backupArguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$backupScript`""
if ($AdditionalCopyPath) {
  $backupArguments += " -AdditionalCopyPath `"$AdditionalCopyPath`""
}
$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument $backupArguments
$trigger = New-ScheduledTaskTrigger -Daily -At '2:17 AM'
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask `
  -TaskName 'Vodb Database Backup' `
  -Description 'Creates a daily PostgreSQL backup and checksum; optionally verifies a second copy.' `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Force | Out-Null

Write-Output 'Registered daily database backup at 2:17 AM (runs when this Windows user is logged in).'
