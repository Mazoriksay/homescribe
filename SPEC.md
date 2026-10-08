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

| Area    | Choice                                                                                                           |
| ------- | ---------------------------------------------------------------------------------------------------------------- |
| Repo    | npm workspaces monorepo: `apps/server`, `apps/web`, `packages/shared`                                            |
| Runtime | Node.js 24, TypeScript, `tsx` runs TS directly (no server build step)                                            |
| Server  | Fastify 5, Zod 4, `node:sqlite`, `@fastify/multipart`, `@fastify/static`                                         |
| Web     | React 19, Vite, Redux Toolkit + RTK Query, React Router 7, Ant Design 6 (form controls only), CSS modules        |
| Shared  | Zod schemas for every API payload; server and web types are inferred from them                                   |
| Media   | system `ffmpeg` and `ffprobe` binaries                                                                           |
| STT     | any server with OpenAI-compatible `POST /v1/audio/transcriptions` (e.g. speaches / faster-whisper-server)        |
| LLM     | any server with OpenAI-compatible `POST /v1/chat/completions` (Ollama, LM Studio, vLLM)                          |
| Quality | Vitest, ESLint + typescript-eslint + `eslint-plugin-react-hooks`, Prettier; jsdom + Testing Library for UI tests |

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
docker compose --profile gpu up -d   # app + speaches on an NVIDIA GPU (or --profile cpu)
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

| Module    | Responsibility                                                | Depends on                  |
| --------- | ------------------------------------------------------------- | --------------------------- |
| `config`  | Read and validate environment variables once at startup       | shared                      |
| `network` | CIDR allow-list check on the socket address                   | config                      |
| `db`      | `node:sqlite` connection, migrations, repositories            | —                           |
| `storage` | Paths inside `DATA_DIR`; never derives a path from user input | config                      |
| `media`   | `MediaTool` interface + ffmpeg/ffprobe implementation         | config                      |
| `stt`     | `Transcriber` interface + OpenAI-compatible HTTP client       | config, shared              |
| `llm`     | `Summarizer` interface + OpenAI-compatible chat client        | config, shared              |
| `ai`      | Backend settings, discovery of local servers, model lists     | db, config, stt, llm        |
| `jobs`    | Single in-process queue, job runner, recovery after restart   | db, media, stt, llm, events |
| `events`  | In-process event bus feeding the SSE endpoint                 | shared                      |
| `http`    | Fastify app: routes, error handler, SSE, static web UI        | everything above            |

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
  stored_name       TEXT NOT NULL,           -- 'original' + sanitized extension, e.g. 'original.m4a'; '' until a link is downloaded
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
  gaps          TEXT NOT NULL DEFAULT '[]',  -- JSON [{ start, end }]: speech lost to a Whisper loop
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
-- Stage 3b:
ALTER TABLE recordings ADD COLUMN source_url TEXT;           -- link the media came from
ALTER TABLE recordings ADD COLUMN title_from_source INTEGER NOT NULL DEFAULT 0;
                                                             -- 1: replace title with the page's title
CREATE TABLE ai_settings (                   -- one row per kind once chosen in the UI
  kind        TEXT PRIMARY KEY,                -- 'stt' | 'llm'
  mode        TEXT NOT NULL,                   -- 'local' | 'api' | 'off' (llm only)
  provider    TEXT,                            -- cloud preset id or NULL
  base_url    TEXT NOT NULL,
  model       TEXT NOT NULL,
  api_key     TEXT,                            -- never returned by the API
  updated_at  TEXT NOT NULL
);
CREATE TABLE stt_speed (                     -- transcription speed per STT model
  model TEXT PRIMARY KEY, ratio REAL NOT NULL, -- seconds per second of audio
  updated_at TEXT NOT NULL
);
CREATE TABLE search_docs (                   -- title + transcript + summary (plain text)
  recording_id  TEXT PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT NOT NULL,
  title_lc TEXT NOT NULL, body_lc TEXT NOT NULL  -- lower-cased, ё as е, in JS (SQLite folds ASCII only)
);
-- created at startup only if FTS5 is available (checked at runtime):
CREATE VIRTUAL TABLE search_fts USING fts5(recording_id UNINDEXED, title, body,  -- the *_lc text
  tokenize = 'unicode61 remove_diacritics 2');
```

Files on disk:

```
DATA_DIR/
  homescribe.db
  media/<recording-id>/original.<ext>      -- upload, kept for re-processing and playback
  media/<recording-id>/work/audio.wav      -- 16 kHz mono (audio.ogg for cloud STT), deleted after the job
```

The extension is taken from the client file name only if it is a known media
extension (`mp3`, `m4a`, `webm`, `mp4`, `wav`, `ogg`, …, lower-cased),
otherwise `bin`. The client file name never
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

| HTTP | `code`                   | When                                                                          |
| ---- | ------------------------ | ----------------------------------------------------------------------------- |
| 400  | `VALIDATION_ERROR`       | Bad path/query/body (including a malformed id); `details` holds the issues    |
| 400  | `FILE_REQUIRED`          | Upload without a `file` part                                                  |
| 403  | `NETWORK_NOT_ALLOWED`    | Client address outside `ALLOWED_NETWORKS`                                     |
| 404  | `NOT_FOUND`              | Unknown recording/job id or unknown route                                     |
| 409  | `JOB_ACTIVE`             | Action needs the recording's job to be finished                               |
| 409  | `TRANSCRIPT_NOT_READY`   | No transcript stored yet (first job not `done`)                               |
| 400  | `URL_NOT_ALLOWED`        | Link is not http(s), has credentials, or points at an internal address (§7.7) |
| 409  | `SUMMARY_NOT_READY`      | No summary stored yet                                                         |
| 409  | `SUMMARIES_OFF`          | A `summarize` job was requested while the LLM is set to `off`                 |
| 502  | `AI_UNREACHABLE`         | Listing models: the given AI server did not answer as expected                |
| 413  | `FILE_TOO_LARGE`         | Upload larger than `MAX_UPLOAD_MB`                                            |
| 415  | `UNSUPPORTED_MEDIA_TYPE` | Upload MIME type is not `audio/*`, `video/*` or `application/octet-stream`    |
| 500  | `INTERNAL_ERROR`         | Anything unexpected; never includes stack traces                              |

Job failures are not HTTP errors; they live on the job (`error.code`):

| `code`                                           | Meaning                                                     |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `INTERRUPTED`                                    | Server stopped while the job was running                    |
| `CANCELLED`                                      | Cancelled from the UI or `POST …/jobs/:id/cancel`           |
| `DOWNLOAD_FAILED`                                | yt-dlp could not fetch the link; the message has its reason |
| `DOWNLOAD_BLOCKED`                               | The site wants a signed-in visitor; add cookies (§7.8)      |
| `DOWNLOAD_COOKIES_EXPIRED`                       | The YouTube cookies are no longer valid; renew them (§7.8)  |
| `MEDIA_UNREADABLE`                               | ffprobe/ffmpeg could not read or convert the upload         |
| `STT_UNAVAILABLE`                                | Speech-to-text server unreachable                           |
| `STT_TIMEOUT`                                    | No answer within `STT_TIMEOUT_MS`                           |
| `STT_FAILED`                                     | Non-2xx answer or a response that does not match the schema |
| `LLM_UNAVAILABLE` / `LLM_TIMEOUT` / `LLM_FAILED` | Same for the LLM; the transcript is kept                    |
| `INTERNAL_ERROR`                                 | Bug; details in the server log                              |

### 7.2 Types

```ts
type JobStatus =
  'queued' | 'downloading' | 'converting' | 'transcribing' | 'summarizing' | 'done' | 'failed';
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
  sizeBytes: number; // 0 until a link has been downloaded
  durationSeconds: number | null;
  sourceUrl: string | null; // the link a recording was made from (§7.7)
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
  gaps: { start: number; end: number }[]; // speech lost to a Whisper loop (§8)
  createdAt: string;
}

interface Page<T> {
  data: T[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
}
```

### 7.3 Endpoints

| Method & path                           | Stage | Request                                                                                                                | Success                                                                 | Errors                                                              |
| --------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `GET /api/v1/health`                    | 1     | —                                                                                                                      | `200 Health` (§7.6)                                                     |                                                                     |
| `POST /api/v1/recordings`               | 1     | `multipart/form-data`: `file` (required), `title` (optional text field, sent **before** `file`, 1–200 chars)           | `201 Recording`, `Location` header                                      | 400, 413, 415                                                       |
| `POST /api/v1/recordings/from-url`      | 3     | `{ url, title? }`: http(s) link to a video or audio page (YouTube and other sites supported by yt-dlp) or a media file | `201 Recording` with `sourceUrl`; the job starts with `downloading`     | 400 `VALIDATION_ERROR`, `URL_NOT_ALLOWED`                           |
| `GET /api/v1/recordings`                | 1     | query `page` (≥1, default 1), `pageSize` (1–100, default 20)                                                           | `200 Page<Recording>`, newest first                                     | 400                                                                 |
| `GET /api/v1/recordings/:id`            | 1     | —                                                                                                                      | `200 Recording`                                                         | 404                                                                 |
| `DELETE /api/v1/recordings/:id`         | 1     | —                                                                                                                      | `204`; a queued job is dropped                                          | 404, 409 `JOB_ACTIVE` if running                                    |
| `GET /api/v1/recordings/:id/transcript` | 1     | —                                                                                                                      | `200 Transcript`                                                        | 404, 409 `TRANSCRIPT_NOT_READY`                                     |
| `POST /api/v1/recordings/:id/jobs`      | 1     | `{ kind: 'process' \| 'summarize' }`                                                                                   | `202 Job`                                                               | 400, 404, 409 `JOB_ACTIVE`, `TRANSCRIPT_NOT_READY`, `SUMMARIES_OFF` |
| `POST /api/v1/jobs/:id/cancel`          | 3     | —                                                                                                                      | `200 Job`; an inactive job is returned unchanged                        | 404                                                                 |
| `GET /api/v1/jobs/:id`                  | 1     | —                                                                                                                      | `200 Job`                                                               | 404                                                                 |
| `GET /api/v1/events`                    | 1     | `Accept: text/event-stream`                                                                                            | SSE stream, see §7.4                                                    |                                                                     |
| `PATCH /api/v1/recordings/:id`          | 2     | `{ title }`                                                                                                            | `200 Recording`                                                         | 400, 404                                                            |
| `GET /api/v1/recordings/:id/summary`    | 2     | —                                                                                                                      | `200 { recordingId, summary, actionItems: string[], model, createdAt }` | 404, 409 `SUMMARY_NOT_READY`                                        |
| `GET /api/v1/recordings/:id/media`      | 2     | `Range` supported                                                                                                      | `200/206` original media, type from our extension map, `CSP: sandbox`   | 404                                                                 |
| `GET /api/v1/search?q=&page=&pageSize=` | 2     | `q` 1–200 chars, `pageSize` ≤ 50                                                                                       | `200 Page<SearchHit>`                                                   | 400                                                                 |
| `GET /api/v1/settings/ai`               | 2     | —                                                                                                                      | `200 { stt: AiSettings, llm: AiSettings }`                              |                                                                     |
| `PUT /api/v1/settings/ai/:kind`         | 2     | `UpdateAiSettings` (§7.5)                                                                                              | `200 AiSettings`                                                        | 400                                                                 |
| `DELETE /api/v1/settings/ai/:kind`      | 2     | —                                                                                                                      | `200 AiSettings` (back to the environment defaults)                     | 400                                                                 |
| `GET /api/v1/ai/discovery`              | 2     | —                                                                                                                      | `200 { servers: DiscoveredServer[], probed: string[] }`                 |                                                                     |
| `POST /api/v1/ai/models`                | 2     | `{ baseUrl, apiKey?, useSavedKeyFor?: 'stt' \| 'llm' }`                                                                | `200 { models: { id, kind: 'stt' \| 'llm' \| null }[] }`                | 400, 502 `AI_UNREACHABLE`                                           |
| `GET /api/v1/ai/memory`                 | 3     | —                                                                                                                      | `200 AiMemory`                                                          |                                                                     |
| `POST /api/v1/ai/unload`                | 3     | —                                                                                                                      | `200 AiMemory & { failed: string[] }`                                   | 409 `JOB_ACTIVE`                                                    |

`SearchHit` is `{ recording, snippet: { text, match }[], segment: { index, start } | null }`:
a fragment around the first match split into highlighted parts, and the first
transcript segment that contains the query (null for title-only matches).
FTS5 mode ranks by relevance and matches word prefixes; LIKE mode matches
substrings, newest first. Every query term is required.

Notes:

- Upload limits: one file per request, at most `MAX_UPLOAD_MB`, at most 5
  text fields. The `title` field must precede `file` in the multipart body
  because the server streams the file to disk as it arrives.
- `POST …/jobs` with `kind: 'process'` re-runs the whole pipeline from the
  stored original, replacing the previous transcript (the previous one stays
  readable until the new one is stored). Used to retry failed or
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

### 7.5 Choosing the AI backends

Speech-to-text (`stt`) and the summarizing LLM (`llm`) are chosen in the UI
(Settings) and stored in `ai_settings`; until then the environment variables
in §9 apply (`source: 'env'`). The choice is read at the start of every job,
so a change applies from the next job on.

```ts
interface AiSettings {
  kind: 'stt' | 'llm';
  mode: 'local' | 'api' | 'off'; // 'off' only for llm: no summaries
  provider: string | null; // cloud preset id
  baseUrl: string; // without /v1
  model: string;
  hasApiKey: boolean; // the key itself is never returned
  source: 'env' | 'saved';
}
interface UpdateAiSettings {
  mode: 'local' | 'api' | 'off';
  provider?: string | null;
  baseUrl?: string; // required unless mode is 'off'; http(s), no credentials/query
  model?: string; // required unless mode is 'off'
  apiKey?: string | null; // omit = keep (only if baseUrl is unchanged), null = remove
}
```

- **Local:** `GET /ai/discovery` probes a fixed list of well-known ports —
  Ollama 11434, LM Studio 1234, speaches/vLLM 8000, llama.cpp/LocalAI 8080,
  Jan 1337, text-generation-webui 5000 — on every host in
  `AI_DISCOVERY_HOSTS` (this machine by default), skipping its own port. A
  server counts when `GET /v1/models` answers with an OpenAI-style list. Each
  model gets a kind guess (speaches' `task` field, else the id: `whisper` →
  stt, embedding/TTS models → none, others → llm). A whole network is never
  scanned.
- **Cloud API:** presets OpenAI (`whisper-1`, `gpt-4o-mini`), Groq
  (`whisper-large-v3`, `llama-3.3-70b-versatile`) and OpenRouter (LLM only),
  or any OpenAI-compatible address. For cloud STT the audio is sent as Opus
  (32 kbit/s, Ogg) instead of WAV, because cloud uploads are capped at about
  25 MB (≈ 1.5 h of Opus versus 13 min of WAV).
- **Keys:** a saved key is only ever sent to the address it was saved for:
  changing `baseUrl` without a new key drops it, and `POST /ai/models` with
  `useSavedKeyFor` uses it only when `baseUrl` matches.

**Freeing video memory.** speaches and Ollama keep a model loaded for about
5 minutes after use. `GET /ai/memory` asks each local backend
`GET {baseUrl}/api/ps`: speaches (`routers/misc.py`) answers
`{ models: string[] }`, Ollama (`docs/api.md`) `{ models: [{ name,
size_vram, … }] }`; the shape tells them apart. Ollama can unload on request
(`ok`). speaches is `auto`: version 0.8.1 unloads on `DELETE /api/ps/{id}`
but then never answers and takes no more transcriptions until restarted
(found in a live test), and it unloads idle models by itself after
`stt_model_ttl` (5 minutes), so it is shown, never asked. Any other answer
means the server cannot unload on request (`unsupported`); cloud APIs are
`remote`, summaries turned off `off`:

```ts
interface AiMemory {
  stt: BackendMemory;
  llm: BackendMemory;
  busy: boolean; // a job is running
}
interface BackendMemory {
  state: 'ok' | 'auto' | 'unsupported' | 'unreachable' | 'remote' | 'off';
  server: 'speaches' | 'ollama' | null;
  loaded: { model: string; vramBytes: number | null }[];
}
```

`POST /ai/unload` unloads every model of an `ok` backend (Ollama:
`POST /api/generate { model, keep_alive: 0 }`). While a job runs it answers
`409 JOB_ACTIVE`, since the job would load the model again; the UI disables
the button with that reason (the job can be cancelled next to it). Models
the server refused are listed in `failed`. The next job loads the model
again by itself. The settings page shows the section only when a backend is
local, the button only when a backend is `ok`, and for speaches "unloads by
itself after 5 idle minutes".

### 7.6 Health and self-check

The server checks what it depends on at startup, logs every problem with a
hint, repeats the check every 60 s and right after AI settings change, and
reports the latest result:

```ts
interface Health {
  status: 'ok'; // the server answers; see checks for readiness
  search: 'fts5' | 'like';
  checks: {
    ffmpeg: 'ok' | 'missing'; // ffmpeg and ffprobe run
    ytdlp: 'ok' | 'missing'; // yt-dlp runs (links, §7.7)
    stt: 'ok' | 'model_missing' | 'unreachable'; // GET /v1/models; model listed?
    llm: 'ok' | 'model_missing' | 'unreachable' | 'off';
    embedding: 'same_origin' | 'origins'; // FRAME_ANCESTORS empty or set
  } | null; // null until the first check finished
  checkedAt: string | null;
  cookies: 'none' | 'ok' | 'expired' | 'unchecked'; // YouTube cookies (§7.8)
}
```

`model_missing` means the server answers but does not list the model (speaches
downloads models only on request; `PRELOAD_MODELS` in the compose file does
it at startup). The UI shows a notice with a link to Settings when `ffmpeg`,
`stt` or `llm` is not `ok`/`off`.

### 7.7 Transcribing a link

`POST /recordings/from-url` creates a recording with `sourceUrl` set and no
media yet; its `process` job begins with `downloading`. The download uses
[yt-dlp](https://github.com/yt-dlp/yt-dlp) (YouTube and ~1800 other sites,
plus direct links to media files):

- best audio only (`-f bestaudio/best`), single video (`--no-playlist`),
  capped at `MAX_UPLOAD_MB` (`--max-filesize`), no config files
  (`--ignore-config`), the URL after `--`, arguments as an array (no shell);
- progress from `--progress-template`, the final file and its title, duration
  and codecs from `--print after_move:…`;
- the file becomes `original.<ext>` like an upload; without a user-given
  title, the page's title replaces the placeholder;
- failures end the job as `DOWNLOAD_FAILED` with yt-dlp's error line
  (e.g. "Video unavailable"); retrying downloads again;
- when the site wants a signed-in visitor (YouTube: "Sign in to confirm
  you're not a bot", common from server and VPN addresses) the job ends as
  `DOWNLOAD_BLOCKED`; when yt-dlp says the cookies it got are no longer
  valid, as `DOWNLOAD_COOKIES_EXPIRED`. Cookies (§7.8) at
  `YTDLP_COOKIES_FILE` are passed with `--cookies`; yt-dlp gets a copy per
  download, since it writes cookies back.

YouTube needs a JavaScript runtime for yt-dlp; the Docker image ships deno,
which yt-dlp recommends because it sandboxes that code. yt-dlp updates itself
(`YTDLP_AUTO_UPDATE`) because sites change often. The self-check reports
`ytdlp: 'ok' | 'missing'`.

**Guard:** the link's host must not resolve to a loopback, private,
link-local or otherwise internal address unless `URL_IMPORT_ALLOW_PRIVATE`
is set (`400 URL_NOT_ALLOWED`). This is a best-effort check before handing
the URL to yt-dlp, which follows redirects and site-specific requests on its
own; every allowed LAN client is trusted anyway (§10). `198.18.0.0/15` is not
blocked: VPN clients with fake-IP DNS (Clash, sing-box) resolve every public
name into it, and blocking it would refuse all links behind such a VPN.

Downloading content is subject to each site's terms; Homescribe is meant for
material the user may keep a personal copy of.

### 7.8 YouTube cookies

From VPN and hosting addresses YouTube answers every client yt-dlp tries with
"Sign in to confirm you're not a bot"; only a signed-in browser's cookies get
through, and they go stale within days. The sign-in cookies (`SID`,
`__Secure-1PSID`, `LOGIN_INFO`) are `HttpOnly`, so only a browser extension
can read them. Nothing needs setting up while YouTube lets the server in;
after a `DOWNLOAD_BLOCKED` the recording page offers "Connect YouTube", which
leads to the YouTube section of the settings with two ways: the extension
(keeps cookies fresh) or uploading a `cookies.txt` once.

Storage: `YTDLP_COOKIES_FILE` (default `DATA_DIR/cookies.txt`, mode `0600`),
Netscape format, only lines whose domain is `youtube.com` or a subdomain.
State in `cookie_state`: source (`extension | file`), times, status, the
SHA-256 of the extension's token, the pairing code's hash, expiry and failed
attempts. Neither the cookies nor the token appear in any API answer or log.

```ts
interface CookieStatus {
  status: 'none' | 'ok' | 'expired' | 'unchecked';
  source: 'extension' | 'file' | null;
  updatedAt: string | null;
  checkedAt: string | null;
  paired: boolean; // an extension holds a token
}
```

| Method and path                | Body                                          | Answer                                                  |
| ------------------------------ | --------------------------------------------- | ------------------------------------------------------- |
| `GET /api/v1/cookies`          | —                                             | `200 CookieStatus`                                      |
| `PUT /api/v1/cookies/file`     | `text/plain`: a `cookies.txt`                 | `200 CookieStatus`; 400 `VALIDATION_ERROR`              |
| `DELETE /api/v1/cookies`       | —                                             | `200 CookieStatus` (cookies and pairing gone)           |
| `POST /api/v1/cookies/pairing` | —                                             | `200 { code, expiresAt, extensionId, extensionFolder }` |
| `POST /api/v1/cookies/pair`    | `{ code }`                                    | `200 { token }`; 400 `PAIRING_INVALID`                  |
| `PUT /api/v1/cookies`          | `text/plain`, `Authorization: Bearer <token>` | `200 CookieStatus`; 401 `TOKEN_INVALID`                 |

- **Pairing:** `POST …/pairing` makes a one-time code of 8 letters and
  digits (no look-alikes), valid 10 minutes, replacing any earlier one. `pair`
  turns it into a random 256-bit token, once; five wrong codes void it.
  Pairing again replaces the old token.
- **Why a token:** there is no login, so without it any client on the LAN
  could replace the cookies the server signs in with. CORS stays off: the
  extension may call the server because the user grants it that address.
- **Check:** after an upload whose content differs from the last checked one
  (at most once a minute; a newer upload waits for the slot; the extension's
  6-hourly resend of the same cookies keeps their status) and once a day, `yt-dlp --simulate` on one public
  video with a copy of the cookies: success → `ok`; "cookies are no longer
  valid" or the sign-in wall → `expired`; anything else (network) leaves the
  status. A job ending in `DOWNLOAD_COOKIES_EXPIRED` sets `expired` too.
- **Retry:** when the status turns `ok`, recordings whose latest job failed
  with `DOWNLOAD_BLOCKED` or `DOWNLOAD_COOKIES_EXPIRED` in the last 24 hours,
  and that have no newer job, get a new `process` job.
- `GET /health` carries `cookies: CookieStatus['status']`.

**Extension** (`apps/extension`, Manifest V3, plain JavaScript, no build,
English and Russian): permissions `cookies`, `storage`, `alarms`; host access
only to `https://*.youtube.com/*`; the server's address is asked for when
pairing (`optional_host_permissions`). It sends `youtube.com` cookies in
Netscape format right after pairing, about 30 s after they change (they change
in bursts), every 6 hours and on "Update now"; its window shows the server,
the last upload, the server's status, "Update now" and "Disconnect". It reads
no other cookies and sends them nowhere but the paired server.

- Chrome is the reference browser; the same package installs in Edge,
  Yandex Browser, Opera and Brave as an unpacked extension (developer mode →
  "Load unpacked"). A fixed `key` in the manifest gives it the same ID
  everywhere, so "Connect the extension" in the settings opens
  `chrome-extension://<id>/pair.html#server=…&code=…` and pairing is one
  click; the settings first check that the extension is installed by loading
  its icon (a web-accessible resource) and otherwise say so, with "Check
  again", instead of a link that fails. Firefox (121+) runs the same code; unsigned it installs only as a
  temporary add-on (`about:debugging`) that goes away on restart, and there
  the code is typed into the extension's window. Store listings are out of
  scope.
- `GET /api/v1/extension.zip` serves the extension, with the server's version
  (`HOMESCRIBE_VERSION`, from the release tag in the image) in its manifest.
- No unpacking on the computer Homescribe runs on: the installer and the
  control script's `start` and `update` unpack that zip into
  `browser-extension` in the install folder and write its full path to `.env`
  as `EXTENSION_FOLDER`. The settings show that path with "Copy", to paste
  into the "Folder" field of the "Load unpacked" dialog, and the zip only for other computers.
  After an update Chrome takes the new files on its next start or on
  "Reload" in the extensions page.

## 8. Job lifecycle

```
            ┌──────────────── process job ────────────────┐
queued ──► converting ──► transcribing ──► summarizing ──► done
   │            │               │              │
   └────────────┴───────────────┴──────────────┴──► failed (error.code)
```

- `process` job: `queued → [downloading] → converting → transcribing →
summarizing → done`; `downloading` only for a recording made from a link
  whose media is not stored yet (§7.7).
  `summarizing` is skipped when the LLM is `off` or no speech was recognised.
  The transcript is stored before `summarizing`, so an LLM failure leaves it
  readable; the UI then offers to retry only the summary.
- `summarize` job (regenerate on demand): `queued → summarizing → done`.
- `converting`: `ffprobe` reads the duration, `ffmpeg` writes
  `work/audio.wav` (16 kHz, mono, PCM s16le). Progress = converted time /
  duration from `ffmpeg -progress`.
- `transcribing`: recordings longer than 75 s are sent in chunks of about
  60 s, cut in the middle of the pause (ffmpeg `silencedetect`, −35 dB,
  0.5 s) nearest to each 60 s mark within ±15 s, else at the mark; each chunk
  is cut from the WAV and encoded in the backend's format (WAV, or Ogg Opus
  for cloud APIs). Whisper conditions on its own previous text, and speaches
  passes faster-whisper a single temperature of 0, so once it starts
  repeating a phrase nothing stops it until the end of the request; chunks
  keep such a loop inside one minute. A chunk whose segments contain a run of
  3+ identical phrases is asked again with `temperature=0.4`, and the answer
  with fewer repeats is kept. A loop that remains is cut to its first segment
  and stored as a gap (from the end of that segment to the next real one);
  the recording page names the gaps, so lost speech is never silent. Later
  chunks get the language detected in the first one; segment times are made
  absolute and kept within their chunk. A segment that is nothing but a
  subtitle credit Whisper makes up over silence ("Продолжение следует",
  "Субтитры создавал …", "Редактор субтитров …", "Thanks for watching",
  "Subtitles by …", Amara.org) is dropped; the same words inside real speech
  stay.
  Progress: done chunks count exactly; within a chunk it is estimated from
  how many seconds this model took per second of audio before (`stt_speed`,
  half old value, half new, chunks of 10 s or more), updated every 2 s and
  capped at 95 % of the chunk. A single chunk without a stored speed or a
  duration has progress `null`.
- `summarizing`: one request to the LLM, or for transcripts longer than
  `LLM_CHUNK_CHARS` one per part plus one to merge (local servers often run
  with a small context window that the OpenAI API cannot raise). Progress =
  requests done / requests needed. The model gets the transcript as tagged
  data with a fixed JSON reply format `{ summary, actionItems }` in the
  transcript's language; the reply is validated, with one retry.
- Exactly one job runs at a time across the whole server (FIFO by
  `created_at`). A recording has at most one job in a non-final state.
- On startup, jobs in `converting`, `transcribing` or `summarizing` are set to
  `failed` with code `INTERRUPTED`; jobs still `queued` stay queued and run.
- Cancelling ends a queued job at once and aborts the running step of a
  running one (the request to the AI server is closed; ffmpeg and yt-dlp are
  killed); either way the job is `failed` with code `CANCELLED` and can be
  retried. The UI asks for a second tap, like deleting.
- The temporary WAV is deleted when the job ends, success or failure.
- A transcript (and later a summary) is written in one SQLite transaction,
  so a reader never sees half of it.

## 9. Configuration

All settings come from environment variables; `.env.example` lists them.
`npm start` / `npm run dev:server` load `.env` from the repository root if it
exists (Node's `--env-file-if-exists`). Invalid values stop the server at
startup with a message naming the variable.

| Variable                   | Default                                                                          | Stage | Meaning                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------- |
| `HOST`                     | `0.0.0.0`                                                                        | 1     | Listen address                                                                           |
| `PORT`                     | `8080`                                                                           | 1     | Listen port                                                                              |
| `DATA_DIR`                 | `./data`                                                                         | 1     | SQLite file and media; created if missing                                                |
| `ALLOWED_NETWORKS`         | `127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7,fe80::/10` | 1     | Comma-separated CIDR list of allowed client addresses                                    |
| `MAX_UPLOAD_MB`            | `2048`                                                                           | 1     | Largest accepted upload                                                                  |
| `FFMPEG_PATH`              | `ffmpeg`                                                                         | 1     | ffmpeg binary                                                                            |
| `FFPROBE_PATH`             | `ffprobe`                                                                        | 1     | ffprobe binary                                                                           |
| `STT_MODE`                 | `local`                                                                          | 2     | `local` or `api` (cloud: audio sent as Opus)                                             |
| `STT_BASE_URL`             | `http://localhost:8000`                                                          | 1     | Base URL; the server calls `${STT_BASE_URL}/v1/audio/transcriptions`                     |
| `STT_MODEL`                | `Systran/faster-whisper-large-v3`                                                | 1     | `model` form field                                                                       |
| `STT_LANGUAGE`             | _(empty = auto-detect)_                                                          | 1     | ISO 639-1 code sent as `language`                                                        |
| `STT_API_KEY`              | _(empty)_                                                                        | 1     | Sent as `Authorization: Bearer …` when set                                               |
| `STT_TIMEOUT_MS`           | `3600000`                                                                        | 1     | Per-request timeout                                                                      |
| `STT_VAD_FILTER`           | `true`                                                                           | 3     | Send speaches' `vad_filter=true` in local mode (skips silence, prevents Whisper loops)   |
| `LLM_MODE`                 | `local`                                                                          | 2     | `local`, `api` or `off` (no summaries)                                                   |
| `LLM_BASE_URL`             | `http://localhost:11434`                                                         | 2     | Base URL; calls `${LLM_BASE_URL}/v1/chat/completions`                                    |
| `LLM_MODEL`                | `llama3.1:8b`                                                                    | 2     | `model` field                                                                            |
| `LLM_API_KEY`              | _(empty)_                                                                        | 2     | Bearer token when set                                                                    |
| `LLM_TIMEOUT_MS`           | `600000`                                                                         | 2     | Per-request timeout                                                                      |
| `LLM_CHUNK_CHARS`          | `12000`                                                                          | 2     | Longer transcripts are summarized in parts, then merged                                  |
| `AI_DISCOVERY_HOSTS`       | `localhost,host.docker.internal`                                                 | 2     | Hosts probed for local AI servers (names or IPs, no ports)                               |
| `BASE_PATH`                | _(empty = root)_                                                                 | 3     | Serve UI and API under this path, e.g. `/homescribe` (§11.2)                             |
| `WEB_DIST_DIR`             | `apps/web/dist` (resolved from the repo root)                                    | 1     | Built UI to serve; skipped if missing                                                    |
| `FRAME_ANCESTORS`          | _(empty = only the app itself)_                                                  | 1     | Space-separated origins (`http://hub.lan:3000`) allowed to show the UI in an iframe      |
| `YTDLP_PATH`               | `yt-dlp`                                                                         | 3     | yt-dlp binary for links (§7.7)                                                           |
| `YTDLP_AUTO_UPDATE`        | `true`                                                                           | 3     | Run `yt-dlp -U` at startup and daily (sites change often)                                |
| `YTDLP_COOKIES_FILE`       | `<DATA_DIR>/cookies.txt`                                                         | 3     | Where YouTube cookies are kept (§7.8); a file put there by hand is used too              |
| `HOMESCRIBE_VERSION`       | `0.0.0`                                                                          | 3     | Set by the image build from the release tag; the extension's version (§7.8)              |
| `EXTENSION_FOLDER`         | _(empty)_                                                                        | 3     | Where the installer unpacked the browser extension on the host; shown in Settings (§7.8) |
| `DOWNLOAD_TIMEOUT_MS`      | `7200000`                                                                        | 3     | Longest a link download may take                                                         |
| `URL_IMPORT_ALLOW_PRIVATE` | `false`                                                                          | 3     | Allow links to private/loopback addresses (e.g. a NAS on the LAN)                        |
| `LOG_LEVEL`                | `info`                                                                           | 1     | Fastify/pino log level                                                                   |

The `STT_*` and `LLM_*` values are defaults: once a backend is chosen in the
UI (§7.5), the saved choice wins until it is reset.

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
- **Outbound calls:** to the chosen STT and LLM addresses, to the fixed
  discovery candidates, and to an address a client passes to
  `POST /ai/models`. That last one lets any allowed LAN client make the server
  send a `GET …/v1/models`; this is accepted because every allowed client is
  already trusted to change the settings. Responses are size-capped and
  validated before use. API keys stay on the server (§7.5).
- **Model output:** treated as untrusted. The prompt marks the transcript as
  data; the reply is validated against a schema with length limits and the
  summary Markdown is rendered without raw HTML.
- **Links:** see the guard in §7.7; yt-dlp runs with an argument array,
  `--ignore-config` and the URL after `--`.
- **Media:** served with a type from our own extension map (never the client's
  claim), `Content-Disposition: inline` and `CSP: sandbox`.
- **Errors:** 500s return a generic message; details go to the log only. Job
  error messages never contain server paths.
- **Headers:** `Content-Security-Policy` (`default-src 'self'`, inline styles
  for Ant Design, `frame-ancestors 'self'` plus `FRAME_ANCESTORS`),
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
  `FRAME_ANCESTORS` accepts bare http(s) origins only.
- **UI:** transcript and summary text are rendered as text (summary Markdown
  through `react-markdown` with `skipHtml`). Zod runs `jitless` in the browser
  so the CSP never needs `unsafe-eval`.

## 11. UI

- Screens: **Library** (upload, list with status/progress, empty state),
  **Recording** (title, metadata, job status with progress or error + retry,
  transcript with clickable timestamps). Stage 2: summary + action items,
  search, player. Stage 3: record screen.
- English and Russian, chosen in Settings, remembered in `localStorage`,
  first visit follows the browser language.
- Themes: Auto / Day / Night (Auto follows `prefers-color-scheme`),
  remembered; `data-theme` is set on `<html>` before the first paint by
  `public/theme-init.js` (an external file, so the CSP needs no inline script).
- Visual language: the **Home Hub design system**, so Homescribe looks like it
  belongs next to the hub. Tokens live in `apps/web/src/global.css` and are
  mirrored for Ant Design in `apps/web/src/theme/theme.ts`; change both
  together.
  - A reference book, not a dashboard: rows separated by hairlines, no card
    grids, shadows, gradients or glass.
  - One warm gray family and a single rust accent, used only for the active
    item, links, the primary button, progress and errors-by-text; success in
    `--ok`. State is never shown by colour alone.
  - System fonts only: a serif for headings, a sans for text, a mono for ids,
    models and addresses.
  - No explanatory copy: no leads or hints; a screen shows its content, its
    controls and its state (status, errors, empty states).
  - Ant Design for form controls only, themed through `ConfigProvider`;
    layout, navigation and lists are CSS modules. A secondary action next to a
    primary one is an underlined accent link.
  - Motion: one curve (`--ease`), 0.15 s colour transitions, small entrances
    (opacity, 6 px, 0.96 scale), `translateY(1px)` on press; all off under
    `prefers-reduced-motion`.
- Layout: desktop has a sticky side rail with the wordmark and navigation;
  phones (≤ 860 px) get a blurred sticky top bar and a fixed bottom tab bar,
  switched in CSS. When the page runs inside a frame (another app embeds it),
  the rail and bars are hidden and a slim inline navigation row is shown, so
  there is no second set of app chrome inside the host.
- Phone first: tap targets ≥ 44 px, no hover-only actions, readable at 320 px
  width, long transcripts render without layout jank.

### 11.1 Embedding

The same UI serves everyone: opened directly, installed as a PWA, or shown
inside another app (for example a home dashboard) in an `<iframe>`. There is
no embedder-specific code or build.

- Preferred: serve Homescribe under a path of the embedding app's own origin
  (`BASE_PATH=/homescribe`, one reverse proxy in front of both, §11.2). Same
  origin means no `FRAME_ANCESTORS`, no mixed `http`/`https`, no second port
  or certificate.
- Otherwise the embedding origin must be listed in `FRAME_ANCESTORS`; by
  default no other site may frame the UI.
- The embedder can match its own settings with query parameters on the iframe
  URL: `?lang=en|ru` and `?theme=auto|light|dark`. They override saved
  preferences; unknown values are ignored.
- The iframe talks to the Homescribe server directly (same origin as the UI),
  so no CORS is needed. Apps that call the API from their own origin should do
  it server-side; CORS is not enabled.
- When framed, the page tells its parent with `postMessage` (any target
  origin; the payload holds nothing private):
  - `{ source: 'homescribe', type: 'ready', path }` once the app has rendered;
  - `{ source: 'homescribe', type: 'navigate', path }` on every route change.
    `path` is relative to the base path (e.g. `/recordings/<id>`), so the
    parent can deep-link back with `<base>/<path>`.

### 11.2 Base path

`BASE_PATH` (e.g. `/homescribe`, default empty) moves everything under that
path: the UI at `<BASE_PATH>/`, the API at `<BASE_PATH>/api/v1`, events,
media. The proxy forwards the path unchanged (no prefix stripping). One build
serves any base path: the server injects `<base href="<BASE_PATH>/">` into
`index.html`, and the web app derives its router basename and API URLs from
`document.baseURI`. With a base path set, `GET /` redirects to
`<BASE_PATH>/`.

Behind a proxy every request comes from the proxy's address, so
`ALLOWED_NETWORKS` then only says "the proxy may talk to me"; who may reach
the proxy (LAN only, or a tailnet) is the proxy's job.

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
  completeness, SSE cache updates) under Vitest in Node; pages under jsdom
  with Testing Library against a stubbed `fetch` (empty, error, failed-job,
  transcript and delete flows).
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

- [x] Workspaces, TypeScript strict, ESLint, Prettier, Vitest wired; `npm run typecheck`, `npm run lint`, `npm test` pass from the root.
- [x] `packages/shared` holds every schema in §7; server and web import types from it.
- [x] Config parsed from env with defaults from §9; `.env.example` committed.
- [x] Requests from outside `ALLOWED_NETWORKS` get `403 NETWORK_NOT_ALLOWED`.
- [x] Upload → `201 Recording` with a `queued` job; the file is on disk under `DATA_DIR/media/<id>/`.
- [x] The runner converts with ffmpeg, transcribes through the STT client, stores transcript + segments, ends in `done`; failures end in `failed` with a code from §7.1.
- [x] One job at a time; on restart running jobs become `failed/INTERRUPTED`, queued jobs run.
- [x] List (paginated), get, delete, transcript, retry, job, events endpoints work as in §7.
- [x] SSE pushes job changes; the UI updates without reload.
- [x] Web: library with upload (progress), list, empty state; recording page with status, error + retry, transcript with timestamps; EN/RU switch; light/dark/auto.
- [x] Tests use fakes for ffmpeg and STT; the suite passes with no GPU, no ffmpeg and no network.

### Stage 2 — summaries, search, player

- [x] `llm` module: OpenAI-compatible chat client; prompt asks for a JSON object `{ summary, actionItems }` in the transcript's language; response validated with Zod, one retry on invalid JSON; long transcripts in parts.
- [x] `process` jobs go through `summarizing`; `POST …/jobs { kind: 'summarize' }` regenerates.
- [x] `GET …/summary`, `PATCH …/recordings/:id` (rename).
- [x] Search: at startup check FTS5 with `CREATE VIRTUAL TABLE … USING fts5` in a scratch connection; use FTS5 if it works, otherwise `LIKE` over transcripts; the chosen mode is logged and reported in `GET /health` as `search: 'fts5' | 'like'`. Both modes covered by tests.
- [x] `GET …/media` with `Range` support; UI player highlights the current segment and seeks when a segment is tapped.
- [x] Summary rendered with `react-markdown`, no raw HTML.
- [x] AI backends chosen in the UI (§7.5): local servers found by discovery, cloud presets with a key, or summaries off.

### Stage 3 — deployment and hub integration

- [x] `BASE_PATH`: UI, API, SSE and media under a path; same build for any path (§11.2).
- [x] Self-check at startup and in `GET /health` (§7.6); notice in the UI.
- [x] `postMessage` `ready`/`navigate` to the parent window when framed (§11.1).
- [x] `Dockerfile` (Node 24 + ffmpeg, non-root, `DATA_DIR` volume, health check) and `compose.yaml` as the main way to run: `homescribe` with `restart: unless-stopped`, speaches under the `gpu` or `cpu` profile with the default model preloaded, Ollama under the `llm` profile.
- [x] README: run with Docker Compose; HTTPS without a private CA (Tailscale `serve`, or an own domain with Let's Encrypt via the DNS challenge) with ready-made examples, including serving under the hub's origin.

### Stage 3b — transcribe a link

- [x] `POST /recordings/from-url`, `sourceUrl` on recordings, `downloading` step with progress, `DOWNLOAD_FAILED`.
- [x] yt-dlp behind a `MediaDownloader` interface; tests with a fake yt-dlp executable; the real one only when installed.
- [x] Private-address guard; `yt-dlp -U` at startup and daily; `ytdlp` in the self-check.
- [x] Docker image with yt-dlp and deno; UI: paste a link next to the upload, source link on the recording page.

### Stage 3c — one-command install

- [x] Published multi-arch image (`linux/amd64`, `linux/arm64`) on GHCR from GitHub Actions: `latest` from `main`, `X.Y.Z`/`X.Y` from tags; CI (lint, typecheck, test, build, installer parse, compose config) on every PR.
- [x] `compose.yaml` pulls the image; `compose.dev.yaml` builds from source; profiles `gpu`/`cpu` (speaches) and `llm-gpu`/`llm-cpu` (Ollama), settable through `COMPOSE_PROFILES` in `.env`.
- [x] `install.sh` (Linux, macOS) and `install.ps1` (Windows): install Docker with consent (get.docker.com, Homebrew `docker-desktop`, winget `Docker.DockerDesktop`), NVIDIA Container Toolkit with consent (apt/dnf), GPU/CPU choice, optional Ollama with a model, free port, `.env` that keeps user lines, start, wait for health and the speech model, print LAN addresses and the self-check. Re-running updates.
- [x] The installer lets you choose what to download before anything is pulled: where speech recognition runs (GPU, CPU or not here), the Whisper model (`large-v3`, `large-v3-turbo`, `medium`, `small`, with sizes) and the local summary model (`qwen2.5:7b`, `llama3.1:8b`, `qwen2.5:3b` or none). Each option shows its download size and the memory it uses; the two models take turns but each stays loaded for about 5 minutes (speaches `stt_model_ttl`, Ollama `keep_alive`), so the summary adds both up, compares with the GPU's memory and asks to confirm. Models already in the volumes are detected first (a throwaway container from the local Homescribe image reads `hf-hub-cache` and `ollama-models`) and marked as downloaded; an unfinished Whisper download is marked as continuing. The installer asks speaches to download the chosen model (`POST /v1/models/{id}`, detached inside the container with retries until it listens) rather than relying on `PRELOAD_MODELS` alone. While speaches downloads, the installer shows the bytes on disk against the expected size; `ollama pull` shows its own progress. Interrupted downloads resume (Hugging Face `.incomplete` files, Ollama partial blobs) and the Whisper download runs in the container, so closing the window does not stop it. Afterwards the installer removes image versions an update replaced, stops services of an earlier choice (GPU↔CPU, no LLM) and offers to delete models, finished or not, that are no longer chosen. The choice goes to `.env` as `STT_MODEL`/`LLM_MODEL`; `compose.yaml` preloads `STT_MODEL`. Flags (`--stt-model`, `--llm-model`, `-SttModel`, `-LlmModel`) skip the questions.
- [x] Start and stop without knowing Docker: the installer puts a control script next to `compose.yaml` (`homescribe` with `start | stop | status | update` on Linux and macOS; `homescribe.ps1` plus `Start Homescribe.cmd`, `Stop Homescribe.cmd`, `Homescribe status.cmd`, `Update Homescribe.cmd` on Windows, and on request Start menu shortcuts). `start` runs `compose up -d`, waits for `/health`, prints the address and opens the browser (and starts Docker Desktop on Windows if needed); `stop` runs `compose down` (never `-v`) and says that recordings, models and settings are kept; `status` shows `compose ps` and the self-check; `update` pulls and restarts (model choices stay with the installer). Starting with the computer is a question (default no, `--autostart`/`-Autostart`), stored as `HOMESCRIBE_RESTART` (`no` or `unless-stopped`), which `compose.yaml` uses as every service's restart policy; on Windows it also needs Docker Desktop to start at sign-in, which the installer says.

### Stage 4 — record in the browser, PWA, offline

- [ ] Record screen using `MediaRecorder`; pick the first supported of `audio/webm;codecs=opus`, `audio/mp4`, `audio/webm` via `MediaRecorder.isTypeSupported`, upload with the matching extension (Chrome → webm, Safari → mp4).
- [ ] Web app manifest, icons, service worker caching the app shell; installable on Android and iOS.
- [ ] Recordings made while the server is unreachable are stored in IndexedDB and uploaded automatically (on `online`, on app start, on a timer) with visible pending state; a successful upload removes them from IndexedDB.
- [ ] Handles: microphone permission denied, recording interrupted by a call/lock screen, storage quota errors.

### Stage 5 — release

- [ ] `README.md` with features, quick start, configuration, API overview, screenshot placeholders.
- [ ] `LICENSE` (MIT), `CHANGELOG.md` entry, tag `v1.0.0`.

## 16. Decisions log

Resolved with the maintainer:

1. Default STT model: `Systran/faster-whisper-large-v3`, the most accurate
   multilingual Whisper model (speaches maps its `whisper-1` alias to it).
   A faster, slightly less accurate option is a `large-v3-turbo` build; set
   `STT_MODEL` to switch.
2. The original upload is kept until the recording is deleted (needed for
   re-processing and the stage 2 player).
3. The UI may be embedded in another app through an iframe (§11.1); the page
   itself stays generic.
4. Approved extra dev packages: `eslint-plugin-react-hooks`, `jsdom`,
   `@testing-library/react`.
5. Both AI backends can be chosen in the UI: local (found by discovery on this
   machine and `AI_DISCOVERY_HOSTS`, no network scan) or a cloud API (OpenAI,
   Groq, OpenRouter presets or any OpenAI-compatible address) (§7.5).
6. Search snippets are a highlighted fragment around the first match.
7. Deployment comes before in-browser recording: Docker Compose is the main
   way to run (stage 3), and the preferred embedding is the same origin via
   `BASE_PATH` behind one proxy. HTTPS is documented, not built in: Tailscale
   `serve` or Let's Encrypt with the DNS challenge, never a private CA.

8. Links are imported with yt-dlp (self-updating, deno as its JS runtime),
   not limited to direct file links.
9. Installation is one command per OS against a published image; Docker
   and the NVIDIA toolkit are installed only after the user agrees.

## 17. Open questions

None at the moment.
