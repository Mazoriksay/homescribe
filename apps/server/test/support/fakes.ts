import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DownloadBlockedError, DownloadError } from '../../src/media/downloader';
import { LlmError } from '../../src/llm/summarizer';
import { MediaError, type ConvertOptions, type MediaTool } from '../../src/media/media-tool';
import {
  SttError,
  type SttErrorCode,
  type TranscriptionResult,
  type Transcriber,
} from '../../src/stt/transcriber';

/** Pretends to be ffmpeg: writes a placeholder WAV and reports progress. */
export class FakeMediaTool implements MediaTool {
  duration: number | null = 42;
  failWith: string | null = null;
  readonly converted: { input: string; output: string; format: string }[] = [];

  isAvailable = true;

  async available(): Promise<boolean> {
    return this.isAvailable;
  }

  async probeDuration(): Promise<number | null> {
    if (this.failWith) throw new MediaError(this.failWith);
    return this.duration;
  }

  async convertAudio(input: string, output: string, options: ConvertOptions): Promise<void> {
    if (this.failWith) throw new MediaError(this.failWith);
    options.onProgress?.(0.5);
    options.onProgress?.(1);
    await writeFile(output, options.format === 'ogg' ? 'OggS' : 'RIFF');
    this.converted.push({ input, output, format: options.format });
  }
}

/** Pretends to be the STT server. `gate` lets a test hold a job in `transcribing`. */
export class FakeTranscriber implements Transcriber {
  readonly model = 'fake-whisper';
  result: TranscriptionResult = {
    language: 'en',
    text: 'Hello there. Bye.',
    segments: [
      { start: 0, end: 1.5, text: 'Hello there.' },
      { start: 1.5, end: 3, text: 'Bye.' },
    ],
  };
  failWith: SttErrorCode | null = null;
  gate: Promise<void> | null = null;
  calls = 0;

  async transcribe(_wavPath: string, signal?: AbortSignal): Promise<TranscriptionResult> {
    this.calls += 1;
    if (this.gate) {
      signal?.throwIfAborted();
      await Promise.race([
        this.gate,
        new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason))),
      ]);
    }
    if (this.failWith) throw new SttError(this.failWith, 'fake failure');
    return this.result;
  }
}

export const silentLogger = { info: () => undefined, error: () => undefined };

/** A promise plus its resolver, for holding fakes mid-job. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Pretends to be the LLM. */
export class FakeSummarizer {
  readonly model = 'fake-llm';
  result = { summary: '- Plan agreed', actionItems: ['Ann: send notes'] };
  failWith: 'LLM_UNAVAILABLE' | 'LLM_TIMEOUT' | 'LLM_FAILED' | null = null;
  calls: { text: string; language: string | null }[] = [];

  async summarize(
    transcript: { text: string; language: string | null },
    options: { onProgress?: (ratio: number) => void } = {},
  ) {
    this.calls.push(transcript);
    if (this.failWith) throw new LlmError(this.failWith, 'fake failure');
    options.onProgress?.(0.5);
    options.onProgress?.(1);
    return this.result;
  }
}

/** AI backends wired to the fakes; `llmOff` simulates summaries turned off. */
export function fakeAi(
  transcriber: FakeTranscriber,
  summarizer: FakeSummarizer,
  state: { llmOff: boolean; format: 'wav' | 'ogg' } = { llmOff: false, format: 'wav' },
) {
  return {
    state,
    stt: () => ({ transcriber, format: state.format }),
    llm: () => (state.llmOff ? null : summarizer),
  };
}

/** Pretends to be yt-dlp: writes a file and reports metadata. */
export class FakeDownloader {
  isAvailable = true;
  failWith: string | null = null;
  blocked = false;
  result = {
    ext: 'webm',
    title: 'Talk: Building a Home Server',
    durationSeconds: 61,
    audioOnly: true,
  };
  urls: string[] = [];
  gate: Promise<void> | null = null;

  async available(): Promise<boolean> {
    return this.isAvailable;
  }

  async download(
    url: string,
    options: { dir: string; onProgress?: (ratio: number) => void; signal?: AbortSignal },
  ) {
    this.urls.push(url);
    if (this.gate) {
      options.signal?.throwIfAborted();
      await Promise.race([
        this.gate,
        new Promise((_, reject) =>
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason)),
        ),
      ]);
    }
    if (this.failWith) {
      throw this.blocked
        ? new DownloadBlockedError(this.failWith)
        : new DownloadError(this.failWith);
    }
    options.onProgress?.(0.5);
    options.onProgress?.(1);
    const file = path.join(options.dir, `download.${this.result.ext}`);
    await writeFile(file, 'downloaded media');
    return { path: file, ...this.result };
  }

  async selfUpdate(): Promise<string> {
    return 'yt-dlp is up to date';
  }
}
