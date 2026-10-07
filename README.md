# Homescribe

Self-hosted voice notes and media transcription for a home server. Upload
audio or video and get a timestamped transcript from your own
speech-to-text server (any OpenAI-compatible `/v1/audio/transcriptions`,
e.g. speaches). Summaries from a local LLM, search, in-browser recording
and Docker packaging follow in later stages — see [`SPEC.md`](SPEC.md).

**Status:** stage 1 of 4 (upload, convert, transcribe, read).

## Quick start

Requires Node.js 24, npm and `ffmpeg`/`ffprobe` on the `PATH`.

```sh
npm install
cp .env.example .env   # point STT_BASE_URL / STT_MODEL at your server
npm run build
npm start              # http://<this-machine>:8080
```

Only clients from `ALLOWED_NETWORKS` (loopback and private ranges by
default) are served. All settings are listed in [`.env.example`](.env.example)
and [`SPEC.md` §9](SPEC.md#9-configuration).

## Development

```sh
npm run dev:server     # API with reload
npm run dev:web        # Vite dev server, proxies /api
npm run typecheck && npm run lint && npm test
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for branches, commits and releases.
