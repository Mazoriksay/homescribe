import { readFile, stat, writeFile } from 'node:fs/promises';
import type { CookieStatus, Recording } from '@homescribe/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { youtubeCookies } from '../src/cookies/netscape';
import { createTestApp } from './support/app';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

const FILE = [
  '# Netscape HTTP Cookie File',
  '.youtube.com\tTRUE\t/\tTRUE\t1893456000\tPREF\tf6=40000000',
  '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1893456000\t__Secure-1PSID\tsecret-sid-value',
  '.google.com\tTRUE\t/\tTRUE\t1893456000\tSID\tgoogle-only',
  'broken line',
  '',
].join('\n');

describe('youtubeCookies', () => {
  it('keeps youtube.com lines, HttpOnly ones included, and drops the rest', () => {
    const { text, count } = youtubeCookies(FILE);
    expect(count).toBe(2);
    expect(text).toContain('__Secure-1PSID\tsecret-sid-value');
    expect(text).not.toContain('google-only');
    expect(text.startsWith('# Netscape HTTP Cookie File\n')).toBe(true);
  });

  it('refuses a file without youtube.com cookies', () => {
    expect(() => youtubeCookies('.google.com\tTRUE\t/\tTRUE\t0\tSID\tx')).toThrow(/youtube/);
  });
});

describe('YouTube cookies API', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  const status = async () => (await t.app.inject('/api/v1/cookies')).json<CookieStatus>();
  const pairing = async () =>
    (await t.app.inject({ method: 'POST', url: '/api/v1/cookies/pairing' })).json<{
      code: string;
      extensionId: string;
    }>();
  const pair = (code: string) =>
    t.app.inject({ method: 'POST', url: '/api/v1/cookies/pair', payload: { code } });
  const push = (token: string | null, body = FILE) =>
    t.app.inject({
      method: 'PUT',
      url: '/api/v1/cookies',
      headers: {
        'content-type': 'text/plain',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      payload: body,
    });

  it('pairs once with a code and then accepts cookies only with the token', async () => {
    expect(await status()).toEqual({
      status: 'none',
      source: null,
      updatedAt: null,
      checkedAt: null,
      paired: false,
    });
    const { code, extensionId } = await pairing();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(extensionId).toMatch(/^[a-p]{32}$/);

    const paired = await pair(code.toLowerCase().replace('-', ' '));
    expect(paired.statusCode).toBe(200);
    const { token } = paired.json<{ token: string }>();
    // A code works once.
    expect((await pair(code)).json().error.code).toBe('PAIRING_INVALID');

    expect((await push(null)).statusCode).toBe(401);
    expect((await push('not-the-token')).json().error.code).toBe('TOKEN_INVALID');
    const saved = await push(token);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ status: 'unchecked', source: 'extension', paired: true });

    // Only youtube.com reaches the file, readable by the server user only.
    const text = await readFile(t.config.ytdlp.cookiesFile, 'utf8');
    expect(text).not.toContain('google-only');
    expect((await stat(t.config.ytdlp.cookiesFile)).mode & 0o777).toBe(0o600);
  });

  it('never returns cookie values or the token', async () => {
    const { code } = await pairing();
    const { token } = (await pair(code)).json<{ token: string }>();
    await push(token);
    for (const url of ['/api/v1/cookies', '/api/v1/health']) {
      const body = (await t.app.inject(url)).body;
      expect(body).not.toContain('secret-sid-value');
      expect(body).not.toContain(token);
    }
  });

  it('voids a code after five wrong tries and an expired one', async () => {
    const { code } = await pairing();
    for (let i = 0; i < 5; i++) expect((await pair('AAAA-AAAA')).statusCode).toBe(400);
    expect((await pair(code)).statusCode).toBe(400);

    const fresh = await pairing();
    t.repo.updateCookieState({ pairingExpiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await pair(fresh.code)).statusCode).toBe(400);
  });

  it('takes a cookies.txt from the settings and refuses one without YouTube', async () => {
    const bad = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/cookies/file',
      headers: { 'content-type': 'text/plain' },
      payload: 'nothing here',
    });
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');

    const ok = await t.app.inject({
      method: 'PUT',
      url: '/api/v1/cookies/file',
      headers: { 'content-type': 'text/plain' },
      payload: FILE,
    });
    expect(ok.json()).toMatchObject({ status: 'unchecked', source: 'file', paired: false });

    const removed = await t.app.inject({ method: 'DELETE', url: '/api/v1/cookies' });
    expect(removed.json()).toMatchObject({ status: 'none', source: null });
    await expect(stat(t.config.ytdlp.cookiesFile)).rejects.toThrow();
  });

  it('retries links blocked for want of cookies once the cookies work', async () => {
    t.downloader.failWith = 'ERROR: [youtube] x: Sign in to confirm you are not a bot';
    t.downloader.blocked = true;
    const { id } = (
      await t.app.inject({
        method: 'POST',
        url: '/api/v1/recordings/from-url',
        payload: { url: 'https://www.youtube.com/watch?v=abc' },
      })
    ).json<Recording>();
    await t.runner.idle();
    expect(t.repo.activeJob(id)).toBeNull();

    t.downloader.failWith = null;
    await t.cookies.save(FILE, 'file');
    await t.cookies.check();
    expect(t.cookies.status().status).toBe('ok');
    await t.runner.idle();
    const after = (await t.app.inject(`/api/v1/recordings/${id}`)).json<Recording>();
    expect(after.job.status).toBe('done');
  });

  it('marks the cookies expired when a download says so', async () => {
    await t.cookies.save(FILE, 'file');
    t.downloader.failWith = 'ERROR: [youtube] x: Sign in to confirm you are not a bot';
    t.downloader.cookiesExpired = true;
    const { job } = (
      await t.app.inject({
        method: 'POST',
        url: '/api/v1/recordings/from-url',
        payload: { url: 'https://www.youtube.com/watch?v=abc' },
      })
    ).json<Recording>();
    await t.runner.idle();
    expect(t.repo.getJob(job.id)?.error?.code).toBe('DOWNLOAD_COOKIES_EXPIRED');
    expect(t.cookies.status().status).toBe('expired');
    expect((await t.app.inject('/api/v1/health')).json().cookies).toBe('expired');
  });

  it('keeps the verdict for the same cookies and checks changed ones again', async () => {
    await t.cookies.save(FILE, 'extension');
    await t.cookies.check();
    expect(t.cookies.status().status).toBe('ok');
    const checks = t.downloader.cookieChecks;

    // The 6-hourly resend of unchanged cookies: no new check, still working.
    await t.cookies.save(FILE, 'extension');
    expect(t.cookies.status().status).toBe('ok');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.downloader.cookieChecks).toBe(checks);

    // Changed cookies are unchecked until their own check.
    await t.cookies.save(`${FILE}.youtube.com\tTRUE\t/\tTRUE\t1893456000\tNEW\tx\n`, 'extension');
    expect(t.cookies.status().status).toBe('unchecked');
  });

  it('adopts a cookies.txt put into the data folder by hand', async () => {
    await writeFile(t.config.ytdlp.cookiesFile, FILE);
    await t.cookies.start();
    expect(t.cookies.status()).toMatchObject({ status: 'unchecked', source: 'file' });
  });

  it('serves the extension as a zip with the server version', async () => {
    const res = await t.app.inject('/api/v1/extension.zip');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.rawPayload.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(res.rawPayload.toString('latin1')).toContain('"version": "0.0.0"');
  });
});
