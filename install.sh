#!/usr/bin/env bash
# Homescribe installer for Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/mazoriksay/homescribe/main/install.sh | bash
#
# Checks (and with your consent installs) Docker, finds an NVIDIA GPU, picks
# the matching setup, writes compose.yaml and .env into an install folder,
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
LLM_MODEL="${HOMESCRIBE_LLM_MODEL:-llama3.1:8b}"
ASSUME_YES=0
SOURCE_DIR=""     # use compose.yaml from a local checkout instead of downloading

usage() {
  cat <<'USAGE'
Usage: install.sh [options]

  --dir DIR        Install folder (default: ~/homescribe)
  --port N         Port for the web UI (default: 8080, or the next free one)
  --gpu | --cpu    Speech-to-text on the NVIDIA GPU or the CPU (default: detect)
  --no-stt         Do not run speech-to-text here (use your own server)
  --llm | --no-llm Run a local LLM (Ollama) for summaries, or not (default: ask)
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

if [ -z "$STT" ]; then
  step "Choosing where speech recognition runs"
  if has_nvidia_gpu; then
    ok "NVIDIA GPU found: $(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"
    if docker_has_nvidia; then
      STT=gpu
    elif ask_yes_no "Docker cannot use the GPU yet. Install the NVIDIA Container Toolkit?" y \
      && install_nvidia_toolkit && docker_has_nvidia; then
      STT=gpu
    else
      warn "Using the CPU for speech recognition (slower). Re-run with --gpu after setting up the toolkit."
      STT=cpu
    fi
  else
    [ "$OS" = Darwin ] && warn "Docker on macOS cannot use the GPU; speech recognition runs on the CPU (slower)."
    STT=cpu
  fi
fi
ok "Speech recognition: $STT"

if [ -z "$LLM" ]; then
  if [ "$STT" = gpu ]; then default_llm=y; else default_llm=n; fi
  if ask_yes_no "Run a local AI for summaries (Ollama, $LLM_MODEL, about 5 GB)? You can also pick a cloud API later in Settings." "$default_llm"; then
    LLM=yes
  else
    LLM=no
  fi
fi

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
grep -vE '^(COMPOSE_PROFILES|HOMESCRIBE_IMAGE|HOMESCRIBE_PORT|LLM_MODE|LLM_MODEL)=' "$DIR/.env" > "$tmp" || true
{
  cat "$tmp"
  echo "COMPOSE_PROFILES=$profiles"
  echo "HOMESCRIBE_IMAGE=$IMAGE"
  echo "HOMESCRIBE_PORT=$PORT"
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
  step "Waiting for the speech model (first start downloads about 3 GB)"
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
