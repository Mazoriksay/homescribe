import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Job, JobErrorCode } from '@homescribe/shared';
import type { JobPatch, Repository } from '../db/repository';
import type { EventBus } from '../events';
import { MediaError, type MediaTool } from '../media/media-tool';
import type { MediaStore } from '../storage';
import { SttError, type Transcriber } from '../stt/transcriber';

export interface Logger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface JobRunnerDeps {
  repo: Repository;
  store: MediaStore;
  media: MediaTool;
  transcriber: Transcriber;
  events: EventBus;
  logger: Logger;
  /** Minimum time between two progress updates of one job. */
  progressIntervalMs?: number;
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
  private readonly progressIntervalMs: number;

  constructor(private readonly deps: JobRunnerDeps) {
    this.progressIntervalMs = deps.progressIntervalMs ?? 500;
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
    this.loop = this.drain().finally(() => {
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

  private async run(job: Job): Promise<void> {
    const { repo, store, media, transcriber, logger } = this.deps;
    const signal = this.abort.signal;
    const recordingId = job.recordingId;
    const storedName = repo.getStoredName(recordingId);
    if (!storedName) return; // recording deleted meanwhile; its job went with it

    const input = store.originalPath(recordingId, storedName);
    const workDir = store.workDir(recordingId);
    const wav = path.join(workDir, 'audio.wav');

    try {
      this.update(job.id, { status: 'converting', progress: 0, error: null, started: true });
      await mkdir(workDir, { recursive: true });
      const duration = await media.probeDuration(input, signal);
      if (duration !== null) repo.setDuration(recordingId, duration);

      let lastProgressAt = 0;
      await media.convertToWav(input, wav, {
        durationSeconds: duration,
        signal,
        onProgress: (ratio) => {
          const now = Date.now();
          if (now - lastProgressAt < this.progressIntervalMs) return;
          lastProgressAt = now;
          this.update(job.id, { progress: Math.round(ratio * 1000) / 1000 });
        },
      });

      this.update(job.id, { status: 'transcribing', progress: null });
      const result = await transcriber.transcribe(wav, signal);
      if (signal.aborted) throw signal.reason;

      repo.saveTranscript(recordingId, { ...result, model: transcriber.model });
      // Stage 2 inserts the 'summarizing' step here.
      this.update(job.id, { status: 'done', progress: null, finished: true });
      logger.info({ jobId: job.id, recordingId }, 'job done');
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
      await store.removeWorkDir(recordingId).catch(() => undefined);
    }
  }

  private toFailure(error: unknown): JobFailure {
    if (this.abort.signal.aborted) {
      return new JobFailure('INTERRUPTED', 'The server stopped while this job was running');
    }
    if (error instanceof MediaError) {
      return new JobFailure(
        'MEDIA_UNREADABLE',
        `Cannot read or convert the media: ${error.message}`,
      );
    }
    if (error instanceof SttError) return new JobFailure(error.code, error.message);
    return new JobFailure('INTERNAL_ERROR', 'Unexpected error; see the server log');
  }
}
