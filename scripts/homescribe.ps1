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
    .\homescribe.ps1 update   download newer files and images and restart
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
# Unpacks the browser extension next to this script; the settings show this
# folder (EXTENSION_FOLDER in .env) to paste into "Load unpacked".
function Update-Extension {
  $zip = Join-Path ([IO.Path]::GetTempPath()) 'homescribe-extension.zip'
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 "http://127.0.0.1:$port/api/v1/extension.zip" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath (Join-Path $PSScriptRoot 'browser-extension') -Force
  } catch {
    Write-Host "Could not unpack the browser extension: $($_.Exception.Message)"
  } finally {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
  }
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

# UTF-8 without BOM, like the installer writes .env, on a line of its own.
function Add-EnvLine($line) {
  $envPath = Join-Path $PSScriptRoot '.env'
  $text = [System.IO.File]::ReadAllText($envPath)
  $start = if ($text.Length -gt 0 -and -not $text.EndsWith("`n")) { "`r`n" } else { '' }
  [System.IO.File]::AppendAllText($envPath, "$start$line`r`n", (New-Object System.Text.UTF8Encoding $false))
}

# What the installer sets for a GPU install, for installs made before it did:
# batched mode, and for a driver older than CUDA 12.9 the same speaches
# release built on an older CUDA. Values already in .env are kept.
function Set-GpuDefaults {
  if (-not (Select-String -Path '.env' -Pattern '^COMPOSE_PROFILES=(.*,)?gpu(,|$)' -Quiet -ErrorAction SilentlyContinue)) { return }
  # Batched speaches on the GPU takes long parts, as the installer sets it.
  if (-not (Select-String -Path '.env' -Pattern '^STT_BATCHED=' -Quiet)) { Add-EnvLine 'STT_BATCHED=true' }
  if (Select-String -Path '.env' -Pattern '^SPEACHES_CUDA_IMAGE=' -Quiet -ErrorAction SilentlyContinue) { return }
  if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) { return }
  $smi = (& { $ErrorActionPreference = 'Continue'; nvidia-smi 2>$null }) -join "`n"
  if ($smi -notmatch 'CUDA Version:\s*(\d+)\.(\d+)') { return }
  $cuda = [int]$Matches[1] * 100 + [int]$Matches[2]
  $tag = if ($cuda -ge 1209) { $null } elseif ($cuda -ge 1206) { '0.8.3-cuda-12.6.3' } else { '0.8.3-cuda-12.4.1' }
  if (-not $tag) { return }
  Add-EnvLine "SPEACHES_CUDA_IMAGE=ghcr.io/speaches-ai/speaches:$tag"
  Write-Host "The NVIDIA driver runs CUDA $($Matches[1]).$($Matches[2]); speech recognition uses speaches $tag."
}

# compose.yaml and this script come from where the installer took them
# (HOMESCRIBE_FILES_URL in .env, empty for an install from a local checkout),
# so fixes in them reach existing installs too. A compose.yaml that Docker
# cannot read is not used.
function Update-Files {
  $base = 'https://raw.githubusercontent.com/mazoriksay/homescribe/main'
  $line = Select-String -Path '.env' -Pattern '^HOMESCRIBE_FILES_URL=(.*)$' -ErrorAction SilentlyContinue | Select-Object -Last 1
  if ($line) { $base = $line.Matches[0].Groups[1].Value.Trim() }
  if (-not $base) { return }
  try {
    Invoke-WebRequest -UseBasicParsing "$base/compose.yaml" -OutFile 'compose.yaml.new' -TimeoutSec 30
    $ErrorActionPreference = 'Continue'
    docker compose -f compose.yaml.new config -q *> $null
    $valid = $LASTEXITCODE -eq 0
    $ErrorActionPreference = 'Stop'
    if (-not $valid) { throw 'compose.yaml.new is not valid' }
    Move-Item -Force 'compose.yaml.new' 'compose.yaml'
    Ok 'compose.yaml is up to date'
  } catch {
    Remove-Item -Force -ErrorAction SilentlyContinue 'compose.yaml.new'
    Write-Host 'Could not get a newer compose.yaml; keeping this one.'
  }
  Set-GpuDefaults
  # PowerShell has read this whole script already, so replacing it is safe.
  try {
    Invoke-WebRequest -UseBasicParsing "$base/scripts/homescribe.ps1" -OutFile 'homescribe.ps1.new' -TimeoutSec 30
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'homescribe.ps1.new'), [ref]$null, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) { throw 'homescribe.ps1.new does not parse' }
    Move-Item -Force 'homescribe.ps1.new' 'homescribe.ps1'
  } catch {
    Remove-Item -Force -ErrorAction SilentlyContinue 'homescribe.ps1.new'
  }
}

switch ($Command) {
  'start' {
    Invoke-Docker compose up -d
    Wait-Ready
    Update-Extension
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
    Update-Files
    Invoke-Docker compose pull
    Invoke-Docker compose up -d --remove-orphans
    Wait-Ready
    Update-Extension
    Ok "Updated and running: $url"
    Write-Host 'To change models or the GPU/CPU choice, run the installer again.'
  }
}
