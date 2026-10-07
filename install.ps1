<#
.SYNOPSIS
  Homescribe installer for Windows (Docker Desktop).

.DESCRIPTION
  Checks (and with your consent installs) Docker Desktop, finds an NVIDIA GPU,
  writes compose.yaml and .env into an install folder, starts everything and
  waits until Homescribe answers. Run it again any time to update.

    irm https://raw.githubusercontent.com/mazoriksay/homescribe/main/install.ps1 | iex

  With options, download it first:  .\install.ps1 -Cpu -NoLlm -Yes
#>
[CmdletBinding()]
param(
  [string]$Dir = (Join-Path $HOME 'homescribe'),
  [int]$Port = 0,
  [switch]$Gpu,
  [switch]$Cpu,
  [switch]$NoStt,
  [switch]$Llm,
  [switch]$NoLlm,
  [string]$Image = '',
  [switch]$Yes,
  [string]$Source = ''
)

$ErrorActionPreference = 'Stop'
$Repo = if ($env:HOMESCRIBE_REPO) { $env:HOMESCRIBE_REPO } else { 'mazoriksay/homescribe' }
$Ref = if ($env:HOMESCRIBE_REF) { $env:HOMESCRIBE_REF } else { 'main' }
if (-not $Image) { $Image = if ($env:HOMESCRIBE_IMAGE) { $env:HOMESCRIBE_IMAGE } else { "ghcr.io/${Repo}:latest" } }
$LlmModel = if ($env:HOMESCRIBE_LLM_MODEL) { $env:HOMESCRIBE_LLM_MODEL } else { 'llama3.1:8b' }

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "OK  $text" -ForegroundColor Green }
function Warn($text) { Write-Host "!   $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "X   $text" -ForegroundColor Red; exit 1 }

function Ask([string]$Question, [bool]$Default) {
  if ($Yes) { return $Default }
  $hint = if ($Default) { '[Y/n]' } else { '[y/N]' }
  $answer = Read-Host "$Question $hint"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
  return $answer.Trim().ToLower().StartsWith('y')
}

function Test-Command($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
# Runs a native command quietly and reports success. Windows PowerShell 5.1 turns
# a native command's stderr into a terminating error under
# $ErrorActionPreference = 'Stop', so relax it for the call.
function Test-Native([scriptblock]$Command) {
  $ErrorActionPreference = 'Continue'
  & $Command *> $null
  return $LASTEXITCODE -eq 0
}
function Test-Docker { Test-Native { docker info } }

function Wait-Docker {
  Write-Host -NoNewline 'Waiting for Docker Desktop to start'
  for ($i = 0; $i -lt 120; $i++) {
    if (Test-Docker) { Write-Host ''; Ok 'Docker is running'; return }
    Write-Host -NoNewline '.'
    Start-Sleep -Seconds 5
  }
  Write-Host ''
  Fail 'Docker did not start within 10 minutes. Start Docker Desktop and run the installer again.'
}

# ------------------------------------------------------------------ docker

Step 'Checking Docker'
if (-not (Test-Command docker)) {
  if (Ask 'Docker Desktop is not installed. Install it now (winget, needs admin rights)?' $true) {
    if (-not (Test-Command winget)) {
      Start-Process 'https://www.docker.com/products/docker-desktop/'
      Fail 'winget is not available. Install Docker Desktop from the page that just opened, then run this again.'
    }
    winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
    Warn 'Docker Desktop is installed. If Windows asks for a restart (WSL 2), restart and run this installer again.'
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  } else {
    Fail 'Docker Desktop is required: https://www.docker.com/products/docker-desktop/'
  }
}
if (-not (Test-Docker)) {
  $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path $desktop) { Start-Process $desktop }
  Wait-Docker
}
if (-not (Test-Native { docker compose version })) { Fail 'Docker Compose v2 is missing. Update Docker Desktop.' }
Ok "Docker $(docker version --format '{{.Server.Version}}') with Compose $(docker compose version --short)"

# ------------------------------------------------------------------ gpu

$Stt = if ($NoStt) { 'none' } elseif ($Gpu) { 'gpu' } elseif ($Cpu) { 'cpu' } else { '' }
if (-not $Stt) {
  Step 'Choosing where speech recognition runs'
  $gpuName = $null
  if (Test-Command nvidia-smi) {
    $gpuName = (& { $ErrorActionPreference = 'Continue'; nvidia-smi --query-gpu=name --format=csv,noheader 2>$null } | Select-Object -First 1)
  }
  if ($gpuName) {
    Ok "NVIDIA GPU found: $gpuName (Docker Desktop uses it through WSL 2)"
    $Stt = 'gpu'
  } else {
    Warn 'No NVIDIA GPU found; speech recognition runs on the CPU (slower).'
    $Stt = 'cpu'
  }
}
Ok "Speech recognition: $Stt"

$UseLlm = if ($Llm) { $true } elseif ($NoLlm) { $false } else {
  Ask "Run a local AI for summaries (Ollama, $LlmModel, about 5 GB)? You can also pick a cloud API later in Settings." ($Stt -eq 'gpu')
}

# ------------------------------------------------------------------ port

$envFile = Join-Path $Dir '.env'
if ($Port -eq 0 -and (Test-Path $envFile)) {
  $saved = Select-String -Path $envFile -Pattern '^HOMESCRIBE_PORT=(\d+)' | Select-Object -Last 1
  if ($saved) { $Port = [int]$saved.Matches[0].Groups[1].Value }
}
if ($Port -eq 0) {
  $Port = 8080
  if (Test-Command Get-NetTCPConnection) {
    while (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { $Port++ }
  }
}

# ------------------------------------------------------------------ files

Step "Writing $Dir"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$composeFile = Join-Path $Dir 'compose.yaml'
if ($Source) {
  Copy-Item (Join-Path $Source 'compose.yaml') $composeFile -Force
} else {
  Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/$Repo/$Ref/compose.yaml" -OutFile $composeFile
}

$profiles = @()
if ($Stt -ne 'none') { $profiles += $Stt }
if ($UseLlm) { $profiles += $(if ($Stt -eq 'gpu') { 'llm-gpu' } else { 'llm-cpu' }) }

# Our keys are rewritten; anything else in .env is kept.
$kept = @()
if (Test-Path $envFile) {
  $kept = Get-Content $envFile | Where-Object { $_ -notmatch '^(COMPOSE_PROFILES|HOMESCRIBE_IMAGE|HOMESCRIBE_PORT|LLM_MODE|LLM_MODEL)=' }
}
$lines = @($kept) + @(
  "COMPOSE_PROFILES=$($profiles -join ',')",
  "HOMESCRIBE_IMAGE=$Image",
  "HOMESCRIBE_PORT=$Port"
)
$lines += $(if ($UseLlm) { @('LLM_MODE=local', "LLM_MODEL=$LlmModel") } else { @('LLM_MODE=off') })
# UTF-8 without BOM: Compose reads the file as is.
[IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object Text.UTF8Encoding $false))
Ok "compose.yaml and .env written (profiles: $(if ($profiles) { $profiles -join ',' } else { 'none' }))"

# ------------------------------------------------------------------ start

Push-Location $Dir
try {
  Step 'Downloading images (the first time this takes a while)'
  docker compose pull
  if ($LASTEXITCODE -ne 0) {
    if (-not (Test-Native { docker image inspect $Image })) { Fail 'Could not download the images. Check the internet connection and run the installer again.' }
    Warn "Could not pull everything; using the local image $Image."
  }

  Step 'Starting Homescribe'
  docker compose up -d --remove-orphans
  if ($LASTEXITCODE -ne 0) { Fail 'docker compose up failed; see the messages above.' }

  function Get-Health {
    try { return Invoke-RestMethod -TimeoutSec 5 "http://127.0.0.1:$Port/api/v1/health" } catch { return $null }
  }
  Write-Host -NoNewline 'Waiting for Homescribe'
  for ($i = 0; -not (Get-Health); $i++) {
    if ($i -ge 60) { Write-Host ''; Fail "Homescribe did not answer. Logs: cd $Dir; docker compose logs homescribe" }
    Write-Host -NoNewline '.'
    Start-Sleep -Seconds 3
  }
  Write-Host ''
  Ok 'Homescribe is running'

  if ($UseLlm) {
    Step "Downloading the summary model $LlmModel"
    $service = if ($Stt -eq 'gpu') { 'ollama-gpu' } else { 'ollama-cpu' }
    docker compose exec -T $service ollama pull $LlmModel
    if ($LASTEXITCODE -ne 0) { Warn "Could not download $LlmModel now. Retry: docker compose exec $service ollama pull $LlmModel" }
  }

  if ($Stt -ne 'none') {
    Step 'Waiting for the speech model (first start downloads about 3 GB)'
    for ($i = 0; $i -lt 180; $i++) {
      $health = Get-Health
      if ($health -and $health.checks -and $health.checks.stt -eq 'ok') { break }
      Write-Host -NoNewline '.'
      Start-Sleep -Seconds 10
    }
    Write-Host ''
  }

  # The first self-check takes a few seconds after start.
  for ($i = 0; $i -lt 10; $i++) {
    $health = Get-Health
    if ($health -and $health.checks) { break }
    Start-Sleep -Seconds 2
  }
  Step 'Done'
  if ($health -and $health.checks) {
    $c = $health.checks
    Write-Host "Self-check: ffmpeg:$($c.ffmpeg) ytdlp:$($c.ytdlp) stt:$($c.stt) llm:$($c.llm)"
  }
  Write-Host "`nOpen Homescribe:"
  Write-Host "  http://localhost:$Port"
  if (Test-Command Get-NetIPAddress) {
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Docker|Loopback' } |
      ForEach-Object { Write-Host "  http://$($_.IPAddress):$Port" }
  }
  if ($Stt -eq 'none') { Write-Host "`nChoose your speech-to-text server in Settings -> Speech recognition." }
  Write-Host "`nUpdate later by running the installer again, or: cd $Dir; docker compose pull; docker compose up -d"
  Write-Host 'Other devices on your network may need a Windows Firewall rule for this port.'
} finally {
  Pop-Location
}
