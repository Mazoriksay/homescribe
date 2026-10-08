import { readFile } from 'node:fs/promises';
import { runInThisContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { youtubeCookies } from '../src/cookies/netscape';

interface Hs {
  normalizeServer(input: string): string;
  looksLocal(server: string): boolean;
  pair(server: string, code: string): Promise<void>;
  load(): Promise<Record<string, unknown>>;
}

/** Loads apps/extension/common.js against a fake browser API. */
async function loadExtension(cookies: object[]) {
  const stored: Record<string, unknown> = {};
  const sent: { url: string; init: RequestInit }[] = [];
  Object.assign(globalThis, {
    chrome: {
      i18n: { getMessage: () => '', getUILanguage: () => 'en' },
      cookies: { getAll: async () => cookies },
      storage: {
        local: {
          get: async () => ({ ...stored }),
          set: async (values: object) => Object.assign(stored, values),
        },
      },
    },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    const body = url.endsWith('/pair') ? { token: 'tok' } : { status: 'unchecked' };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  // A plain script that sets globalThis.HS, run fresh each time like a page load.
  runInThisContext(await readFile(new URL('../../extension/common.js', import.meta.url), 'utf8'));
  const hs = (globalThis as unknown as { HS: Hs }).HS;
  return { hs, sent, stored, restore: () => (globalThis.fetch = realFetch) };
}

describe('browser extension', () => {
  it('sends youtube.com cookies in a Netscape file the server accepts', async () => {
    const { hs, sent, stored, restore } = await loadExtension([
      {
        domain: '.youtube.com',
        hostOnly: false,
        path: '/',
        secure: true,
        httpOnly: true,
        session: false,
        expirationDate: 1893456000.5,
        name: '__Secure-1PSID',
        value: 'sid',
      },
      {
        domain: 'www.youtube.com',
        hostOnly: true,
        path: '/',
        secure: false,
        httpOnly: false,
        session: true,
        name: 'VISITOR',
        value: 'v',
      },
    ]);
    try {
      await hs.pair('http://hub.lan:8080/homescribe', 'ABCD-EFGH');
      expect(stored).toMatchObject({ server: 'http://hub.lan:8080/homescribe', token: 'tok' });
      const put = sent.find((s) => s.init.method === 'PUT')!;
      expect(put.url).toBe('http://hub.lan:8080/homescribe/api/v1/cookies');
      expect((put.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
      const body = String(put.init.body);
      expect(body).toContain(
        '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1893456000\t__Secure-1PSID\tsid',
      );
      expect(body).toContain('www.youtube.com\tFALSE\t/\tFALSE\t0\tVISITOR\tv');
      expect(youtubeCookies(body).count).toBe(2);
    } finally {
      restore();
    }
  });

  it('warns about pairing with an address outside the local network', async () => {
    const { hs, restore } = await loadExtension([]);
    restore();
    expect(hs.looksLocal(hs.normalizeServer('192.168.1.5:8080'))).toBe(true);
    expect(hs.looksLocal(hs.normalizeServer('https://evil.example.com'))).toBe(false);
  });
});
