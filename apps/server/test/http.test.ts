import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Job, Recording, RecordingPage, Transcript } from '@homescribe/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { audioFile, createTestApp, multipart } from './support/app';
import { deferred } from './support/fakes';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

describe('HTTP API', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  async function upload(
    parts: Parameters<typeof multipart>[0] = [
      { name: 'file', value: audioFile(), filename: 'Team Sync.m4a' },
    ],
  ) {
    const { payload, headers } = await multipart(parts);
    return t.app.inject({ method: 'POST', url: '/api/v1/recordings', payload, headers });
  }

  it('reports health', async () => {
    const res = await t.app.inject('/api/v1/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      search: 'fts5',
      checks: { ffmpeg: 'ok', ytdlp: 'ok', stt: 'ok', llm: 'ok', embedding: 'same_origin' },
      checkedAt: expect.any(String),
      cookies: 'none',
    });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  describe('embedding', () => {
    it('allows framing only by the app itself by default', async () => {
      const res = await t.app.inject('/api/v1/health');
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    });

    it('allows framing by the configured origins', async () => {
      await t.close();
      t = await createTestApp({ FRAME_ANCESTORS: 'http://hub.lan:3000' });
      const res = await t.app.inject('/api/v1/health');
      expect(res.headers['content-security-policy']).toContain(
        "frame-ancestors 'self' http://hub.lan:3000",
      );
    });
  });

  describe('network allow-list', () => {
    it('refuses clients outside ALLOWED_NETWORKS with the error shape', async () => {
      const res = await t.app.inject({ url: '/api/v1/health', remoteAddress: '203.0.113.9' });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({
        error: { code: 'NETWORK_NOT_ALLOWED', message: expect.any(String) },
      });
    });

    it('ignores X-Forwarded-For', async () => {
      const res = await t.app.inject({
        url: '/api/v1/health',
        remoteAddress: '203.0.113.9',
        headers: { 'x-forwarded-for': '192.168.1.10' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('allows LAN clients', async () => {
      const res = await t.app.inject({ url: '/api/v1/health', remoteAddress: '192.168.1.10' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /api/v1/recordings', () => {
    it('stores the upload and queues a process job', async () => {
      const res = await upload();
      expect(res.statusCode).toBe(201);
      const recording = res.json<Recording>();
      expect(res.headers.location).toBe(`/api/v1/recordings/${recording.id}`);
      expect(recording).toMatchObject({
        title: 'Team Sync',
        originalFilename: 'Team Sync.m4a',
        mediaType: 'audio/mp4',
        sizeBytes: 16,
        job: { kind: 'process' },
      });
      const stored = await readFile(t.store.originalPath(recording.id, 'original.m4a'));
      expect(stored.length).toBe(16);

      await t.runner.idle();
      const after = await t.app.inject(`/api/v1/recordings/${recording.id}`);
      expect(after.json<Recording>().job.status).toBe('done');
      expect(after.json<Recording>().durationSeconds).toBe(42);
    });

    it('uses the title field when it comes before the file', async () => {
      const res = await upload([
        { name: 'title', value: '  Groceries  ' },
        { name: 'file', value: audioFile(), filename: 'rec.webm' },
      ]);
      expect(res.json<Recording>().title).toBe('Groceries');
    });

    it('rejects a request without a file', async () => {
      const res = await upload([{ name: 'title', value: 'x' }]);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('FILE_REQUIRED');
    });

    it('rejects an empty file and leaves nothing behind', async () => {
      const res = await upload([{ name: 'file', value: audioFile(0), filename: 'empty.wav' }]);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('FILE_REQUIRED');
      expect(t.repo.listRecordings({ page: 1, pageSize: 10 }).pagination.totalItems).toBe(0);
    });

    it('rejects a non-multipart request', async () => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/recordings',
        payload: { file: 'x' },
      });
      expect(res.statusCode).toBe(415);
      expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('rejects files that are not audio or video', async () => {
      const res = await upload([
        { name: 'file', value: audioFile(8, 'text/html'), filename: 'evil.html' },
      ]);
      expect(res.statusCode).toBe(415);
      expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(t.repo.listRecordings({ page: 1, pageSize: 10 }).pagination.totalItems).toBe(0);
    });

    it('rejects files over MAX_UPLOAD_MB and leaves nothing behind', async () => {
      await t.close();
      t = await createTestApp({ MAX_UPLOAD_MB: '0.0001' }); // ~104 bytes
      const res = await upload([{ name: 'file', value: audioFile(4096), filename: 'big.wav' }]);
      expect(res.statusCode).toBe(413);
      expect(res.json().error.code).toBe('FILE_TOO_LARGE');
      expect(t.repo.listRecordings({ page: 1, pageSize: 10 }).pagination.totalItems).toBe(0);
    });

    it('never uses the client file name as a path', async () => {
      const res = await upload([
        { name: 'file', value: audioFile(), filename: '../../../etc/cron.d/x' },
      ]);
      expect(res.statusCode).toBe(201);
      const recording = res.json<Recording>();
      expect(existsSync(t.store.originalPath(recording.id, 'original.bin'))).toBe(true);
    });
  });

  describe('GET /api/v1/recordings', () => {
    it('lists newest first with pagination', async () => {
      for (let i = 0; i < 3; i++) await upload();
      const res = await t.app.inject('/api/v1/recordings?page=1&pageSize=2');
      expect(res.statusCode).toBe(200);
      const page = res.json<RecordingPage>();
      expect(page.data).toHaveLength(2);
      expect(page.pagination).toEqual({ page: 1, pageSize: 2, totalItems: 3, totalPages: 2 });
    });

    it('validates the query', async () => {
      const res = await t.app.inject('/api/v1/recordings?pageSize=1000');
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: expect.anything(),
      });
    });
  });

  describe('single recording', () => {
    it('returns 404 with the error shape for unknown or malformed ids', async () => {
      const unknown = await t.app.inject('/api/v1/recordings/0b9f1a8e-3c6d-4f7a-8e2b-5d4c3b2a1f00');
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error.code).toBe('NOT_FOUND');
      const malformed = await t.app.inject('/api/v1/recordings/..%2F..%2Fetc');
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('serves the transcript once the job is done', async () => {
      t.transcriber.gate = deferred().promise;
      const { id } = (await upload()).json<Recording>();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const early = await t.app.inject(`/api/v1/recordings/${id}/transcript`);
      expect(early.statusCode).toBe(409);
      expect(early.json().error.code).toBe('TRANSCRIPT_NOT_READY');

      t.transcriber.gate = null;
      await t.runner.stop(); // interrupt the held job
      t.repo.saveTranscript(id, {
        language: 'en',
        model: 'm',
        text: 'Hi',
        segments: [{ start: 0, end: 1, text: 'Hi' }],
      });
      const ready = await t.app.inject(`/api/v1/recordings/${id}/transcript`);
      expect(ready.statusCode).toBe(200);
      expect(ready.json<Transcript>().segments).toEqual([
        { index: 0, start: 0, end: 1, text: 'Hi' },
      ]);
    });

    it('exports the transcript as subtitles, text and Markdown', async () => {
      const { id } = (await upload()).json<Recording>();
      await t.runner.idle();
      expect((await t.app.inject(`/api/v1/recordings/${id}/export?format=srt`)).statusCode).toBe(
        200,
      );
      t.repo.renameRecording(id, 'Встреча: план/бюджет');
      t.repo.saveTranscript(id, {
        language: 'ru',
        model: 'm',
        text: 'Привет. Начнём.',
        segments: [
          { start: 0, end: 1.5, text: 'Привет.' },
          { start: 62.25, end: 64, text: 'Начнём.' },
        ],
      });
      t.repo.saveSummary(id, { summary: 'Коротко.', actionItems: ['Позвонить'], model: 'm' });

      const srt = await t.app.inject(`/api/v1/recordings/${id}/export?format=srt`);
      expect(srt.statusCode).toBe(200);
      expect(srt.headers['content-type']).toBe('application/x-subrip; charset=utf-8');
      expect(srt.headers['content-disposition']).toBe(
        `attachment; filename="_______ ____ ______.srt"; filename*=UTF-8''${encodeURIComponent('Встреча план бюджет.srt')}`,
      );
      expect(srt.body).toBe(
        '1\n00:00:00,000 --> 00:00:01,500\nПривет.\n\n2\n00:01:02,250 --> 00:01:04,000\nНачнём.\n',
      );

      const vtt = await t.app.inject(`/api/v1/recordings/${id}/export?format=vtt`);
      expect(vtt.headers['content-type']).toBe('text/vtt; charset=utf-8');
      expect(vtt.body.startsWith('WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nПривет.\n')).toBe(true);

      const md = await t.app.inject(`/api/v1/recordings/${id}/export?format=md&lang=ru`);
      expect(md.headers['content-type']).toBe('text/markdown; charset=utf-8');
      expect(md.body).toContain('# Встреча: план/бюджет');
      expect(md.body).toContain('## Итоги\n\nКоротко.');
      expect(md.body).toContain('## Задачи\n\n- [ ] Позвонить');
      expect(md.body).toContain('**1:02** Начнём.');

      const txt = await t.app.inject(`/api/v1/recordings/${id}/export?format=txt`);
      expect(txt.body).toBe('Привет.\nНачнём.\n');

      const bad = await t.app.inject(`/api/v1/recordings/${id}/export?format=docx`);
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('refuses to export before there is a transcript', async () => {
      t.transcriber.gate = deferred().promise;
      const { id } = (await upload()).json<Recording>();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const res = await t.app.inject(`/api/v1/recordings/${id}/export?format=srt`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('TRANSCRIPT_NOT_READY');
      t.transcriber.gate = null;
      await t.runner.stop();
    });

    it('deletes a recording and its files', async () => {
      const { id } = (await upload()).json<Recording>();
      await t.runner.idle();
      const res = await t.app.inject({ method: 'DELETE', url: `/api/v1/recordings/${id}` });
      expect(res.statusCode).toBe(204);
      expect(existsSync(t.store.recordingDir(id))).toBe(false);
      expect((await t.app.inject(`/api/v1/recordings/${id}`)).statusCode).toBe(404);
    });

    it('refuses to delete while its job is running', async () => {
      t.transcriber.gate = deferred().promise;
      const { id } = (await upload()).json<Recording>();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const res = await t.app.inject({ method: 'DELETE', url: `/api/v1/recordings/${id}` });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('JOB_ACTIVE');
    });

    it('drops a queued job when its recording is deleted', async () => {
      const gate = deferred();
      t.transcriber.gate = gate.promise;
      await upload();
      const queued = (await upload()).json<Recording>();
      const res = await t.app.inject({ method: 'DELETE', url: `/api/v1/recordings/${queued.id}` });
      expect(res.statusCode).toBe(204);
      expect(t.repo.getJob(queued.job.id)).toBeNull();
      gate.resolve();
      await t.runner.idle();
    });
  });

  describe('jobs', () => {
    it('retries a failed recording', async () => {
      t.transcriber.failWith = 'STT_UNAVAILABLE';
      const { id, job } = (await upload()).json<Recording>();
      await t.runner.idle();
      expect(t.repo.getJob(job.id)?.status).toBe('failed');

      t.transcriber.failWith = null;
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/v1/recordings/${id}/jobs`,
        payload: { kind: 'process' },
      });
      expect(res.statusCode).toBe(202);
      const retry = res.json<Job>();
      expect(retry).toMatchObject({ recordingId: id, kind: 'process', status: 'queued' });
      await t.runner.idle();
      const fetched = await t.app.inject(`/api/v1/jobs/${retry.id}`);
      expect(fetched.json<Job>().status).toBe('done');
    });

    it('refuses a second job while one is active', async () => {
      t.transcriber.gate = deferred().promise;
      const { id } = (await upload()).json<Recording>();
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/v1/recordings/${id}/jobs`,
        payload: { kind: 'process' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('JOB_ACTIVE');
    });

    it('validates the job body', async () => {
      const { id } = (await upload()).json<Recording>();
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/v1/recordings/${id}/jobs`,
        payload: { kind: 'launch-rockets' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('cancels a running job, after which it can be retried', async () => {
      t.transcriber.gate = deferred().promise;
      const { id, job } = (await upload()).json<Recording>();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const res = await t.app.inject({ method: 'POST', url: `/api/v1/jobs/${job.id}/cancel` });
      expect(res.statusCode).toBe(200);
      t.transcriber.gate = null;
      await t.runner.idle();
      expect(t.repo.getJob(job.id)?.error?.code).toBe('CANCELLED');

      const again = await t.app.inject({ method: 'POST', url: `/api/v1/jobs/${job.id}/cancel` });
      expect(again.json<Job>().status).toBe('failed');
      const retry = await t.app.inject({
        method: 'POST',
        url: `/api/v1/recordings/${id}/jobs`,
        payload: { kind: 'process' },
      });
      expect(retry.statusCode).toBe(202);
    });

    it('does not unload models while a job is running', async () => {
      t.transcriber.gate = deferred().promise;
      await upload();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const res = await t.app.inject({ method: 'POST', url: '/api/v1/ai/unload' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('JOB_ACTIVE');
      t.transcriber.gate = null;
    });

    it('keeps the own summary instructions of the user', async () => {
      expect((await t.app.inject('/api/v1/settings/summary')).json()).toEqual({ instructions: '' });
      const tooLong = await t.app.inject({
        method: 'PUT',
        url: '/api/v1/settings/summary',
        payload: { instructions: 'x'.repeat(2001) },
      });
      expect(tooLong.statusCode).toBe(400);
      const res = await t.app.inject({
        method: 'PUT',
        url: '/api/v1/settings/summary',
        payload: { instructions: '  More detail, please.  ' },
      });
      expect(res.json()).toEqual({ instructions: 'More detail, please.' });
      expect((await t.app.inject('/api/v1/settings/summary')).json()).toEqual({
        instructions: 'More detail, please.',
      });
    });

    it('stores the take-turns switch over the environment default', async () => {
      const bad = await t.app.inject({
        method: 'PUT',
        url: '/api/v1/ai/take-turns',
        payload: { enabled: 'yes' },
      });
      expect(bad.statusCode).toBe(400);
      const res = await t.app.inject({
        method: 'PUT',
        url: '/api/v1/ai/take-turns',
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ takeTurns: true, sttIdleSeconds: 10 });
      expect(t.repo.getAppSetting('take_turns')).toBe(true);
    });

    it('returns 404 for an unknown job', async () => {
      const res = await t.app.inject('/api/v1/jobs/0b9f1a8e-3c6d-4f7a-8e2b-5d4c3b2a1f00');
      expect(res.statusCode).toBe(404);
      const cancel = await t.app.inject({
        method: 'POST',
        url: '/api/v1/jobs/0b9f1a8e-3c6d-4f7a-8e2b-5d4c3b2a1f00/cancel',
      });
      expect(cancel.statusCode).toBe(404);
    });
  });

  it('answers unknown API routes with the error shape', async () => {
    const res = await t.app.inject('/api/v1/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('answers malformed JSON with VALIDATION_ERROR', async () => {
    const { id } = (await upload()).json<Recording>();
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/v1/recordings/${id}/jobs`,
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('streams job events over SSE', async () => {
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = t.app.server.address() as AddressInfo;
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/events`, {
      signal: controller.signal,
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();

    await upload();
    let text = '';
    while (!text.includes('"status":"done"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += value;
    }
    controller.abort();
    expect(text).toContain('event: job\ndata: {');
    expect(text).toContain('"status":"queued"');
    expect(text).toContain('"status":"done"');
  });
});
