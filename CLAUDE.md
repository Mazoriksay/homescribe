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
```

Run typecheck, lint and test before every commit and report honestly what
passed and what you could not run.

## Layout

- `packages/shared` — Zod schemas for the whole API (`src/api.ts`), error
  codes, pure helpers. Types for server and web are inferred from it.
- `apps/server` — Fastify 5 API. `src/config.ts` (env), `src/network.ts`
  (allow-list), `src/db/` (node:sqlite + migrations + repositories),
  `src/media/` (ffmpeg behind `MediaTool`), `src/stt/` (speech-to-text behind
  `Transcriber`), `src/jobs/` (single queue + runner), `src/events.ts` (SSE
  bus), `src/http/` (routes, errors).
- `apps/web` — React 19 + Vite + RTK Query + React Router 7.

## Fixed decisions (do not change without asking)

- npm workspaces monorepo: `apps/server`, `apps/web`, `packages/shared`.
- Server: Node 24, TypeScript, Fastify 5, Zod, `node:sqlite` (no native
  packages), `tsx` runs TS.
- Web: React 19, TypeScript, Vite, Redux Toolkit + RTK Query, React Router 7,
  Ant Design 6 for form controls only; layout and lists are hand-written CSS
  modules.
- Tests: Vitest. Lint: ESLint + typescript-eslint, Prettier.
- Allowed extra packages: `@fastify/multipart`, `@fastify/static`,
  `react-markdown`. **Ask the maintainer before adding any other package**
  and give the reason.
- Speech-to-text: any OpenAI-compatible `POST /v1/audio/transcriptions`
  (speaches / faster-whisper-server), `response_format=verbose_json`, segment
  timestamps. Check that project's docs/source before changing the client.
- LLM: any OpenAI-compatible `POST /v1/chat/completions`.
- ffmpeg is a system binary; every upload is converted to 16 kHz mono before
  transcription; ffprobe reads the duration.
- All URLs, model names, paths and the port come from environment variables,
  listed in `.env.example`. Data lives in `DATA_DIR` (git-ignored). No
  personal paths, names or hosts anywhere.
- No login. Only clients from `ALLOWED_NETWORKS` (CIDR list) are served;
  `X-Forwarded-For` is never trusted.
- One job at a time (single in-process queue, shared GPU). Jobs running at
  restart become `failed` with code `INTERRUPTED`.
- Progress goes to clients over Server-Sent Events.
- Every error response: `{ error: { code, message, details? } }`.
- UI in English and Russian, light/dark/auto theme, phone-friendly (large tap
  targets, no hover-only actions), one neutral colour family plus one accent,
  system fonts only (works offline on a LAN), not the stock Ant Design look.
- No npm script commits, pushes or bumps a version.
- External services (ffmpeg, STT, LLM) stay behind interfaces; tests use
  fakes and must pass without a GPU, ffmpeg or network.

## Git

Branching, commit format, pull requests, versions and the changelog are
defined in [`CONTRIBUTING.md`](CONTRIBUTING.md). Never commit to `main`.
