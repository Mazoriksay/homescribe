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
  'MEDIA_UNREADABLE',
  'STT_UNAVAILABLE',
  'STT_TIMEOUT',
  'STT_FAILED',
  'INTERNAL_ERROR',
] as const;
export type JobErrorCode = (typeof jobErrorCodes)[number];

// ---------------------------------------------------------------- jobs

export const jobStatuses = [
  'queued',
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

export const jobKindSchema = z.enum(['process']);
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
  createdAt: timestamp,
  updatedAt: timestamp,
  job: jobSchema,
});
export type Recording = z.infer<typeof recordingSchema>;

export const TITLE_MAX_LENGTH = 200;
export const titleSchema = z.string().trim().min(1).max(TITLE_MAX_LENGTH);

export const idParamsSchema = z.object({ id: z.uuid() });

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

export const transcriptSchema = z.object({
  recordingId: z.uuid(),
  language: z.string().nullable(),
  model: z.string(),
  text: z.string(),
  segments: z.array(segmentSchema),
  createdAt: timestamp,
});
export type Transcript = z.infer<typeof transcriptSchema>;

export const healthSchema = z.object({ status: z.literal('ok') });
export type Health = z.infer<typeof healthSchema>;

// ---------------------------------------------------------------- events (SSE)

export const recordingDeletedEventSchema = z.object({ id: z.uuid() });

export type ServerEvent =
  | { event: 'job'; data: Job }
  | { event: 'recording.deleted'; data: z.infer<typeof recordingDeletedEventSchema> };

// ---------------------------------------------------------------- upstream: speech-to-text

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
});
export type SttVerboseResponse = z.infer<typeof sttVerboseResponseSchema>;
