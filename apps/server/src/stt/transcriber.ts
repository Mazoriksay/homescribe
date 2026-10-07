export type SttErrorCode = 'STT_UNAVAILABLE' | 'STT_TIMEOUT' | 'STT_FAILED';

export class SttError extends Error {
  constructor(
    readonly code: SttErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface TranscriptionResult {
  language: string | null;
  text: string;
  segments: { start: number; end: number; text: string }[];
}

/** Speech-to-text backend (OpenAI-compatible HTTP in production, a fake in tests). */
export interface Transcriber {
  /** Model name stored with the transcript. */
  readonly model: string;
  /** Transcribes a 16 kHz mono WAV file. Throws SttError on failure. */
  transcribe(wavPath: string, signal?: AbortSignal): Promise<TranscriptionResult>;
}
