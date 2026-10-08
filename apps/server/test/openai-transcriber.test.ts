import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OpenAiTranscriber } from '../src/stt/openai-transcriber';
import { SttError } from '../src/stt/transcriber';

interface Received {
  url: string;
  authorization: string | undefined;
  fields: Record<string, string>;
  fileName: string | null;
  fileSize: number;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** A local stand-in for an OpenAI-compatible STT server. */
async function startFakeServer(respond: (received: Received, res: http.ServerResponse) => void) {
  const received: Received[] = [];
  const handler: Handler = async (req, res) => {
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: Readable.toWeb(req) as ReadableStream,
      duplex: 'half',
    } as RequestInit);
    const form = await request.formData();
    const fields: Record<string, string> = {};
    let fileName: string | null = null;
    let fileSize = 0;
    for (const [key, value] of form) {
      if (typeof value === 'string') fields[key] = value;
      else {
        fileName = value.name;
        fileSize = value.size;
      }
    }
    const entry = {
      url: req.url ?? '',
      authorization: req.headers.authorization,
      fields,
      fileName,
      fileSize,
    };
    received.push(entry);
    respond(entry, res);
  };
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, received, baseUrl: `http://127.0.0.1:${port}` };
}

const verbose = {
  text: ' Hello there. Bye.',
  language: 'en',
  duration: 3,
  segments: [
    {
      id: 1,
      seek: 0,
      start: 1.5,
      end: 3,
      text: ' Bye.',
      tokens: [],
      temperature: 0,
      avg_logprob: 0,
      compression_ratio: 1,
      no_speech_prob: 0,
    },
    {
      id: 0,
      seek: 0,
      start: 0,
      end: 1.5,
      text: ' Hello there.',
      tokens: [],
      temperature: 0,
      avg_logprob: 0,
      compression_ratio: 1,
      no_speech_prob: 0,
    },
    {
      id: 2,
      seek: 0,
      start: 3,
      end: 3.1,
      text: '  ',
      tokens: [],
      temperature: 0,
      avg_logprob: 0,
      compression_ratio: 1,
      no_speech_prob: 0,
    },
  ],
};

describe('OpenAiTranscriber', () => {
  let dir: string;
  let wav: string;
  const servers: http.Server[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'homescribe-stt-'));
    wav = path.join(dir, 'audio.wav');
    await writeFile(wav, Buffer.alloc(4096, 1));
  });

  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const transcriber = (
    baseUrl: string,
    overrides: Partial<{ language: string | null; apiKey: string | null; timeoutMs: number }> = {},
  ) =>
    new OpenAiTranscriber({
      baseUrl,
      model: 'test-model',
      language: null,
      apiKey: null,
      timeoutMs: 5000,
      ...overrides,
    });

  it('sends the documented multipart fields and parses verbose_json', async () => {
    const fake = await startFakeServer((_, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(verbose));
    });
    servers.push(fake.server);

    const result = await transcriber(fake.baseUrl, { language: 'en', apiKey: 'secret' }).transcribe(
      wav,
    );

    expect(fake.received).toHaveLength(1);
    const [request] = fake.received;
    expect(request).toMatchObject({
      url: '/v1/audio/transcriptions',
      authorization: 'Bearer secret',
      fileName: 'audio.wav',
      fileSize: 4096,
      fields: {
        model: 'test-model',
        response_format: 'verbose_json',
        'timestamp_granularities[]': 'segment',
        language: 'en',
      },
    });
    expect(result).toEqual({
      language: 'en',
      text: 'Hello there. Bye.',
      segments: [
        { start: 0, end: 1.5, text: 'Hello there.' },
        { start: 1.5, end: 3, text: 'Bye.' },
      ],
    });
  });

  it('omits language and authorization when not configured', async () => {
    const fake = await startFakeServer((_, res) => res.end(JSON.stringify(verbose)));
    servers.push(fake.server);
    await transcriber(fake.baseUrl).transcribe(wav);
    expect(fake.received[0]?.fields.language).toBeUndefined();
    expect(fake.received[0]?.authorization).toBeUndefined();
  });

  it('asks speaches to skip silence only when told to', async () => {
    const fake = await startFakeServer((_, res) => res.end(JSON.stringify(verbose)));
    servers.push(fake.server);
    await transcriber(fake.baseUrl).transcribe(wav);
    await new OpenAiTranscriber({
      baseUrl: fake.baseUrl,
      model: 'test-model',
      language: null,
      apiKey: null,
      timeoutMs: 5000,
      vadFilter: true,
    }).transcribe(wav);
    expect(fake.received[0]?.fields.vad_filter).toBeUndefined();
    expect(fake.received[1]?.fields.vad_filter).toBe('true');
  });

  it('sends a per-call language and temperature', async () => {
    const fake = await startFakeServer((_, res) => res.end(JSON.stringify(verbose)));
    servers.push(fake.server);
    await transcriber(fake.baseUrl).transcribe(wav, undefined, {
      language: 'ru',
      temperature: 0.4,
    });
    expect(fake.received[0]?.fields).toMatchObject({ language: 'ru', temperature: '0.4' });
  });

  it('maps an HTTP error to STT_FAILED', async () => {
    const fake = await startFakeServer((_, res) => res.writeHead(500).end('model not found'));
    servers.push(fake.server);
    await expect(transcriber(fake.baseUrl).transcribe(wav)).rejects.toMatchObject({
      code: 'STT_FAILED',
      message: expect.stringContaining('model not found'),
    });
  });

  it('maps a response of the wrong shape to STT_FAILED', async () => {
    const fake = await startFakeServer((_, res) => res.end(JSON.stringify({ segments: 'nope' })));
    servers.push(fake.server);
    await expect(transcriber(fake.baseUrl).transcribe(wav)).rejects.toMatchObject({
      code: 'STT_FAILED',
    });
  });

  it('maps a refused connection to STT_UNAVAILABLE', async () => {
    const fake = await startFakeServer(() => undefined);
    const { baseUrl } = fake;
    await new Promise((resolve) => fake.server.close(resolve));
    const error = await transcriber(baseUrl)
      .transcribe(wav)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SttError);
    expect((error as SttError).code).toBe('STT_UNAVAILABLE');
  });

  it('maps a slow server to STT_TIMEOUT', async () => {
    const fake = await startFakeServer(() => undefined); // never answers
    servers.push(fake.server);
    const error = await transcriber(fake.baseUrl, { timeoutMs: 200 })
      .transcribe(wav)
      .catch((e: unknown) => e);
    fake.server.closeAllConnections();
    expect((error as SttError).code).toBe('STT_TIMEOUT');
  });
});
