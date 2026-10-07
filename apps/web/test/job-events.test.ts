import type { Job, Recording } from '@homescribe/shared';
import { describe, expect, it } from 'vitest';
import { withJob } from '../src/api/job-events';

const job = (overrides: Partial<Job> = {}): Job => ({
  id: 'job-1',
  recordingId: 'rec-1',
  kind: 'process',
  status: 'queued',
  progress: null,
  error: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  ...overrides,
});

const recording: Recording = {
  id: 'rec-1',
  title: 'Note',
  originalFilename: 'note.m4a',
  mediaType: 'audio/mp4',
  sizeBytes: 1,
  durationSeconds: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  job: job(),
};

describe('withJob', () => {
  it('applies progress of the current job', () => {
    const next = withJob(recording, job({ status: 'converting', progress: 0.4 }));
    expect(next.job).toMatchObject({ status: 'converting', progress: 0.4 });
  });

  it('switches to a newer job (a retry)', () => {
    const retry = job({ id: 'job-2', createdAt: '2026-01-02T00:00:00.000Z' });
    expect(withJob(recording, retry).job.id).toBe('job-2');
  });

  it('ignores events for older jobs and other recordings', () => {
    const current = withJob(recording, job({ id: 'job-2', createdAt: '2026-01-02T00:00:00.000Z' }));
    expect(withJob(current, job({ status: 'failed' }))).toBe(current);
    expect(withJob(recording, job({ recordingId: 'rec-2' }))).toBe(recording);
  });
});
