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
import { MediaStore } from './storage';
import { createAiBackends } from './ai/backends';
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
  let app: FastifyInstance | undefined;
  const runner = new JobRunner({
    repo,
    store,
    events,
    media,
    ai: createAiBackends(aiSettings, config),
    logger: {
      info: (obj, msg) => app?.log.info(obj, msg),
      error: (obj, msg) => app?.log.error(obj, msg),
    },
  });
  const selfCheck = new SelfCheck({
    media,
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
    aiSettings,
    discover: () => discoverServers({ hosts: config.discoveryHosts, selfPort: config.port }),
    listModels: (baseUrl, apiKey) => listModels(baseUrl, apiKey),
  });
  app.log.info({ search: repo.search.mode }, 'search index ready');

  const shutdown = async (signal: string) => {
    app?.log.info({ signal }, 'shutting down');
    selfCheck.stop();
    await runner.stop();
    await app?.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  runner.start();
  selfCheck.start();
  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
