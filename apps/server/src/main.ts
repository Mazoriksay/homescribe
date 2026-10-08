import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ConfigError, loadConfig } from './config';
import { openDatabase } from './db/database';
import { Repository } from './db/repository';
import { EventBus } from './events';
import { buildApp } from './http/app';
import { JobRunner } from './jobs/runner';
import { FfmpegMediaTool } from './media/ffmpeg';
import { YtDlpDownloader } from './media/ytdlp';
import { MediaStore } from './storage';
import { createAiBackends } from './ai/backends';
import { AiMemoryService } from './ai/memory';
import { CookieService, retryRecordings } from './cookies/service';
import { discoverServers } from './ai/discovery';
import { listModels } from './ai/models';
import { AiSettingsService } from './ai/settings';
import { SelfCheck } from './self-check';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

async function main(): Promise<void> {
  const config = loadConfig(process.env, repoRoot);
  mkdirSync(config.dataDir, { recursive: true });

  const repo = new Repository(openDatabase(path.join(config.dataDir, 'homescribe.db')));
  const store = new MediaStore(config.dataDir);
  const events = new EventBus();
  const aiSettings = new AiSettingsService(repo, config);
  const media = new FfmpegMediaTool(config.ffmpegPath, config.ffprobePath);
  const downloader = new YtDlpDownloader(config.ytdlp.path, config.ytdlp.cookiesFile);
  let app: FastifyInstance | undefined;
  const memory: AiMemoryService = new AiMemoryService(aiSettings, (): boolean => runner.busy, {
    repo,
    gpu: config.gpu,
  });
  const runner = new JobRunner({
    repo,
    store,
    events,
    media,
    downloader,
    download: { maxBytes: config.maxUploadBytes, timeoutMs: config.ytdlp.timeoutMs },
    ai: createAiBackends(aiSettings, config),
    logger: {
      info: (obj, msg) => app?.log.info(obj, msg),
      error: (obj, msg) => app?.log.error(obj, msg),
    },
    gpu: memory,
    onCookiesExpired: () => cookies.markExpired(),
  });
  const cookies = new CookieService({
    repo,
    file: config.ytdlp.cookiesFile,
    downloader,
    retry: (ids) => retryRecordings({ repo, events, kick: () => runner.kick() }, ids),
    logger: { info: (obj, msg) => app?.log.info(obj, msg) },
  });
  const selfCheck = new SelfCheck({
    media,
    downloader,
    aiSettings,
    config,
    listModels: (baseUrl, apiKey) => listModels(baseUrl, apiKey, 3000),
    logger: {
      info: (obj, msg) => app?.log.info(obj, msg),
      warn: (obj, msg) => app?.log.warn(obj, msg),
    },
  });
  app = await buildApp({
    selfCheck,
    config,
    repo,
    store,
    runner,
    events,
    cookies,
    aiSettings,
    discover: () => discoverServers({ hosts: config.discoveryHosts, selfPort: config.port }),
    memory,
    listModels: (baseUrl, apiKey) => listModels(baseUrl, apiKey),
  });
  app.log.info({ search: repo.search.mode }, 'search index ready');

  const shutdown = async (signal: string) => {
    app?.log.info({ signal }, 'shutting down');
    selfCheck.stop();
    await cookies.stop();
    await runner.stop();
    await app?.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  runner.start();
  selfCheck.start();
  await cookies.start();

  // Sites change often; a stale yt-dlp is the most common reason links fail.
  if (config.ytdlp.autoUpdate) {
    const update = async () => {
      const result = await downloader.selfUpdate();
      app?.log.info({ result }, 'yt-dlp self-update');
    };
    void update();
    setInterval(() => void update(), 24 * 60 * 60 * 1000).unref();
  }
  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
