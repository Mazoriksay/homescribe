import type { Config } from '../config';
import type { AiBackends } from '../jobs/runner';
import type { ChunkPlan } from '../stt/chunks';
import { OpenAiSummarizer } from '../llm/openai-summarizer';
import { OpenAiTranscriber } from '../stt/openai-transcriber';
import type { LlmContextService } from './context';
import type { AiSettingsService } from './settings';

/**
 * Parts for a speaches in batched mode: it transcribes 30-second windows in
 * parallel and independently, so long parts are fast and cannot carry a
 * loop from one window into the next (SPEC.md §7.5).
 */
export const BATCHED_CHUNKING: ChunkPlan = { target: 600, slack: 60 };

/** Builds clients from the current settings, so a change applies from the next job on. */
export function createAiBackends(
  settings: AiSettingsService,
  config: Config,
  context?: LlmContextService,
): AiBackends {
  return {
    stt() {
      const s = settings.effective('stt');
      // Only the bundled server is known to run batched; others keep minute parts.
      const batched = s.mode === 'local' && config.stt.batched && s.baseUrl === config.stt.baseUrl;
      return {
        transcriber: new OpenAiTranscriber({
          baseUrl: s.baseUrl,
          model: s.model,
          apiKey: s.apiKey,
          language: config.stt.language,
          timeoutMs: config.stt.timeoutMs,
          // A speaches extension; cloud APIs get only the standard OpenAI fields.
          // Batched mode cuts the audio by voice activity, so it needs the filter.
          vadFilter: s.mode === 'local' && (config.stt.vadFilter || batched),
          // Its segments are whole windows; sentences come from word times.
          sentenceSegments: batched,
        }),
        // Cloud APIs cap uploads (~25 MB); compressed audio fits far longer recordings.
        format: s.mode === 'api' ? 'ogg' : 'wav',
        ...(batched && { chunking: BATCHED_CHUNKING }),
      };
    },
    llm() {
      const s = settings.effective('llm');
      if (s.mode === 'off') return null;
      return new OpenAiSummarizer({
        baseUrl: s.baseUrl,
        model: s.model,
        apiKey: s.apiKey,
        timeoutMs: config.llm.timeoutMs,
        chunkChars: config.llm.chunkChars,
        // A chosen window goes to Ollama's own API; the part size follows it (SPEC.md §7.5).
        ollamaContext: context?.chosen() ?? null,
        window: context ? () => context.window() : undefined,
      });
    },
  };
}
