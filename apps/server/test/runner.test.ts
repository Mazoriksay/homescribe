import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Job, ServerEvent } from '@homescribe/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database';
import { Repository } from '../src/db/repository';
import { EventBus } from '../src/events';
import { JobRunner } from '../src/jobs/runner';
import { MediaStore } from '../src/storage';
import { deferred, FakeMediaTool, FakeTranscriber, silentLogger } from './support/fakes';

describe('JobRunner', () => {
  let dataDir: string;
  let repo: Repository;
  let store: MediaStore;
  let media: FakeMediaTool;
  let transcriber: FakeTranscriber;
  let events: EventBus;
  let seen: ServerEvent[];
  let runner: JobRunner;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'homescribe-runner-'));
    repo = new Repository(openDatabase(':memory:'));
    store = new MediaStore(dataDir);
    media = new FakeMediaTool();
    transcriber = new FakeTranscriber();
    events = new EventBus();
    seen = [];
    events.subscribe((event) => seen.push(event));
    runner = new JobRunner({
      repo,
      store,
      media,
      transcriber,
      events,
      logger: silentLogger,
      progressIntervalMs: 0,
    });
  });

  afterEach(async () => {
    await runner.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function upload(): Promise<{ id: string; job: Job }> {
    const id = randomUUID();
    await store.ensureRecordingDir(id);
    await writeFile(store.originalPath(id, 'original.m4a'), 'media');
    const recording = repo.createRecording({
      id,
      title: 'Note',
      originalFilename: 'note.m4a',
      mediaType: 'audio/mp4',
      sizeBytes: 5,
      storedName: 'original.m4a',
    });
    return { id, job: recording.job };
  }

  const statuses = (jobId: string) =>
    seen
      .filter((e): e is Extract<ServerEvent, { event: 'job' }> => e.event === 'job')
      .filter((e) => e.data.id === jobId)
      .map((e) => e.data.status);

  it('converts, transcribes and stores the transcript', async () => {
    const { id, job } = await upload();
    runner.start();
    await runner.idle();

    expect(repo.getJob(job.id)).toMatchObject({ status: 'done', progress: null, error: null });
    expect(repo.getRecording(id)?.durationSeconds).toBe(42);
    expect(repo.getTranscript(id)).toMatchObject({
      model: 'fake-whisper',
      language: 'en',
      segments: [
        { index: 0, start: 0, end: 1.5, text: 'Hello there.' },
        { index: 1, start: 1.5, end: 3, text: 'Bye.' },
      ],
    });
    expect(media.converted[0]?.input).toBe(store.originalPath(id, 'original.m4a'));
    expect(new Set(statuses(job.id))).toEqual(new Set(['converting', 'transcribing', 'done']));
    expect(existsSync(store.workDir(id))).toBe(false);
  });

  it('publishes conversion progress', async () => {
    const { job } = await upload();
    runner.start();
    await runner.idle();
    const progress = seen
      .filter((e) => e.event === 'job' && e.data.id === job.id && e.data.status === 'converting')
      .map((e) => (e.data as Job).progress);
    expect(progress).toEqual([0, 0.5, 1]);
  });

  it('fails with MEDIA_UNREADABLE when ffmpeg cannot read the file', async () => {
    const { job, id } = await upload();
    media.failWith = 'moov atom not found';
    runner.start();
    await runner.idle();
    expect(repo.getJob(job.id)).toMatchObject({
      status: 'failed',
      error: { code: 'MEDIA_UNREADABLE' },
    });
    expect(repo.getTranscript(id)).toBeNull();
  });

  it.each(['STT_UNAVAILABLE', 'STT_TIMEOUT', 'STT_FAILED'] as const)(
    'fails with %s from the transcriber',
    async (code) => {
      const { job } = await upload();
      transcriber.failWith = code;
      runner.start();
      await runner.idle();
      expect(repo.getJob(job.id)?.error?.code).toBe(code);
    },
  );

  it('runs one job at a time in upload order', async () => {
    const gate = deferred();
    transcriber.gate = gate.promise;
    const first = await upload();
    const second = await upload();
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(repo.getJob(first.job.id)?.status).toBe('transcribing');
    expect(repo.getJob(second.job.id)?.status).toBe('queued');
    expect(transcriber.calls).toBe(1);

    gate.resolve();
    await runner.idle();
    expect(repo.getJob(second.job.id)?.status).toBe('done');
    expect(transcriber.calls).toBe(2);
  });

  it('picks up jobs queued while it is busy', async () => {
    runner.start();
    const { job } = await upload();
    runner.kick();
    await runner.idle();
    expect(repo.getJob(job.id)?.status).toBe('done');
  });

  it('marks jobs left running by a previous process as INTERRUPTED and runs queued ones', async () => {
    const stale = await upload();
    repo.updateJob(stale.job.id, { status: 'transcribing', started: true });
    const queued = await upload();

    runner.start();
    await runner.idle();

    expect(repo.getJob(stale.job.id)).toMatchObject({
      status: 'failed',
      error: { code: 'INTERRUPTED' },
    });
    expect(repo.getJob(queued.job.id)?.status).toBe('done');
  });

  it('fails a job with INTERNAL_ERROR instead of crashing the queue', async () => {
    const broken = await upload();
    media.probeDuration = () => Promise.reject(new Error('disk on fire'));
    const next = await upload();
    runner.start();
    await runner.idle();
    expect(repo.getJob(broken.job.id)?.error?.code).toBe('INTERNAL_ERROR');
    expect(repo.getJob(next.job.id)?.error?.code).toBe('INTERNAL_ERROR');
  });

  it('ends the running job as INTERRUPTED on stop', async () => {
    transcriber.gate = deferred().promise; // never released
    const { job } = await upload();
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runner.stop();
    expect(repo.getJob(job.id)?.error?.code).toBe('INTERRUPTED');
  });
});
