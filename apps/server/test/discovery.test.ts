import { afterEach, describe, expect, it } from 'vitest';
import { discoverServers, resolveHost } from '../src/ai/discovery';
import { AiUnreachableError, listModels } from '../src/ai/models';
import { startFakeOpenAi } from './support/fake-openai';

describe('discoverServers', () => {
  it('probes every host and port, skips itself and keeps servers that answer', async () => {
    const result = await discoverServers({
      hosts: ['localhost', 'gpu-box'],
      selfPort: 8080,
      resolve: async (host) => host,
      ports: [
        { port: 11434, product: 'Ollama' },
        { port: 8080, product: 'llama.cpp' },
      ],
      list: async (baseUrl) => {
        if (baseUrl === 'http://localhost:11434') return [{ id: 'llama3.1:8b', kind: 'llm' }];
        if (baseUrl === 'http://gpu-box:8080') return [];
        throw new AiUnreachableError('nope');
      },
    });
    expect(result.probed).toEqual([
      'http://localhost:11434',
      'http://gpu-box:11434',
      'http://gpu-box:8080',
    ]);
    expect(result.servers).toEqual([
      {
        baseUrl: 'http://localhost:11434',
        product: 'Ollama',
        models: [{ id: 'llama3.1:8b', kind: 'llm' }],
      },
      { baseUrl: 'http://gpu-box:8080', product: 'llama.cpp', models: [] },
    ]);
  });

  it('probes each host once by address and skips hosts that do not resolve', async () => {
    const lookups: string[] = [];
    const probed: string[] = [];
    const result = await discoverServers({
      hosts: ['host.docker.internal', 'ollama'],
      selfPort: 8080,
      ports: [
        { port: 11434, product: 'Ollama' },
        { port: 1234, product: 'LM Studio' },
      ],
      resolve: async (host) => {
        lookups.push(host);
        return host === 'ollama' ? null : '192.168.65.254';
      },
      list: async (baseUrl) => {
        probed.push(baseUrl);
        if (baseUrl === 'http://192.168.65.254:11434') return [{ id: 'qwen2.5:7b', kind: 'llm' }];
        throw new AiUnreachableError('nope');
      },
    });
    expect(lookups).toEqual(['host.docker.internal', 'ollama']);
    expect(probed).toEqual(['http://192.168.65.254:11434', 'http://192.168.65.254:1234']);
    expect(result.servers).toEqual([
      {
        baseUrl: 'http://host.docker.internal:11434',
        product: 'Ollama',
        models: [{ id: 'qwen2.5:7b', kind: 'llm' }],
      },
    ]);
    expect(result.probed).toHaveLength(4);
  });

  it('resolves names to IPv4 first and keeps IP literals', async () => {
    expect(await resolveHost('localhost', 1000)).toBe('127.0.0.1');
    expect(await resolveHost('[::1]', 1000)).toBe('[::1]');
    expect(await resolveHost('10.0.0.5', 1000)).toBe('10.0.0.5');
    expect(await resolveHost('no-such-host.invalid', 1000)).toBeNull();
  });

  it('finds a real server on a local port', async () => {
    const fake = await startFakeOpenAi((_, res) =>
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen2.5:7b', object: 'model' }] })),
    );
    try {
      const result = await discoverServers({
        hosts: ['127.0.0.1'],
        selfPort: 1,
        ports: [{ port: fake.port, product: 'Test' }],
      });
      expect(result.servers[0]?.models).toEqual([{ id: 'qwen2.5:7b', kind: 'llm' }]);
    } finally {
      await fake.close();
    }
  });
});

describe('listModels', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it('classifies models and sends the key', async () => {
    const fake = await startFakeOpenAi((_, res) =>
      res.end(
        JSON.stringify({
          data: [
            { id: 'Systran/faster-whisper-large-v3', task: 'automatic-speech-recognition' },
            { id: 'speaches-ai/Kokoro-82M-v1.0-ONNX', task: 'text-to-speech' },
            { id: 'llama3.1:8b' },
            { id: 'llama3.1:8b' },
          ],
        }),
      ),
    );
    closers.push(fake.close);
    const models = await listModels(fake.baseUrl, 'secret');
    expect(models).toEqual([
      { id: 'llama3.1:8b', kind: 'llm' },
      { id: 'speaches-ai/Kokoro-82M-v1.0-ONNX', kind: null },
      { id: 'Systran/faster-whisper-large-v3', kind: 'stt' },
    ]);
    expect(fake.received[0]).toMatchObject({ url: '/v1/models', authorization: 'Bearer secret' });
  });

  it('explains refused keys, odd answers and dead servers', async () => {
    const denied = await startFakeOpenAi((_, res) => res.writeHead(401).end('{}'));
    closers.push(denied.close);
    await expect(listModels(denied.baseUrl, 'bad')).rejects.toThrow(/refused the API key/);

    const html = await startFakeOpenAi((_, res) => res.end('<html>router login</html>'));
    closers.push(html.close);
    await expect(listModels(html.baseUrl, null)).rejects.toThrow(/did not answer with JSON/);

    const gone = await startFakeOpenAi(() => undefined);
    await gone.close();
    await expect(listModels(gone.baseUrl, null)).rejects.toBeInstanceOf(AiUnreachableError);
  });
});
