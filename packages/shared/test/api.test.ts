import { describe, expect, it } from 'vitest';
import {
  apiErrorSchema,
  createFromUrlBodySchema,
  jobSchema,
  listRecordingsQuerySchema,
  recordingSchema,
  sttVerboseResponseSchema,
} from '../src/api';

const job = {
  id: '6f1c2c43-6a5e-4a43-9a3c-1f0d2a9b8c11',
  recordingId: '0b9f1a8e-3c6d-4f7a-8e2b-5d4c3b2a1f00',
  kind: 'process',
  status: 'queued',
  progress: null,
  error: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
};

describe('api schemas', () => {
  it('accepts a recording with its latest job', () => {
    const parsed = recordingSchema.parse({
      id: job.recordingId,
      title: 'Meeting',
      originalFilename: 'meeting.m4a',
      mediaType: 'audio/mp4',
      sizeBytes: 1234,
      durationSeconds: null,
      sourceUrl: null,
      createdAt: job.createdAt,
      updatedAt: job.createdAt,
      job,
    });
    expect(parsed.job.status).toBe('queued');
  });

  it('rejects an unknown job status', () => {
    expect(jobSchema.safeParse({ ...job, status: 'paused' }).success).toBe(false);
  });

  it('applies list query defaults and coerces strings', () => {
    expect(listRecordingsQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(listRecordingsQuerySchema.parse({ page: '3', pageSize: '50' })).toEqual({
      page: 3,
      pageSize: 50,
    });
    expect(listRecordingsQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
  });

  it('describes the error envelope', () => {
    expect(
      apiErrorSchema.parse({ error: { code: 'NOT_FOUND', message: 'Recording not found' } }),
    ).toBeTruthy();
  });

  it('keeps only the STT fields the server relies on', () => {
    const parsed = sttVerboseResponseSchema.parse({
      text: ' Hello world',
      language: 'en',
      duration: 2.5,
      segments: [
        {
          id: 0,
          seek: 0,
          start: 0,
          end: 2.5,
          text: ' Hello world',
          tokens: [1, 2],
          temperature: 0,
          avg_logprob: -0.2,
          compression_ratio: 1.1,
          no_speech_prob: 0.01,
        },
      ],
    });
    expect(parsed.segments).toEqual([{ start: 0, end: 2.5, text: ' Hello world' }]);
  });

  it('tolerates a verbose STT response without segments', () => {
    const parsed = sttVerboseResponseSchema.parse({ text: '', language: 'en', duration: 0 });
    expect(parsed.segments).toEqual([]);
  });

  it('accepts http(s) links for import and rejects others', () => {
    expect(createFromUrlBodySchema.parse({ url: 'https://youtu.be/abc' })).toEqual({
      url: 'https://youtu.be/abc',
    });
    for (const url of ['ftp://x.org/a', 'javascript:alert(1)', 'nope', 'https://u:p@x.org/']) {
      expect(createFromUrlBodySchema.safeParse({ url }).success, url).toBe(false);
    }
  });
});
