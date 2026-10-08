import type { AiKind, AiMemory, BackendMemory, LoadedModel } from '@homescribe/shared';
import { authHeaders, httpRequest, withTimeout } from './http';
import type { Repository } from '../db/repository';
import type { AiSettingsService } from './settings';

const TIMEOUT_MS = 3000;

type Probe = { server: 'speaches' | 'ollama'; loaded: LoadedModel[] } | 'unsupported';

/**
 * `GET {baseUrl}/api/ps` answers on both servers, in different shapes:
 * speaches (`routers/misc.py`) lists model ids as strings, Ollama
 * (`docs/api.md`, "List Running Models") lists objects with `name` and
 * `size_vram`. Anything else means the server cannot unload on request.
 */
async function probe(baseUrl: string, apiKey: string | null): Promise<Probe> {
  const timer = withTimeout(TIMEOUT_MS);
  const { status, body } = await httpRequest(new URL(`${baseUrl}/api/ps`), {
    headers: { accept: 'application/json', ...authHeaders(apiKey) },
    signal: timer.signal,
    limit: 1024 * 1024,
  });
  if (status < 200 || status >= 300) return 'unsupported';
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return 'unsupported';
  }
  const models = (json as { models?: unknown }).models;
  if (!Array.isArray(models)) return 'unsupported';
  // An empty list fits both shapes; only Ollama has /api/version.
  if (models.length === 0) {
    return { server: (await isOllama(baseUrl, apiKey)) ? 'ollama' : 'speaches', loaded: [] };
  }
  if (models.every((m) => typeof m === 'string')) {
    return { server: 'speaches', loaded: models.map((model) => ({ model, vramBytes: null })) };
  }
  if (models.every((m) => typeof m === 'object' && m !== null && 'name' in m)) {
    return {
      server: 'ollama',
      loaded: (models as { name: unknown; size_vram?: unknown }[]).map((m) => ({
        model: String(m.name),
        vramBytes: typeof m.size_vram === 'number' ? m.size_vram : null,
      })),
    };
  }
  return 'unsupported';
}

async function isOllama(baseUrl: string, apiKey: string | null): Promise<boolean> {
  const timer = withTimeout(TIMEOUT_MS);
  try {
    const { status, body } = await httpRequest(new URL(`${baseUrl}/api/version`), {
      headers: { accept: 'application/json', ...authHeaders(apiKey) },
      signal: timer.signal,
      limit: 64 * 1024,
    });
    if (status < 200 || status >= 300) return false;
    return typeof (JSON.parse(body) as { version?: unknown }).version === 'string';
  } catch {
    return false;
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason as Error);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason as Error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const TAKE_TURNS = 'take_turns';

export interface AiMemoryOptions {
  repo: Pick<Repository, 'getAppSetting' | 'setAppSetting'>;
  /** Default of "take turns" (AI_TAKE_TURNS) and speaches' STT_MODEL_TTL. */
  gpu: { takeTurns: boolean; sttIdleSeconds: number };
  /** How often to look whether speaches has let Whisper go. */
  pollMs?: number;
  /** Wait after a failed model load when speaches cannot be watched. */
  fallbackWaitMs?: number;
}

async function unloadOllama(baseUrl: string, apiKey: string | null, model: string): Promise<void> {
  const timer = withTimeout(TIMEOUT_MS * 5);
  const headers = { accept: 'application/json', ...authHeaders(apiKey) };
  // Ollama: an empty generate request with keep_alive 0 unloads the model.
  const { status, body } = await httpRequest(new URL(`${baseUrl}/api/generate`), {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: 0 }),
    signal: timer.signal,
  });
  // 404: already gone, which is what was asked for.
  if (status === 404 || (status >= 200 && status < 300)) return;
  throw new Error(`HTTP ${status}: ${body.slice(0, 200)}`);
}

/** What the local AI servers hold in GPU memory, and freeing it (SPEC.md §7.5). */
export class AiMemoryService {
  constructor(
    private readonly settings: AiSettingsService,
    private readonly isBusy: () => boolean,
    private readonly options: AiMemoryOptions,
  ) {}

  /** Whisper and the summary model take turns on the GPU (SPEC.md §7.5). */
  takeTurns(): boolean {
    return this.options.repo.getAppSetting<boolean>(TAKE_TURNS) ?? this.options.gpu.takeTurns;
  }

  async setTakeTurns(enabled: boolean): Promise<AiMemory> {
    this.options.repo.setAppSetting(TAKE_TURNS, enabled);
    return this.status();
  }

  /**
   * Waits until a local speaches has unloaded Whisper by itself (its TTL),
   * at most STT_MODEL_TTL + 15 s. Returns false when there is nothing to
   * watch (not a local speaches); speaches is never asked to unload.
   */
  async waitForSttIdle(signal?: AbortSignal): Promise<boolean> {
    const { mode, baseUrl, apiKey } = this.settings.effective('stt');
    if (mode !== 'local') return false;
    const deadline = Date.now() + (this.options.gpu.sttIdleSeconds + 15) * 1000;
    for (;;) {
      const result = await probe(baseUrl, apiKey).catch(() => 'unsupported' as const);
      if (result === 'unsupported' || result.server !== 'speaches') return false;
      if (result.loaded.length === 0 || Date.now() >= deadline) return true;
      await sleep(this.options.pollMs ?? 2000, signal);
    }
  }

  /** Before a retry after a failed model load: speaches idle, else a minute. */
  async waitBeforeRetry(signal?: AbortSignal): Promise<void> {
    if (!(await this.waitForSttIdle(signal))) {
      await sleep(this.options.fallbackWaitMs ?? 60_000, signal);
    }
  }

  /** Unloads the local Ollama summary model; cloud APIs are never touched. */
  async unloadLlm(): Promise<void> {
    const { mode, baseUrl, apiKey } = this.settings.effective('llm');
    if (mode !== 'local') return;
    const result = await probe(baseUrl, apiKey).catch(() => 'unsupported' as const);
    if (result === 'unsupported' || result.server !== 'ollama') return;
    for (const { model } of result.loaded) await unloadOllama(baseUrl, apiKey, model);
  }

  private async backend(kind: AiKind): Promise<BackendMemory> {
    const { mode, baseUrl, apiKey } = this.settings.effective(kind);
    if (mode === 'off') return { state: 'off', server: null, loaded: [] };
    if (mode === 'api') return { state: 'remote', server: null, loaded: [] };
    try {
      const result = await probe(baseUrl, apiKey);
      if (result === 'unsupported') return { state: 'unsupported', server: null, loaded: [] };
      // speaches 0.8.1: DELETE /api/ps/{id} holds the manager's lock while the
      // unload callback waits for it, so it never answers and takes no more
      // transcriptions (live test 2026-10-08). Its TTL timer unloads safely.
      return { state: result.server === 'speaches' ? 'auto' : 'ok', ...result };
    } catch {
      return { state: 'unreachable', server: null, loaded: [] };
    }
  }

  async status(): Promise<AiMemory> {
    const [stt, llm] = await Promise.all([this.backend('stt'), this.backend('llm')]);
    return {
      stt,
      llm,
      busy: this.isBusy(),
      takeTurns: this.takeTurns(),
      sttIdleSeconds: this.options.gpu.sttIdleSeconds,
    };
  }

  /** Unloads every loaded model on both servers; returns what is left. */
  async unload(): Promise<{ memory: AiMemory; failed: string[] }> {
    const before = await this.status();
    const failed: string[] = [];
    for (const kind of ['stt', 'llm'] as const) {
      const backend = before[kind];
      if (backend.state !== 'ok') continue;
      const { baseUrl, apiKey } = this.settings.effective(kind);
      for (const { model } of backend.loaded) {
        try {
          await unloadOllama(baseUrl, apiKey, model);
        } catch {
          failed.push(model);
        }
      }
    }
    return { memory: await this.status(), failed };
  }
}
