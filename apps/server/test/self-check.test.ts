import type { AiModel } from '@homescribe/shared';
import { describe, expect, it, vi } from 'vitest';
import { AiSettingsService } from '../src/ai/settings';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db/database';
import { Repository } from '../src/db/repository';
import { SelfCheck } from '../src/self-check';
import { FakeDownloader, FakeMediaTool } from './support/fakes';

function setup(env: Record<string, string> = {}) {
  const config = loadConfig(env, '/srv');
  const repo = new Repository(openDatabase(':memory:'));
  const aiSettings = new AiSettingsService(repo, config);
  const media = new FakeMediaTool();
  const downloader = new FakeDownloader();
  const servers: Record<string, AiModel[] | Error> = {
    'http://localhost:8000': [{ id: 'Systran/faster-whisper-large-v3', kind: 'stt' }],
    'http://localhost:11434': [{ id: 'llama3.1:8b', kind: 'llm' }],
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const check = new SelfCheck({
    media,
    downloader,
    aiSettings,
    config,
    logger,
    listModels: async (baseUrl) => {
      const result = servers[baseUrl] ?? new Error('ECONNREFUSED');
      if (result instanceof Error) throw result;
      return result;
    },
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
  return { check, media, downloader, servers, logger, aiSettings };
}

describe('SelfCheck', () => {
  it('reports everything ok when the dependencies answer', async () => {
    const { check, logger } = setup();
    expect(await check.run()).toEqual({
      ffmpeg: 'ok',
      ytdlp: 'ok',
      stt: 'ok',
      llm: 'ok',
      embedding: 'same_origin',
    });
    expect(check.latest?.checkedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('finds missing ffmpeg, unreachable servers and missing models, with hints', async () => {
    const { check, media, downloader, servers, logger } = setup({
      FRAME_ANCESTORS: 'http://hub.lan',
    });
    media.isAvailable = false;
    downloader.isAvailable = false;
    servers['http://localhost:8000'] = new Error('down');
    servers['http://localhost:11434'] = [{ id: 'qwen2.5:7b', kind: 'llm' }];

    expect(await check.run()).toEqual({
      ffmpeg: 'missing',
      ytdlp: 'missing',
      stt: 'unreachable',
      llm: 'model_missing',
      embedding: 'origins',
    });
    const warnings = logger.warn.mock.calls.map(([detail, msg]) => [
      msg,
      (detail as { hint: string }).hint,
    ]);
    expect(warnings).toEqual([
      ['self-check: ffmpeg missing', expect.stringContaining('Install ffmpeg')],
      ['self-check: ytdlp missing', expect.stringContaining('yt-dlp')],
      ['self-check: stt unreachable', expect.stringContaining('Settings')],
      ['self-check: llm model_missing', expect.stringContaining('ollama pull')],
    ]);
  });

  it('accepts Ollama ":latest" tags and treats a turned-off LLM as fine', async () => {
    const { check, servers, aiSettings } = setup({ LLM_MODEL: 'llama3.1' });
    servers['http://localhost:11434'] = [{ id: 'llama3.1:latest', kind: 'llm' }];
    expect((await check.run()).llm).toBe('ok');
    aiSettings.update('llm', { mode: 'off', provider: null });
    expect((await check.run()).llm).toBe('off');
  });

  it('logs a problem once, and again only when it recovers', async () => {
    const { check, servers, logger } = setup();
    servers['http://localhost:8000'] = new Error('down');
    await check.run();
    await check.run();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    servers['http://localhost:8000'] = [{ id: 'Systran/faster-whisper-large-v3', kind: 'stt' }];
    await check.run();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ check: 'stt', state: 'ok' }),
      'self-check: stt recovered',
    );
  });
});
