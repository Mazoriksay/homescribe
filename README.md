# Homescribe

Self-hosted voice notes and media transcription for a home server. Upload
audio or video and get a timestamped transcript, a short summary and action
items, all searchable. Speech-to-text and summaries come from AI servers you
choose: on this machine (found automatically) or a cloud API. See
[`SPEC.md`](SPEC.md) for the full design.

**Status:** stages 1–3 of 5 (transcription, summaries and search, links,
deployment with a one-command installer).
In-browser recording and offline support come next.

## Install

One command sets everything up. It checks Docker and offers to install it,
finds an NVIDIA GPU (and offers the NVIDIA Container Toolkit on Linux), then
asks what to download and shows a summary before anything is pulled:

- where speech recognition runs: the GPU, the CPU, or not on this computer;
- the Whisper model: `large-v3` (about 3.1 GB, best), `large-v3-turbo`
  (1.6 GB, much faster), `medium` (1.5 GB) or `small` (0.5 GB, for a CPU);
- a local AI for summaries: `qwen2.5:7b` (4.7 GB, good in Russian),
  `llama3.1:8b` (4.9 GB), `qwen2.5:3b` (1.9 GB) or none (a cloud API in
  Settings, or no summaries).

Each option shows its download size and how much memory it uses (video
memory on a GPU). The two models take turns, transcription first and the
summary after it, but each stays loaded for about 5 minutes after use, so
plan for both at once: for example `large-v3` (~4.5 GB) plus `qwen2.5:7b`
(~6 GB) need about 10.5 GB. The summary before downloading adds this up and
warns when it is more than the GPU has (Ollama then runs partly on the CPU).

Models you already have are marked as downloaded and are not fetched again.
Downloads show their progress and resume where they stopped if the
connection drops; the speech model keeps downloading in Docker even if you
close the window, so running the installer again simply continues. Old image
versions are removed after an update, and models you no longer use (or
downloads you abandoned) are offered for deletion, so nothing piles up.

Then it finds a free port, starts everything and waits until it works.

**Linux / macOS**

```sh
curl -fsSL https://raw.githubusercontent.com/mazoriksay/homescribe/main/install.sh | bash
```

**Windows** (PowerShell; uses Docker Desktop)

```powershell
irm https://raw.githubusercontent.com/mazoriksay/homescribe/main/install.ps1 | iex
```

At the end it prints the addresses to open, for example
`http://192.168.1.20:8080`, and what the self-check found. The first start
downloads the speech model (about 3 GB). Everything restarts with the machine.

To update, run the same command again. It keeps your port and settings.

Options skip the questions, for example
`bash install.sh --gpu --stt-model large-v3-turbo --llm-model qwen2.5:7b --yes`
or `.\install.ps1 -Cpu -SttModel small -NoLlm -Yes`: install folder, port,
GPU/CPU or no speech recognition here, the Whisper and summary models,
non-interactive. See `install.sh --help`.

What runs where: GPU acceleration works on Linux and on Windows with an
NVIDIA card. Docker on macOS has no GPU access, so speech recognition runs on
the CPU there (fine for voice notes, slow for hour-long recordings); point
Settings at a faster server if you have one.

### By hand with Docker Compose

The installer only writes `compose.yaml` and `.env` into `~/homescribe`. To
do it yourself:

```sh
mkdir homescribe && cd homescribe
curl -fsSLO https://raw.githubusercontent.com/mazoriksay/homescribe/main/compose.yaml
docker compose --profile gpu up -d     # or --profile cpu; add --profile llm-gpu for Ollama
```

Settings go into `.env` next to `compose.yaml` (see
[`.env.example`](.env.example)), for example `COMPOSE_PROFILES=gpu,llm-gpu`,
`HOMESCRIBE_PORT=8080`, `BASE_PATH=/homescribe` or `MAX_UPLOAD_MB=4096`. Data
lives in the `homescribe-data` volume. If something is missing, a notice at
the top of the page says what, and `GET /api/v1/health` lists the same checks.

To build the image from a checkout instead of pulling it:
`docker compose -f compose.yaml -f compose.dev.yaml --profile cpu up -d --build`.

## Transcribe a link

Paste a link under the upload area: YouTube and most video sites (via
[yt-dlp](https://github.com/yt-dlp/yt-dlp)), or a direct link to an audio or
video file. Only the audio is downloaded. The Docker image includes yt-dlp and
deno (the JavaScript runtime yt-dlp needs for YouTube) and keeps yt-dlp up to
date by itself; without Docker, install both and keep yt-dlp current.

Links to this server or the local network are refused unless
`URL_IMPORT_ALLOW_PRIVATE=true` (for example to import from a NAS). Respect the
terms of the sites you download from.

## Put it in your home hub

Serve Homescribe under a path of the hub's own address, for example
`https://home.example.com/homescribe/`, with one reverse proxy in front of
both. One origin means no cross-origin embedding rules, no mixed
`http`/`https` and one certificate.

1. Set `BASE_PATH=/homescribe` for Homescribe.
2. Route `/homescribe/*` to Homescribe unchanged (do not strip the prefix) and
   everything else to the hub. A ready Caddy example is in
   [`deploy/Caddyfile.example`](deploy/Caddyfile.example).
3. In the hub, show `<iframe src="/homescribe/?lang=ru&theme=dark"
allow="microphone; clipboard-write; autoplay">`. The page posts
   `{ source: 'homescribe', type: 'ready' | 'navigate', path }` to the hub when
   it has loaded and on every navigation.

Behind a proxy every request comes from the proxy, so keep the proxy itself
reachable only from your LAN or tailnet.

If the hub stays on a different origin, list it in `FRAME_ANCESTORS` instead
(SPEC.md §11.1).

## HTTPS without your own certificate authority

Browsers need HTTPS for the microphone and for installing the app on a phone.
A self-signed certificate means installing it on every device, so use one of
these instead. Neither is tested by this project on your network; both are the
providers' documented setups.

**Tailscale (no domain, nothing to open):** with MagicDNS and HTTPS
certificates enabled for your tailnet, on the server run

```sh
tailscale serve --bg 8080
```

and open `https://<machine>.<tailnet>.ts.net/` on any device in the tailnet.
For the hub setup above, point `tailscale serve` at the proxy instead of at
Homescribe.

**Your own domain with Let's Encrypt (DNS challenge):** works for a server that
is only reachable on the LAN, because the certificate is proven through a DNS
record, not an open port. Use a reverse proxy with your DNS provider's plugin,
for example Caddy (see [`deploy/Caddyfile.example`](deploy/Caddyfile.example)),
and point the domain at the server's LAN address.

## Run without Docker

Requires Node.js 24, npm and `ffmpeg`/`ffprobe` on the `PATH`.

```sh
npm install
cp .env.example .env   # point STT_BASE_URL / LLM_BASE_URL at your servers
npm run build
npm start              # http://<this-machine>:8080
```

Only clients from `ALLOWED_NETWORKS` (loopback and private ranges by default)
are served. All settings are listed in [`.env.example`](.env.example) and
[`SPEC.md` §9](SPEC.md#9-configuration).

## Development

```sh
npm run dev:server     # API with reload
npm run dev:web        # Vite dev server, proxies /api
npm run typecheck && npm run lint && npm test
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for branches, commits and releases.
