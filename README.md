# Homescribe

Self-hosted voice notes and media transcription for a home server. Upload
audio or video and get a timestamped transcript, a short summary and action
items, all searchable. Speech-to-text and summaries come from AI servers you
choose: on this machine (found automatically) or a cloud API. See
[`SPEC.md`](SPEC.md) for the full design.

**Status:** stages 1–3 of 5 (transcription, summaries and search, deployment).
In-browser recording and offline support come next.

## Run with Docker Compose (recommended)

Requires Docker with Compose v2. The image contains ffmpeg; speech-to-text
(speaches) and an LLM (Ollama) can run next to it.

```sh
git clone https://github.com/<you>/homescribe.git && cd homescribe

docker compose --profile gpu up -d     # + speech-to-text on an NVIDIA GPU
# or
docker compose --profile cpu up -d     # + speech-to-text on the CPU (slow)

# optional: a local LLM for summaries
docker compose --profile gpu --profile llm up -d
docker compose exec ollama ollama pull llama3.1:8b
```

Open `http://<server>:8080`. The first start downloads the speech model
(about 3 GB), so give it a few minutes. If something is missing, a notice at
the top of the page says what, and `GET /api/v1/health` lists the same
checks. Settings in the UI choose other AI servers or a cloud API at any time.

Everything restarts with the machine (`restart: unless-stopped`). Data lives
in the `homescribe-data` volume.

Settings that are not about AI go into an optional `.env` file next to
`compose.yaml` (see [`.env.example`](.env.example)), for example
`BASE_PATH=/homescribe` or `MAX_UPLOAD_MB=4096`.

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
