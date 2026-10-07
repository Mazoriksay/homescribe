# Spec: Homescribe

Self-hosted voice notes and media transcription for a home server.

Status: **living document.** Change the spec first, then the code.

## 1. Objective

Turn voice notes and audio/video files into searchable text with timestamps,
plus a short summary and action items. Everything runs on the user's own
hardware: speech-to-text on a local GPU, summaries from a local LLM. No cloud
service is ever contacted unless the operator points a URL at one.

Users: one household, no accounts. Main devices:

- **Phone** — record a note, read the summary. Large tap targets, no
  hover-only actions, works as an installed PWA.
- **Desktop** — upload long recordings, read and search transcripts.

The HTTP API is a first-class product: a separate "home hub" app will embed
Homescribe as a section and talk to the same API the bundled web UI uses.

Success looks like: drop a 1-hour meeting recording on the desktop, see live
progress, and some minutes later read a timestamped transcript, a summary and
a list of action items; record a 30-second note on the phone with no network
and have it transcribed once the phone is back on the home LAN.

## 2. Out of scope

- User accounts, logins, sharing links, per-user permissions.
- Access from the public internet. The server refuses clients outside
  `ALLOWED_NETWORKS`; exposing it through a tunnel or reverse proxy is the
  operator's own risk and not supported (`X-Forwarded-For` is never trusted).
- Running models in-process. Speech-to-text and the LLM are external
  OpenAI-compatible HTTP services.
- Parallel processing. One job at a time, because the GPU is shared.
- Speaker diarization, translation, word-level timestamps, live (streaming)
  transcription, editing transcripts.
- Cloud sync, backups, multi-server setups.
- Languages other than English and Russian in the UI (transcription itself
  supports whatever the speech-to-text model supports).

## 3. Tech stack (fixed)

| Area    | Choice                                                                                                    |
| ------- | --------------------------------------------------------------------------------------------------------- |
| Repo    | npm workspaces monorepo: `apps/server`, `apps/web`, `packages/shared`                                     |
| Runtime | Node.js 24, TypeScript, `tsx` runs TS directly (no server build step)                                     |
| Server  | Fastify 5, Zod 4, `node:sqlite`, `@fastify/multipart`, `@fastify/static`                                  |
| Web     | React 19, Vite, Redux Toolkit + RTK Query, React Router 7, Ant Design 6 (form controls only), CSS modules |
| Shared  | Zod schemas for every API payload; server and web types are inferred from them                            |
| Media   | system `ffmpeg` and `ffprobe` binaries                                                                    |
| STT     | any server with OpenAI-compatible `POST /v1/audio/transcriptions` (e.g. speaches / faster-whisper-server) |
| LLM     | any server with OpenAI-compatible `POST /v1/chat/completions` (Ollama, LM Studio, vLLM)                   |
| Quality | Vitest, ESLint + typescript-eslint, Prettier                                                              |

Extra npm packages beyond the list above (and the type/tooling packages the
stack implies) require the maintainer's approval first.

## 4. Commands

```sh
npm install                 # install all workspaces
npm run dev:server          # API on PORT (default 8080), restarts on change
npm run dev:web             # Vite dev server, proxies /api to the API
npm run build               # build the web UI into apps/web/dist
npm start                   # production: API + built web UI on one port
npm run typecheck           # tsc --noEmit in every workspace
npm run lint                # ESLint + Prettier check
npm run format              # Prettier write
npm test                    # Vitest, all workspaces, no GPU/network needed
```

No npm script commits, pushes, tags or bumps a version.

## 5. Module map

```
packages/shared           API contract: Zod schemas, inferred types, error codes,
                          small pure helpers (timestamp formatting)
        ▲         ▲
        │         │
apps/server               apps/web
```

`apps/server/src`

| Module          | Responsibility                                                | Depends on                  |
| --------------- | ------------------------------------------------------------- | --------------------------- |
| `config`        | Read and validate environment variables once at startup       | shared                      |
| `network`       | CIDR allow-list check on the socket address                   | config                      |
| `db`            | `node:sqlite` connection, migrations, repositories            | —                           |
| `storage`       | Paths inside `DATA_DIR`; never derives a path from user input | config                      |
| `media`         | `MediaTool` interface + ffmpeg/ffprobe implementation         | config                      |
| `stt`           | `Transcriber` interface + OpenAI-compatible HTTP client       | config, shared              |
| `llm` (stage 2) | `Summarizer` interface + OpenAI-compatible chat client        | config, shared              |
| `jobs`          | Single in-process queue, job runner, recovery after restart   | db, media, stt, llm, events |
| `events`        | In-process event bus feeding the SSE endpoint                 | shared                      |
| `http`          | Fastify app: routes, error handler, SSE, static web UI        | everything above            |

External services (`media`, `stt`, `llm`) sit behind interfaces; tests pass
fakes so the suite needs no GPU, ffmpeg or network models.

`apps/web/src`

| Module      | Responsibility                                                    |
| ----------- | ----------------------------------------------------------------- |
| `api`       | RTK Query API slice, upload with progress, SSE subscription       |
| `app`       | Store, router, providers (theme, locale)                          |
| `i18n`      | English and Russian dictionaries, `useT()` hook                   |
| `theme`     | Light / dark / auto, design tokens as CSS variables + antd theme  |
| `features/` | Screens: library (list + upload), recording (status + transcript) |
| `ui/`       | Small hand-written layout pieces                                  |

## 6. Data model

SQLite file `DATA_DIR/homescribe.db`; schema version in `PRAGMA user_version`;
migrations run at startup, forward-only.

```sql
CREATE TABLE recordings (
  id                TEXT PRIMARY KEY,        -- UUID v4
  title             TEXT NOT NULL,           -- defaults to original file name without extension
  original_filename TEXT NOT NULL,           -- as sent by the client, display only
  media_type        TEXT NOT NULL,           -- MIME type sent by the client
  size_bytes        INTEGER NOT NULL,
  stored_name       TEXT NOT NULL,           -- 'original' + sanitized extension, e.g. 'original.m4a'
  duration_seconds  REAL,                    -- from ffprobe; NULL until known
  created_at        TEXT NOT NULL,           -- ISO 8601 UTC
  updated_at        TEXT NOT NULL
);

CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,               -- 'process' | 'summarize' (stage 2)
  status        TEXT NOT NULL,               -- see §8
  progress      REAL,                        -- 0..1 within the current status, NULL = unknown
  error_code    TEXT,
  error_message TEXT,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT
);
CREATE INDEX jobs_recording ON jobs(recording_id, created_at);
CREATE INDEX jobs_status ON jobs(status, created_at);

CREATE TABLE transcripts (
  recording_id  TEXT PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,
  language      TEXT,                        -- as reported by the STT server
  text          TEXT NOT NULL,
  model         TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE segments (
  recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  idx           INTEGER NOT NULL,            -- 0-based, ordered by start
  start_seconds REAL NOT NULL,
  end_seconds   REAL NOT NULL,
  text          TEXT NOT NULL,
  PRIMARY KEY (recording_id, idx)
);
```

Stage 2 adds:

```sql
CREATE TABLE summaries (
  recording_id  TEXT PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,
  summary       TEXT NOT NULL,               -- Markdown
  action_items  TEXT NOT NULL,               -- JSON array of strings
  model         TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
-- if FTS5 is available (checked at runtime):
CREATE VIRTUAL TABLE search_index USING fts5(recording_id UNINDEXED, title, body);
```

Files on disk:

```
DATA_DIR/
  homescribe.db
  media/<recording-id>/original.<ext>      -- upload, kept for re-processing and playback
  media/<recording-id>/work/audio.wav      -- 16 kHz mono, deleted after transcription
```

The extension is taken from the client file name only if it matches
`^[a-z0-9]{1,8}$` (lower-cased), otherwise `bin`. The client file name never
becomes part of a path.

## 7. API contract

Base path: **`/api/v1`**. JSON bodies, camelCase fields, ISO 8601 UTC
timestamps, UUID ids. Every schema lives in `packages/shared/src/api.ts`;
this section is the human-readable view of it. Adding optional fields is a
non-breaking change; removing or retyping a field needs `/api/v2`.

### 7.1 Errors

Every non-2xx response has exactly this shape:

```json
{ "error": { "code": "NOT_FOUND", "message": "Recording not found", "details": {} } }
```

`details` is optional. `message` is for humans and may change; clients branch
on `code` only.

| HTTP | `code`                   | When                                                                       |
| ---- | ------------------------ | -------------------------------------------------------------------------- |
| 400  | `VALIDATION_ERROR`       | Bad path/query/body; `details` holds the Zod issues                        |
| 400  | `FILE_REQUIRED`          | Upload without a `file` part                                               |
| 403  | `NETWORK_NOT_ALLOWED`    | Client address outside `ALLOWED_NETWORKS`                                  |
| 404  | `NOT_FOUND`              | Unknown recording/job id or unknown route                                  |
| 409  | `JOB_ACTIVE`             | Action needs the recording's job to be finished                            |
| 409  | `TRANSCRIPT_NOT_READY`   | Transcript requested before the job reached `done`                         |
| 413  | `FILE_TOO_LARGE`         | Upload larger than `MAX_UPLOAD_MB`                                         |
| 415  | `UNSUPPORTED_MEDIA_TYPE` | Upload MIME type is not `audio/*`, `video/*` or `application/octet-stream` |
| 500  | `INTERNAL_ERROR`         | Anything unexpected; never includes stack traces                           |

Job failures are not HTTP errors; they live on the job (`error.code`):

| `code`                                           | Meaning                                                     |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `INTERRUPTED`                                    | Server stopped while the job was running                    |
| `MEDIA_UNREADABLE`                               | ffprobe/ffmpeg could not read or convert the upload         |
| `STT_UNAVAILABLE`                                | Speech-to-text server unreachable                           |
| `STT_TIMEOUT`                                    | No answer within `STT_TIMEOUT_MS`                           |
| `STT_FAILED`                                     | Non-2xx answer or a response that does not match the schema |
| `LLM_UNAVAILABLE` / `LLM_TIMEOUT` / `LLM_FAILED` | Same for the LLM (stage 2)                                  |
| `INTERNAL_ERROR`                                 | Bug; details in the server log                              |

### 7.2 Types

```ts
type JobStatus = 'queued' | 'converting' | 'transcribing' | 'summarizing' | 'done' | 'failed';
type JobKind = 'process' | 'summarize';

interface Job {
  id: string;
  recordingId: string;
  kind: JobKind;
  status: JobStatus;
  progress: number | null; // 0..1 within the current status, null = unknown
  error: { code: string; message: string } | null; // set only when status = 'failed'
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface Recording {
  id: string;
  title: string;
  originalFilename: string;
  mediaType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  createdAt: string;
  updatedAt: string;
  job: Job; // the latest job of this recording
}

interface Segment {
  index: number;
  start: number;
  end: number;
  text: string;
} // seconds

interface Transcript {
  recordingId: string;
  language: string | null;
  model: string;
  text: string;
  segments: Segment[];
  createdAt: string;
}

interface Page<T> {
  data: T[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
}
```

### 7.3 Endpoints

| Method & path                           | Stage | Request                                                                                                      | Success                                                                 | Errors                           |
| --------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------- |
| `GET /api/v1/health`                    | 1     | —                                                                                                            | `200 { status: 'ok' }`                                                  |                                  |
| `POST /api/v1/recordings`               | 1     | `multipart/form-data`: `file` (required), `title` (optional text field, sent **before** `file`, 1–200 chars) | `201 Recording`, `Location` header                                      | 400, 413, 415                    |
| `GET /api/v1/recordings`                | 1     | query `page` (≥1, default 1), `pageSize` (1–100, default 20); stage 2 adds `q`                               | `200 Page<Recording>`, newest first                                     | 400                              |
| `GET /api/v1/recordings/:id`            | 1     | —                                                                                                            | `200 Recording`                                                         | 404                              |
| `DELETE /api/v1/recordings/:id`         | 1     | —                                                                                                            | `204`; a queued job is dropped                                          | 404, 409 `JOB_ACTIVE` if running |
| `GET /api/v1/recordings/:id/transcript` | 1     | —                                                                                                            | `200 Transcript`                                                        | 404, 409 `TRANSCRIPT_NOT_READY`  |
| `POST /api/v1/recordings/:id/jobs`      | 1     | `{ kind: 'process' }` (stage 2 adds `'summarize'`)                                                           | `202 Job`                                                               | 400, 404, 409 `JOB_ACTIVE`       |
| `GET /api/v1/jobs/:id`                  | 1     | —                                                                                                            | `200 Job`                                                               | 404                              |
| `GET /api/v1/events`                    | 1     | `Accept: text/event-stream`                                                                                  | SSE stream, see §7.4                                                    |                                  |
| `PATCH /api/v1/recordings/:id`          | 2     | `{ title }`                                                                                                  | `200 Recording`                                                         | 400, 404                         |
| `GET /api/v1/recordings/:id/summary`    | 2     | —                                                                                                            | `200 { recordingId, summary, actionItems: string[], model, createdAt }` | 404, 409 `SUMMARY_NOT_READY`     |
| `GET /api/v1/recordings/:id/media`      | 2     | `Range` supported                                                                                            | `200/206` original media                                                | 404                              |
| `GET /api/v1/search?q=&page=&pageSize=` | 2     | `q` 1–200 chars                                                                                              | `200 Page<{ recording, snippet, segmentIndex }>`                        | 400                              |

Notes:

- Upload limits: one file per request, at most `MAX_UPLOAD_MB`, at most 5
  text fields. The `title` field must precede `file` in the multipart body
  because the server streams the file to disk as it arrives.
- `POST …/jobs` with `kind: 'process'` re-runs the whole pipeline from the
  stored original, replacing the previous transcript. Used to retry failed or
  interrupted jobs.
- Lists are paginated from day one; the page size cap keeps a phone fast.
- The API is safe to call from the bundled UI and from the home hub; it
  sets no cookies and needs no CSRF token because there is no session.

### 7.4 Server-Sent Events

`GET /api/v1/events` keeps a `text/event-stream` open. Events:

| `event:`            | `data:` (JSON) | Sent when                                    |
| ------------------- | -------------- | -------------------------------------------- |
| `job`               | `Job`          | a job is created, changes status or progress |
| `recording.deleted` | `{ id }`       | a recording is deleted                       |

A comment line (`: ping`) is sent every 15 s to keep proxies and phones from
closing the connection. Progress events are throttled to at most 2 per second
per job. There is no replay: after reconnecting, a client refetches what it
displays. `EventSource` reconnects on its own.

## 8. Job lifecycle

```
            ┌──────────────── process job ────────────────┐
queued ──► converting ──► transcribing ──► summarizing ──► done
   │            │               │              │
   └────────────┴───────────────┴──────────────┴──► failed (error.code)
```

- `process` job: `queued → converting → transcribing → summarizing → done`.
  In stage 1 there is no LLM; the runner goes `transcribing → done`.
- `summarize` job (stage 2, regenerate on demand): `queued → summarizing → done`.
- `converting`: `ffprobe` reads the duration, `ffmpeg` writes
  `work/audio.wav` (16 kHz, mono, PCM s16le). Progress = converted time /
  duration from `ffmpeg -progress`.
- `transcribing`: one request to the STT server. Progress is `null`
  (the API reports none).
- `summarizing`: one request to the LLM. Progress is `null`.
- Exactly one job runs at a time across the whole server (FIFO by
  `created_at`). A recording has at most one job in a non-final state.
- On startup, jobs in `converting`, `transcribing` or `summarizing` are set to
  `failed` with code `INTERRUPTED`; jobs still `queued` stay queued and run.
- The temporary WAV is deleted when the job ends, success or failure.
- A transcript (and later a summary) is written in one SQLite transaction,
  so a reader never sees half of it.

## 9. Configuration

All settings come from environment variables; `.env.example` lists them.
`npm start` / `npm run dev:server` load `.env` from the repository root if it
exists (Node's `--env-file-if-exists`). Invalid values stop the server at
startup with a message naming the variable.

| Variable           | Default                                                                          | Stage | Meaning                                                              |
| ------------------ | -------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------- |
| `HOST`             | `0.0.0.0`                                                                        | 1     | Listen address                                                       |
| `PORT`             | `8080`                                                                           | 1     | Listen port                                                          |
| `DATA_DIR`         | `./data`                                                                         | 1     | SQLite file and media; created if missing                            |
| `ALLOWED_NETWORKS` | `127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7,fe80::/10` | 1     | Comma-separated CIDR list of allowed client addresses                |
| `MAX_UPLOAD_MB`    | `2048`                                                                           | 1     | Largest accepted upload                                              |
| `FFMPEG_PATH`      | `ffmpeg`                                                                         | 1     | ffmpeg binary                                                        |
| `FFPROBE_PATH`     | `ffprobe`                                                                        | 1     | ffprobe binary                                                       |
| `STT_BASE_URL`     | `http://localhost:8000`                                                          | 1     | Base URL; the server calls `${STT_BASE_URL}/v1/audio/transcriptions` |
| `STT_MODEL`        | `Systran/faster-whisper-large-v3`                                                | 1     | `model` form field                                                   |
| `STT_LANGUAGE`     | _(empty = auto-detect)_                                                          | 1     | ISO 639-1 code sent as `language`                                    |
| `STT_API_KEY`      | _(empty)_                                                                        | 1     | Sent as `Authorization: Bearer …` when set                           |
| `STT_TIMEOUT_MS`   | `3600000`                                                                        | 1     | Per-request timeout                                                  |
| `LLM_BASE_URL`     | `http://localhost:11434`                                                         | 2     | Base URL; calls `${LLM_BASE_URL}/v1/chat/completions`                |
| `LLM_MODEL`        | `llama3.1:8b`                                                                    | 2     | `model` field                                                        |
| `LLM_API_KEY`      | _(empty)_                                                                        | 2     | Bearer token when set                                                |
| `LLM_TIMEOUT_MS`   | `600000`                                                                         | 2     | Per-request timeout                                                  |
| `WEB_DIST_DIR`     | `apps/web/dist` (resolved from the repo root)                                    | 1     | Built UI to serve; skipped if missing                                |
| `LOG_LEVEL`        | `info`                                                                           | 1     | Fastify/pino log level                                               |

STT request (verified against the speaches source, `src/speaches/routers/stt.py`,
and the OpenAI types it returns, `openai.types.audio.TranscriptionVerbose`):

```
POST {STT_BASE_URL}/v1/audio/transcriptions   multipart/form-data
  file=@audio.wav  model={STT_MODEL}  response_format=verbose_json
  timestamp_granularities[]=segment  [language={STT_LANGUAGE}]

200 application/json
  { "text": string, "language": string, "duration": number,
    "segments": [ { "id", "seek", "start", "end", "text", "tokens",
                    "temperature", "avg_logprob", "compression_ratio",
                    "no_speech_prob" } ] }
```

The server only relies on `text`, `language` and `segments[].{start,end,text}`
and treats the response as untrusted input (validated with Zod).

## 10. Security

- **Network allow-list:** every request's socket address is checked against
  `ALLOWED_NETWORKS` (`node:net` `BlockList`; IPv4-mapped IPv6 addresses are
  normalised). Fastify `trustProxy` stays off; `X-Forwarded-For` is ignored.
- **Uploads:** streamed to disk, size-capped, stored under a server-generated
  id; the client file name is display-only. Media is only ever passed to
  ffmpeg/ffprobe as an argument array (`execFile`-style, no shell).
- **Paths:** every path is built from `DATA_DIR` + a UUID from the database;
  ids from URLs are validated as UUIDs before touching the disk.
- **Outbound calls:** only to `STT_BASE_URL` and `LLM_BASE_URL`; their
  responses are validated before use.
- **Errors:** 500s return a generic message; details go to the log only.
- **UI:** transcript and summary text are rendered as text (summary Markdown
  through `react-markdown` without raw HTML in stage 2).

## 11. UI

- Screens: **Library** (upload, list with status/progress, empty state),
  **Recording** (title, metadata, job status with progress or error + retry,
  transcript with clickable timestamps). Stage 2: summary + action items,
  search, player. Stage 3: record screen.
- English and Russian, switch in the header, remembered in `localStorage`,
  first visit follows the browser language.
- Themes: light, dark, auto (follows `prefers-color-scheme`), remembered.
- Visual language: one neutral colour family plus one accent; system font
  stack only; no stock Ant Design look (antd is themed through
  `ConfigProvider` tokens and used for form controls only — buttons,
  segmented switches, inputs). Layout and lists are hand-written CSS modules.
- Phone first: tap targets ≥ 44 px, no hover-only actions, readable at 320 px
  width, long transcripts render without layout jank.

## 12. Code style

TypeScript strict mode everywhere, ES modules, Prettier defaults with
`singleQuote` and `printWidth: 100`. Names: `camelCase` values, `PascalCase`
types and components, `kebab-case` file names for server modules,
`PascalCase.tsx` for components. Errors cross module boundaries as typed
error classes, never as strings.

```ts
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
```

## 13. Testing strategy

- Vitest in every workspace; `npm test` runs them all from the root.
- Server logic is test-first. Levels:
  - unit: config parsing, CIDR checks, path building, STT response parsing;
  - integration: repositories against an in-memory SQLite; the job runner
    with fake `MediaTool` / `Transcriber`; HTTP routes through
    `fastify.inject`; the STT client against a local fake HTTP server;
  - the real ffmpeg adapter has a test that runs only when ffmpeg is installed.
- Web: pure logic (formatting, theme and locale resolution, dictionary
  completeness, SSE cache updates) under Vitest; no browser tests in stage 1.
- No test touches the network beyond `127.0.0.1` or needs a GPU.

## 14. Boundaries

- **Always:** validate input at the HTTP edge and responses from STT/LLM; keep
  the error shape; run typecheck, lint and tests before pushing; update
  `CHANGELOG.md` under _Unreleased_.
- **Ask first:** new npm packages, schema changes outside a migration,
  breaking API changes, changes to CI.
- **Never:** commit to `main` directly, commit `.env` or `DATA_DIR`, hardcode
  hosts/paths/names, trust `X-Forwarded-For`, run a shell with user input.

## 15. Stages and done criteria

### Stage 1 — skeleton and transcription

- [ ] Workspaces, TypeScript strict, ESLint, Prettier, Vitest wired; `npm run typecheck`, `npm run lint`, `npm test` pass from the root.
- [ ] `packages/shared` holds every schema in §7; server and web import types from it.
- [ ] Config parsed from env with defaults from §9; `.env.example` committed.
- [ ] Requests from outside `ALLOWED_NETWORKS` get `403 NETWORK_NOT_ALLOWED`.
- [ ] Upload → `201 Recording` with a `queued` job; the file is on disk under `DATA_DIR/media/<id>/`.
- [ ] The runner converts with ffmpeg, transcribes through the STT client, stores transcript + segments, ends in `done`; failures end in `failed` with a code from §7.1.
- [ ] One job at a time; on restart running jobs become `failed/INTERRUPTED`, queued jobs run.
- [ ] List (paginated), get, delete, transcript, retry, job, events endpoints work as in §7.
- [ ] SSE pushes job changes; the UI updates without reload.
- [ ] Web: library with upload (progress), list, empty state; recording page with status, error + retry, transcript with timestamps; EN/RU switch; light/dark/auto.
- [ ] Tests use fakes for ffmpeg and STT; the suite passes with no GPU, no ffmpeg and no network.

### Stage 2 — summaries, search, player

- [ ] `llm` module: OpenAI-compatible chat client; prompt asks for a JSON object `{ summary, actionItems }` in the transcript's language; response validated with Zod, one retry on invalid JSON.
- [ ] `process` jobs go through `summarizing`; `POST …/jobs { kind: 'summarize' }` regenerates.
- [ ] `GET …/summary`, `PATCH …/recordings/:id` (rename).
- [ ] Search: at startup check FTS5 with `CREATE VIRTUAL TABLE … USING fts5` in a scratch connection; use FTS5 if it works, otherwise `LIKE` over transcripts; the chosen mode is logged and reported in `GET /health` as `search: 'fts5' | 'like'`. Both modes covered by tests.
- [ ] `GET …/media` with `Range` support; UI player highlights the current segment and seeks when a segment is tapped.
- [ ] Summary rendered with `react-markdown`, no raw HTML.

### Stage 3 — record in the browser, PWA, offline

- [ ] Record screen using `MediaRecorder`; pick the first supported of `audio/webm;codecs=opus`, `audio/mp4`, `audio/webm` via `MediaRecorder.isTypeSupported`, upload with the matching extension (Chrome → webm, Safari → mp4).
- [ ] Web app manifest, icons, service worker caching the app shell; installable on Android and iOS.
- [ ] Recordings made while the server is unreachable are stored in IndexedDB and uploaded automatically (on `online`, on app start, on a timer) with visible pending state; a successful upload removes them from IndexedDB.
- [ ] Handles: microphone permission denied, recording interrupted by a call/lock screen, storage quota errors.

### Stage 4 — packaging and release

- [ ] `Dockerfile` (Node 24 + ffmpeg, non-root, `DATA_DIR` volume).
- [ ] `docker-compose.yml`: `app` service; optional `stt` service (speaches) under the `gpu` profile.
- [ ] GitHub Actions CI: install, lint, typecheck, test on pull requests and `main`.
- [ ] `README.md` with features, quick start, configuration, API overview, screenshot placeholders.
- [ ] `LICENSE` (MIT), `CHANGELOG.md` entry, tag `v1.0.0`.

## 16. Open questions

1. Default STT model name: `Systran/faster-whisper-large-v3` is a guess at a
   sensible speaches default; set your own in `.env`.
2. Should the original media be kept forever (needed for re-processing and the
   stage 2 player) or deleted after transcription to save disk? Current
   decision: keep it.
3. Stage 2 search snippets: whole segment text or a highlighted fragment?
