import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Recording } from '@homescribe/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { audioFile, createTestApp, multipart } from './support/app';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

const INDEX = '<!doctype html><html><head><base href="/" /></head><body>app</body></html>';

/** A test app with a minimal built UI in a temporary web dist directory. */
async function appWithWeb(env: Record<string, string> = {}) {
  const t = await createTestApp(env, async (dataDir) => {
    const web = path.join(dataDir, 'web');
    await mkdir(path.join(web, 'assets'), { recursive: true });
    await writeFile(path.join(web, 'index.html'), INDEX);
    await writeFile(path.join(web, 'assets', 'app-1234.js'), 'console.log(1)');
    return { WEB_DIST_DIR: web };
  });
  return t;
}

describe('BASE_PATH', () => {
  let t: TestApp;
  afterEach(async () => {
    await t.close();
  });

  it('serves the API, UI and assets under the base path only', async () => {
    t = await appWithWeb({ BASE_PATH: '/homescribe' });

    expect((await t.app.inject('/homescribe/api/v1/health')).statusCode).toBe(200);
    const rootApi = await t.app.inject('/api/v1/health');
    expect(rootApi.statusCode).toBe(404);

    const index = await t.app.inject('/homescribe/');
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.body).toContain('<base href="/homescribe/" />');
    expect(index.headers['cache-control']).toBe('no-cache');

    const deep = await t.app.inject('/homescribe/recordings/0b9f1a8e-3c6d-4f7a-8e2b-5d4c3b2a1f00');
    expect(deep.body).toContain('<base href="/homescribe/" />');

    const asset = await t.app.inject('/homescribe/assets/app-1234.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
  });

  it('redirects the root and the bare base path to the UI', async () => {
    t = await appWithWeb({ BASE_PATH: '/homescribe' });
    for (const url of ['/', '/homescribe']) {
      const res = await t.app.inject(url);
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location).toBe('/homescribe/');
    }
  });

  it('answers unknown API routes under the base path with JSON', async () => {
    t = await appWithWeb({ BASE_PATH: '/homescribe' });
    const res = await t.app.inject('/homescribe/api/v1/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('puts the base path into the upload Location header', async () => {
    t = await appWithWeb({ BASE_PATH: '/homescribe' });
    const { payload, headers } = await multipart([
      { name: 'file', value: audioFile(), filename: 'a.m4a' },
    ]);
    const res = await t.app.inject({
      method: 'POST',
      url: '/homescribe/api/v1/recordings',
      payload,
      headers,
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers.location).toBe(`/homescribe/api/v1/recordings/${res.json<Recording>().id}`);
    await t.runner.idle();
  });

  it('serves at the root with base href "/" when unset', async () => {
    t = await appWithWeb();
    const index = await t.app.inject('/');
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('<base href="/" />');
    expect((await t.app.inject('/settings')).body).toContain('<base href="/" />');
  });
});
