import { existsSync } from 'node:fs';
import type { Job, Recording } from '@homescribe/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './support/app';
import { deferred } from './support/fakes';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

describe('transcribing a link', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  const fromUrl = (payload: object) =>
    t.app.inject({ method: 'POST', url: '/api/v1/recordings/from-url', payload });

  it('downloads, then converts, transcribes and summarizes', async () => {
    const res = await fromUrl({ url: 'https://www.youtube.com/watch?v=abc' });
    expect(res.statusCode).toBe(201);
    const created = res.json<Recording>();
    expect(created).toMatchObject({
      title: 'youtube.com/watch',
      sourceUrl: 'https://www.youtube.com/watch?v=abc',
      sizeBytes: 0,
      job: { status: 'queued' },
    });
    expect(res.headers.location).toBe(`/api/v1/recordings/${created.id}`);

    const statuses: string[] = [];
    t.events.subscribe((e) => {
      if (e.event === 'job' && e.data.recordingId === created.id) statuses.push(e.data.status);
    });
    await t.runner.idle();

    const done = (await t.app.inject(`/api/v1/recordings/${created.id}`)).json<Recording>();
    expect(done).toMatchObject({
      title: 'Talk: Building a Home Server',
      mediaType: 'audio/webm',
      sizeBytes: 16,
      durationSeconds: 42,
      job: { status: 'done' },
    });
    expect([...new Set(statuses)]).toEqual([
      'downloading',
      'converting',
      'transcribing',
      'summarizing',
      'done',
    ]);
    expect(t.downloader.urls).toEqual(['https://www.youtube.com/watch?v=abc']);
    expect(existsSync(t.store.originalPath(created.id, 'original.webm'))).toBe(true);
    expect((await t.app.inject(`/api/v1/recordings/${created.id}/transcript`)).statusCode).toBe(
      200,
    );
  });

  it('keeps a title the user gave', async () => {
    const res = await fromUrl({ url: 'https://media.example.com/ep1.mp3', title: 'Episode 1' });
    await t.runner.idle();
    const done = (
      await t.app.inject(`/api/v1/recordings/${res.json<Recording>().id}`)
    ).json<Recording>();
    expect(done.title).toBe('Episode 1');
  });

  it('fails as DOWNLOAD_FAILED and downloads again on retry', async () => {
    t.downloader.failWith = 'ERROR: [youtube] abc: Video unavailable';
    const { id, job } = (
      await fromUrl({ url: 'https://www.youtube.com/watch?v=abc' })
    ).json<Recording>();
    await t.runner.idle();
    expect(t.repo.getJob(job.id)).toMatchObject({
      status: 'failed',
      error: {
        code: 'DOWNLOAD_FAILED',
        message: 'Cannot download the link: ERROR: [youtube] abc: Video unavailable',
      },
    });

    t.downloader.failWith = null;
    const retry = await t.app.inject({
      method: 'POST',
      url: `/api/v1/recordings/${id}/jobs`,
      payload: { kind: 'process' },
    });
    await t.runner.idle();
    expect(t.repo.getJob(retry.json<Job>().id)?.status).toBe('done');
    expect(t.downloader.urls).toHaveLength(2);
  });

  it('fails as DOWNLOAD_BLOCKED when the site asks to sign in', async () => {
    t.downloader.failWith = 'ERROR: [youtube] abc: Sign in to confirm you are not a bot';
    t.downloader.blocked = true;
    const { job } = (
      await fromUrl({ url: 'https://www.youtube.com/watch?v=abc' })
    ).json<Recording>();
    await t.runner.idle();
    expect(t.repo.getJob(job.id)?.error?.code).toBe('DOWNLOAD_BLOCKED');
  });

  it('does not download again when the media is already stored', async () => {
    const { id } = (
      await fromUrl({ url: 'https://www.youtube.com/watch?v=abc' })
    ).json<Recording>();
    await t.runner.idle();
    await t.app.inject({
      method: 'POST',
      url: `/api/v1/recordings/${id}/jobs`,
      payload: { kind: 'process' },
    });
    await t.runner.idle();
    expect(t.downloader.urls).toHaveLength(1);
  });

  it('refuses to delete while downloading', async () => {
    t.downloader.gate = deferred().promise;
    const { id } = (
      await fromUrl({ url: 'https://www.youtube.com/watch?v=abc' })
    ).json<Recording>();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const res = await t.app.inject({ method: 'DELETE', url: `/api/v1/recordings/${id}` });
    expect(res.statusCode).toBe(409);
  });

  it('rejects links to this server or the local network', async () => {
    for (const url of [
      'http://localhost:8080/api/v1/health',
      'http://127.0.0.1/x.mp3',
      'http://[::1]/x',
      'http://nas.lan/video.mp4',
      'http://does-not-resolve.example/x',
    ]) {
      const res = await fromUrl({ url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error.code, url).toBe('URL_NOT_ALLOWED');
    }
    expect(t.repo.listRecordings({ page: 1, pageSize: 10 }).pagination.totalItems).toBe(0);
  });

  it('allows the local network when URL_IMPORT_ALLOW_PRIVATE is set', async () => {
    await t.close();
    t = await createTestApp({ URL_IMPORT_ALLOW_PRIVATE: 'true' });
    expect((await fromUrl({ url: 'http://nas.lan/video.mp4' })).statusCode).toBe(201);
    await t.runner.idle();
  });

  it('validates the link', async () => {
    for (const url of [
      'ftp://www.youtube.com/x',
      'not a url',
      'https://user:pw@media.example.com/a',
    ]) {
      const res = await fromUrl({ url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error.code, url).toBe('VALIDATION_ERROR');
    }
    const long = await fromUrl({ url: `https://media.example.com/${'a'.repeat(2000)}` });
    expect(long.statusCode).toBe(400);
  });
});
