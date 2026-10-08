import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  Job,
  JobKind,
  JobStatus,
  ListRecordingsQuery,
  Recording,
  RecordingPage,
  Summary,
  Transcript,
} from '@homescribe/shared';
import { transaction } from './database';
import { SearchIndex } from './search';
import { foldText } from './snippet';

export interface NewRecording {
  id: string;
  title: string;
  originalFilename: string;
  mediaType: string;
  sizeBytes: number;
  /** '' for a link whose media is not downloaded yet. */
  storedName: string;
  sourceUrl?: string | null;
  /** Replace the title with the page's title once the link is downloaded. */
  titleFromSource?: boolean;
}

export interface DownloadedMedia {
  storedName: string;
  mediaType: string;
  sizeBytes: number;
  /** Used only when the recording still has its placeholder title. */
  title: string | null;
}

export interface JobPatch {
  status?: JobStatus;
  progress?: number | null;
  error?: { code: string; message: string } | null;
  /** Set `started_at` to now. */
  started?: boolean;
  /** Set `finished_at` to now. */
  finished?: boolean;
}

export interface NewSummary {
  summary: string;
  actionItems: string[];
  model: string;
}

/** AI backend settings as stored; the API key never leaves the server. */
export interface StoredAiSettings {
  mode: 'local' | 'api' | 'off';
  provider: string | null;
  baseUrl: string;
  model: string;
  apiKey: string | null;
}

export interface NewTranscript {
  language: string | null;
  model: string;
  text: string;
  segments: { start: number; end: number; text: string }[];
}

interface JobRow {
  id: string;
  recording_id: string;
  kind: string;
  status: string;
  progress: number | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface RecordingRow {
  id: string;
  title: string;
  original_filename: string;
  media_type: string;
  size_bytes: number;
  stored_name: string;
  duration_seconds: number | null;
  source_url: string | null;
  created_at: string;
  updated_at: string;
}

const RUNNING_STATUSES: JobStatus[] = ['downloading', 'converting', 'transcribing', 'summarizing'];

const LATEST_JOB_ID = `(SELECT j.id FROM jobs j WHERE j.recording_id = r.id
  ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1)`;

const RECORDING_WITH_JOB = `
  SELECT r.*, j.id AS job_id, j.kind AS job_kind, j.status AS job_status,
         j.progress AS job_progress, j.error_code AS job_error_code,
         j.error_message AS job_error_message, j.created_at AS job_created_at,
         j.started_at AS job_started_at, j.finished_at AS job_finished_at
  FROM recordings r JOIN jobs j ON j.id = ${LATEST_JOB_ID}`;

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    recordingId: row.recording_id,
    kind: row.kind as JobKind,
    status: row.status as JobStatus,
    progress: row.progress,
    error:
      row.error_code !== null ? { code: row.error_code, message: row.error_message ?? '' } : null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function toRecording(row: Record<string, unknown>): Recording {
  const r = row as unknown as RecordingRow & Record<`job_${string}`, unknown>;
  return {
    id: r.id,
    title: r.title,
    originalFilename: r.original_filename,
    mediaType: r.media_type,
    sizeBytes: r.size_bytes,
    durationSeconds: r.duration_seconds,
    sourceUrl: r.source_url,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    job: toJob({
      id: r.job_id as string,
      recording_id: r.id,
      kind: r.job_kind as string,
      status: r.job_status as string,
      progress: r.job_progress as number | null,
      error_code: r.job_error_code as string | null,
      error_message: r.job_error_message as string | null,
      created_at: r.job_created_at as string,
      started_at: r.job_started_at as string | null,
      finished_at: r.job_finished_at as string | null,
    }),
  };
}

/** All SQL lives here. Methods are synchronous because node:sqlite is. */
export class Repository {
  readonly search: SearchIndex;

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
    options: { forceLikeSearch?: boolean } = {},
  ) {
    this.search = new SearchIndex(db, { forceLike: options.forceLikeSearch });
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  createRecording(input: NewRecording): Recording {
    const at = this.timestamp();
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO recordings (id, title, original_filename, media_type, size_bytes,
             stored_name, duration_seconds, source_url, title_from_source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.title,
          input.originalFilename,
          input.mediaType,
          input.sizeBytes,
          input.storedName,
          input.sourceUrl ?? null,
          input.titleFromSource ? 1 : 0,
          at,
          at,
        );
      this.insertJob(input.id, 'process', at);
      this.search.refresh(input.id);
    });
    return this.getRecording(input.id)!;
  }

  getRecording(id: string): Recording | null {
    const row = this.db.prepare(`${RECORDING_WITH_JOB} WHERE r.id = ?`).get(id);
    return row ? toRecording(row) : null;
  }

  /** Stores what a link download produced (SPEC.md §7.7). */
  setDownloadedMedia(id: string, media: DownloadedMedia): void {
    transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE recordings SET stored_name = ?, media_type = ?, size_bytes = ?,
             title = CASE WHEN title_from_source = 1 AND ? IS NOT NULL THEN ? ELSE title END,
             title_from_source = CASE WHEN ? IS NOT NULL THEN 0 ELSE title_from_source END,
             updated_at = ?
           WHERE id = ?`,
        )
        .run(
          media.storedName,
          media.mediaType,
          media.sizeBytes,
          media.title,
          media.title,
          media.title,
          this.timestamp(),
          id,
        );
      this.search.refresh(id);
    });
  }

  getStoredName(id: string): string | null {
    const row = this.db.prepare('SELECT stored_name FROM recordings WHERE id = ?').get(id) as
      { stored_name: string } | undefined;
    return row?.stored_name ?? null;
  }

  listRecordings({ page, pageSize }: ListRecordingsQuery): RecordingPage {
    const { total } = this.db.prepare('SELECT COUNT(*) AS total FROM recordings').get() as {
      total: number;
    };
    const rows = this.db
      .prepare(`${RECORDING_WITH_JOB} ORDER BY r.created_at DESC, r.rowid DESC LIMIT ? OFFSET ?`)
      .all(pageSize, (page - 1) * pageSize);
    return {
      data: rows.map(toRecording),
      pagination: {
        page,
        pageSize,
        totalItems: total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  setDuration(id: string, durationSeconds: number): void {
    this.db
      .prepare('UPDATE recordings SET duration_seconds = ?, updated_at = ? WHERE id = ?')
      .run(durationSeconds, this.timestamp(), id);
  }

  /** Seconds of transcription per second of audio last seen for this model. */
  getSttSpeed(model: string): number | null {
    const row = this.db.prepare('SELECT ratio FROM stt_speed WHERE model = ?').get(model) as
      { ratio: number } | undefined;
    return row?.ratio ?? null;
  }

  /** Blends a new measurement into the stored speed (half old, half new). */
  recordSttSpeed(model: string, ratio: number): void {
    const previous = this.getSttSpeed(model);
    const blended = previous === null ? ratio : (previous + ratio) / 2;
    this.db
      .prepare(
        `INSERT INTO stt_speed (model, ratio, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(model) DO UPDATE SET ratio = excluded.ratio, updated_at = excluded.updated_at`,
      )
      .run(model, blended, this.timestamp());
  }

  renameRecording(id: string, title: string): Recording | null {
    transaction(this.db, () => {
      this.db
        .prepare('UPDATE recordings SET title = ?, updated_at = ? WHERE id = ?')
        .run(title, this.timestamp(), id);
      this.search.refresh(id);
    });
    return this.getRecording(id);
  }

  deleteRecording(id: string): boolean {
    return transaction(this.db, () => {
      this.search.remove(id);
      return this.db.prepare('DELETE FROM recordings WHERE id = ?').run(id).changes > 0;
    });
  }

  createJob(recordingId: string, kind: JobKind): Job {
    const id = this.insertJob(recordingId, kind, this.timestamp());
    return this.getJob(id)!;
  }

  private insertJob(recordingId: string, kind: JobKind, at: string): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO jobs (id, recording_id, kind, status, created_at) VALUES (?, ?, ?, 'queued', ?)`,
      )
      .run(id, recordingId, kind, at);
    return id;
  }

  getJob(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  updateJob(id: string, patch: JobPatch): Job {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      values.push(patch.status);
    }
    if (patch.progress !== undefined) {
      sets.push('progress = ?');
      values.push(patch.progress);
    }
    if (patch.error !== undefined) {
      sets.push('error_code = ?', 'error_message = ?');
      values.push(patch.error?.code ?? null, patch.error?.message ?? null);
    }
    if (patch.started) {
      sets.push('started_at = ?');
      values.push(this.timestamp());
    }
    if (patch.finished) {
      sets.push('finished_at = ?');
      values.push(this.timestamp());
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    }
    const job = this.getJob(id);
    if (!job) throw new Error(`Job ${id} not found`);
    return job;
  }

  /** The recording's job that has not reached a final status, if any. */
  activeJob(recordingId: string): Job | null {
    const row = this.db
      .prepare(
        `SELECT * FROM jobs WHERE recording_id = ? AND status NOT IN ('done', 'failed')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(recordingId) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  nextQueuedJob(): Job | null {
    const row = this.db
      .prepare(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1`)
      .get() as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  /** Fails every job that was mid-run, e.g. after a restart. Returns the failed jobs. */
  failRunningJobs(code: string, message: string): Job[] {
    const placeholders = RUNNING_STATUSES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT id FROM jobs WHERE status IN (${placeholders})`)
      .all(...RUNNING_STATUSES) as { id: string }[];
    return rows.map(({ id }) =>
      this.updateJob(id, {
        status: 'failed',
        progress: null,
        error: { code, message },
        finished: true,
      }),
    );
  }

  saveTranscript(recordingId: string, transcript: NewTranscript): void {
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM segments WHERE recording_id = ?').run(recordingId);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO transcripts (recording_id, language, text, model, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(recordingId, transcript.language, transcript.text, transcript.model, this.timestamp());
      const insert = this.db.prepare(
        `INSERT INTO segments (recording_id, idx, start_seconds, end_seconds, text)
         VALUES (?, ?, ?, ?, ?)`,
      );
      transcript.segments.forEach((segment, index) => {
        insert.run(recordingId, index, segment.start, segment.end, segment.text);
      });
      this.search.refresh(recordingId);
    });
  }

  saveSummary(recordingId: string, summary: NewSummary): void {
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO summaries (recording_id, summary, action_items, model, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          recordingId,
          summary.summary,
          JSON.stringify(summary.actionItems),
          summary.model,
          this.timestamp(),
        );
      this.search.refresh(recordingId);
    });
  }

  getSummary(recordingId: string): Summary | null {
    const row = this.db
      .prepare('SELECT * FROM summaries WHERE recording_id = ?')
      .get(recordingId) as
      { summary: string; action_items: string; model: string; created_at: string } | undefined;
    if (!row) return null;
    return {
      recordingId,
      summary: row.summary,
      actionItems: JSON.parse(row.action_items) as string[],
      model: row.model,
      createdAt: row.created_at,
    };
  }

  /** Transcript segments containing any of the (folded) terms, first one only. */
  firstMatchingSegment(
    recordingId: string,
    terms: string[],
  ): { index: number; start: number } | null {
    const rows = this.db
      .prepare('SELECT idx, start_seconds, text FROM segments WHERE recording_id = ? ORDER BY idx')
      .all(recordingId) as { idx: number; start_seconds: number; text: string }[];
    const hit = rows.find((row) => {
      const text = foldText(row.text);
      return terms.some((term) => text.includes(term));
    });
    return hit ? { index: hit.idx, start: hit.start_seconds } : null;
  }

  getAiSettings(kind: string): StoredAiSettings | null {
    const row = this.db.prepare('SELECT * FROM ai_settings WHERE kind = ?').get(kind) as
      | {
          mode: string;
          provider: string | null;
          base_url: string;
          model: string;
          api_key: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      mode: row.mode as StoredAiSettings['mode'],
      provider: row.provider,
      baseUrl: row.base_url,
      model: row.model,
      apiKey: row.api_key,
    };
  }

  saveAiSettings(kind: string, settings: StoredAiSettings): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ai_settings (kind, mode, provider, base_url, model, api_key, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        kind,
        settings.mode,
        settings.provider,
        settings.baseUrl,
        settings.model,
        settings.apiKey,
        this.timestamp(),
      );
  }

  deleteAiSettings(kind: string): void {
    this.db.prepare('DELETE FROM ai_settings WHERE kind = ?').run(kind);
  }

  getTranscript(recordingId: string): Transcript | null {
    const row = this.db
      .prepare('SELECT * FROM transcripts WHERE recording_id = ?')
      .get(recordingId) as
      { language: string | null; text: string; model: string; created_at: string } | undefined;
    if (!row) return null;
    const segments = this.db
      .prepare(
        `SELECT idx, start_seconds, end_seconds, text FROM segments
         WHERE recording_id = ? ORDER BY idx`,
      )
      .all(recordingId) as {
      idx: number;
      start_seconds: number;
      end_seconds: number;
      text: string;
    }[];
    return {
      recordingId,
      language: row.language,
      model: row.model,
      text: row.text,
      createdAt: row.created_at,
      segments: segments.map((s) => ({
        index: s.idx,
        start: s.start_seconds,
        end: s.end_seconds,
        text: s.text,
      })),
    };
  }
}
