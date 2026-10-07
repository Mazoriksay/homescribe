import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database';
import { Repository, type NewRecording } from '../src/db/repository';

function newRecording(overrides: Partial<NewRecording> = {}): NewRecording {
  return {
    id: randomUUID(),
    title: 'Standup',
    originalFilename: 'standup.m4a',
    mediaType: 'audio/mp4',
    sizeBytes: 1000,
    storedName: 'original.m4a',
    ...overrides,
  };
}

describe('Repository', () => {
  let clock: number;
  let repo: Repository;

  beforeEach(() => {
    clock = Date.parse('2026-01-01T00:00:00.000Z');
    repo = new Repository(openDatabase(':memory:'), () => new Date((clock += 1000)));
  });

  it('creates a recording together with a queued process job', () => {
    const recording = repo.createRecording(newRecording());
    expect(recording.job).toMatchObject({
      recordingId: recording.id,
      kind: 'process',
      status: 'queued',
      progress: null,
      error: null,
      startedAt: null,
    });
    expect(repo.getRecording(recording.id)).toEqual(recording);
  });

  it('lists recordings newest first with pagination', () => {
    const ids = [1, 2, 3].map(() => repo.createRecording(newRecording()).id);
    const page1 = repo.listRecordings({ page: 1, pageSize: 2 });
    expect(page1.data.map((r) => r.id)).toEqual([ids[2], ids[1]]);
    expect(page1.pagination).toEqual({ page: 1, pageSize: 2, totalItems: 3, totalPages: 2 });
    const page2 = repo.listRecordings({ page: 2, pageSize: 2 });
    expect(page2.data.map((r) => r.id)).toEqual([ids[0]]);
  });

  it('exposes the latest job of a recording', () => {
    const recording = repo.createRecording(newRecording());
    repo.updateJob(recording.job.id, { status: 'failed', error: { code: 'X', message: 'boom' } });
    const retry = repo.createJob(recording.id, 'process');
    expect(repo.getRecording(recording.id)?.job.id).toBe(retry.id);
  });

  it('updates job status, progress and timestamps', () => {
    const { job } = repo.createRecording(newRecording());
    const started = repo.updateJob(job.id, { status: 'converting', progress: 0.5, started: true });
    expect(started.status).toBe('converting');
    expect(started.progress).toBe(0.5);
    expect(started.startedAt).not.toBeNull();
    const done = repo.updateJob(job.id, { status: 'done', progress: null, finished: true });
    expect(done.finishedAt).not.toBeNull();
  });

  it('returns queued jobs in FIFO order', () => {
    const a = repo.createRecording(newRecording());
    const b = repo.createRecording(newRecording());
    expect(repo.nextQueuedJob()?.id).toBe(a.job.id);
    repo.updateJob(a.job.id, { status: 'done', finished: true });
    expect(repo.nextQueuedJob()?.id).toBe(b.job.id);
  });

  it('marks running jobs as interrupted and leaves queued ones alone', () => {
    const running = repo.createRecording(newRecording());
    const queued = repo.createRecording(newRecording());
    repo.updateJob(running.job.id, { status: 'transcribing', started: true });

    const interrupted = repo.failRunningJobs('INTERRUPTED', 'Server restarted');
    expect(interrupted.map((j) => j.id)).toEqual([running.job.id]);
    expect(repo.getJob(running.job.id)).toMatchObject({
      status: 'failed',
      error: { code: 'INTERRUPTED', message: 'Server restarted' },
    });
    expect(repo.getJob(queued.job.id)?.status).toBe('queued');
  });

  it('stores and replaces a transcript with its segments atomically', () => {
    const recording = repo.createRecording(newRecording());
    expect(repo.getTranscript(recording.id)).toBeNull();

    repo.saveTranscript(recording.id, {
      language: 'en',
      model: 'whisper',
      text: 'Hello there. Bye.',
      segments: [
        { start: 0, end: 1.5, text: 'Hello there.' },
        { start: 1.5, end: 2, text: 'Bye.' },
      ],
    });
    const first = repo.getTranscript(recording.id);
    expect(first?.segments).toEqual([
      { index: 0, start: 0, end: 1.5, text: 'Hello there.' },
      { index: 1, start: 1.5, end: 2, text: 'Bye.' },
    ]);

    repo.saveTranscript(recording.id, { language: null, model: 'w2', text: 'Hi', segments: [] });
    expect(repo.getTranscript(recording.id)).toMatchObject({ model: 'w2', segments: [] });
  });

  it('deletes a recording with its jobs and transcript', () => {
    const recording = repo.createRecording(newRecording());
    repo.saveTranscript(recording.id, { language: 'en', model: 'm', text: 't', segments: [] });
    expect(repo.deleteRecording(recording.id)).toBe(true);
    expect(repo.getRecording(recording.id)).toBeNull();
    expect(repo.getJob(recording.job.id)).toBeNull();
    expect(repo.getTranscript(recording.id)).toBeNull();
    expect(repo.deleteRecording(recording.id)).toBe(false);
  });

  it('records the media duration', () => {
    const recording = repo.createRecording(newRecording());
    repo.setDuration(recording.id, 12.5);
    expect(repo.getRecording(recording.id)?.durationSeconds).toBe(12.5);
  });
});
