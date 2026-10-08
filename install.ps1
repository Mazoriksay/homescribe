<#
.SYNOPSIS
  Homescribe installer for Windows (Docker Desktop).

.DESCRIPTION
  Checks (and with your consent installs) Docker Desktop, finds an NVIDIA GPU,
  writes compose.yaml and .env into an install folder, starts everything and
  waits until Homescribe answers. Run it again any time to update.

    irm https://raw.githubusercontent.com/mazoriksay/homescribe/main/install.ps1 | iex

  It asks what to download (speech recognition on the GPU or CPU, the Whisper
  model, a local summary model or none) and shows a summary before pulling.

  With options, download it first:  .\install.ps1 -Cpu -SttModel small -NoLlm -Yes

  -Autostart / -NoAutostart: start Homescribe with Windows or only from the
  "Start Homescribe" shortcut (default: ask; no).
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
  [string]$SttModel = '',
  [string]$LlmModel = '',
  [string]$Image = '',
  [switch]$Yes,
  [string]$Source = '',
  [switch]$Autostart,
  [switch]$NoAutostart
)

$ErrorActionPreference = 'Stop'
$Repo = if ($env:HOMESCRIBE_REPO) { $env:HOMESCRIBE_REPO } else { 'mazoriksay/homescribe' }
$Ref = if ($env:HOMESCRIBE_REF) { $env:HOMESCRIBE_REF } else { 'main' }
if (-not $Image) { $Image = if ($env:HOMESCRIBE_IMAGE) { $env:HOMESCRIBE_IMAGE } else { "ghcr.io/${Repo}:latest" } }
if (-not $LlmModel -and $env:HOMESCRIBE_LLM_MODEL) { $LlmModel = $env:HOMESCRIBE_LLM_MODEL }
if ($LlmModel) { $Llm = $true }

# What can be downloaded: download size and memory in use (video memory on a
# GPU, RAM on a CPU), both approximate.
$SttModels = @(
  @{ Name = 'large-v3'; Vram = 4.5; Id = 'Systran/faster-whisper-large-v3'; Size = 3.1; Note = 'best quality' },
  @{ Name = 'large-v3-turbo'; Vram = 2.5; Id = 'deepdml/faster-whisper-large-v3-turbo-ct2'; Size = 1.6; Note = 'almost as good, several times faster' },
  @{ Name = 'medium'; Vram = 2.5; Id = 'Systran/faster-whisper-medium'; Size = 1.5; Note = 'good, for older GPUs' },
  @{ Name = 'small'; Vram = 1; Id = 'Systran/faster-whisper-small'; Size = 0.5; Note = 'fast on a CPU, rougher text' }
)
$LlmModels = @(
  @{ Id = 'qwen2.5:7b'; Vram = 6; Size = 4.7; Note = 'good in Russian and English' },
  @{ Id = 'llama3.1:8b'; Vram = 6.5; Size = 4.9; Note = 'good in English' },
  @{ Id = 'qwen2.5:3b'; Vram = 3; Size = 1.9; Note = 'smaller, for weaker machines' }
)

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

# A numbered menu; returns the chosen option's index. -Yes takes the default.
function Choose([string]$Title, [string[]]$Options, [int]$Default) {
  if ($Yes) { return $Default }
  Write-Host "`n$Title"
  for ($i = 0; $i -lt $Options.Count; $i++) {
    $mark = if ($i -eq $Default) { '  <- default' } else { '' }
    Write-Host ("  {0}) {1}{2}" -f ($i + 1), $Options[$i], $mark)
  }
  while ($true) {
    $answer = Read-Host "Choose 1-$($Options.Count) [$($Default + 1)]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    $n = 0
    if ([int]::TryParse($answer.Trim(), [ref]$n) -and $n -ge 1 -and $n -le $Options.Count) { return $n - 1 }
    Warn 'Enter one of the numbers above.'
  }
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

# ------------------------------------------------------------------ downloads

# Models live in Compose volumes (project "homescribe"). A throwaway container
# from an image that is already here reads them, so nothing is downloaded
# just to look. The script goes in on stdin: Windows PowerShell mangles
# quotes in native arguments, and the trailing '#' swallows the CR it adds.
$VolHf = 'homescribe_hf-hub-cache'
$VolOl = 'homescribe_ollama-models'
$HfDir = '/home/ubuntu/.cache/huggingface/hub'
function Invoke-Volumes([string]$Script) {
  if (-not (Test-Native { docker image inspect $Image })) { return @() }
  $mounts = @()
  if (Test-Native { docker volume inspect $VolHf }) { $mounts += @('-v', "${VolHf}:/hf") }
  if (Test-Native { docker volume inspect $VolOl }) { $mounts += @('-v', "${VolOl}:/ol") }
  if (-not $mounts) { return @() }
  $ErrorActionPreference = 'Continue'
  return @("$Script; true #" | docker run -i --rm --user 0 @mounts --entrypoint sh $Image 2>$null)
}
function ConvertFrom-RepoDir([string]$name) { $i = $name.IndexOf('--'); if ($i -lt 0) { $name } else { $name.Substring(0, $i) + '/' + $name.Substring($i + 2) } }

$scan = 'for d in /hf/models--*; do [ -d "$d" ] || continue; id="${d#/hf/models--}"; case "$id" in *whisper*) ;; *) continue ;; esac; ' +
  'if [ -e "$(ls -d "$d"/snapshots/*/model.bin 2>/dev/null | head -1)" ]; then echo "stt $id"; else echo "partial $id"; fi; done; ' +
  'lib=/ol/models/manifests/registry.ollama.ai/library; if [ -d "$lib" ]; then cd "$lib" && for f in */*; do [ -f "$f" ] && echo "llm ${f%%/*}:${f#*/}"; done; fi'
$HaveStt = @(); $PartialStt = @(); $HaveLlm = @()
foreach ($line in (Invoke-Volumes $scan)) {
  $kind, $id = "$line".Trim() -split ' ', 2
  switch ($kind) {
    'stt' { $HaveStt += ConvertFrom-RepoDir $id }
    'partial' { $PartialStt += ConvertFrom-RepoDir $id }
    'llm' { $HaveLlm += $id }
  }
}

# ------------------------------------------------------------------ gpu

$GpuMemGb = $null
$Stt = if ($NoStt) { 'none' } elseif ($Gpu) { 'gpu' } elseif ($Cpu) { 'cpu' } else { '' }
if (-not $Stt) {
  Step 'Choosing what to download'
  $gpuName = $null
  if (Test-Command nvidia-smi) {
    $gpuName = (& { $ErrorActionPreference = 'Continue'; nvidia-smi --query-gpu=name --format=csv,noheader 2>$null } | Select-Object -First 1)
  }
  if ($gpuName) {
    $mib = (& { $ErrorActionPreference = 'Continue'; nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>$null } | Select-Object -First 1)
    if ($mib -match '^\s*(\d+)') { $GpuMemGb = [math]::Round([int]$Matches[1] / 1024, 1) }
    Ok "NVIDIA GPU found: $gpuName$(if ($GpuMemGb) { ", $GpuMemGb GB" }) (Docker Desktop uses it through WSL 2)"
  }
  else { Warn 'No NVIDIA GPU found; speech recognition here would run on the CPU (slower).' }
  $where = @()
  $values = @()
  if ($gpuName) { $where += "On this NVIDIA GPU ($gpuName)"; $values += 'gpu' }
  $where += 'On the CPU (works anywhere, slow for long recordings)'; $values += 'cpu'
  $where += 'Not on this computer (a cloud API or another server, chosen in Settings)'; $values += 'none'
  $Stt = $values[(Choose 'Speech recognition:' $where 0)]
}

# The Whisper model: a short name from the list or any model id.
if ($Stt -ne 'none') {
  if ($SttModel) {
    $known = $SttModels | Where-Object { $_.Name -eq $SttModel -or $_.Id -eq $SttModel } | Select-Object -First 1
    $SttChoice = if ($known) { $known } else { @{ Name = $SttModel; Id = $SttModel; Size = 0; Note = '' } }
  } else {
    $mem = if ($Stt -eq 'gpu') { 'video memory' } else { 'RAM' }
    $labels = $SttModels | ForEach-Object {
      $dl = if ($HaveStt -contains $_.Id) { 'downloaded' } else { "download $($_.Size) GB" }
      "$($_.Name) - $dl, uses ~$($_.Vram) GB $mem, $($_.Note)"
    }
    $SttChoice = $SttModels[(Choose 'Speech recognition model (Whisper):' $labels $(if ($Stt -eq 'gpu') { 0 } else { 3 }))]
  }
}

# The local summary model, or none.
if ($NoLlm) {
  $UseLlm = $false
} elseif ($Llm) {
  $UseLlm = $true
  if (-not $LlmModel) { $LlmModel = $LlmModels[0].Id }
} else {
  $mem = if ($Stt -eq 'gpu') { 'video memory' } else { 'RAM' }
  Write-Host "`nThe two models take turns: a recording is transcribed first, then summarized."
  Write-Host 'Each stays loaded for about 5 minutes after use, so right after a recording both'
  Write-Host "can sit in $mem at once. Plan for the sum of the two."
  $labels = @($LlmModels | ForEach-Object {
      $dl = if ($HaveLlm -contains $_.Id) { 'downloaded' } else { "download $($_.Size) GB" }
      "$($_.Id) - $dl, uses ~$($_.Vram) GB $mem, $($_.Note)"
    })
  $labels += 'None (use a cloud API in Settings, or no summaries)'
  $pick = Choose 'Local AI for summaries (Ollama):' $labels $(if ($Stt -eq 'gpu') { 0 } else { $LlmModels.Count })
  $UseLlm = $pick -lt $LlmModels.Count
  if ($UseLlm) { $LlmModel = $LlmModels[$pick].Id }
}

# Summary, then one confirmation before anything is downloaded.
Step 'You chose'
Write-Host '  Homescribe app'
if ($Stt -eq 'none') { Write-Host '  Speech recognition: not on this computer' }
else {
  $size = ''
  if ($HaveStt -contains $SttChoice.Id) { $size = ' (already downloaded)' }
  elseif ($PartialStt -contains $SttChoice.Id) { $size = " (continues the unfinished download$(if ($SttChoice.Size) { " of about $($SttChoice.Size) GB" }))" }
  elseif ($SttChoice.Size) { $size = " (download about $($SttChoice.Size) GB)" }
  Write-Host "  Speech recognition on the $($Stt.ToUpper()): $($SttChoice.Name)$size"
}
if ($UseLlm) {
  $known = $LlmModels | Where-Object { $_.Id -eq $LlmModel } | Select-Object -First 1
  $size = if ($HaveLlm -contains $LlmModel) { ' (already downloaded)' } elseif ($known) { " (download about $($known.Size) GB)" } else { '' }
  Write-Host "  Summaries: Ollama with $LlmModel$size"
} else { Write-Host '  Summaries: no local AI' }
$memSum = 0
$TakeTurns = $false
if ($Stt -ne 'none' -and $SttChoice.Vram) { $memSum += $SttChoice.Vram }
$llmKnown = if ($UseLlm) { $LlmModels | Where-Object { $_.Id -eq $LlmModel } | Select-Object -First 1 } else { $null }
if ($llmKnown) { $memSum += $llmKnown.Vram }
if ($memSum -gt 0) {
  $mem = if ($Stt -eq 'gpu') { 'video memory' } else { 'RAM' }
  Write-Host "  Memory: up to ~$memSum GB of $mem while both are loaded$(if ($Stt -eq 'gpu' -and $GpuMemGb) { " (this GPU has $GpuMemGb GB)" })"
  if ($Stt -eq 'gpu' -and $GpuMemGb -and $memSum -gt $GpuMemGb) {
    $TakeTurns = $true
    Warn 'More than this GPU has, so the two models will take turns: each recording takes about 30 s longer. Pick smaller models to avoid that.'
  }
}
if (-not (Ask 'Download and start?' $true)) { Write-Host 'Nothing was downloaded.'; exit 0 }

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

# ------------------------------------------------------------------ autostart

# Keep the answer of an earlier install unless a switch says otherwise.
$UseAutostart = $null
if ($Autostart) { $UseAutostart = $true } elseif ($NoAutostart) { $UseAutostart = $false }
if ($null -eq $UseAutostart -and (Test-Path $envFile)) {
  $savedRestart = Select-String -Path $envFile -Pattern '^HOMESCRIBE_RESTART=(.+)$' | Select-Object -Last 1
  if ($savedRestart) { $UseAutostart = $savedRestart.Matches[0].Groups[1].Value.Trim() -eq 'unless-stopped' }
}
if ($null -eq $UseAutostart) {
  $UseAutostart = Ask 'Start Homescribe when Windows starts? (otherwise use the "Start Homescribe" shortcut)' $false
}
$Restart = if ($UseAutostart) { 'unless-stopped' } else { 'no' }

# ------------------------------------------------------------------ files

Step "Writing $Dir"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Dir = (Resolve-Path $Dir).Path
$extensionFolder = Join-Path $Dir 'browser-extension'
$composeFile = Join-Path $Dir 'compose.yaml'
$controlScript = Join-Path $Dir 'homescribe.ps1'
if ($Source) {
  Copy-Item (Join-Path $Source 'compose.yaml') $composeFile -Force
  Copy-Item (Join-Path $Source 'scripts/homescribe.ps1') $controlScript -Force
} else {
  Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/$Repo/$Ref/compose.yaml" -OutFile $composeFile
  Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/$Repo/$Ref/scripts/homescribe.ps1" -OutFile $controlScript
}

# Double-click launchers; the window stays open so the result can be read.
$launchers = [ordered]@{
  'Start Homescribe.cmd' = 'start'
  'Stop Homescribe.cmd' = 'stop'
  'Homescribe status.cmd' = 'status'
  'Update Homescribe.cmd' = 'update'
}
foreach ($name in $launchers.Keys) {
  $body = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0homescribe.ps1`" $($launchers[$name])`r`npause`r`n"
  [IO.File]::WriteAllText((Join-Path $Dir $name), $body, (New-Object Text.ASCIIEncoding))
}

$profiles = @()
if ($Stt -ne 'none') { $profiles += $Stt }
if ($UseLlm) { $profiles += $(if ($Stt -eq 'gpu') { 'llm-gpu' } else { 'llm-cpu' }) }

# Our keys are rewritten; anything else in .env is kept.
$kept = @()
if (Test-Path $envFile) {
  $kept = Get-Content $envFile | Where-Object { $_ -notmatch $(if ($Stt -ne 'none') { '^(AI_TAKE_TURNS|COMPOSE_PROFILES|EXTENSION_FOLDER|HOMESCRIBE_IMAGE|HOMESCRIBE_PORT|HOMESCRIBE_RESTART|LLM_MODE|LLM_MODEL|STT_MODEL)=' } else { '^(AI_TAKE_TURNS|COMPOSE_PROFILES|EXTENSION_FOLDER|HOMESCRIBE_IMAGE|HOMESCRIBE_PORT|HOMESCRIBE_RESTART|LLM_MODE|LLM_MODEL)=' }) }
}
$lines = @($kept) + @(
  "COMPOSE_PROFILES=$($profiles -join ',')",
  "HOMESCRIBE_IMAGE=$Image",
  "HOMESCRIBE_PORT=$Port",
  "HOMESCRIBE_RESTART=$Restart",
  "EXTENSION_FOLDER=$extensionFolder",
  "AI_TAKE_TURNS=$(if ($TakeTurns) { 'true' } else { 'false' })"
)
if ($Stt -ne 'none') { $lines += "STT_MODEL=$($SttChoice.Id)" }
$lines += $(if ($UseLlm) { @('LLM_MODE=local', "LLM_MODEL=$LlmModel") } else { @('LLM_MODE=off') })
# UTF-8 without BOM: Compose reads the file as is.
[IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object Text.UTF8Encoding $false))
Ok "compose.yaml and .env written (profiles: $(if ($profiles) { $profiles -join ',' } else { 'none' }))"

# ------------------------------------------------------------------ start

Push-Location $Dir
try {
  # Services from an earlier choice that are not wanted now (GPU <-> CPU, no LLM).
  $unused = @()
  foreach ($pair in @('stt-gpu:gpu', 'stt-cpu:cpu', 'ollama-gpu:llm-gpu', 'ollama-cpu:llm-cpu')) {
    $svc, $prof = $pair -split ':'
    if ($profiles -notcontains $prof) { $unused += $svc }
  }
  Test-Native { docker compose --profile '*' rm --stop --force @unused } | Out-Null

  # Image versions before the update, to remove the replaced ones afterwards.
  function Get-ImageIds {
    $ErrorActionPreference = 'Continue'
    @(docker compose config --images 2>$null | ForEach-Object { docker image inspect -f '{{.Id}}' $_ 2>$null })
  }
  $oldImages = Get-ImageIds

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

  # Unpacked for "Load unpacked"; the settings show this folder.
  $zip = Join-Path ([IO.Path]::GetTempPath()) 'homescribe-extension.zip'
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 "http://127.0.0.1:$Port/api/v1/extension.zip" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $extensionFolder -Force
    Ok "Browser extension unpacked in $extensionFolder"
  } catch {
    Warn "Could not unpack the browser extension: $($_.Exception.Message)"
  } finally {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
  }

  $service = if ($Stt -eq 'gpu') { 'ollama-gpu' } else { 'ollama-cpu' }
  if ($UseLlm -and $HaveLlm -contains $LlmModel) {
    Ok "Summary model $LlmModel is already downloaded"
  } elseif ($UseLlm) {
    # Ollama resumes an interrupted download the next time it is asked for it.
    Step "Downloading the summary model $LlmModel"
    docker compose exec $service ollama pull $LlmModel                     # with a progress bar
    if ($LASTEXITCODE -ne 0) { docker compose exec -T $service ollama pull $LlmModel }  # no console attached
    if ($LASTEXITCODE -ne 0) { Warn "Could not download $LlmModel now; run the installer again to continue where it stopped." }
  }

  if ($Stt -ne 'none') {
    # speaches downloads into the hf-hub-cache volume and resumes unfinished
    # files; it keeps going even if this window is closed.
    $haveIt = $HaveStt -contains $SttChoice.Id
    if ($haveIt) { Step "Starting speech recognition ($($SttChoice.Name) is already downloaded)" }
    else { Step "Downloading the speech model $($SttChoice.Name)$(if ($SttChoice.Size) { " (about $($SttChoice.Size) GB)" })" }
    $sttDir = "$HfDir/models--$($SttChoice.Id.Replace('/', '--'))"
    # Ask speaches to download it (POST /v1/models/{id}); not every image build
    # honours PRELOAD_MODELS. Detached inside the container, with retries until
    # the server listens, so it survives this window being closed. The id goes
    # in as $0 so that no quotes have to cross into the native argument.
    if (-not $haveIt) {
      $kick = 'i=0; while [ $i -lt 120 ]; do curl -fsS -X POST http://localhost:8000/v1/models/$0 >/tmp/homescribe-download.log 2>&1 && exit 0; i=$((i+1)); sleep 5; done; exit 1'
      if (-not (Test-Native { docker compose exec -d "stt-$Stt" sh -c $kick $SttChoice.Id })) { Warn "Could not ask the speech server to download $($SttChoice.Id)." }
    }
    for ($i = 0; ; $i++) {
      # speaches lists a model as soon as its first files are on disk, so a
      # requested download is done only when its answer is in the log.
      $health = Get-Health
      if ($health -and $health.checks -and $health.checks.stt -eq 'ok') {
        if ($haveIt) { break }
        $log = & { $ErrorActionPreference = 'Continue'; docker compose exec -T "stt-$Stt" cat /tmp/homescribe-download.log 2>$null }
        if ("$log" -match 'downloaded|already exists') { break }
      }
      if ($i -ge 360) {
        Write-Host ''; Warn 'Speech recognition is not ready yet; it keeps downloading in the background.'
        & { $ErrorActionPreference = 'Continue'; docker compose exec -T "stt-$Stt" cat /tmp/homescribe-download.log 2>$null } | Select-Object -Last 5
        break
      }
      $bytes = $null
      if (-not $haveIt) {
        $du = & { $ErrorActionPreference = 'Continue'; docker compose exec -T "stt-$Stt" du -sb $sttDir 2>$null } | Select-Object -First 1
        if ("$du" -match '^(\d+)') { $bytes = [double]$Matches[1] }
      }
      if ($null -ne $bytes) {
        $of = if ($SttChoice.Size) { " of ~$($SttChoice.Size)" } else { '' }
        Write-Host -NoNewline ("`r  {0} GB{1} downloaded " -f ($bytes / 1e9).ToString('0.00', [Globalization.CultureInfo]::InvariantCulture), $of)
      } else {
        Write-Host -NoNewline '.'
      }
      Start-Sleep -Seconds 5
    }
    Write-Host ''
  }

  # ---------------------------------------------------------------- clean up

  # Replaced image versions are removed without asking (they are not used).
  $currentImages = Get-ImageIds
  foreach ($id in $oldImages) {
    if ($currentImages -notcontains $id) { Test-Native { docker image rm $id } | Out-Null }
  }

  # Models that are not used any more, and unfinished downloads of them.
  $unusedStt = @(@($HaveStt) + @($PartialStt) | Where-Object { $_ -and ($Stt -eq 'none' -or $_ -ne $SttChoice.Id) })
  $unusedLlm = @($HaveLlm | Where-Object { $_ -and (-not $UseLlm -or $_ -ne $LlmModel) })
  if (($unusedStt.Count + $unusedLlm.Count) -gt 0 -and -not $Yes) {
    Step 'Models you no longer use'
    $unusedStt | ForEach-Object { Write-Host "  speech: $_" }
    $unusedLlm | ForEach-Object { Write-Host "  summaries: $_" }
    if (Ask 'Delete them to free disk space?' $true) {
      if ($unusedStt) {
        $script = ($unusedStt | ForEach-Object { "rm -rf '/hf/models--$($_.Replace('/', '--'))'" }) -join '; '
        Invoke-Volumes $script | Out-Null
      }
      if ($unusedLlm -and $UseLlm) {
        foreach ($id in $unusedLlm) { if (-not (Test-Native { docker compose exec -T $service ollama rm $id })) { Warn "Could not delete $id." } }
      } elseif ($unusedLlm) {
        if (-not (Test-Native { docker volume rm $VolOl })) { Warn 'Could not delete the summary models.' }
      }
      Ok 'Deleted'
    }
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

  # Start menu shortcuts to the launchers.
  $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Homescribe'
  if (Ask 'Add "Homescribe: start" and "Homescribe: stop" to the Start menu?' $true) {
    New-Item -ItemType Directory -Force -Path $menu | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    foreach ($pair in @(@('Homescribe - start', 'Start Homescribe.cmd'), @('Homescribe - stop', 'Stop Homescribe.cmd'), @('Homescribe - status', 'Homescribe status.cmd'))) {
      $link = $shell.CreateShortcut((Join-Path $menu "$($pair[0]).lnk"))
      $link.TargetPath = Join-Path $Dir $pair[1]
      $link.WorkingDirectory = $Dir
      $link.Save()
    }
    Ok "Start menu: $menu"
  }

  Write-Host "`nStart, stop and check it with the shortcuts in $Dir"
  Write-Host '  Start Homescribe, Stop Homescribe, Homescribe status, Update Homescribe'
  if ($UseAutostart) {
    Write-Host 'It starts with Windows when Docker Desktop does (Docker Desktop -> Settings -> General -> Start Docker Desktop when you sign in).'
  } else {
    Write-Host 'It does not start with Windows. Run the installer with -Autostart to change that.'
  }
  Write-Host 'Change models or the GPU/CPU choice by running the installer again.'
  Write-Host 'Other devices on your network may need a Windows Firewall rule for this port.'
} finally {
  Pop-Location
}
