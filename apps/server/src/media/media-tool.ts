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

/** Media inspection and conversion (ffmpeg in production, a fake in tests). */
export interface MediaTool {
  /** Duration in seconds, or null when the container does not say. Throws MediaError if unreadable. */
  probeDuration(input: string, signal?: AbortSignal): Promise<number | null>;
  /** Writes 16 kHz mono audio in the requested format to `output`. Throws MediaError on failure. */
  convertAudio(input: string, output: string, options: ConvertOptions): Promise<void>;
}
