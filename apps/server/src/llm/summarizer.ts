export type LlmErrorCode = 'LLM_UNAVAILABLE' | 'LLM_TIMEOUT' | 'LLM_FAILED';

export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface SummaryResult {
  /** Markdown. */
  summary: string;
  actionItems: string[];
}

export interface SummarizeOptions {
  signal?: AbortSignal;
  onProgress?: (ratio: number) => void;
}

/** Summarizing LLM (OpenAI-compatible chat in production, a fake in tests). */
export interface Summarizer {
  readonly model: string;
  summarize(
    transcript: { text: string; language: string | null },
    options?: SummarizeOptions,
  ): Promise<SummaryResult>;
}
