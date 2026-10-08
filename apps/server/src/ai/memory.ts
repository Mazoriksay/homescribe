import type { AiKind, AiMemory, BackendMemory, LoadedModel } from '@homescribe/shared';
import { authHeaders, httpRequest, withTimeout } from './http';
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
  ) {}

  private async backend(kind: AiKind): Promise<BackendMemory> {
    const { mode, baseUrl, apiKey } = this.settings.effective(kind);
    if (mode === 'off') return { state: 'off', server: null, loaded: [] };
    if (mode === 'api') return { state: 'remote', server: null, loaded: [] };
    try {
      const result = await probe(baseUrl, apiKey);
      if (result === 'unsupported') return { state: 'unsupported', server: null, loaded: [] };
      // speaches 0.8.1: DELETE /api/ps/{id} unloads, then never answers and
      // takes no more transcriptions until restarted (live test 2026-10-08).
      // It unloads idle models by itself (stt_model_ttl, 5 min), so leave it.
      return { state: result.server === 'speaches' ? 'auto' : 'ok', ...result };
    } catch {
      return { state: 'unreachable', server: null, loaded: [] };
    }
  }

  async status(): Promise<AiMemory> {
    const [stt, llm] = await Promise.all([this.backend('stt'), this.backend('llm')]);
    return { stt, llm, busy: this.isBusy() };
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
