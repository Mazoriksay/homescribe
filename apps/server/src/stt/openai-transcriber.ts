import { openAsBlob } from 'node:fs';
import { Readable } from 'node:stream';
import { sttVerboseResponseSchema } from '@homescribe/shared';
import { authHeaders, httpRequest, withTimeout } from '../ai/http';
import {
  SttError,
  type TranscribeOptions,
  type TranscriptionResult,
  type Transcriber,
} from './transcriber';

export interface OpenAiTranscriberOptions {
  baseUrl: string;
  model: string;
  language: string | null;
  apiKey: string | null;
  timeoutMs: number;
  /** Send speaches' `vad_filter=true` (skip silence, avoids Whisper loops). */
  vadFilter?: boolean;
}

/**
 * Client for an OpenAI-compatible `POST /v1/audio/transcriptions` endpoint
 * (speaches, faster-whisper-server, ...). Request fields and the
 * `verbose_json` response follow speaches' `src/speaches/routers/stt.py` and
 * `openai.types.audio.TranscriptionVerbose`.
 *
 * The file is streamed from disk, never loaded into memory.
 */
export class OpenAiTranscriber implements Transcriber {
  readonly model: string;

  constructor(private readonly options: OpenAiTranscriberOptions) {
    this.model = options.model;
  }

  async transcribe(
    audioPath: string,
    signal?: AbortSignal,
    options: TranscribeOptions = {},
  ): Promise<TranscriptionResult> {
    const isOgg = audioPath.endsWith('.ogg');
    const form = new FormData();
    form.append(
      'file',
      await openAsBlob(audioPath, { type: isOgg ? 'audio/ogg' : 'audio/wav' }),
      isOgg ? 'audio.ogg' : 'audio.wav',
    );
    form.append('model', this.options.model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    const language = options.language ?? this.options.language;
    if (language) form.append('language', language);
    // speaches passes one temperature to faster-whisper, which then has no
    // higher temperature to fall back to when it loops; the caller retries.
    if (options.temperature !== undefined) form.append('temperature', String(options.temperature));
    if (this.options.vadFilter) form.append('vad_filter', 'true');

    // Let the platform encode the multipart body, then stream it over node:http.
    const encoded = new Request('http://encoder.invalid', { method: 'POST', body: form });
    const headers = {
      'content-type': encoded.headers.get('content-type')!,
      accept: 'application/json',
      ...authHeaders(this.options.apiKey),
    };

    const url = new URL(`${this.options.baseUrl}/v1/audio/transcriptions`);
    const timer = withTimeout(this.options.timeoutMs, signal);

    const { status, body } = await httpRequest(url, {
      method: 'POST',
      headers,
      body: Readable.fromWeb(encoded.body!),
      signal: timer.signal,
    }).catch((error: unknown) => {
      if (timer.timedOut()) {
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
