import type {
  AiSettings,
  AiSettingsPair,
  Job,
  Recording,
  SearchPage,
  Summary,
} from '@homescribe/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiUnreachableError } from '../src/ai/models';
import { audioFile, createTestApp, multipart } from './support/app';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

describe('HTTP API, stage 2', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  async function uploadAndProcess(filename = 'Team Sync.m4a'): Promise<Recording> {
    const { payload, headers } = await multipart([
      { name: 'file', value: audioFile(16), filename },
    ]);
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/recordings', payload, headers });
    await t.runner.idle();
    return res.json<Recording>();
  }

  const json = (method: 'PUT' | 'POST' | 'PATCH', url: string, payload: unknown) =>
    t.app.inject({ method, url, payload: payload as object });

  describe('summaries', () => {
    it('serves the summary made after transcription', async () => {
      const { id } = await uploadAndProcess();
      const res = await t.app.inject(`/api/v1/recordings/${id}/summary`);
      expect(res.statusCode).toBe(200);
      expect(res.json<Summary>()).toMatchObject({
        recordingId: id,
        summary: '- Plan agreed',
        actionItems: ['Ann: send notes'],
        model: 'fake-llm',
      });
    });

    it('answers 409 SUMMARY_NOT_READY when there is none', async () => {
      await json('PUT', '/api/v1/settings/ai/llm', { mode: 'off' });
      const { id } = await uploadAndProcess();
      const res = await t.app.inject(`/api/v1/recordings/${id}/summary`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('SUMMARY_NOT_READY');
    });

    it('regenerates the summary on demand', async () => {
      const { id } = await uploadAndProcess();
      t.summarizer.result = { summary: 'Take two', actionItems: [] };
      const res = await json('POST', `/api/v1/recordings/${id}/jobs`, { kind: 'summarize' });
      expect(res.statusCode).toBe(202);
      expect(res.json<Job>().kind).toBe('summarize');
      await t.runner.idle();
      const summary = await t.app.inject(`/api/v1/recordings/${id}/summary`);
      expect(summary.json<Summary>().summary).toBe('Take two');
    });

    it('refuses to summarize without a transcript or with summaries off', async () => {
      t.transcriber.failWith = 'STT_UNAVAILABLE';
      const failed = await uploadAndProcess();
      const noTranscript = await json('POST', `/api/v1/recordings/${failed.id}/jobs`, {
        kind: 'summarize',
      });
      expect(noTranscript.json().error.code).toBe('TRANSCRIPT_NOT_READY');

      t.transcriber.failWith = null;
      const ok = await uploadAndProcess();
      await json('PUT', '/api/v1/settings/ai/llm', { mode: 'off' });
      const off = await json('POST', `/api/v1/recordings/${ok.id}/jobs`, { kind: 'summarize' });
      expect(off.statusCode).toBe(409);
      expect(off.json().error.code).toBe('SUMMARIES_OFF');
    });
  });

  describe('PATCH /api/v1/recordings/:id', () => {
    it('renames and validates the title', async () => {
      const { id } = await uploadAndProcess();
      const res = await json('PATCH', `/api/v1/recordings/${id}`, { title: '  Retro  ' });
      expect(res.statusCode).toBe(200);
      expect(res.json<Recording>().title).toBe('Retro');
      const bad = await json('PATCH', `/api/v1/recordings/${id}`, { title: '   ' });
      expect(bad.statusCode).toBe(400);
      const missing = await json(
        'PATCH',
        '/api/v1/recordings/0b9f1a8e-3c6d-4f7a-8e2b-5d4c3b2a1f00',
        { title: 'x' },
      );
      expect(missing.statusCode).toBe(404);
    });
  });

  describe('GET /api/v1/recordings/:id/media', () => {
    it('streams the original with range support, a safe type and a sandbox', async () => {
      const { id } = await uploadAndProcess('voice.m4a');
      const full = await t.app.inject(`/api/v1/recordings/${id}/media`);
      expect(full.statusCode).toBe(200);
      expect(full.headers['content-type']).toBe('audio/mp4');
      expect(full.headers['accept-ranges']).toBe('bytes');
      expect(full.headers['content-security-policy']).toContain('sandbox');
      expect(full.rawPayload.length).toBe(16);

      const part = await t.app.inject({
        url: `/api/v1/recordings/${id}/media`,
        headers: { range: 'bytes=0-3' },
      });
      expect(part.statusCode).toBe(206);
      expect(part.rawPayload.length).toBe(4);
      expect(part.headers['content-range']).toBe('bytes 0-3/16');
    });

    it('answers 404 for an unknown recording', async () => {
      const res = await t.app.inject(
        '/api/v1/recordings/0b9f1a8e-3c6d-4f7a-8e2b-5d4c3b2a1f00/media',
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /api/v1/search', () => {
    it('finds transcripts with a highlighted snippet and the matching segment', async () => {
      const { id } = await uploadAndProcess();
      await uploadAndProcess('Other.m4a');
      t.repo.saveTranscript(id, {
        language: 'en',
        model: 'm',
        text: 'Hello there. The budget is approved.',
        segments: [
          { start: 0, end: 2, text: 'Hello there.' },
          { start: 65, end: 70, text: 'The budget is approved.' },
        ],
      });

      const res = await t.app.inject('/api/v1/search?q=Budget');
      expect(res.statusCode).toBe(200);
      const page = res.json<SearchPage>();
      expect(page.pagination.totalItems).toBe(1);
      expect(page.data[0]?.recording.id).toBe(id);
      expect(page.data[0]?.segment).toEqual({ index: 1, start: 65 });
      expect(page.data[0]?.snippet.filter((p) => p.match).map((p) => p.text)).toEqual(['budget']);
    });

    it('matches titles without pointing at a segment', async () => {
      await uploadAndProcess('Quarterly review.m4a');
      const page = (await t.app.inject('/api/v1/search?q=quarterly')).json<SearchPage>();
      expect(page.data[0]?.segment).toBeNull();
      expect(page.data[0]?.snippet.some((p) => p.match)).toBe(true);
    });

    it('validates the query', async () => {
      expect((await t.app.inject('/api/v1/search')).statusCode).toBe(400);
      expect((await t.app.inject(`/api/v1/search?q=${'x'.repeat(201)}`)).statusCode).toBe(400);
    });
  });

  describe('AI settings', () => {
    it('starts from the environment defaults', async () => {
      const res = await t.app.inject('/api/v1/settings/ai');
      expect(res.json<AiSettingsPair>()).toEqual({
        stt: {
          kind: 'stt',
          mode: 'local',
          provider: null,
          baseUrl: 'http://localhost:8000',
          model: 'Systran/faster-whisper-large-v3',
          hasApiKey: false,
          source: 'env',
        },
        llm: {
          kind: 'llm',
          mode: 'local',
          provider: null,
          baseUrl: 'http://localhost:11434',
          model: 'llama3.1:8b',
          hasApiKey: false,
          source: 'env',
        },
      });
    });

    it('saves a cloud API with a key that is never sent back', async () => {
      const res = await json('PUT', '/api/v1/settings/ai/llm', {
        mode: 'api',
        provider: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1/',
        model: 'llama-3.3-70b-versatile',
        apiKey: 'gsk_secret',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<AiSettings>()).toMatchObject({
        mode: 'api',
        provider: 'groq',
        baseUrl: 'https://api.groq.com/openai',
        hasApiKey: true,
        source: 'saved',
      });
      expect(res.body).not.toContain('gsk_secret');
      expect((await t.app.inject('/api/v1/settings/ai')).body).not.toContain('gsk_secret');
    });

    it('drops the saved key when the address changes, so it cannot be redirected', async () => {
      await json('PUT', '/api/v1/settings/ai/llm', {
        mode: 'api',
        baseUrl: 'https://api.openai.com',
        model: 'gpt-4o-mini',
        apiKey: 'sk-secret',
      });
      const sameAddress = await json('PUT', '/api/v1/settings/ai/llm', {
        mode: 'api',
        baseUrl: 'https://api.openai.com',
        model: 'gpt-4o',
      });
      expect(sameAddress.json<AiSettings>().hasApiKey).toBe(true);

      const moved = await json('PUT', '/api/v1/settings/ai/llm', {
        mode: 'local',
        baseUrl: 'http://evil.lan:1234',
        model: 'x',
      });
      expect(moved.json<AiSettings>().hasApiKey).toBe(false);
      expect(t.aiSettings.effective('llm').apiKey).toBeNull();
    });

    it('rejects turning speech-to-text off and invalid addresses', async () => {
      expect((await json('PUT', '/api/v1/settings/ai/stt', { mode: 'off' })).statusCode).toBe(400);
      const bad = await json('PUT', '/api/v1/settings/ai/llm', {
        mode: 'local',
        baseUrl: 'file:///etc/passwd',
        model: 'x',
      });
      expect(bad.statusCode).toBe(400);
      expect((await json('PUT', '/api/v1/settings/ai/tts', { mode: 'off' })).statusCode).toBe(400);
    });

    it('checks a new choice right away', async () => {
      await json('PUT', '/api/v1/settings/ai/llm', { mode: 'off' });
      await t.selfCheck.run();
      const health = await t.app.inject('/api/v1/health');
      expect(health.json().checks.llm).toBe('off');
    });

    it('resets to the environment defaults', async () => {
      await json('PUT', '/api/v1/settings/ai/llm', { mode: 'off' });
      const res = await t.app.inject({ method: 'DELETE', url: '/api/v1/settings/ai/llm' });
      expect(res.json<AiSettings>()).toMatchObject({ mode: 'local', source: 'env' });
    });

    it('uses a cloud speech-to-text API with compressed audio', async () => {
      await json('PUT', '/api/v1/settings/ai/stt', {
        mode: 'api',
        provider: 'openai',
        baseUrl: 'https://api.openai.com',
        model: 'whisper-1',
        apiKey: 'sk',
      });
      await uploadAndProcess();
      expect(t.media.converted.at(-1)?.format).toBe('ogg');
    });
  });

  describe('AI discovery and models', () => {
    it('returns what discovery found', async () => {
      t.ai$.discovery = {
        servers: [
          {
            baseUrl: 'http://localhost:11434',
            product: 'Ollama',
            models: [{ id: 'llama3.1:8b', kind: 'llm' }],
          },
        ],
        probed: ['http://localhost:11434'],
      };
      const res = await t.app.inject('/api/v1/ai/discovery');
      expect(res.json()).toEqual(t.ai$.discovery);
    });

    it('lists models, reusing the saved key only for its own address', async () => {
      await json('PUT', '/api/v1/settings/ai/llm', {
        mode: 'api',
        baseUrl: 'https://api.groq.com/openai',
        model: 'm',
        apiKey: 'gsk_secret',
      });
      t.ai$.models = [{ id: 'llama-3.3-70b-versatile', kind: 'llm' }];

      const same = await json('POST', '/api/v1/ai/models', {
        baseUrl: 'https://api.groq.com/openai',
        useSavedKeyFor: 'llm',
      });
      expect(same.json()).toEqual({ models: t.ai$.models });
      await json('POST', '/api/v1/ai/models', {
        baseUrl: 'http://elsewhere.lan:1234',
        useSavedKeyFor: 'llm',
      });
      expect(t.ai$.modelCalls).toEqual([
        { baseUrl: 'https://api.groq.com/openai', apiKey: 'gsk_secret' },
        { baseUrl: 'http://elsewhere.lan:1234', apiKey: null },
      ]);
    });

    it('reports an unreachable server as 502 AI_UNREACHABLE', async () => {
      t.ai$.modelsError = new AiUnreachableError('Cannot reach http://localhost:1234');
      const res = await json('POST', '/api/v1/ai/models', { baseUrl: 'http://localhost:1234' });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toEqual({
        code: 'AI_UNREACHABLE',
        message: 'Cannot reach http://localhost:1234',
      });
    });
  });
});
