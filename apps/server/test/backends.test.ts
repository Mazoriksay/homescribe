import { describe, expect, it } from 'vitest';
import { BATCHED_CHUNKING, createAiBackends } from '../src/ai/backends';
import type { AiSettingsService } from '../src/ai/settings';
import { loadConfig } from '../src/config';

const settings = (stt: { mode: 'local' | 'api'; baseUrl: string }) =>
  ({
    effective: () => ({ ...stt, provider: null, model: 'm', apiKey: null, source: 'env' }),
  }) as unknown as AiSettingsService;

const config = (env: Record<string, string>) =>
  loadConfig({ STT_BASE_URL: 'http://stt:8000', ...env }, '/srv/app');

describe('createAiBackends: STT parts', () => {
  it('keeps minute parts unless the bundled server runs batched', () => {
    const local = settings({ mode: 'local', baseUrl: 'http://stt:8000' });
    expect(createAiBackends(local, config({})).stt().chunking).toBeUndefined();
    expect(createAiBackends(local, config({ STT_BATCHED: 'true' })).stt().chunking).toEqual(
      BATCHED_CHUNKING,
    );
  });

  it('sends minute parts to any other server, local or cloud', () => {
    const batched = config({ STT_BATCHED: 'true' });
    const other = settings({ mode: 'local', baseUrl: 'http://localhost:9000' });
    const cloud = settings({ mode: 'api', baseUrl: 'http://stt:8000' });
    expect(createAiBackends(other, batched).stt().chunking).toBeUndefined();
    expect(createAiBackends(cloud, batched).stt().chunking).toBeUndefined();
  });
});
