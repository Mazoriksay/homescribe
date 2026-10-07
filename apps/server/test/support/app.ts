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
import { FakeMediaTool, FakeTranscriber, silentLogger } from './fakes';

/** A fully wired app with fake ffmpeg/STT and a temporary DATA_DIR. */
export async function createTestApp(env: Record<string, string> = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'homescribe-app-'));
  const config: Config = loadConfig(
    { DATA_DIR: dataDir, WEB_DIST_DIR: path.join(dataDir, 'no-web'), LOG_LEVEL: 'silent', ...env },
    dataDir,
  );
  const repo = new Repository(openDatabase(':memory:'));
  const store = new MediaStore(config.dataDir);
  const media = new FakeMediaTool();
  const transcriber = new FakeTranscriber();
  const events = new EventBus();
  const runner = new JobRunner({
    repo,
    store,
    media,
    transcriber,
    events,
    logger: silentLogger,
    progressIntervalMs: 0,
  });
  const app = await buildApp({ config, repo, store, runner, events });
  runner.start();

  return {
    app,
    repo,
    store,
    media,
    transcriber,
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
