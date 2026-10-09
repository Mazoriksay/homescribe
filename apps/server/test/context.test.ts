import { afterEach, describe, expect, it } from 'vitest';
import { ContextError, LlmContextService } from '../src/ai/context';
import type { AiSettingsService, EffectiveAiSettings } from '../src/ai/settings';
import { startFakeOpenAi } from './support/fake-openai';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** Ollama's /api/version, /api/show and /api/ps as far as the window needs them. */
async function fakeOllama(loadedWindow: number | null) {
  const fake = await startFakeOpenAi((req, res) => {
    if (req.url === '/api/version') return res.end('{"version":"0.40.1"}');
    if (req.url === '/api/show') {
      return res.end(
        JSON.stringify({
          model_info: { 'gemma3.context_length': 131072, 'gemma3.block_count': 48 },
        }),
      );
    }
    if (req.url === '/api/ps') {
      return res.end(
        JSON.stringify({
          models: loadedWindow ? [{ name: 'gemma', context_length: loadedWindow }] : [],
        }),
      );
    }
    res.writeHead(404).end();
  });
  closers.push(fake.close);
  return fake;
}

function setup(llm: Partial<EffectiveAiSettings>, fixedChunkChars: number | null = null) {
  const current = {
    mode: 'local',
    provider: null,
    model: 'gemma',
    apiKey: null,
    source: 'env',
    ...llm,
  };
  const settings = { effective: () => current } as unknown as AiSettingsService;
  const stored = new Map<string, unknown>();
  const repo = {
    getAppSetting: <T>(key: string) => (stored.get(key) ?? null) as T | null,
    setAppSetting: (key: string, value: unknown) => void stored.set(key, value),
  };
  return { service: new LlmContextService(settings, repo, fixedChunkChars), current };
}

describe('LlmContextService', () => {
  it("offers sizes up to the model's own maximum and follows the window", async () => {
    const ollama = await fakeOllama(4096);
    const { service, current } = setup({ baseUrl: ollama.baseUrl });
    expect(await service.status()).toEqual({
      supported: true,
      value: null,
      min: 2048,
      max: 131072,
      presets: [4096, 8192, 16384, 32768, 65536, 131072],
      loaded: 4096,
      chunkChars: 4100,
    });

    const chosen = await service.set(16384);
    expect(chosen).toMatchObject({ value: 16384, chunkChars: 16200 });
    expect(service.chosen()).toBe(16384);
    await expect(service.window()).resolves.toBe(16384);

    await expect(service.set(200_000)).rejects.toBeInstanceOf(ContextError);
    await expect(service.set(1000)).rejects.toThrow(/between 2048 and 131072/);

    // Chosen for this model only.
    current.model = 'other';
    expect(service.chosen()).toBeNull();
    current.model = 'gemma';
    expect((await service.set(null)).value).toBeNull();
  });

  it('takes the window Ollama gave the loaded model, else 4096', async () => {
    const big = await fakeOllama(32768);
    expect(await setup({ baseUrl: big.baseUrl }).service.window()).toBe(32768);
    const idle = await fakeOllama(null);
    expect(await setup({ baseUrl: idle.baseUrl }).service.window()).toBe(4096);
  });

  it('is not offered for other servers and keeps a hand-set part size', async () => {
    const cloud = await startFakeOpenAi((_, res) => res.writeHead(404).end());
    closers.push(cloud.close);
    const { service } = setup({ mode: 'api', baseUrl: cloud.baseUrl }, 9000);
    expect(await service.status()).toMatchObject({ supported: false, max: null, chunkChars: 9000 });
    await expect(service.set(8192)).rejects.toThrow(/only for a local Ollama/);
  });
});
