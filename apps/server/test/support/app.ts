import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../../src/config';
import { openDatabase } from '../../src/db/database';
import { Repository } from '../../src/db/repository';
import { EventBus } from '../../src/events';
import { buildApp } from '../../src/http/app';
import { JobRunner } from '../../src/jobs/runner';
import { MediaStore } from '../../src/storage';
import type { AiModel, Discovery } from '@homescribe/shared';
import { AiSettingsService } from '../../src/ai/settings';
import { SelfCheck } from '../../src/self-check';
import {
  FakeDownloader,
  FakeMediaTool,
  FakeSummarizer,
  FakeTranscriber,
  silentLogger,
} from './fakes';

/** A fully wired app with fake ffmpeg/STT and a temporary DATA_DIR. */
export async function createTestApp(
  env: Record<string, string> = {},
  prepare?: (dataDir: string) => Promise<Record<string, string>>,
) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'homescribe-app-'));
  const prepared = prepare ? await prepare(dataDir) : {};
  const config: Config = loadConfig(
    {
      DATA_DIR: dataDir,
      WEB_DIST_DIR: path.join(dataDir, 'no-web'),
      LOG_LEVEL: 'silent',
      ...prepared,
      ...env,
    },
    dataDir,
  );
  const repo = new Repository(openDatabase(':memory:'));
  const store = new MediaStore(config.dataDir);
  const media = new FakeMediaTool();
  const transcriber = new FakeTranscriber();
  const summarizer = new FakeSummarizer();
  const downloader = new FakeDownloader();
  // Fake DNS for the link guard: example hosts are public, *.lan is private.
  const hosts: Record<string, string> = {
    'www.youtube.com': '142.250.74.46',
    'media.example.com': '93.184.215.14',
    'nas.lan': '192.168.1.5',
  };
  const aiSettings = new AiSettingsService(repo, config);
  // Real settings, fake clients: what the UI chooses decides which fake runs.
  const ai = {
    stt: () => ({
      transcriber,
      format: aiSettings.effective('stt').mode === 'api' ? ('ogg' as const) : ('wav' as const),
    }),
    llm: () => (aiSettings.effective('llm').mode === 'off' ? null : summarizer),
  };
  const ai$ = {
    discovery: { servers: [], probed: [] } as Discovery,
    models: [] as AiModel[],
    modelsError: null as Error | null,
    modelCalls: [] as { baseUrl: string; apiKey: string | null }[],
  };
  const events = new EventBus();
  const runner = new JobRunner({
    repo,
    store,
    media,
    ai,
    downloader,
    download: { maxBytes: config.maxUploadBytes, timeoutMs: config.ytdlp.timeoutMs },
    events,
    logger: silentLogger,
    progressIntervalMs: 0,
  });
  const selfCheck = new SelfCheck({
    media,
    downloader,
    aiSettings,
    config,
    logger: { info: () => undefined, warn: () => undefined },
    listModels: async (baseUrl) =>
      baseUrl === config.stt.baseUrl
        ? [{ id: config.stt.model, kind: 'stt' }]
        : [{ id: config.llm.model, kind: 'llm' }],
  });
  await selfCheck.run();
  const app = await buildApp({
    selfCheck,
    lookup: async (host) => {
      const address = hosts[host];
      if (!address) throw new Error(`ENOTFOUND ${host}`);
      return [{ address }];
    },
    config,
    repo,
    store,
    runner,
    events,
    aiSettings,
    discover: async () => ai$.discovery,
    listModels: async (baseUrl, apiKey) => {
      ai$.modelCalls.push({ baseUrl, apiKey });
      if (ai$.modelsError) throw ai$.modelsError;
      return ai$.models;
    },
  });
  runner.start();

  return {
    app,
    repo,
    store,
    media,
    transcriber,
    summarizer,
    downloader,
    aiSettings,
    selfCheck,
    ai$,
    events,
    runner,
    config,
    async close() {
      await runner.stop();
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** Encodes a multipart body the way a browser would. */
export async function multipart(
  parts: { name: string; value: string | Blob; filename?: string }[],
): Promise<{ payload: Buffer; headers: Record<string, string> }> {
  const form = new FormData();
  for (const part of parts) {
    if (typeof part.value === 'string') form.append(part.name, part.value);
    else form.append(part.name, part.value, part.filename);
  }
  const encoded = new Response(form);
  return {
    payload: Buffer.from(await encoded.arrayBuffer()),
    headers: { 'content-type': encoded.headers.get('content-type')! },
  };
}

export const audioFile = (size = 16, type = 'audio/mp4') =>
  new Blob([new Uint8Array(size).fill(7)], { type });
