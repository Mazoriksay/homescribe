import { afterEach, describe, expect, it } from 'vitest';
import { AiMemoryService } from '../src/ai/memory';
import type { AiSettingsService, EffectiveAiSettings } from '../src/ai/settings';
import { startFakeOpenAi } from './support/fake-openai';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** A speaches stand-in following routers/misc.py: GET/DELETE /api/ps. */
async function fakeSpeaches(loaded: string[]) {
  const fake = await startFakeOpenAi((req, res) => {
    if (req.method === 'GET' && req.url === '/api/ps') {
      return res.end(JSON.stringify({ models: loaded }));
    }
    if (req.method === 'DELETE' && req.url.startsWith('/api/ps/')) {
      const id = decodeURIComponent(req.url.slice('/api/ps/'.length));
      const at = loaded.indexOf(id);
      if (at === -1) return res.writeHead(404).end('Model not found');
      loaded.splice(at, 1);
      return res.writeHead(204).end();
    }
    res.writeHead(404).end();
  });
  closers.push(fake.close);
  return fake;
}

/** An Ollama stand-in following docs/api.md: GET /api/ps, generate with keep_alive 0. */
async function fakeOllama(loaded: { name: string; size_vram: number }[]) {
  const fake = await startFakeOpenAi((req, res) => {
    if (req.method === 'GET' && req.url === '/api/ps') {
      return res.end(JSON.stringify({ models: loaded }));
    }
    if (req.method === 'GET' && req.url === '/api/version') {
      return res.end(JSON.stringify({ version: '0.12.0' }));
    }
    const body = req.json as { model?: string; keep_alive?: number } | null;
    if (req.method === 'POST' && req.url === '/api/generate' && body?.keep_alive === 0) {
      loaded.splice(
        loaded.findIndex((m) => m.name === body.model),
        1,
      );
      return res.end(JSON.stringify({ model: body.model, done: true, done_reason: 'unload' }));
    }
    res.writeHead(404).end();
  });
  closers.push(fake.close);
  return fake;
}

/** In-memory app_settings and fast waits. */
function options(takeTurns = false) {
  const stored = new Map<string, unknown>();
  return {
    repo: {
      getAppSetting: <T>(key: string) => (stored.has(key) ? (stored.get(key) as T) : null),
      setAppSetting: (key: string, value: unknown) => void stored.set(key, value),
    },
    gpu: { takeTurns, sttIdleSeconds: 30 },
    pollMs: 10,
    fallbackWaitMs: 10,
  };
}

function settings(stt: Partial<EffectiveAiSettings>, llm: Partial<EffectiveAiSettings>) {
  const base = { mode: 'local', provider: null, model: 'm', apiKey: null, source: 'env' } as const;
  return {
    effective: (kind: 'stt' | 'llm') => ({ ...base, ...(kind === 'stt' ? stt : llm) }),
  } as unknown as AiSettingsService;
}

describe('AiMemoryService', () => {
  it('tells speaches from Ollama and unloads only Ollama', async () => {
    const speaches = await fakeSpeaches(['Systran/faster-whisper-large-v3']);
    const ollama = await fakeOllama([{ name: 'qwen2.5:7b', size_vram: 5_000_000_000 }]);
    const memory = new AiMemoryService(
      settings({ baseUrl: speaches.baseUrl }, { baseUrl: ollama.baseUrl }),
      () => false,
      options(),
    );

    expect(await memory.status()).toEqual({
      busy: false,
      takeTurns: false,
      sttIdleSeconds: 30,
      stt: {
        state: 'auto',
        server: 'speaches',
        loaded: [{ model: 'Systran/faster-whisper-large-v3', vramBytes: null }],
      },
      llm: {
        state: 'ok',
        server: 'ollama',
        loaded: [{ model: 'qwen2.5:7b', vramBytes: 5_000_000_000, sizeBytes: null }],
      },
    });

    const { memory: after, failed } = await memory.unload();
    expect(failed).toEqual([]);
    // Nothing loaded is still Ollama, not speaches (both answer { models: [] }).
    expect(after.llm).toEqual({ state: 'ok', server: 'ollama', loaded: [] });
    // speaches 0.8.1 stops working after DELETE /api/ps; it unloads by itself.
    expect(after.stt.loaded).toHaveLength(1);
    expect(speaches.received.some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('says when a server cannot unload, is a cloud API, is off or does not answer', async () => {
    const lmStudio = await startFakeOpenAi((_, res) => res.writeHead(404).end());
    closers.push(lmStudio.close);
    const memory = new AiMemoryService(
      settings({ baseUrl: lmStudio.baseUrl }, { mode: 'api', baseUrl: 'https://api.example.com' }),
      () => true,
      options(),
    );
    expect(await memory.status()).toMatchObject({
      busy: true,
      stt: { state: 'unsupported', loaded: [] },
      llm: { state: 'remote', loaded: [] },
    });

    const offline = new AiMemoryService(
      settings({ baseUrl: 'http://127.0.0.1:9' }, { mode: 'off', baseUrl: 'http://x' }),
      () => false,
      options(),
    );
    expect(await offline.status()).toMatchObject({
      stt: { state: 'unreachable' },
      llm: { state: 'off' },
    });
  });

  it('reports a model the server refused to unload', async () => {
    const busy = await startFakeOpenAi((req, res) => {
      if (req.method === 'GET') {
        return res.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b', size_vram: 1 }] }));
      }
      res.writeHead(500).end('busy');
    });
    closers.push(busy.close);
    const memory = new AiMemoryService(
      settings({ mode: 'api', baseUrl: 'https://api.example.com' }, { baseUrl: busy.baseUrl }),
      () => false,
      options(),
    );
    expect((await memory.unload()).failed).toEqual(['qwen2.5:7b']);
  });

  it('tells an idle speaches from an idle Ollama', async () => {
    const speaches = await fakeSpeaches([]);
    const ollama = await fakeOllama([]);
    const memory = new AiMemoryService(
      settings({ baseUrl: speaches.baseUrl }, { baseUrl: ollama.baseUrl }),
      () => false,
      options(),
    );
    expect(await memory.status()).toMatchObject({
      stt: { state: 'auto', server: 'speaches', loaded: [] },
      llm: { state: 'ok', server: 'ollama', loaded: [] },
    });
  });

  it('takes turns: waits for speaches to let Whisper go and unloads Ollama', async () => {
    const whisper = ['Systran/faster-whisper-large-v3'];
    const speaches = await fakeSpeaches(whisper);
    const ollama = await fakeOllama([{ name: 'gemma4:26b', size_vram: 14_000_000_000 }]);
    const memory = new AiMemoryService(
      settings({ baseUrl: speaches.baseUrl }, { baseUrl: ollama.baseUrl }),
      () => false,
      options(true),
    );
    expect(memory.takeTurns()).toBe(true);
    // speaches unloads by its TTL a moment later; it is never asked to.
    setTimeout(() => whisper.splice(0), 50);
    await expect(memory.waitForSttIdle()).resolves.toBe(true);
    expect(whisper).toEqual([]);
    expect(speaches.received.filter((r) => r.url === '/api/ps').length).toBeGreaterThan(1);
    expect(speaches.received.some((r) => r.method === 'DELETE')).toBe(false);

    await memory.unloadLlm();
    expect((await memory.status()).llm.loaded).toEqual([]);

    // The switch in the settings overrides the installer's default.
    expect((await memory.setTakeTurns(false)).takeTurns).toBe(false);
    expect(memory.takeTurns()).toBe(false);
  });

  it('leaves cloud APIs alone and has nothing to wait for without a local speaches', async () => {
    const cloud = await startFakeOpenAi((_, res) => res.end('{}'));
    closers.push(cloud.close);
    const memory = new AiMemoryService(
      settings({ mode: 'api', baseUrl: cloud.baseUrl }, { mode: 'api', baseUrl: cloud.baseUrl }),
      () => false,
      options(true),
    );
    await expect(memory.waitForSttIdle()).resolves.toBe(false);
    await memory.unloadLlm();
    await memory.waitBeforeRetry();
    expect(cloud.received).toEqual([]);
  });
});
