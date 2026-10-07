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

# What can be downloaded: name|id|approximate GB|note
STT_MODELS=(
  "large-v3|Systran/faster-whisper-large-v3|3.1|best quality"
  "large-v3-turbo|deepdml/faster-whisper-large-v3-turbo-ct2|1.6|almost as good, several times faster"
  "medium|Systran/faster-whisper-medium|1.5|good, for older GPUs"
  "small|Systran/faster-whisper-small|0.5|fast on a CPU, rougher text"
)
LLM_MODELS=(
  "qwen2.5:7b|4.7|good in Russian and English"
  "llama3.1:8b|4.9|good in English"
  "qwen2.5:3b|1.9|smaller, for weaker machines"
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

if [ -z "$STT" ]; then
  step "Choosing what to download"
  gpu_ok=no
  if has_nvidia_gpu; then
    ok "NVIDIA GPU found: $(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"
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

# The Whisper model: a short name from the list or any model id.
STT_ID="" STT_NAME="" STT_SIZE=""
if [ "$STT" != none ]; then
  if [ -n "$STT_MODEL" ]; then
    STT_NAME="$STT_MODEL" STT_ID="$STT_MODEL"
    for entry in "${STT_MODELS[@]}"; do
      IFS='|' read -r name id size _ <<<"$entry"
      if [ "$name" = "$STT_MODEL" ] || [ "$id" = "$STT_MODEL" ]; then STT_NAME="$name" STT_ID="$id" STT_SIZE="$size"; fi
    done
  else
    labels=()
    for entry in "${STT_MODELS[@]}"; do
      IFS='|' read -r name _ size note <<<"$entry"
      labels+=("$name - about $size GB, $note")
    done
    if [ "$STT" = gpu ]; then default_stt=0; else default_stt=3; fi
    IFS='|' read -r STT_NAME STT_ID STT_SIZE _ <<<"${STT_MODELS[$(choose "Speech recognition model (Whisper):" "$default_stt" "${labels[@]}")]}"
  fi
fi

# The local summary model, or none.
if [ "$LLM" = yes ]; then
  [ -z "$LLM_MODEL" ] && LLM_MODEL="${LLM_MODELS[0]%%|*}"
elif [ -z "$LLM" ]; then
  labels=()
  for entry in "${LLM_MODELS[@]}"; do
    IFS='|' read -r id size note <<<"$entry"
    labels+=("$id - about $size GB, $note")
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
else echo "  Speech recognition on the $(echo "$STT" | tr '[:lower:]' '[:upper:]'): $STT_NAME${STT_SIZE:+ (model about $STT_SIZE GB)}"; fi
if [ "$LLM" = yes ]; then
  llm_size=""
  for entry in "${LLM_MODELS[@]}"; do
    IFS='|' read -r id size _ <<<"$entry"
    [ "$id" = "$LLM_MODEL" ] && llm_size="$size"
  done
  echo "  Summaries: Ollama with $LLM_MODEL${llm_size:+ (about $llm_size GB)}"
else
  echo "  Summaries: no local AI"
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

# ---------------------------------------------------------------- files

step "Writing $DIR"
mkdir -p "$DIR"
if [ -n "$SOURCE_DIR" ]; then
  cp "$SOURCE_DIR/compose.yaml" "$DIR/compose.yaml"
else
  curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/compose.yaml" -o "$DIR/compose.yaml.new"
  mv "$DIR/compose.yaml.new" "$DIR/compose.yaml"
fi

profiles=""
[ "$STT" != none ] && profiles="$STT"
[ "$LLM" = yes ] && profiles="${profiles:+$profiles,}llm-$([ "$STT" = gpu ] && echo gpu || echo cpu)"

# Our keys are rewritten; anything else you put into .env is kept.
touch "$DIR/.env"
tmp="$(mktemp)"
ours='COMPOSE_PROFILES|HOMESCRIBE_IMAGE|HOMESCRIBE_PORT|LLM_MODE|LLM_MODEL'
[ "$STT" != none ] && ours="$ours|STT_MODEL"
grep -vE "^($ours)=" "$DIR/.env" > "$tmp" || true
{
  cat "$tmp"
  echo "COMPOSE_PROFILES=$profiles"
  echo "HOMESCRIBE_IMAGE=$IMAGE"
  echo "HOMESCRIBE_PORT=$PORT"
  [ "$STT" != none ] && echo "STT_MODEL=$STT_ID"
  if [ "$LLM" = yes ]; then echo "LLM_MODE=local"; echo "LLM_MODEL=$LLM_MODEL"; else echo "LLM_MODE=off"; fi
} > "$DIR/.env"
rm -f "$tmp"
ok "compose.yaml and .env written (profiles: ${profiles:-none})"

# ---------------------------------------------------------------- start

cd "$DIR"
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

if [ "$LLM" = yes ]; then
  step "Downloading the summary model $LLM_MODEL"
  llm_service="ollama-$([ "$STT" = gpu ] && echo gpu || echo cpu)"
  $DOCKER compose exec -T "$llm_service" ollama pull "$LLM_MODEL" \
    || warn "Could not download $LLM_MODEL now; Homescribe will tell you in the UI. Retry: docker compose exec $llm_service ollama pull $LLM_MODEL"
fi

if [ "$STT" != none ]; then
  if [ -n "$STT_SIZE" ]; then stt_download="about $STT_SIZE GB"; else stt_download="the model"; fi
  step "Waiting for the speech model (first start downloads $stt_download)"
  waited=0
  until health | grep -q '"stt":"ok"'; do
    if [ "$waited" -ge 1800 ]; then
      warn "Speech recognition is not ready yet; it keeps downloading in the background."
      break
    fi
    printf '.'; sleep 10; waited=$((waited + 10))
  done
  echo
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
echo "Update later by running the installer again, or: cd $DIR && docker compose pull && docker compose up -d"
