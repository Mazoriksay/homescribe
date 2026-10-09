import type { Config } from '../config';
import type { AiBackends } from '../jobs/runner';
import { OpenAiSummarizer } from '../llm/openai-summarizer';
import { OpenAiTranscriber } from '../stt/openai-transcriber';
import type { LlmContextService } from './context';
import type { AiSettingsService } from './settings';

/** Builds clients from the current settings, so a change applies from the next job on. */
export function createAiBackends(
  settings: AiSettingsService,
  config: Config,
  context?: LlmContextService,
): AiBackends {
  return {
    stt() {
      const s = settings.effective('stt');
      return {
        transcriber: new OpenAiTranscriber({
          baseUrl: s.baseUrl,
          model: s.model,
          apiKey: s.apiKey,
          language: config.stt.language,
          timeoutMs: config.stt.timeoutMs,
          // A speaches extension; cloud APIs get only the standard OpenAI fields.
          vadFilter: s.mode === 'local' && config.stt.vadFilter,
        }),
        // Cloud APIs cap uploads (~25 MB); compressed audio fits far longer recordings.
        format: s.mode === 'api' ? 'ogg' : 'wav',
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
