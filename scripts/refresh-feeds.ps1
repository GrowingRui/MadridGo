<#
.SYNOPSIS
  Refresh the Cercanías timetable (or other feeds) end to end: download, validate, import,
  rebuild the OTP graph and restart OTP. Safe to run on a schedule.

.DESCRIPTION
  Renfe publishes about four weeks of timetable at a time, so this has to run regularly
  (docs/TECHNICAL_RISKS.md, R11). Steps:
    1. `python -m app.ingest update -s <sources>`   (nothing else happens if no feed changed)
    2. `python -m app.ingest otp-prepare`
    3. docker compose ... run --rm otp-build        (about 4-5 minutes)
    4. docker compose ... up -d --force-recreate otp
    5. wait until the journey planner answers, then `python -m app.ingest status`

  If step 1 fails, the old data and the running OTP stay untouched. Everything is logged to
  data/logs/refresh-feeds.log. Exit code: 0 ok, 1 a step failed, 2 a feed is expired or
  within its warning window (or missing) after the refresh (so a scheduler or a person notices).

  Built to be started often (weekly at 04:00 and again after every logon, because the computer
  is not always on at 04:00): it writes its first log line before anything else, waits up to 20
  minutes for Docker Desktop, starts the database and Redis if they are not running, and does nothing when a refresh finished less than 3 days ago
  (unless -Force). An unexpected error is logged (exit 1) instead of vanishing.

.PARAMETER Sources
  Comma-separated feed keys; default "cercanias".

.PARAMETER Force
  Rebuild OTP even when no feed changed.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\refresh-feeds.ps1
#>
[CmdletBinding()]
param(
  [string]$Sources = 'cercanias',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$api = Join-Path $root 'services\api'
$py = Join-Path $api '.venv\Scripts\python.exe'
$compose = @('compose', '--env-file', (Join-Path $root '.env'), '-f', (Join-Path $root 'infra\docker-compose.yml'))
$logDir = Join-Path $root 'data\logs'
$log = Join-Path $logDir 'refresh-feeds.log'
New-Item -ItemType Directory -Force $logDir | Out-Null
$step = Join-Path $env:TEMP 'madridgo-refresh-step.txt'

function Say([string]$msg) {
  $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $msg
  Write-Host $line
  Add-Content -Path $log -Value $line -Encoding utf8
}

# Runs a command through cmd so stderr (Python logging, docker progress) is plain text; the
# output goes to the log. Returns the exit code.
function Run([string]$title, [string]$command) {
  Say "== $title"
  if (Test-Path $step) { Remove-Item $step -Force }
  cmd /c "$command > `"$step`" 2>&1"
  $code = $LASTEXITCODE
  if (Test-Path $step) { Get-Content $step | Add-Content -Path $log -Encoding utf8 }
  if ($code -ne 0) { Say "!! $title failed (exit $code)" }
  return $code
}

# Started again after each logon: nothing to do if a refresh finished recently.
function Get-LastFinished {
  if (-not (Test-Path $log)) { return $null }
  $m = Select-String -Path $log -Pattern '^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) refresh finished$' | Select-Object -Last 1
  if ($m) { return [datetime]::ParseExact($m.Matches[0].Groups[1].Value, 'yyyy-MM-dd HH:mm:ss', $null) }
  return $null
}

Say "refresh started (sources: $Sources)"
$last = Get-LastFinished
if (-not $Force -and $last -and ((Get-Date) - $last).TotalDays -lt 3) {
  Say ('skipped: the last refresh finished {0:yyyy-MM-dd HH:mm} (use -Force to run anyway)' -f $last)
  exit 0
}

# Docker Desktop may still be starting (this task also runs after logon).
$dockerUp = $false
for ($i = 0; $i -lt 80 -and -not $dockerUp; $i++) {
  cmd /c 'docker info >nul 2>nul'
  if ($LASTEXITCODE -eq 0) { $dockerUp = $true } else { if ($i -eq 0) { Say 'waiting for Docker Desktop...' }; Start-Sleep -Seconds 15 }
}
if (-not $dockerUp) { Say '!! Docker Desktop did not start within 20 minutes'; exit 1 }

# The import needs the database (and Redis); start them if the stack is not up (no-op if it is).
$dc0 = 'docker ' + ($compose -join ' ')
if ((Run 'start database and Redis' "$dc0 up -d --wait db redis") -ne 0) { exit 1 }

try {
# The API reads its settings from .env (MADRIDGO_DATABASE_URL and so on).
Get-Content (Join-Path $root '.env') | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
    [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim().Trim('"').Trim("'"), 'Process')
  }
}
Set-Location $api

if ((Run 'import feeds' "`"$py`" -m app.ingest update -s $Sources") -ne 0) { exit 1 }
$unchanged = (Test-Path $step) -and ((Get-Content $step -Raw) -match 'already active') -and `
  -not ((Get-Content $step -Raw) -match 'active as version')

if ($unchanged -and -not $Force) {
  Say 'no feed changed: OTP left as it is'
} else {
  if ((Run 'prepare OTP inputs' "`"$py`" -m app.ingest otp-prepare") -ne 0) { exit 1 }
  Set-Location $root
  $dc = 'docker ' + ($compose -join ' ')
  if ((Run 'rebuild OTP graph' "$dc --profile otp-build run --rm otp-build") -ne 0) { exit 1 }
  if ((Run 'restart OTP' "$dc --profile otp up -d --force-recreate otp") -ne 0) { exit 1 }

  # OTP needs a few minutes to load its graph. /health does not cover it, so ask for a real
  # connection (Parla -> Puerta del Sol area, tomorrow 09:00) until the planner answers.
  $at = [uri]::EscapeDataString((Get-Date).Date.AddDays(1).AddHours(9).ToString('yyyy-MM-ddTHH:mm:sszzz'))
  $url = "http://localhost:8000/journeys?from=renfe:37012&to_lat=40.4153&to_lon=-3.6919&at=$at"
  $ok = $false
  for ($i = 0; $i -lt 120 -and -not $ok; $i++) {
    Start-Sleep -Seconds 5
    try {
      $r = Invoke-RestMethod -Uri $url -TimeoutSec 20
      $ok = $null -ne $r.journeys
    } catch { }
  }
  if ($ok) { Say 'journey planner answers' } else { Say '!! the journey planner did not answer within 10 minutes'; exit 1 }
}

Set-Location $api
$code = Run 'feed status' "`"$py`" -m app.ingest status"
$statusText = Get-Content $step -Raw
$statusText | Write-Host
# After a refresh a feed should be well inside its dates; if not, the publisher has nothing newer.
if ($code -eq 2 -or $statusText -match 'EXPIRING|EXPIRED|NOT IMPORTED') {
  Say '!! a feed is expired, about to expire or missing: check the status lines above'
  exit 2
}
Say 'refresh finished'
exit 0
} catch {
  Say "!! unexpected error: $($_.Exception.Message)"
  exit 1
}
