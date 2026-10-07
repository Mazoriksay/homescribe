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
import { OpenAiTranscriber } from './stt/openai-transcriber';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

async function main(): Promise<void> {
  const config = loadConfig(process.env, repoRoot);
  mkdirSync(config.dataDir, { recursive: true });

  const repo = new Repository(openDatabase(path.join(config.dataDir, 'homescribe.db')));
  const store = new MediaStore(config.dataDir);
  const events = new EventBus();
  let app: FastifyInstance | undefined;
  const runner = new JobRunner({
    repo,
    store,
    events,
    media: new FfmpegMediaTool(config.ffmpegPath, config.ffprobePath),
    transcriber: new OpenAiTranscriber(config.stt),
    logger: {
      info: (obj, msg) => app?.log.info(obj, msg),
      error: (obj, msg) => app?.log.error(obj, msg),
    },
  });
  app = await buildApp({ config, repo, store, runner, events });

  const shutdown = async (signal: string) => {
    app?.log.info({ signal }, 'shutting down');
    await runner.stop();
    await app?.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  runner.start();
  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
