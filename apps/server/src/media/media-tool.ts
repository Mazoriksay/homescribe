export class MediaError extends Error {}

export interface ConvertOptions {
  /** Used to turn ffmpeg's position into a 0..1 ratio; null = no progress. */
  durationSeconds: number | null;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

/** Media inspection and conversion (ffmpeg in production, a fake in tests). */
export interface MediaTool {
  /** Duration in seconds, or null when the container does not say. Throws MediaError if unreadable. */
  probeDuration(input: string, signal?: AbortSignal): Promise<number | null>;
  /** Writes 16 kHz mono 16-bit PCM WAV to `output`. Throws MediaError on failure. */
  convertToWav(input: string, output: string, options: ConvertOptions): Promise<void>;
}
