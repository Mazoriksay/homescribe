/**
 * The HTTP API contract (SPEC.md §7). Every request and response payload is
 * defined here; server and web infer their types from these schemas.
 */
import { z } from 'zod';

export const API_PREFIX = '/api/v1';

// ---------------------------------------------------------------- errors

export const apiErrorCodes = [
  'VALIDATION_ERROR',
  'FILE_REQUIRED',
  'NETWORK_NOT_ALLOWED',
  'NOT_FOUND',
  'JOB_ACTIVE',
  'TRANSCRIPT_NOT_READY',
  'SUMMARY_NOT_READY',
  'SUMMARIES_OFF',
  'URL_NOT_ALLOWED',
  'AI_UNREACHABLE',
  'PAIRING_INVALID',
  'TOKEN_INVALID',
  'FILE_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'INTERNAL_ERROR',
] as const;
export type ApiErrorCode = (typeof apiErrorCodes)[number];

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const jobErrorCodes = [
  'INTERRUPTED',
  'CANCELLED',
  'DOWNLOAD_FAILED',
  'DOWNLOAD_BLOCKED',
  'DOWNLOAD_COOKIES_EXPIRED',
  'MEDIA_UNREADABLE',
  'STT_UNAVAILABLE',
  'STT_TIMEOUT',
  'STT_FAILED',
  'LLM_UNAVAILABLE',
  'LLM_TIMEOUT',
  'LLM_FAILED',
  'LLM_CONTEXT_EXCEEDED',
  'LLM_OUT_OF_MEMORY',
  'LLM_BAD_REPLY',
  'LLM_BUSY',
  'INTERNAL_ERROR',
] as const;
export type JobErrorCode = (typeof jobErrorCodes)[number];

// ---------------------------------------------------------------- jobs

export const jobStatuses = [
  'queued',
  'downloading',
  'converting',
  'transcribing',
  'summarizing',
  'done',
  'failed',
] as const;
export const jobStatusSchema = z.enum(jobStatuses);
export type JobStatus = z.infer<typeof jobStatusSchema>;

/** Statuses after which a job never changes again. */
export const finalJobStatuses: readonly JobStatus[] = ['done', 'failed'];
export const isJobFinal = (status: JobStatus): boolean => finalJobStatuses.includes(status);

/** `process`: convert, transcribe, summarize. `summarize`: only (re)create the summary. */
export const jobKindSchema = z.enum(['process', 'summarize']);
export type JobKind = z.infer<typeof jobKindSchema>;

const timestamp = z.iso.datetime();

export const jobSchema = z.object({
  id: z.uuid(),
  recordingId: z.uuid(),
  kind: jobKindSchema,
  status: jobStatusSchema,
  progress: z.number().min(0).max(1).nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: timestamp,
  startedAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
});
export type Job = z.infer<typeof jobSchema>;

export const createJobBodySchema = z.object({ kind: jobKindSchema });
export type CreateJobBody = z.infer<typeof createJobBodySchema>;

// ---------------------------------------------------------------- recordings

export const recordingSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  originalFilename: z.string(),
  mediaType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  durationSeconds: z.number().nonnegative().nullable(),
  /** The link the media was downloaded from (SPEC.md §7.7), or null for uploads. */
  sourceUrl: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  job: jobSchema,
});
export type Recording = z.infer<typeof recordingSchema>;

export const TITLE_MAX_LENGTH = 200;
export const titleSchema = z.string().trim().min(1).max(TITLE_MAX_LENGTH);

export const idParamsSchema = z.object({ id: z.uuid() });

export const SOURCE_URL_MAX_LENGTH = 2000;

export const createFromUrlBodySchema = z.object({
  url: z
    .url({ protocol: /^https?$/ })
    .max(SOURCE_URL_MAX_LENGTH)
    .refine((value) => {
      // An unparsable link is already reported by z.url(); say it only once.
      if (!URL.canParse(value)) return true;
      const url = new URL(value);
      return !url.username && !url.password;
    }, 'Links with credentials are not accepted'),
  title: titleSchema.optional(),
});
export type CreateFromUrlBody = z.infer<typeof createFromUrlBodySchema>;

export const updateRecordingBodySchema = z.object({ title: titleSchema });
export type UpdateRecordingBody = z.infer<typeof updateRecordingBodySchema>;

export const listRecordingsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListRecordingsQuery = z.infer<typeof listRecordingsQuerySchema>;

export const paginationSchema = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  totalItems: z.number().int(),
  totalPages: z.number().int(),
});
export type Pagination = z.infer<typeof paginationSchema>;

export const recordingPageSchema = z.object({
  data: z.array(recordingSchema),
  pagination: paginationSchema,
});
export type RecordingPage = z.infer<typeof recordingPageSchema>;

// ---------------------------------------------------------------- transcripts

export const segmentSchema = z.object({
  index: z.number().int().nonnegative(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string(),
});
export type Segment = z.infer<typeof segmentSchema>;

/** A stretch of audio whose speech could not be recognized (seconds). */
export const transcriptGapSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
});
export type TranscriptGap = z.infer<typeof transcriptGapSchema>;

export const transcriptSchema = z.object({
  recordingId: z.uuid(),
  language: z.string().nullable(),
  model: z.string(),
  text: z.string(),
  segments: z.array(segmentSchema),
  /** Where Whisper got stuck repeating itself even after a retry; the text there is missing. */
  gaps: z.array(transcriptGapSchema),
  createdAt: timestamp,
});
export type Transcript = z.infer<typeof transcriptSchema>;

// ---------------------------------------------------------------- summaries

export const SUMMARY_MAX_LENGTH = 20_000;
export const ACTION_ITEMS_MAX = 50;
export const ACTION_ITEM_MAX_LENGTH = 500;

export const summarySchema = z.object({
  recordingId: z.uuid(),
  /** Markdown; render without raw HTML. */
  summary: z.string(),
  actionItems: z.array(z.string()),
  model: z.string(),
  createdAt: timestamp,
});
export type Summary = z.infer<typeof summarySchema>;

// ---------------------------------------------------------------- search

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/** A text fragment split into plain and matching parts, for highlighting. */
export const snippetSchema = z.array(z.object({ text: z.string(), match: z.boolean() }));
export type Snippet = z.infer<typeof snippetSchema>;

export const searchHitSchema = z.object({
  recording: recordingSchema,
  snippet: snippetSchema,
  /** First transcript segment containing the query, if the match is in the transcript. */
  segment: z.object({ index: z.number().int(), start: z.number() }).nullable(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchPageSchema = z.object({
  data: z.array(searchHitSchema),
  pagination: paginationSchema,
});
export type SearchPage = z.infer<typeof searchPageSchema>;

export const searchModes = ['fts5', 'like'] as const;
export type SearchMode = (typeof searchModes)[number];

/** Result of the server's self-check (SPEC.md §7.6). */
export const healthChecksSchema = z.object({
  ffmpeg: z.enum(['ok', 'missing']),
  ytdlp: z.enum(['ok', 'missing']),
  stt: z.enum(['ok', 'model_missing', 'unreachable']),
  llm: z.enum(['ok', 'model_missing', 'unreachable', 'off']),
  embedding: z.enum(['same_origin', 'origins']),
});
export type HealthChecks = z.infer<typeof healthChecksSchema>;

// ---------------------------------------------------------------- YouTube cookies (§7.8)

export const cookieStatuses = ['none', 'ok', 'expired', 'unchecked'] as const;

export const cookieStatusSchema = z.object({
  status: z.enum(cookieStatuses),
  source: z.enum(['extension', 'file']).nullable(),
  updatedAt: timestamp.nullable(),
  checkedAt: timestamp.nullable(),
  /** An extension holds a token. */
  paired: z.boolean(),
});
export type CookieStatus = z.infer<typeof cookieStatusSchema>;

export const pairingSchema = z.object({
  code: z.string(),
  expiresAt: timestamp,
  /** The extension's fixed Chrome ID, for the one-click pairing link. */
  extensionId: z.string(),
  /** Where the installer unpacked the extension on the host (EXTENSION_FOLDER). */
  extensionFolder: z.string().nullable(),
});
export type Pairing = z.infer<typeof pairingSchema>;

export const pairBodySchema = z.object({ code: z.string().trim().min(1).max(20) });
export const pairResultSchema = z.object({ token: z.string() });

/** ID that the `key` in apps/extension/manifest.json gives the extension in Chromium browsers. */
export const EXTENSION_ID = 'fladogegofoeopddbkeonljdjgpbblgi';

export const healthSchema = z.object({
  status: z.literal('ok'),
  search: z.enum(searchModes),
  /** null until the first check has finished. */
  checks: healthChecksSchema.nullable(),
  checkedAt: timestamp.nullable(),
  cookies: z.enum(cookieStatuses),
});
export type Health = z.infer<typeof healthSchema>;

// ---------------------------------------------------------------- events (SSE)

export const recordingDeletedEventSchema = z.object({ id: z.uuid() });

export type ServerEvent =
  | { event: 'job'; data: Job }
  | { event: 'recording.deleted'; data: z.infer<typeof recordingDeletedEventSchema> };

// ---------------------------------------------------------------- upstream: speech-to-text

// ---------------------------------------------------------------- upstream: model lists and chat

/** `GET /v1/models` of an OpenAI-compatible server; speaches adds `task`. */
export const upstreamModelListSchema = z.object({
  // Ollama without models answers { "data": null }.
  data: z
    .array(z.object({ id: z.string(), task: z.string().nullish() }))
    .nullish()
    .transform((data) => data ?? []),
});

/** Subset of Ollama's own POST /api/chat answer (stream: false). */
export const ollamaChatSchema = z.object({
  message: z.object({ content: z.string().nullish() }),
  /** "length" when the context window cut the reply off. */
  done_reason: z.string().nullish(),
});

/** Subset of an OpenAI-compatible chat completion response. */
export const chatCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullish() }),
        /** "length" when the context window cut the reply off. */
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
});

export const SUMMARY_INSTRUCTIONS_MAX_LENGTH = 2000;
/** The user's own additions to the summary prompt (SPEC.md §8). */
export const summarySettingsSchema = z.object({
  instructions: z.string().trim().max(SUMMARY_INSTRUCTIONS_MAX_LENGTH),
});
export type SummarySettings = z.infer<typeof summarySettingsSchema>;

/** What the summarizer must return; validated before anything is stored. */
export const summaryPayloadSchema = z.object({
  summary: z.string().trim().min(1).max(SUMMARY_MAX_LENGTH),
  actionItems: z
    .array(z.string().trim().min(1).max(ACTION_ITEM_MAX_LENGTH))
    .max(ACTION_ITEMS_MAX)
    .default([]),
});
export type SummaryPayload = z.infer<typeof summaryPayloadSchema>;

/**
 * Subset of the OpenAI-compatible `verbose_json` transcription response that
 * the server relies on (openai.types.audio.TranscriptionVerbose, as returned
 * by speaches). Unknown fields are dropped.
 */
export const sttVerboseResponseSchema = z.object({
  text: z.string(),
  language: z.string().nullish(),
  segments: z
    .array(z.object({ start: z.number(), end: z.number(), text: z.string() }))
    .nullish()
    .transform((segments) => segments ?? []),
  /** Present when word timestamps were asked for (`timestamp_granularities[]=word`). */
  words: z
    .array(z.object({ start: z.number(), end: z.number(), word: z.string() }))
    .nullish()
    .transform((words) => words ?? []),
});
export type SttVerboseResponse = z.infer<typeof sttVerboseResponseSchema>;

// ---------------------------------------------------------------- updates

/** "Check for updates" (SPEC.md §7.9): this build against GitHub. */
export const updateStatusSchema = z.object({
  current: z.object({ version: z.string(), commit: z.string().nullable() }),
  /** The newest release (release images) or the newest commit on main. */
  latest: z.object({ ref: z.string(), date: z.string().nullable() }).nullable(),
  /** Changes on main since this build; null for release images or when unknown. */
  behind: z.number().int().nonnegative().nullable(),
  updateAvailable: z.boolean().nullable(),
  /** Why nothing could be compared: off, built from source, GitHub unreachable. */
  error: z.enum(['off', 'unknown_build', 'unreachable']).nullable(),
});
export type UpdateStatus = z.infer<typeof updateStatusSchema>;
