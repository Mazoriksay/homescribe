import type { AiKind, AiModel, HealthChecks } from '@homescribe/shared';
import type { AiSettingsService } from './ai/settings';
import type { Config } from './config';
import type { MediaTool } from './media/media-tool';

export interface SelfCheckDeps {
  media: MediaTool;
  aiSettings: AiSettingsService;
  config: Config;
  listModels: (baseUrl: string, apiKey: string | null) => Promise<AiModel[]>;
  logger: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  now?: () => Date;
}

const HINTS: Record<string, string> = {
  'ffmpeg:missing':
    'Install ffmpeg (it includes ffprobe) or set FFMPEG_PATH/FFPROBE_PATH; uploads cannot be processed until then.',
  'stt:unreachable': 'Start the speech-to-text server or choose another one in Settings.',
  'stt:model_missing':
    'The speech-to-text server does not list the model; for speaches download it (POST /v1/models/<id>) or set PRELOAD_MODELS.',
  'llm:unreachable': 'Start the LLM server, choose another one in Settings, or turn summaries off.',
  'llm:model_missing':
    'The LLM server does not list the model; for Ollama run `ollama pull <model>`.',
  'embedding:same_origin':
    'FRAME_ANCESTORS is empty: only pages on this origin (e.g. a hub behind the same proxy with BASE_PATH) can embed the UI.',
};

/** Whether `model` is among `models`; Ollama lists untagged models as "<name>:latest". */
function hasModel(models: AiModel[], model: string): boolean {
  return models.some((m) => m.id === model || m.id === `${model}:latest`);
}

/**
 * Checks what the server depends on (SPEC.md §7.6): at startup, every minute
 * and after AI settings change. Logs a problem when it appears, not on every
 * round, and keeps the latest result for GET /health.
 */
export class SelfCheck {
  latest: { checks: HealthChecks; checkedAt: string } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<HealthChecks> | null = null;

  constructor(private readonly deps: SelfCheckDeps) {}

  /** Runs one round; concurrent calls share it. */
  run(): Promise<HealthChecks> {
    this.running ??= this.check().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  start(intervalMs = 60_000): void {
    void this.run();
    this.timer = setInterval(() => void this.run(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async check(): Promise<HealthChecks> {
    const [ffmpeg, stt, llm] = await Promise.all([
      this.deps.media.available().then((ok) => (ok ? 'ok' : 'missing') as HealthChecks['ffmpeg']),
      this.checkAi('stt') as Promise<HealthChecks['stt']>,
      this.checkAi('llm'),
    ]);
    const checks: HealthChecks = {
      ffmpeg,
      stt,
      llm,
      embedding: this.deps.config.frameAncestors.length > 0 ? 'origins' : 'same_origin',
    };
    this.report(checks);
    this.latest = { checks, checkedAt: (this.deps.now?.() ?? new Date()).toISOString() };
    return checks;
  }

  private async checkAi(kind: AiKind): Promise<HealthChecks['llm']> {
    const settings = this.deps.aiSettings.effective(kind);
    if (settings.mode === 'off') return 'off';
    try {
      const models = await this.deps.listModels(settings.baseUrl, settings.apiKey);
      return hasModel(models, settings.model) ? 'ok' : 'model_missing';
    } catch {
      return 'unreachable';
    }
  }

  private report(checks: HealthChecks): void {
    const previous = this.latest?.checks;
    for (const [name, state] of Object.entries(checks)) {
      if (previous?.[name as keyof HealthChecks] === state) continue;
      const hint = HINTS[`${name}:${state}`];
      const detail = {
        check: name,
        state,
        ...(name === 'stt' || name === 'llm'
          ? {
              baseUrl: this.deps.aiSettings.effective(name).baseUrl,
              model: this.deps.aiSettings.effective(name).model,
            }
          : {}),
      };
      if (name === 'embedding') {
        if (!previous) this.deps.logger.info({ ...detail, hint }, 'self-check: embedding');
      } else if (state === 'ok' || state === 'off') {
        if (previous) this.deps.logger.info(detail, `self-check: ${name} recovered`);
      } else {
        this.deps.logger.warn({ ...detail, hint }, `self-check: ${name} ${state}`);
      }
    }
  }
}
