import { openAsBlob } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { sttVerboseResponseSchema } from '@homescribe/shared';
import { SttError, type TranscriptionResult, type Transcriber } from './transcriber';

const RESPONSE_LIMIT = 64 * 1024 * 1024;

export interface OpenAiTranscriberOptions {
  baseUrl: string;
  model: string;
  language: string | null;
  apiKey: string | null;
  timeoutMs: number;
}

/**
 * Client for an OpenAI-compatible `POST /v1/audio/transcriptions` endpoint
 * (speaches, faster-whisper-server, ...). Request fields and the
 * `verbose_json` response follow speaches' `src/speaches/routers/stt.py` and
 * `openai.types.audio.TranscriptionVerbose`.
 *
 * Uses node:http instead of fetch: the server answers only when the whole file
 * is transcribed, which can take longer than fetch's fixed 300 s header
 * timeout. The file is streamed from disk, never loaded into memory.
 */
export class OpenAiTranscriber implements Transcriber {
  readonly model: string;

  constructor(private readonly options: OpenAiTranscriberOptions) {
    this.model = options.model;
  }

  async transcribe(wavPath: string, signal?: AbortSignal): Promise<TranscriptionResult> {
    const form = new FormData();
    form.append('file', await openAsBlob(wavPath, { type: 'audio/wav' }), 'audio.wav');
    form.append('model', this.options.model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    if (this.options.language) form.append('language', this.options.language);

    // Let the platform encode the multipart body, then stream it over node:http.
    const encoded = new Request('http://encoder.invalid', { method: 'POST', body: form });
    const headers: Record<string, string> = {
      'content-type': encoded.headers.get('content-type')!,
      accept: 'application/json',
    };
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;

    const url = new URL(`${this.options.baseUrl}/v1/audio/transcriptions`);
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    const { status, body } = await post(
      url,
      headers,
      Readable.fromWeb(encoded.body!),
      combined,
    ).catch((error: unknown) => {
      if (timeout.aborted) {
        throw new SttError('STT_TIMEOUT', `No answer within ${this.options.timeoutMs} ms`);
      }
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new SttError('STT_UNAVAILABLE', `Cannot reach ${url.origin}: ${message}`, {
        cause: error,
      });
    });

    if (status < 200 || status >= 300) {
      throw new SttError('STT_FAILED', `HTTP ${status}: ${body.slice(0, 500)}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new SttError('STT_FAILED', 'Response is not JSON');
    }
    const parsed = sttVerboseResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new SttError('STT_FAILED', `Unexpected response shape: ${parsed.error.message}`);
    }
    return {
      language: parsed.data.language ?? null,
      text: parsed.data.text.trim(),
      segments: parsed.data.segments
        .map((s) => ({ start: Math.max(0, s.start), end: Math.max(0, s.end), text: s.text.trim() }))
        .filter((s) => s.text.length > 0)
        .sort((a, b) => a.start - b.start),
    };
  }
}

function post(
  url: URL,
  headers: Record<string, string>,
  body: Readable,
  signal: AbortSignal,
): Promise<{ status: number; body: string }> {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(url, { method: 'POST', headers, signal }, (res) => {
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > RESPONSE_LIMIT) {
          req.destroy(new Error('Response too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    body.on('error', (error) => req.destroy(error));
    body.pipe(req);
  });
}
