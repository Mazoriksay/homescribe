import {
  chunkCharsForWindow,
  CONTEXT_FALLBACK_MAX,
  CONTEXT_MIN,
  CONTEXT_PRESETS,
  type LlmContext,
} from '@homescribe/shared';
import type { Repository } from '../db/repository';
import { authHeaders, httpRequest, withTimeout } from './http';
import { isOllama } from './memory';
import type { AiSettingsService } from './settings';

const TIMEOUT_MS = 3000;
const KEY = 'llm_context';
/** What Ollama gives a model on a 16 GB card when nothing else is said. */
const ASSUMED_WINDOW = 4096;

interface Stored {
  baseUrl: string;
  model: string;
  value: number;
}

export class ContextError extends Error {}

async function ollamaJson(
  baseUrl: string,
  apiKey: string | null,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const timer = withTimeout(TIMEOUT_MS);
  const { status, body: text } = await httpRequest(new URL(`${baseUrl}${path}`), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...authHeaders(apiKey),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: timer.signal,
    limit: 8 * 1024 * 1024,
  });
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
  return JSON.parse(text) as unknown;
}

/** The model's own maximum: `details.context_length`, else `<arch>.context_length`. */
export async function ollamaModelMax(
  baseUrl: string,
  apiKey: string | null,
  model: string,
): Promise<number | null> {
  try {
    const show = (await ollamaJson(baseUrl, apiKey, '/api/show', { model })) as {
      details?: { context_length?: unknown };
      model_info?: Record<string, unknown>;
    };
    if (typeof show.details?.context_length === 'number') return show.details.context_length;
    const entry = Object.entries(show.model_info ?? {}).find(([key]) =>
      key.endsWith('.context_length'),
    );
    return typeof entry?.[1] === 'number' ? entry[1] : null;
  } catch {
    return null;
  }
}

/** The window Ollama gave the model it holds now, if it holds it. */
export async function ollamaLoadedWindow(
  baseUrl: string,
  apiKey: string | null,
  model: string,
): Promise<number | null> {
  try {
    const ps = (await ollamaJson(baseUrl, apiKey, '/api/ps')) as {
      models?: { name?: string; model?: string; context_length?: unknown }[];
    };
    const entry = ps.models?.find((m) => m.name === model || m.model === model);
    return typeof entry?.context_length === 'number' && entry.context_length > 0
      ? entry.context_length
      : null;
  } catch {
    return null;
  }
}

/** Settings → Summaries → Context window, for a local Ollama (SPEC.md §7.5). */
export class LlmContextService {
  constructor(
    private readonly settings: AiSettingsService,
    private readonly repo: Pick<Repository, 'getAppSetting' | 'setAppSetting'>,
    /** LLM_CHUNK_CHARS when set by hand. */
    private readonly fixedChunkChars: number | null,
  ) {}

  /** The chosen size, if it was chosen for the summary server and model in use. */
  chosen(): number | null {
    const { mode, baseUrl, model } = this.settings.effective('llm');
    const stored = this.repo.getAppSetting<Stored>(KEY);
    if (mode !== 'local' || !stored) return null;
    return stored.baseUrl === baseUrl && stored.model === model ? stored.value : null;
  }

  /** The window the next summary works with, for the part size. */
  async window(): Promise<number> {
    const chosen = this.chosen();
    if (chosen) return chosen;
    const { mode, baseUrl, apiKey, model } = this.settings.effective('llm');
    if (mode !== 'local') return ASSUMED_WINDOW;
    return (await ollamaLoadedWindow(baseUrl, apiKey, model)) ?? ASSUMED_WINDOW;
  }

  chunkChars(window: number): number {
    return this.fixedChunkChars ?? chunkCharsForWindow(window);
  }

  async status(): Promise<LlmContext> {
    const { mode, baseUrl, apiKey, model } = this.settings.effective('llm');
    const supported = mode === 'local' && (await isOllama(baseUrl, apiKey));
    const max = supported ? await ollamaModelMax(baseUrl, apiKey, model) : null;
    const loaded = supported ? await ollamaLoadedWindow(baseUrl, apiKey, model) : null;
    const value = supported ? this.chosen() : null;
    const window = value ?? loaded ?? ASSUMED_WINDOW;
    return {
      supported,
      value,
      min: CONTEXT_MIN,
      max,
      presets: CONTEXT_PRESETS.filter((size) => size <= (max ?? CONTEXT_FALLBACK_MAX)),
      loaded,
      chunkChars: this.chunkChars(window),
    };
  }

  /** Stores a size for the current server and model; null goes back to Ollama's own. */
  async set(value: number | null): Promise<LlmContext> {
    const { baseUrl, model } = this.settings.effective('llm');
    const current = await this.status();
    if (value !== null) {
      if (!current.supported) {
        throw new ContextError('The context window can be set only for a local Ollama');
      }
      const max = current.max ?? CONTEXT_FALLBACK_MAX;
      if (value < CONTEXT_MIN || value > max) {
        throw new ContextError(`The context window must be between ${CONTEXT_MIN} and ${max}`);
      }
    }
    this.repo.setAppSetting(KEY, value === null ? null : { baseUrl, model, value });
    return this.status();
  }
}
