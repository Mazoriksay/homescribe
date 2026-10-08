<#
.SYNOPSIS
  Start, stop and check Homescribe on Windows.

.DESCRIPTION
  The installer puts this next to compose.yaml and .env in the install folder,
  together with "Start Homescribe.cmd", "Stop Homescribe.cmd",
  "Homescribe status.cmd" and "Update Homescribe.cmd" that run it on a
  double click.

    .\homescribe.ps1 start    start everything, wait until it answers, open the browser
    .\homescribe.ps1 stop     stop everything and free memory; data is kept
    .\homescribe.ps1 status   what is running, the address and the self-check
    .\homescribe.ps1 update   download newer images and restart
#>
param([ValidateSet('start', 'stop', 'status', 'update')][string]$Command = 'status')

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Ok($text) { Write-Host "OK  $text" -ForegroundColor Green }
function Fail($text) { Write-Host "X   $text" -ForegroundColor Red; exit 1 }
# Windows PowerShell 5.1 turns a native command's stderr into an error under
# 'Stop'; Docker writes progress there.
function Invoke-Docker {
  $ErrorActionPreference = 'Continue'
  & docker @args
  if ($LASTEXITCODE -ne 0) { Fail "docker $($args -join ' ') failed; see the messages above." }
}

if (-not (Test-Path 'compose.yaml')) { Fail 'No compose.yaml here. Run this from the Homescribe install folder.' }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'Docker Desktop is not installed.' }

$ErrorActionPreference = 'Continue'
docker info *> $null
$dockerUp = $LASTEXITCODE -eq 0
$ErrorActionPreference = 'Stop'
if (-not $dockerUp) {
  $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if ($Command -eq 'stop' -or $Command -eq 'status') { Write-Host 'Docker Desktop is not running, so Homescribe is not running either.'; exit 0 }
  if (-not (Test-Path $desktop)) { Fail 'Docker Desktop is not running. Start it and try again.' }
  Write-Host -NoNewline 'Starting Docker Desktop'
  Start-Process $desktop
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 5
    Write-Host -NoNewline '.'
    $ErrorActionPreference = 'Continue'
    docker info *> $null
    $dockerUp = $LASTEXITCODE -eq 0
    $ErrorActionPreference = 'Stop'
    if ($dockerUp) { break }
  }
  Write-Host ''
  if (-not $dockerUp) { Fail 'Docker Desktop did not start within 5 minutes.' }
}

$port = 8080
$saved = Select-String -Path '.env' -Pattern '^HOMESCRIBE_PORT=(\d+)' -ErrorAction SilentlyContinue | Select-Object -Last 1
if ($saved) { $port = [int]$saved.Matches[0].Groups[1].Value }
$url = "http://localhost:$port"

function Get-Health {
  try { return Invoke-RestMethod -TimeoutSec 5 "http://127.0.0.1:$port/api/v1/health" } catch { return $null }
}
function Wait-Ready {
  Write-Host -NoNewline 'Waiting for Homescribe'
  for ($i = 0; -not (Get-Health); $i++) {
    if ($i -ge 60) { Write-Host ''; Fail 'Homescribe did not answer. Logs: docker compose logs homescribe' }
    Write-Host -NoNewline '.'
    Start-Sleep -Seconds 3
  }
  Write-Host ''
}

switch ($Command) {
  'start' {
    Invoke-Docker compose up -d
    Wait-Ready
    Ok "Homescribe is running: $url"
    # The self-check repeats every minute; right after start speaches may still load.
    $health = Get-Health
    if (-not $health -or -not $health.checks -or $health.checks.stt -ne 'ok') {
      Write-Host 'Speech recognition is still starting; new recordings wait in the queue until it is ready.'
    }
    Start-Process $url
  }
  'stop' {
    # down without -v: containers go, volumes with recordings and models stay.
    Invoke-Docker compose down
    Ok 'Homescribe is stopped and no longer uses memory.'
    Write-Host 'Recordings, models and settings are kept. Start again with "Start Homescribe".'
  }
  'status' {
    Invoke-Docker compose ps
    $health = Get-Health
    if ($health) {
      Ok "Homescribe answers at $url"
      if ($health.checks) {
        $c = $health.checks
        Write-Host "Self-check: ffmpeg:$($c.ffmpeg) ytdlp:$($c.ytdlp) stt:$($c.stt) llm:$($c.llm)"
      }
    } else {
      Write-Host 'Homescribe is not running. Start it with "Start Homescribe".'
    }
  }
  'update' {
    Invoke-Docker compose pull
    Invoke-Docker compose up -d --remove-orphans
    Wait-Ready
    Ok "Updated and running: $url"
    Write-Host 'To change models or the GPU/CPU choice, run the installer again.'
  }
}
