import type { Job, Recording, Transcript } from '@homescribe/shared';

export const RECORDING_ID = '0b9f1a8e-3c6d-4f7a-8e2b-5d4c3b2a1f00';

export function job(overrides: Partial<Job> = {}): Job {
  return {
    id: '6f1c2c43-6a5e-4a43-9a3c-1f0d2a9b8c11',
    recordingId: RECORDING_ID,
    kind: 'process',
    status: 'done',
    progress: null,
    error: null,
    createdAt: '2026-01-01T10:00:00.000Z',
    startedAt: '2026-01-01T10:00:01.000Z',
    finishedAt: '2026-01-01T10:05:00.000Z',
    ...overrides,
  };
}

export function recording(overrides: Partial<Recording> = {}): Recording {
  return {
    id: RECORDING_ID,
    title: 'Weekly planning',
    originalFilename: 'weekly-planning.m4a',
    mediaType: 'audio/mp4',
    sizeBytes: 12_345_678,
    durationSeconds: 3725,
    sourceUrl: null,
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T10:05:00.000Z',
    job: job(),
    ...overrides,
  };
}

export function transcript(overrides: Partial<Transcript> = {}): Transcript {
  return {
    recordingId: RECORDING_ID,
    language: 'en',
    model: 'whisper',
    text: 'Good morning. Let us start.',
    gaps: [],
    segments: [
      { index: 0, start: 0, end: 2, text: 'Good morning.' },
      { index: 1, start: 3725, end: 3727, text: 'Let us start.' },
    ],
    createdAt: '2026-01-01T10:05:00.000Z',
    ...overrides,
  };
}
