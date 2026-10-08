import { mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { TITLE_MAX_LENGTH, type Job, type JobErrorCode } from '@homescribe/shared';
import type { JobPatch, Repository } from '../db/repository';
import type { EventBus } from '../events';
import { LlmError, type Summarizer } from '../llm/summarizer';
import { DownloadBlockedError, DownloadError, type MediaDownloader } from '../media/downloader';
import { MediaError, type AudioFormat, type MediaTool } from '../media/media-tool';
import { downloadedMediaType, storedNameFor, type MediaStore } from '../storage';
import { SttError, type Transcriber } from '../stt/transcriber';

/** The AI backends to use, resolved per job so settings changes apply to the next job. */
export interface AiBackends {
  stt(): { transcriber: Transcriber; format: AudioFormat };
  /** null when summaries are turned off. */
  llm(): Summarizer | null;
}

export interface Logger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface JobRunnerDeps {
  repo: Repository;
  store: MediaStore;
  media: MediaTool;
  ai: AiBackends;
  /** Link import (SPEC.md §7.7); optional so tests without links can omit it. */
  downloader?: MediaDownloader;
  download?: { maxBytes: number; timeoutMs: number };
  events: EventBus;
  logger: Logger;
  /** Minimum time between two progress updates of one job. */
  progressIntervalMs?: number;
  /** How often the transcribing estimate is updated. */
  estimateIntervalMs?: number;
}

class JobFailure extends Error {
  constructor(
    readonly code: JobErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Runs queued jobs one at a time, in creation order (SPEC.md §8). Jobs live in
 * the database, so the queue survives restarts; `kick()` wakes the loop.
 */
export class JobRunner {
  private loop: Promise<void> | null = null;
  private readonly abort = new AbortController();
  /** The job being run and its own abort (cancel). */
  private current: { jobId: string; cancel: AbortController } | null = null;
  private readonly progressIntervalMs: number;
  private readonly estimateIntervalMs: number;

  constructor(private readonly deps: JobRunnerDeps) {
    this.progressIntervalMs = deps.progressIntervalMs ?? 500;
    this.estimateIntervalMs = deps.estimateIntervalMs ?? 2000;
  }

  /** Fails jobs left running by a previous process, then starts the queue. */
  start(): void {
    const interrupted = this.deps.repo.failRunningJobs(
      'INTERRUPTED',
      'The server stopped while this job was running',
    );
    for (const job of interrupted) this.publish(job);
    if (interrupted.length > 0) {
      this.deps.logger.info({ count: interrupted.length }, 'marked interrupted jobs as failed');
    }
    this.kick();
  }

  /** Starts processing if idle. Safe to call any number of times. */
  kick(): void {
    if (this.loop || this.abort.signal.aborted) return;
    this.loop = this.drain()
      .catch((error: unknown) => this.deps.logger.error({ err: error }, 'job queue crashed'))
      .finally(() => {
        this.loop = null;
      });
  }

  /** Resolves once the queue is empty (used by tests and shutdown). */
  async idle(): Promise<void> {
    while (this.loop) await this.loop;
  }

  /** Aborts the running job (it ends as INTERRUPTED) and stops taking new ones. */
  async stop(): Promise<void> {
    this.abort.abort();
    await this.idle();
  }

  /**
   * Cancels a job: a queued one at once, a running one by aborting its current
   * step. It ends as failed/CANCELLED and can be retried. Returns the job as it
   * is now, or null when it was not active.
   */
  cancel(jobId: string): Job | null {
    const job = this.deps.repo.getJob(jobId);
    if (!job || job.status === 'done' || job.status === 'failed') return null;
    if (this.current?.jobId === jobId) {
      this.current.cancel.abort();
      return job;
    }
    return this.update(jobId, {
      status: 'failed',
      progress: null,
      error: { code: 'CANCELLED', message: 'Cancelled' },
      finished: true,
    });
  }

  /** Aborts on shutdown or when the running job is cancelled. */
  private get signal(): AbortSignal {
    return this.current
      ? AbortSignal.any([this.abort.signal, this.current.cancel.signal])
      : this.abort.signal;
  }

  private async drain(): Promise<void> {
    for (let job = this.deps.repo.nextQueuedJob(); job; job = this.deps.repo.nextQueuedJob()) {
      if (this.abort.signal.aborted) return;
      await this.run(job);
    }
  }

  private update(jobId: string, patch: JobPatch): Job {
    const job = this.deps.repo.updateJob(jobId, patch);
    this.publish(job);
    return job;
  }

  private publish(job: Job): void {
    this.deps.events.emit({ event: 'job', data: job });
  }

  /** Persists progress at most every `progressIntervalMs`. */
  private progressReporter(jobId: string): (ratio: number) => void {
    let lastAt = 0;
    return (ratio) => {
      const now = Date.now();
      if (now - lastAt < this.progressIntervalMs) return;
      lastAt = now;
      this.update(jobId, { progress: Math.round(ratio * 1000) / 1000 });
    };
  }

  private async run(job: Job): Promise<void> {
    const { repo, store, logger } = this.deps;
    const recordingId = job.recordingId;
    const storedName = repo.getStoredName(recordingId);
    if (storedName === null) return; // recording deleted meanwhile; its job went with it

    this.current = { jobId: job.id, cancel: new AbortController() };
    try {
      if (job.kind === 'process') {
        // A recording made from a link has no media until it is downloaded.
        const media = storedName || (await this.download(job));
        await this.transcribe(job, media, !storedName);
      }
      await this.summarize(job);
      this.update(job.id, { status: 'done', progress: null, finished: true });
      logger.info({ jobId: job.id, recordingId, kind: job.kind }, 'job done');
    } catch (error) {
      const failure = this.toFailure(error);
      if (failure.code === 'INTERNAL_ERROR')
        logger.error({ err: error, jobId: job.id }, 'job crashed');
      else
        logger.info({ jobId: job.id, code: failure.code, reason: failure.message }, 'job failed');
      if (repo.getJob(job.id)) {
        this.update(job.id, {
          status: 'failed',
          progress: null,
          error: { code: failure.code, message: failure.message },
          finished: true,
        });
      }
    } finally {
      this.current = null;
      await store.removeWorkDir(recordingId).catch(() => undefined);
    }
  }

  /** converting → transcribing; stores the transcript. */
  /** downloading: fetches the recording's link and stores it like an upload. */
  private async download(job: Job): Promise<string> {
    const { repo, store, downloader, download } = this.deps;
    const recording = repo.getRecording(job.recordingId);
    if (!recording?.sourceUrl) throw new JobFailure('MEDIA_UNREADABLE', 'No media is stored');
    if (!downloader || !download) {
      throw new JobFailure('DOWNLOAD_FAILED', 'Link import is not available on this server');
    }

    this.update(job.id, { status: 'downloading', progress: 0, error: null, started: true });
    const dir = path.join(store.workDir(recording.id), 'download');
    await mkdir(dir, { recursive: true });
    const timeout = AbortSignal.timeout(download.timeoutMs);
    let file;
    try {
      file = await downloader.download(recording.sourceUrl, {
        dir,
        maxBytes: download.maxBytes,
        signal: AbortSignal.any([this.signal, timeout]),
        onProgress: this.progressReporter(job.id),
      });
    } catch (error) {
      if (timeout.aborted && !this.signal.aborted) {
        throw new JobFailure(
          'DOWNLOAD_FAILED',
          `The download took longer than ${download.timeoutMs} ms`,
        );
      }
      throw error;
    }

    const storedName = storedNameFor(`download.${file.ext}`);
    const target = store.originalPath(recording.id, storedName);
    await rename(file.path, target);
    repo.setDownloadedMedia(recording.id, {
      storedName,
      mediaType: downloadedMediaType(file.ext, file.audioOnly),
      sizeBytes: (await stat(target)).size,
      title: file.title ? file.title.slice(0, TITLE_MAX_LENGTH) : null,
    });
    return storedName;
  }

  private async transcribe(job: Job, storedName: string, alreadyStarted: boolean): Promise<void> {
    const { repo, store, media } = this.deps;
    const signal = this.signal;
    const recordingId = job.recordingId;
    const { transcriber, format } = this.deps.ai.stt();
    const input = store.originalPath(recordingId, storedName);
    const workDir = store.workDir(recordingId);
    const audio = path.join(workDir, `audio.${format}`);

    this.update(job.id, {
      status: 'converting',
      progress: 0,
      ...(!alreadyStarted && { error: null, started: true }),
    });
    await mkdir(workDir, { recursive: true });
    const duration = await media.probeDuration(input, signal);
    if (duration !== null) repo.setDuration(recordingId, duration);
    await media.convertAudio(input, audio, {
      format,
      durationSeconds: duration,
      signal,
      onProgress: this.progressReporter(job.id),
    });

    const result = await this.withEstimate(job.id, transcriber.model, duration, () =>
      transcriber.transcribe(audio, signal),
    );
    if (signal.aborted) throw signal.reason;
    // Whisper can place its last segments past the end of the audio.
    const segments =
      duration === null
        ? result.segments
        : result.segments
            .filter((s) => s.start < duration)
            .map((s) => ({ ...s, end: Math.min(s.end, duration) }));
    repo.saveTranscript(recordingId, { ...result, segments, model: transcriber.model });
  }

  /**
   * transcribing: the STT server reports no progress, so it is estimated from
   * how long this model took per second of audio before (capped at 95 %).
   * Without a measurement yet the progress stays unknown.
   */
  private async withEstimate<T>(
    jobId: string,
    model: string,
    duration: number | null,
    work: () => Promise<T>,
  ): Promise<T> {
    const { repo } = this.deps;
    const speed = duration ? repo.getSttSpeed(model) : null;
    const expectedMs = speed && duration ? speed * duration * 1000 : null;
    this.update(jobId, { status: 'transcribing', progress: expectedMs ? 0 : null });
    const startedAt = Date.now();
    const timer = expectedMs
      ? setInterval(() => {
          const ratio = Math.min(0.95, (Date.now() - startedAt) / expectedMs);
          this.update(jobId, { progress: Math.round(ratio * 1000) / 1000 });
        }, this.estimateIntervalMs)
      : null;
    try {
      const result = await work();
      // Very short clips are mostly model start-up time and would skew the speed.
      if (duration && duration >= 10) {
        repo.recordSttSpeed(model, (Date.now() - startedAt) / 1000 / duration);
      }
      return result;
    } finally {
      if (timer) clearInterval(timer);
    }
  }

  /** summarizing; skipped when summaries are off or there is no speech. */
  private async summarize(job: Job): Promise<void> {
    const { repo } = this.deps;
    const summarizer = this.deps.ai.llm();
    const transcript = repo.getTranscript(job.recordingId);
    if (!summarizer || !transcript?.text.trim()) {
      if (job.kind === 'summarize') {
        throw new JobFailure(
          'LLM_FAILED',
          summarizer ? 'There is no speech to summarize' : 'Summaries are turned off',
        );
      }
      return;
    }

    this.update(job.id, {
      status: 'summarizing',
      progress: 0,
      ...(job.kind === 'summarize' && { error: null, started: true }),
    });
    const signal = this.signal;
    const result = await summarizer.summarize(
      { text: transcript.text, language: transcript.language },
      { signal, onProgress: this.progressReporter(job.id) },
    );
    if (signal.aborted) throw signal.reason;
    repo.saveSummary(job.recordingId, { ...result, model: summarizer.model });
  }

  private toFailure(error: unknown): JobFailure {
    if (this.abort.signal.aborted) {
      return new JobFailure('INTERRUPTED', 'The server stopped while this job was running');
    }
    if (this.current?.cancel.signal.aborted) return new JobFailure('CANCELLED', 'Cancelled');
    if (error instanceof MediaError) {
      return new JobFailure(
        'MEDIA_UNREADABLE',
        `Cannot read or convert the media: ${error.message}`,
      );
    }
    if (error instanceof JobFailure) return error;
    if (error instanceof DownloadBlockedError) {
      return new JobFailure('DOWNLOAD_BLOCKED', `The site asks to sign in: ${error.message}`);
    }
    if (error instanceof DownloadError) {
      return new JobFailure('DOWNLOAD_FAILED', `Cannot download the link: ${error.message}`);
    }
    if (error instanceof SttError || error instanceof LlmError) {
      return new JobFailure(error.code, error.message);
    }
    return new JobFailure('INTERNAL_ERROR', 'Unexpected error; see the server log');
  }
}
