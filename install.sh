#!/usr/bin/env bash
# Homescribe installer for Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/mazoriksay/homescribe/main/install.sh | bash
#
# Checks (and with your consent installs) Docker, finds an NVIDIA GPU, asks
# what to download (where speech recognition runs, the Whisper model, a local
# summary model or none) and shows a summary before pulling, writes
# compose.yaml and .env into an install folder,
# starts everything and waits until Homescribe answers. Re-run it any time to
# update. `install.sh --help` lists the options.

set -euo pipefail

REPO="${HOMESCRIBE_REPO:-mazoriksay/homescribe}"
REF="${HOMESCRIBE_REF:-main}"
DIR="${HOMESCRIBE_DIR:-$HOME/homescribe}"
PORT=""
IMAGE="${HOMESCRIBE_IMAGE:-ghcr.io/$REPO:latest}"
STT=""            # gpu | cpu | none
LLM=""            # yes | no
STT_MODEL=""      # short name from the list below or any model id
LLM_MODEL="${HOMESCRIBE_LLM_MODEL:-}"
ASSUME_YES=0
SOURCE_DIR=""     # use compose.yaml from a local checkout instead of downloading
AUTOSTART=""      # yes | no

usage() {
  cat <<'USAGE'
Usage: install.sh [options]

  --dir DIR        Install folder (default: ~/homescribe)
  --port N         Port for the web UI (default: 8080, or the next free one)
  --gpu | --cpu    Speech-to-text on the NVIDIA GPU or the CPU (default: detect)
  --no-stt         Do not run speech-to-text here (use your own server)
  --stt-model M    Whisper model: large-v3, large-v3-turbo, medium, small or an id
  --llm | --no-llm Run a local LLM (Ollama) for summaries, or not (default: ask)
  --llm-model M    Ollama model for summaries, e.g. qwen2.5:7b (implies --llm)
  --image IMAGE    Homescribe image (default: ghcr.io/<repo>:latest)
  --autostart | --no-autostart
                   Start Homescribe with the computer, or only with ./homescribe start
                   (default: ask; no)
  --yes, -y        Accept all defaults and consents without asking
  --source DIR     Use compose.yaml from a local checkout (for development)
  -h, --help       Show this help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --gpu) STT=gpu; shift ;;
    --cpu) STT=cpu; shift ;;
    --no-stt) STT=none; shift ;;
    --llm) LLM=yes; shift ;;
    --no-llm) LLM=no; shift ;;
    --stt-model) STT_MODEL="$2"; shift 2 ;;
    --llm-model) LLM_MODEL="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --autostart) AUTOSTART=yes; shift ;;
    --no-autostart) AUTOSTART=no; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --source) SOURCE_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------- output

if [ -t 1 ]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi
step() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$RESET"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()  { printf '%s✗ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

# Questions read from the terminal even when the script is piped into bash.
ask_yes_no() { # question default(y|n)
  local question="$1" default="$2" answer hint
  if [ "$ASSUME_YES" = 1 ]; then [ "$default" = y ]; return; fi
  if ! { : </dev/tty; } 2>/dev/null; then [ "$default" = y ]; return; fi
  [ "$default" = y ] && hint="[Y/n]" || hint="[y/N]"
  printf '%s %s ' "$question" "$hint" >/dev/tty
  read -r answer </dev/tty || answer=""
  answer="${answer:-$default}"
  case "$answer" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# A numbered menu; prints the chosen index (0-based). --yes takes the default.
choose() { # title default option...
  local title="$1" default="$2" answer i; shift 2
  if [ "$ASSUME_YES" = 1 ] || ! { : </dev/tty; } 2>/dev/null; then echo "$default"; return; fi
  printf '\n%s\n' "$title" >/dev/tty
  i=0
  for option in "$@"; do
    i=$((i + 1))
    if [ "$i" -eq $((default + 1)) ]; then printf '  %d) %s  <- default\n' "$i" "$option" >/dev/tty
    else printf '  %d) %s\n' "$i" "$option" >/dev/tty; fi
  done
  while :; do
    printf 'Choose 1-%d [%d] ' "$#" $((default + 1)) >/dev/tty
    read -r answer </dev/tty || answer=""
    [ -z "$answer" ] && { echo "$default"; return; }
    case "$answer" in
      *[!0-9]*) ;;
      *) if [ "$answer" -ge 1 ] && [ "$answer" -le "$#" ]; then echo $((answer - 1)); return; fi ;;
    esac
    printf 'Enter one of the numbers above.\n' >/dev/tty
  done
}

# What can be downloaded: name|id|download GB|GB in use|note. In use means
# video memory on a GPU, RAM on a CPU; all sizes are approximate.
STT_MODELS=(
  "large-v3|Systran/faster-whisper-large-v3|3.1|4.5|best quality"
  "large-v3-turbo|deepdml/faster-whisper-large-v3-turbo-ct2|1.6|2.5|almost as good, several times faster"
  "medium|Systran/faster-whisper-medium|1.5|2.5|good, for older GPUs"
  "small|Systran/faster-whisper-small|0.5|1|fast on a CPU, rougher text"
)
LLM_MODELS=(
  "qwen2.5:7b|4.7|6|good in Russian and English"
  "llama3.1:8b|4.9|6.5|good in English"
  "qwen2.5:3b|1.9|3|smaller, for weaker machines"
)

need() { command -v "$1" >/dev/null 2>&1; }

SUDO=""
if [ "$(id -u)" -ne 0 ] && need sudo; then SUDO="sudo"; fi

OS="$(uname -s)"
case "$OS" in
  Linux|Darwin) ;;
  *) die "This installer is for Linux and macOS. On Windows use install.ps1." ;;
esac

need curl || die "curl is required."

# ---------------------------------------------------------------- docker

DOCKER="docker"

docker_works() { $DOCKER info >/dev/null 2>&1; }

install_docker_linux() {
  step "Installing Docker (official script from get.docker.com)"
  local script; script="$(mktemp)"
  curl -fsSL https://get.docker.com -o "$script"
  $SUDO sh "$script"
  rm -f "$script"
  $SUDO systemctl enable --now docker 2>/dev/null || true
  if [ -n "$SUDO" ]; then
    $SUDO usermod -aG docker "$(id -un)" 2>/dev/null || true
    warn "You were added to the 'docker' group; it applies after you log in again. Using sudo for now."
  fi
}

install_docker_mac() {
  if need brew; then
    step "Installing Docker Desktop with Homebrew"
    brew install --cask docker-desktop
    open -a Docker || true
  else
    warn "Install Docker Desktop from https://www.docker.com/products/docker-desktop/ and start it."
    open "https://www.docker.com/products/docker-desktop/" 2>/dev/null || true
  fi
}

wait_for_docker() {
  local waited=0
  printf 'Waiting for Docker to start'
  until docker_works; do
    [ "$waited" -ge 600 ] && { echo; die "Docker did not start within 10 minutes. Start it and run the installer again."; }
    printf '.'; sleep 5; waited=$((waited + 5))
  done
  echo; ok "Docker is running"
}

step "Checking Docker"
if ! need docker; then
  if ask_yes_no "Docker is not installed. Install it now?" y; then
    if [ "$OS" = Linux ]; then install_docker_linux; else install_docker_mac; fi
  else
    die "Docker is required. Install it and run this script again: https://docs.docker.com/get-docker/"
  fi
fi
if ! docker_works && [ -n "$SUDO" ] && $SUDO docker info >/dev/null 2>&1; then
  DOCKER="$SUDO docker"   # installed, but this user is not in the docker group yet
fi
if ! docker_works; then
  if [ "$OS" = Linux ]; then
    $SUDO systemctl start docker 2>/dev/null || true
  else
    open -a Docker 2>/dev/null || true
  fi
  wait_for_docker
fi
$DOCKER compose version >/dev/null 2>&1 \
  || die "Docker Compose v2 is missing. Install the docker-compose-plugin package (Linux) or update Docker Desktop."
ok "Docker $($DOCKER version --format '{{.Server.Version}}' 2>/dev/null) with Compose $($DOCKER compose version --short)"

# ---------------------------------------------------------------- gpu

has_nvidia_gpu() { [ "$OS" = Linux ] && need nvidia-smi && nvidia-smi -L >/dev/null 2>&1; }
docker_has_nvidia() { $DOCKER info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia; }

install_nvidia_toolkit() {
  step "Installing the NVIDIA Container Toolkit (docs.nvidia.com install guide)"
  if need apt-get; then
    $SUDO apt-get update
    $SUDO apt-get install -y --no-install-recommends ca-certificates curl gnupg2
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
      | $SUDO gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
      | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
      | $SUDO tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
    $SUDO apt-get update
    $SUDO apt-get install -y nvidia-container-toolkit
  elif need dnf; then
    curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo \
      | $SUDO tee /etc/yum.repos.d/nvidia-container-toolkit.repo >/dev/null
    $SUDO dnf install -y nvidia-container-toolkit
  else
    return 1
  fi
  $SUDO nvidia-ctk runtime configure --runtime=docker
  $SUDO systemctl restart docker
  wait_for_docker
}

[ -n "$LLM_MODEL" ] && [ "$LLM" != no ] && LLM=yes

# ---------------------------------------------------------------- downloads

# Models live in Compose volumes (project "homescribe"). A throwaway container
# from an image that is already here reads them, so nothing is downloaded
# just to look.
VOL_HF="homescribe_hf-hub-cache"
VOL_OL="homescribe_ollama-models"
HF_DIR="/home/ubuntu/.cache/huggingface/hub"
HAVE_STT=()      # complete Whisper models
PARTIAL_STT=()   # Whisper downloads that never finished
HAVE_LLM=()      # Ollama models

volumes_shell() { # script: runs in a helper container with the model volumes at /hf and /ol
  local args=()
  $DOCKER image inspect "$IMAGE" >/dev/null 2>&1 || return 1
  $DOCKER volume inspect "$VOL_HF" >/dev/null 2>&1 && args+=(-v "$VOL_HF:/hf")
  $DOCKER volume inspect "$VOL_OL" >/dev/null 2>&1 && args+=(-v "$VOL_OL:/ol")
  [ ${#args[@]} -gt 0 ] || return 1
  $DOCKER run --rm --user 0 "${args[@]}" --entrypoint sh "$IMAGE" -c "$1"
}

# shellcheck disable=SC2016  # runs in the helper container
SCAN='
for d in /hf/models--*; do
  [ -d "$d" ] || continue
  id="${d#/hf/models--}"
  case "$id" in *whisper*) ;; *) continue ;; esac  # speaches keeps other helper models here
  if ls "$d"/snapshots/*/model.bin >/dev/null 2>&1 && [ -e "$(ls -d "$d"/snapshots/*/model.bin | head -1)" ]; then
    echo "stt $id"
  else
    echo "partial $id"
  fi
done
lib=/ol/models/manifests/registry.ollama.ai/library
[ -d "$lib" ] && cd "$lib" && for f in */*; do [ -f "$f" ] && echo "llm ${f%%/*}:${f#*/}"; done
true'
while read -r kind id; do
  case "$kind" in
    stt) HAVE_STT+=("${id/--//}") ;;
    partial) PARTIAL_STT+=("${id/--//}") ;;
    llm) HAVE_LLM+=("$id") ;;
  esac
done < <(volumes_shell "$SCAN" 2>/dev/null || true)

has() { # needle haystack...
  local needle="$1" item; shift
  for item in "$@"; do [ "$item" = "$needle" ] && return 0; done
  return 1
}

GPU_MEM=""
if [ -z "$STT" ]; then
  step "Choosing what to download"
  gpu_ok=no
  if has_nvidia_gpu; then
    mib="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -dc '0-9')"
    [ -n "$mib" ] && GPU_MEM="$(awk -v m="$mib" 'BEGIN { printf "%.1f", m / 1024 }')"
    ok "NVIDIA GPU found: $(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)${GPU_MEM:+, $GPU_MEM GB}"
    if docker_has_nvidia; then
      gpu_ok=yes
    elif ask_yes_no "Docker cannot use the GPU yet. Install the NVIDIA Container Toolkit?" y \
      && install_nvidia_toolkit && docker_has_nvidia; then
      gpu_ok=yes
    else
      warn "Docker cannot use the GPU; re-run with --gpu after setting up the NVIDIA Container Toolkit."
    fi
  elif [ "$OS" = Darwin ]; then
    warn "Docker on macOS cannot use the GPU; speech recognition here would run on the CPU (slower)."
  fi
  where=() values=()
  if [ "$gpu_ok" = yes ]; then where+=("On this NVIDIA GPU"); values+=(gpu); fi
  where+=("On the CPU (works anywhere, slow for long recordings)"); values+=(cpu)
  where+=("Not on this computer (a cloud API or another server, chosen in Settings)"); values+=(none)
  STT="${values[$(choose "Speech recognition:" 0 "${where[@]}")]}"
fi
if [ "$STT" = gpu ]; then MEM="video memory"; else MEM="RAM"; fi

# The Whisper model: a short name from the list or any model id.
STT_ID="" STT_NAME="" STT_SIZE="" STT_MEM=""
if [ "$STT" != none ]; then
  if [ -n "$STT_MODEL" ]; then
    STT_NAME="$STT_MODEL" STT_ID="$STT_MODEL"
    for entry in "${STT_MODELS[@]}"; do
      IFS='|' read -r name id size inuse _ <<<"$entry"
      if [ "$name" = "$STT_MODEL" ] || [ "$id" = "$STT_MODEL" ]; then
        STT_NAME="$name" STT_ID="$id" STT_SIZE="$size" STT_MEM="$inuse"
      fi
    done
  else
    labels=()
    for entry in "${STT_MODELS[@]}"; do
      IFS='|' read -r name _ size inuse note <<<"$entry"
      id="$(printf '%s' "$entry" | cut -d'|' -f2)"
      if has "$id" ${HAVE_STT[@]+"${HAVE_STT[@]}"}; then
        labels+=("$name - downloaded, uses ~$inuse GB $MEM, $note")
      else
        labels+=("$name - download $size GB, uses ~$inuse GB $MEM, $note")
      fi
    done
    if [ "$STT" = gpu ]; then default_stt=0; else default_stt=3; fi
    IFS='|' read -r STT_NAME STT_ID STT_SIZE STT_MEM _ <<<"${STT_MODELS[$(choose "Speech recognition model (Whisper):" "$default_stt" "${labels[@]}")]}"
  fi
fi

# The local summary model, or none.
if [ "$LLM" = yes ]; then
  [ -z "$LLM_MODEL" ] && LLM_MODEL="${LLM_MODELS[0]%%|*}"
elif [ -z "$LLM" ]; then
  if { : </dev/tty; } 2>/dev/null && [ "$ASSUME_YES" != 1 ]; then
    {
      echo
      echo "The two models take turns: a recording is transcribed first, then summarized."
      echo "Each stays loaded for about 5 minutes after use, so right after a recording both"
      echo "can sit in $MEM at once. Plan for the sum of the two."
    } >/dev/tty
  fi
  labels=()
  for entry in "${LLM_MODELS[@]}"; do
    IFS='|' read -r id size inuse note <<<"$entry"
    if has "$id" ${HAVE_LLM[@]+"${HAVE_LLM[@]}"}; then
      labels+=("$id - downloaded, uses ~$inuse GB $MEM, $note")
    else
      labels+=("$id - download $size GB, uses ~$inuse GB $MEM, $note")
    fi
  done
  labels+=("None (use a cloud API in Settings, or no summaries)")
  if [ "$STT" = gpu ]; then default_llm=0; else default_llm=${#LLM_MODELS[@]}; fi
  pick="$(choose "Local AI for summaries (Ollama):" "$default_llm" "${labels[@]}")"
  if [ "$pick" -lt "${#LLM_MODELS[@]}" ]; then LLM=yes LLM_MODEL="${LLM_MODELS[$pick]%%|*}"; else LLM=no; fi
fi

# Summary, then one confirmation before anything is downloaded.
step "You chose"
echo "  Homescribe app"
if [ "$STT" = none ]; then echo "  Speech recognition: not on this computer"
else
  if has "$STT_ID" ${HAVE_STT[@]+"${HAVE_STT[@]}"}; then stt_note=" (already downloaded)"
  elif has "$STT_ID" ${PARTIAL_STT[@]+"${PARTIAL_STT[@]}"}; then stt_note=" (continues the unfinished download${STT_SIZE:+ of about $STT_SIZE GB})"
  else stt_note="${STT_SIZE:+ (download about $STT_SIZE GB)}"; fi
  echo "  Speech recognition on the $(echo "$STT" | tr '[:lower:]' '[:upper:]'): $STT_NAME$stt_note"
fi
llm_mem=""
if [ "$LLM" = yes ]; then
  llm_size=""
  for entry in "${LLM_MODELS[@]}"; do
    IFS='|' read -r id size inuse _ <<<"$entry"
    if [ "$id" = "$LLM_MODEL" ]; then llm_size="$size" llm_mem="$inuse"; fi
  done
  if has "$LLM_MODEL" ${HAVE_LLM[@]+"${HAVE_LLM[@]}"}; then llm_note=" (already downloaded)"; else llm_note="${llm_size:+ (download about $llm_size GB)}"; fi
  echo "  Summaries: Ollama with $LLM_MODEL$llm_note"
else
  echo "  Summaries: no local AI"
fi
mem_sum="$(awk -v a="${STT_MEM:-0}" -v b="${llm_mem:-0}" 'BEGIN { s = a + b; if (s > 0) printf "%g", s }')"
if [ -n "$mem_sum" ]; then
  gpu_note=""
  [ "$STT" = gpu ] && [ -n "$GPU_MEM" ] && gpu_note=" (this GPU has $GPU_MEM GB)"
  echo "  Memory: up to ~$mem_sum GB of $MEM while both are loaded$gpu_note"
  if [ "$STT" = gpu ] && [ -n "$GPU_MEM" ] && awk -v s="$mem_sum" -v g="$GPU_MEM" 'BEGIN { exit !(s > g) }'; then
    warn "More than this GPU has: Ollama then runs partly on the CPU and summaries get slower. Pick smaller models to avoid that."
  fi
fi
ask_yes_no "Download and start?" y || { echo "Nothing was downloaded."; exit 0; }

# ---------------------------------------------------------------- port

port_in_use() {
  if need ss; then ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"
  elif need lsof; then lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
  fi
}

# Keep the port of an earlier install.
if [ -z "$PORT" ] && [ -f "$DIR/.env" ]; then
  PORT="$(sed -n 's/^HOMESCRIBE_PORT=//p' "$DIR/.env" | tail -1)"
fi
if [ -z "$PORT" ]; then
  PORT=8080
  while port_in_use "$PORT"; do PORT=$((PORT + 1)); done
fi

# ---------------------------------------------------------------- autostart

# Keep the answer of an earlier install unless asked again with a flag.
if [ -z "$AUTOSTART" ] && [ -f "$DIR/.env" ]; then
  case "$(sed -n 's/^HOMESCRIBE_RESTART=//p' "$DIR/.env" | tail -1)" in
    no) AUTOSTART=no ;;
    unless-stopped) AUTOSTART=yes ;;
  esac
fi
if [ -z "$AUTOSTART" ]; then
  if ask_yes_no "Start Homescribe when the computer starts? (otherwise: ./homescribe start)" n; then
    AUTOSTART=yes
  else
    AUTOSTART=no
  fi
fi
RESTART="$([ "$AUTOSTART" = yes ] && echo unless-stopped || echo no)"

# ---------------------------------------------------------------- files

step "Writing $DIR"
mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd)"
if [ -n "$SOURCE_DIR" ]; then
  cp "$SOURCE_DIR/compose.yaml" "$DIR/compose.yaml"
  cp "$SOURCE_DIR/scripts/homescribe" "$DIR/homescribe"
else
  for file in compose.yaml scripts/homescribe; do
    curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/$file" -o "$DIR/$(basename "$file").new"
    mv "$DIR/$(basename "$file").new" "$DIR/$(basename "$file")"
  done
fi
chmod +x "$DIR/homescribe"

profiles=""
[ "$STT" != none ] && profiles="$STT"
[ "$LLM" = yes ] && profiles="${profiles:+$profiles,}llm-$([ "$STT" = gpu ] && echo gpu || echo cpu)"

# Our keys are rewritten; anything else you put into .env is kept.
touch "$DIR/.env"
tmp="$(mktemp)"
ours='COMPOSE_PROFILES|EXTENSION_FOLDER|HOMESCRIBE_IMAGE|HOMESCRIBE_PORT|HOMESCRIBE_RESTART|LLM_MODE|LLM_MODEL'
[ "$STT" != none ] && ours="$ours|STT_MODEL"
grep -vE "^($ours)=" "$DIR/.env" > "$tmp" || true
{
  cat "$tmp"
  echo "COMPOSE_PROFILES=$profiles"
  echo "HOMESCRIBE_IMAGE=$IMAGE"
  echo "HOMESCRIBE_PORT=$PORT"
  echo "HOMESCRIBE_RESTART=$RESTART"
  echo "EXTENSION_FOLDER=$DIR/browser-extension"
  [ "$STT" != none ] && echo "STT_MODEL=$STT_ID"
  if [ "$LLM" = yes ]; then echo "LLM_MODE=local"; echo "LLM_MODEL=$LLM_MODEL"; else echo "LLM_MODE=off"; fi
} > "$DIR/.env"
rm -f "$tmp"
ok "compose.yaml and .env written (profiles: ${profiles:-none})"

# ---------------------------------------------------------------- start

cd "$DIR"

# Services from an earlier choice that are not wanted now (GPU <-> CPU, no LLM).
unused_services=()
for svc in stt-gpu:gpu stt-cpu:cpu ollama-gpu:llm-gpu ollama-cpu:llm-cpu; do
  case ",$profiles," in *",${svc#*:},"*) ;; *) unused_services+=("${svc%%:*}") ;; esac
done
$DOCKER compose --profile '*' rm --stop --force "${unused_services[@]}" >/dev/null 2>&1 || true

# Image versions before the update, to remove the replaced ones afterwards.
image_ids() { $DOCKER compose config --images 2>/dev/null | while read -r ref; do $DOCKER image inspect -f '{{.Id}}' "$ref" 2>/dev/null || true; done; }
old_images="$(image_ids)"

step "Downloading images (the first time this takes a while)"
if ! $DOCKER compose pull; then
  if $DOCKER image inspect "$IMAGE" >/dev/null 2>&1; then
    warn "Could not pull everything; using the local image $IMAGE."
  else
    die "Could not download the images. Check the internet connection and run the installer again."
  fi
fi

step "Starting Homescribe"
$DOCKER compose up -d --remove-orphans

health() { curl -fsS "http://127.0.0.1:$PORT/api/v1/health" 2>/dev/null || true; }
printf 'Waiting for Homescribe'
waited=0
until [ -n "$(health)" ]; do
  [ "$waited" -ge 180 ] && { echo; die "Homescribe did not answer. Logs: cd $DIR && docker compose logs homescribe"; }
  printf '.'; sleep 3; waited=$((waited + 3))
done
echo; ok "Homescribe is running"

# Unpacked for "Load unpacked"; the settings show this folder.
ext_zip="$(mktemp)"
if curl -fsS --max-time 30 "http://127.0.0.1:$PORT/api/v1/extension.zip" -o "$ext_zip" 2>/dev/null \
  && mkdir -p browser-extension \
  && { if command -v unzip >/dev/null 2>&1; then unzip -qo "$ext_zip" -d browser-extension;
       else python3 -m zipfile -e "$ext_zip" browser-extension; fi; } 2>/dev/null; then
  ok "Browser extension unpacked in $DIR/browser-extension"
else
  warn "Could not unpack the browser extension; it can be downloaded in Settings → YouTube."
fi
rm -f "$ext_zip"

llm_service="ollama-$([ "$STT" = gpu ] && echo gpu || echo cpu)"
if [ "$LLM" = yes ] && has "$LLM_MODEL" ${HAVE_LLM[@]+"${HAVE_LLM[@]}"}; then
  ok "Summary model $LLM_MODEL is already downloaded"
elif [ "$LLM" = yes ]; then
  # Ollama resumes an interrupted download the next time it is asked for it.
  step "Downloading the summary model $LLM_MODEL"
  if { : </dev/tty; } 2>/dev/null; then
    pull_ok() { $DOCKER compose exec "$llm_service" ollama pull "$LLM_MODEL" </dev/tty; }  # with a progress bar
  else
    pull_ok() { $DOCKER compose exec -T "$llm_service" ollama pull "$LLM_MODEL"; }
  fi
  pull_ok || warn "Could not download $LLM_MODEL now; run the installer again to continue where it stopped."
fi

if [ "$STT" != none ]; then
  # speaches downloads into the hf-hub-cache volume and resumes unfinished
  # files; it keeps going even if this window is closed.
  if has "$STT_ID" ${HAVE_STT[@]+"${HAVE_STT[@]}"}; then
    step "Starting speech recognition ($STT_NAME is already downloaded)"
  else
    step "Downloading the speech model $STT_NAME${STT_SIZE:+ (about $STT_SIZE GB)}"
  fi
  stt_dir="$HF_DIR/models--${STT_ID//\//--}"
  # Ask speaches to download it (POST /v1/models/{id}); not every image build
  # honours PRELOAD_MODELS. Detached inside the container, with retries until
  # the server listens, so it survives this window being closed.
  if ! has "$STT_ID" ${HAVE_STT[@]+"${HAVE_STT[@]}"}; then
    # shellcheck disable=SC2016  # expands in the container
    $DOCKER compose exec -d "stt-$STT" sh -c 'i=0; while [ $i -lt 120 ]; do curl -fsS -X POST "http://localhost:8000/v1/models/$0" >/tmp/homescribe-download.log 2>&1 && exit 0; i=$((i+1)); sleep 5; done; exit 1' "$STT_ID" \
      || warn "Could not ask the speech server to download $STT_ID."
  fi
  waited=0
  # speaches lists a model as soon as its first files are on disk, so a
  # requested download is done only when its answer is in the log.
  stt_ready() {
    health | grep -q '"stt":"ok"' || return 1
    has "$STT_ID" ${HAVE_STT[@]+"${HAVE_STT[@]}"} && return 0
    $DOCKER compose exec -T "stt-$STT" cat /tmp/homescribe-download.log 2>/dev/null | grep -Eq 'downloaded|already exists'
  }
  until stt_ready; do
    if [ "$waited" -ge 1800 ]; then
      echo; warn "Speech recognition is not ready yet; it keeps downloading in the background."
      $DOCKER compose exec -T "stt-$STT" cat /tmp/homescribe-download.log 2>/dev/null | tail -5 || true
      break
    fi
    bytes="$($DOCKER compose exec -T "stt-$STT" du -sb "$stt_dir" 2>/dev/null | cut -f1 || true)"
    if [ -n "$bytes" ] && ! has "$STT_ID" ${HAVE_STT[@]+"${HAVE_STT[@]}"}; then
      printf '\r  %s GB%s downloaded ' "$(awk -v b="$bytes" 'BEGIN { printf "%.2f", b / 1e9 }')" "${STT_SIZE:+ of ~$STT_SIZE}"
    else
      printf '.'
    fi
    sleep 5; waited=$((waited + 5))
  done
  echo
fi

# ---------------------------------------------------------------- clean up

# Replaced image versions are removed without asking (they are not used).
current_images="$(image_ids)"
for id in $old_images; do
  case "$current_images" in *"$id"*) ;; *) $DOCKER image rm "$id" >/dev/null 2>&1 || true ;; esac
done

# Models that are not used any more, and unfinished downloads of them.
unused_stt=() unused_llm=()
for id in ${HAVE_STT[@]+"${HAVE_STT[@]}"} ${PARTIAL_STT[@]+"${PARTIAL_STT[@]}"}; do
  [ "$STT" != none ] && [ "$id" = "$STT_ID" ] || unused_stt+=("$id")
done
for id in ${HAVE_LLM[@]+"${HAVE_LLM[@]}"}; do
  [ "$LLM" = yes ] && [ "$id" = "$LLM_MODEL" ] || unused_llm+=("$id")
done
if [ $((${#unused_stt[@]} + ${#unused_llm[@]})) -gt 0 ] && [ "$ASSUME_YES" != 1 ] && { : </dev/tty; } 2>/dev/null; then
  step "Models you no longer use"
  for id in ${unused_stt[@]+"${unused_stt[@]}"}; do echo "  speech: $id"; done
  for id in ${unused_llm[@]+"${unused_llm[@]}"}; do echo "  summaries: $id"; done
  if ask_yes_no "Delete them to free disk space?" y; then
    script=""
    for id in ${unused_stt[@]+"${unused_stt[@]}"}; do script="$script rm -rf '/hf/models--${id//\//--}';"; done
    [ -n "$script" ] && { volumes_shell "$script" >/dev/null || warn "Could not delete the speech models."; }
    if [ ${#unused_llm[@]} -gt 0 ]; then
      if [ "$LLM" = yes ]; then
        for id in ${unused_llm[@]+"${unused_llm[@]}"}; do $DOCKER compose exec -T "$llm_service" ollama rm "$id" >/dev/null || warn "Could not delete $id."; done
      else
        $DOCKER volume rm "$VOL_OL" >/dev/null || warn "Could not delete the summary models."
      fi
    fi
    ok "Deleted"
  fi
fi

# ---------------------------------------------------------------- done

# The first self-check takes a few seconds after start.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  health | grep -q '"checks":{' && break
  sleep 2
done
checks="$(health | sed -n 's/.*"checks":{\([^}]*\)}.*/\1/p' | tr -d '"' | tr ',' ' ')"
step "Done"
echo "Self-check: ${checks:-not available yet}"
echo
echo "Open Homescribe:"
echo "  http://localhost:$PORT"
if [ "$OS" = Linux ] && need ip; then
  # Global IPv4 addresses, without Docker's own bridges.
  ip -4 -o addr show scope global 2>/dev/null \
    | awk '$2 !~ /^(docker|br-|veth)/ { split($4, a, "/"); print a[1] }' \
    | while read -r addr; do echo "  http://$addr:$PORT"; done
elif [ "$OS" = Darwin ]; then
  ip="$(ipconfig getifaddr en0 2>/dev/null || true)"; [ -n "$ip" ] && echo "  http://$ip:$PORT"
fi
echo
[ "$STT" = none ] && echo "Choose your speech-to-text server in Settings → Speech recognition."
echo "Start, stop, check or update it with:"
echo "  $DIR/homescribe start | stop | status | update"
if [ "$AUTOSTART" = yes ]; then
  echo "It starts with the computer; stopping it with ./homescribe stop keeps it off until you start it."
else
  echo "It does not start with the computer. Run the installer with --autostart to change that."
fi
echo "Change models or the GPU/CPU choice by running the installer again."
