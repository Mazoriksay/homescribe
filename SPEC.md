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
CREATE TABLE search_docs (                   -- title + transcript + summary (plain text)
  recording_id  TEXT PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT NOT NULL,
  title_lc TEXT NOT NULL, body_lc TEXT NOT NULL  -- lower-cased in JS (SQLite folds ASCII only)
);
-- created at startup only if FTS5 is available (checked at runtime):
CREATE VIRTUAL TABLE search_fts USING fts5(recording_id UNINDEXED, title, body,
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
| `DOWNLOAD_FAILED`                                | yt-dlp could not fetch the link; the message has its reason |
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
  (e.g. "Video unavailable"); retrying downloads again.

YouTube needs a JavaScript runtime for yt-dlp; the Docker image ships deno,
which yt-dlp recommends because it sandboxes that code. yt-dlp updates itself
(`YTDLP_AUTO_UPDATE`) because sites change often. The self-check reports
`ytdlp: 'ok' | 'missing'`.

**Guard:** the link's host must not resolve to a loopback, private,
link-local or otherwise internal address unless `URL_IMPORT_ALLOW_PRIVATE`
is set (`400 URL_NOT_ALLOWED`). This is a best-effort check before handing
the URL to yt-dlp, which follows redirects and site-specific requests on its
own; every allowed LAN client is trusted anyway (§10).

Downloading content is subject to each site's terms; Homescribe is meant for
material the user may keep a personal copy of.

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
- `transcribing`: one request to the STT server. Progress is `null`
  (the API reports none).
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
- The temporary WAV is deleted when the job ends, success or failure.
- A transcript (and later a summary) is written in one SQLite transaction,
  so a reader never sees half of it.

## 9. Configuration

All settings come from environment variables; `.env.example` lists them.
`npm start` / `npm run dev:server` load `.env` from the repository root if it
exists (Node's `--env-file-if-exists`). Invalid values stop the server at
startup with a message naming the variable.

| Variable                   | Default                                                                          | Stage | Meaning                                                                             |
| -------------------------- | -------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------- |
| `HOST`                     | `0.0.0.0`                                                                        | 1     | Listen address                                                                      |
| `PORT`                     | `8080`                                                                           | 1     | Listen port                                                                         |
| `DATA_DIR`                 | `./data`                                                                         | 1     | SQLite file and media; created if missing                                           |
| `ALLOWED_NETWORKS`         | `127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7,fe80::/10` | 1     | Comma-separated CIDR list of allowed client addresses                               |
| `MAX_UPLOAD_MB`            | `2048`                                                                           | 1     | Largest accepted upload                                                             |
| `FFMPEG_PATH`              | `ffmpeg`                                                                         | 1     | ffmpeg binary                                                                       |
| `FFPROBE_PATH`             | `ffprobe`                                                                        | 1     | ffprobe binary                                                                      |
| `STT_MODE`                 | `local`                                                                          | 2     | `local` or `api` (cloud: audio sent as Opus)                                        |
| `STT_BASE_URL`             | `http://localhost:8000`                                                          | 1     | Base URL; the server calls `${STT_BASE_URL}/v1/audio/transcriptions`                |
| `STT_MODEL`                | `Systran/faster-whisper-large-v3`                                                | 1     | `model` form field                                                                  |
| `STT_LANGUAGE`             | _(empty = auto-detect)_                                                          | 1     | ISO 639-1 code sent as `language`                                                   |
| `STT_API_KEY`              | _(empty)_                                                                        | 1     | Sent as `Authorization: Bearer …` when set                                          |
| `STT_TIMEOUT_MS`           | `3600000`                                                                        | 1     | Per-request timeout                                                                 |
| `LLM_MODE`                 | `local`                                                                          | 2     | `local`, `api` or `off` (no summaries)                                              |
| `LLM_BASE_URL`             | `http://localhost:11434`                                                         | 2     | Base URL; calls `${LLM_BASE_URL}/v1/chat/completions`                               |
| `LLM_MODEL`                | `llama3.1:8b`                                                                    | 2     | `model` field                                                                       |
| `LLM_API_KEY`              | _(empty)_                                                                        | 2     | Bearer token when set                                                               |
| `LLM_TIMEOUT_MS`           | `600000`                                                                         | 2     | Per-request timeout                                                                 |
| `LLM_CHUNK_CHARS`          | `12000`                                                                          | 2     | Longer transcripts are summarized in parts, then merged                             |
| `AI_DISCOVERY_HOSTS`       | `localhost,host.docker.internal`                                                 | 2     | Hosts probed for local AI servers (names or IPs, no ports)                          |
| `BASE_PATH`                | _(empty = root)_                                                                 | 3     | Serve UI and API under this path, e.g. `/homescribe` (§11.2)                        |
| `WEB_DIST_DIR`             | `apps/web/dist` (resolved from the repo root)                                    | 1     | Built UI to serve; skipped if missing                                               |
| `FRAME_ANCESTORS`          | _(empty = only the app itself)_                                                  | 1     | Space-separated origins (`http://hub.lan:3000`) allowed to show the UI in an iframe |
| `YTDLP_PATH`               | `yt-dlp`                                                                         | 3     | yt-dlp binary for links (§7.7)                                                      |
| `YTDLP_AUTO_UPDATE`        | `true`                                                                           | 3     | Run `yt-dlp -U` at startup and daily (sites change often)                           |
| `DOWNLOAD_TIMEOUT_MS`      | `7200000`                                                                        | 3     | Longest a link download may take                                                    |
| `URL_IMPORT_ALLOW_PRIVATE` | `false`                                                                          | 3     | Allow links to private/loopback addresses (e.g. a NAS on the LAN)                   |
| `LOG_LEVEL`                | `info`                                                                           | 1     | Fastify/pino log level                                                              |

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
- English and Russian, switch in the header, remembered in `localStorage`,
  first visit follows the browser language.
- Themes: light, dark, auto (follows `prefers-color-scheme`), remembered.
- Visual language: one neutral colour family plus one accent; system font
  stack only; no stock Ant Design look (antd is themed through
  `ConfigProvider` tokens and used for form controls only — buttons,
  segmented switches, inputs). Layout and lists are hand-written CSS modules.
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

### Stage 4 — record in the browser, PWA, offline

- [ ] Record screen using `MediaRecorder`; pick the first supported of `audio/webm;codecs=opus`, `audio/mp4`, `audio/webm` via `MediaRecorder.isTypeSupported`, upload with the matching extension (Chrome → webm, Safari → mp4).
- [ ] Web app manifest, icons, service worker caching the app shell; installable on Android and iOS.
- [ ] Recordings made while the server is unreachable are stored in IndexedDB and uploaded automatically (on `online`, on app start, on a timer) with visible pending state; a successful upload removes them from IndexedDB.
- [ ] Handles: microphone permission denied, recording interrupted by a call/lock screen, storage quota errors.

### Stage 5 — release

- [ ] GitHub Actions CI: install, lint, typecheck, test on pull requests and `main`.
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

## 17. Open questions

None at the moment.
