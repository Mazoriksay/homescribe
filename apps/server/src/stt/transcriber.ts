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

export interface TranscribeOptions {
  /** Overrides the configured language (e.g. the one detected on the first chunk). */
  language?: string | null;
  /** Sampling temperature; a retry raises it to get Whisper out of a loop. */
  temperature?: number;
}

/** Speech-to-text backend (OpenAI-compatible HTTP in production, a fake in tests). */
export interface Transcriber {
  /** Model name stored with the transcript. */
  readonly model: string;
  /** Transcribes a 16 kHz mono audio file as is (no clean-up). Throws SttError on failure. */
  transcribe(
    audioPath: string,
    signal?: AbortSignal,
    options?: TranscribeOptions,
  ): Promise<TranscriptionResult>;
}
