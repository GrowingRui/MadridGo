<#
.SYNOPSIS
  Register (or remove) the weekly Windows scheduled task that runs scripts\refresh-feeds.ps1.

.DESCRIPTION
  Runs every Sunday at 04:00 (and, if the computer was off then, at the next start: the task
  runs "as soon as possible after a missed start"). Docker Desktop must be running at that
  time; if it is not, the task fails and says so in data\logs\refresh-feeds.log.
  Runs as the current user, only while that user is logged on.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\register-refresh-task.ps1
  powershell -ExecutionPolicy Bypass -File scripts\register-refresh-task.ps1 -Remove
#>
[CmdletBinding()]
param([switch]$Remove)

$name = 'MadridGo feed refresh'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop
  Write-Host "Removed '$name'."
  return
}

$script = Join-Path $PSScriptRoot 'refresh-feeds.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 4:00AM
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Downloads the newest Renfe timetable and rebuilds OTP (MadridGo).' -Force | Out-Null
Write-Host "Registered '$name': Sundays 04:00. Test it with: Start-ScheduledTask -TaskName '$name'"
