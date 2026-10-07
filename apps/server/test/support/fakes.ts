import { writeFile } from 'node:fs/promises';
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
  readonly converted: { input: string; output: string }[] = [];

  async probeDuration(): Promise<number | null> {
    if (this.failWith) throw new MediaError(this.failWith);
    return this.duration;
  }

  async convertToWav(input: string, output: string, options: ConvertOptions): Promise<void> {
    if (this.failWith) throw new MediaError(this.failWith);
    options.onProgress?.(0.5);
    options.onProgress?.(1);
    await writeFile(output, 'RIFF');
    this.converted.push({ input, output });
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
