<#
.SYNOPSIS
  Register (or remove) the weekly Windows scheduled task that runs scripts\refresh-feeds.ps1.

.DESCRIPTION
  Runs every Sunday at 04:00 and also 5 minutes after every logon (the computer is often off at
  04:00). The script skips itself if a refresh finished less than 3 days ago, waits up to 20
  minutes for Docker Desktop to start, and runs in a hidden window (on 2026-11-22 the run was
  killed from outside and left no trace in the log). If it fails it is tried again up to 3
  times, 15 minutes apart. Everything is in data\logs\refresh-feeds.log. Runs as the current
  user, only while that user is logged on.

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
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$weekly = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 4:00AM
$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$logon.Delay = 'PT5M'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 3) `
  -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -MultipleInstances IgnoreNew `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($weekly, $logon) -Settings $settings `
  -Description 'Downloads the newest Renfe timetable and rebuilds OTP (MadridGo).' -Force | Out-Null
Write-Host "Registered '$name': Sundays 04:00 and 5 min after logon. Test it with: Start-ScheduledTask -TaskName '$name'"
