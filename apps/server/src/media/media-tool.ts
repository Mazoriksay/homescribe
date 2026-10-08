export class MediaError extends Error {}

/**
 * `wav`: lossless 16-bit PCM for local servers. `ogg`: Opus at 32 kbit/s for
 * cloud APIs, whose uploads are capped (about 25 MB, roughly 1.5 hours of Opus
 * versus 13 minutes of WAV).
 */
export type AudioFormat = 'wav' | 'ogg';

export interface ConvertOptions {
  format: AudioFormat;
  /** Used to turn ffmpeg's position into a 0..1 ratio; null = no progress. */
  durationSeconds: number | null;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

export interface CutOptions {
  /** Seconds from the start of the input. */
  start: number;
  end: number;
  format: AudioFormat;
  signal?: AbortSignal;
}

/** A pause in the audio, in seconds. */
export interface Silence {
  start: number;
  end: number;
}

/** Media inspection and conversion (ffmpeg in production, a fake in tests). */
export interface MediaTool {
  /** True when the binaries can be run (self-check). */
  available(): Promise<boolean>;
  /** Duration in seconds, or null when the container does not say. Throws MediaError if unreadable. */
  probeDuration(input: string, signal?: AbortSignal): Promise<number | null>;
  /** Writes 16 kHz mono audio in the requested format to `output`. Throws MediaError on failure. */
  convertAudio(input: string, output: string, options: ConvertOptions): Promise<void>;
  /** Pauses of at least half a second, in order. Throws MediaError on failure. */
  findSilences(input: string, signal?: AbortSignal): Promise<Silence[]>;
  /** Writes `start`..`end` of a 16 kHz mono input to `output`. Throws MediaError on failure. */
  cutAudio(input: string, output: string, options: CutOptions): Promise<void>;
}
