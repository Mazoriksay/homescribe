# CLAUDE.md

Guidance for Claude Code sessions in this repository. Everything in the
repository (code, comments, docs, commit messages) is in English.

## What this is

Homescribe: a self-hosted web app that turns voice notes and audio/video files
into timestamped transcripts, summaries and action items, using a local
speech-to-text server and a local LLM. Scope, API contract, data model and the
stage plan live in [`SPEC.md`](SPEC.md) — read the relevant section before
changing anything, and update the spec first when a decision changes.

## Commands

Requires Node.js 24 and npm. ffmpeg/ffprobe are needed to actually process
media, not for tests.

```sh
npm install
cp .env.example .env        # then edit URLs/models
npm run dev:server          # API on :8080 (tsx watch)
npm run dev:web             # Vite on :5173, proxies /api to :8080
npm run build && npm start  # one process serves API + built UI
npm run typecheck
npm run lint                # ESLint + Prettier check; `npm run format` fixes formatting
npm test                    # all workspaces; `npm test -w apps/server` for one
./install.sh               # what users run (install.ps1 on Windows); --help for options
docker compose -f compose.yaml -f compose.dev.yaml --profile cpu up -d --build  # run from source
```

Run typecheck, lint and test before every commit and report honestly what
passed and what you could not run.

## Layout

- `packages/shared` — Zod schemas for the whole API (`src/api.ts`), error
  codes, pure helpers. Types for server and web are inferred from it.
- `apps/server` — Fastify 5 API. `src/config.ts` (env), `src/network.ts`
  (allow-list), `src/db/` (node:sqlite + migrations + repositories),
  `src/media/` (ffmpeg behind `MediaTool`), `src/stt/` (speech-to-text behind
  `Transcriber`), `src/llm/` (summaries behind `Summarizer`), `src/ai/`
  (backend settings, discovery, model lists), `src/jobs/` (single queue + runner), `src/events.ts` (SSE
  bus), `src/http/` (routes, errors).
- `apps/web` — React 19 + Vite + RTK Query + React Router 7.

## Fixed decisions (do not change without asking)

- npm workspaces monorepo: `apps/server`, `apps/web`, `packages/shared`.
- Server: Node 24, TypeScript, Fastify 5, Zod, `node:sqlite` (no native
  packages), `tsx` runs TS.
- Web: React 19, TypeScript, Vite, Redux Toolkit + RTK Query, React Router 7,
  Ant Design 6 for form controls only; layout and lists are hand-written CSS
  modules.
- Tests: Vitest (jsdom + Testing Library for UI). Lint: ESLint +
  typescript-eslint + `eslint-plugin-react-hooks`, Prettier.
- Allowed extra packages: `@fastify/multipart`, `@fastify/static`,
  `react-markdown`, and the dev packages `eslint-plugin-react-hooks`, `jsdom`,
  `@testing-library/react`. **Ask the maintainer before adding any other package**
  and give the reason.
- Speech-to-text: any OpenAI-compatible `POST /v1/audio/transcriptions`
  (speaches / faster-whisper-server), `response_format=verbose_json`, segment
  timestamps. Check that project's docs/source before changing the client.
- LLM: any OpenAI-compatible `POST /v1/chat/completions`.
- Both AI backends can be chosen in the UI (local server found by discovery,
  or a cloud API with a key); environment variables are only the defaults.
  API keys never leave the server and only go to the address they were saved
  for (SPEC.md §7.5).
- Links are downloaded with yt-dlp (a system binary behind `MediaDownloader`,
  self-updating, deno as its JS runtime in the image); links to internal
  addresses are refused unless `URL_IMPORT_ALLOW_PRIVATE` (SPEC.md §7.7).
- ffmpeg is a system binary; every upload is converted to 16 kHz mono before
  transcription; ffprobe reads the duration.
- The UI is generic and may be embedded in another app's iframe
  (`FRAME_ANCESTORS`, `?lang=`/`?theme=`, SPEC.md §11.1); no embedder-specific
  code. The preferred setup is the hub's own origin via `BASE_PATH` (§11.2);
  one web build must keep working under any base path.
- All URLs, model names, paths and the port come from environment variables
  (AI backends: defaults, overridable in the UI), listed in `.env.example`.
  Data lives in `DATA_DIR` (git-ignored). No personal paths, names or hosts
  anywhere.
- No login. Only clients from `ALLOWED_NETWORKS` (CIDR list) are served;
  `X-Forwarded-For` is never trusted.
- One job at a time (single in-process queue, shared GPU). Jobs running at
  restart become `failed` with code `INTERRUPTED`.
- Progress goes to clients over Server-Sent Events.
- Every error response: `{ error: { code, message, details? } }`.
- UI in English and Russian, Auto/Day/Night theme, phone-friendly (large tap
  targets, no hover-only actions), system fonts only (works offline on a LAN).
  Visual language: the Home Hub design system (SPEC.md §11): warm gray plus a
  rust accent, hairlines instead of cards, no shadows or gradients, no
  explanatory copy, not the stock Ant Design look. Tokens live in
  `apps/web/src/global.css` and are mirrored in `apps/web/src/theme/theme.ts`.
- No npm script commits, pushes or bumps a version.
- External services (ffmpeg, STT, LLM) stay behind interfaces; tests use
  fakes and must pass without a GPU, ffmpeg or network.

## Git

Branching, commit format, pull requests, versions and the changelog are
defined in [`CONTRIBUTING.md`](CONTRIBUTING.md). Never commit to `main`.
