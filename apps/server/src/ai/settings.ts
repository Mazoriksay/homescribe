import type { AiKind, AiSettings, UpdateAiSettingsBody } from '@homescribe/shared';
import type { Config } from '../config';
import type { Repository, StoredAiSettings } from '../db/repository';

export interface EffectiveAiSettings extends StoredAiSettings {
  source: 'env' | 'saved';
}

export class AiSettingsError extends Error {}

/**
 * Which speech-to-text and LLM backends to use: chosen in the UI and stored
 * in SQLite, or the environment defaults until then (SPEC.md §7.5).
 * API keys are write-only for clients.
 */
export class AiSettingsService {
  constructor(
    private readonly repo: Repository,
    private readonly config: Config,
  ) {}

  effective(kind: AiKind): EffectiveAiSettings {
    const saved = this.repo.getAiSettings(kind);
    if (saved) return { ...saved, source: 'saved' };
    const env = kind === 'stt' ? this.config.stt : this.config.llm;
    return {
      mode: env.mode,
      provider: null,
      baseUrl: env.baseUrl,
      model: env.model,
      apiKey: env.apiKey,
      source: 'env',
    };
  }

  public(kind: AiKind): AiSettings {
    const { apiKey, ...rest } = this.effective(kind);
    return { kind, ...rest, hasApiKey: Boolean(apiKey) };
  }

  update(kind: AiKind, body: UpdateAiSettingsBody): AiSettings {
    if (kind === 'stt' && body.mode === 'off') {
      throw new AiSettingsError('Speech-to-text cannot be turned off');
    }
    const current = this.effective(kind);
    const baseUrl = body.baseUrl ?? current.baseUrl;
    // A saved key only ever goes back to the address it was entered for, so a
    // client cannot redirect it to a server of its choosing.
    const apiKey =
      body.apiKey === undefined
        ? baseUrl === current.baseUrl
          ? current.apiKey
          : null
        : body.apiKey;
    this.repo.saveAiSettings(kind, {
      mode: body.mode,
      provider: body.provider,
      baseUrl,
      model: body.model ?? current.model,
      apiKey,
    });
    return this.public(kind);
  }

  reset(kind: AiKind): AiSettings {
    this.repo.deleteAiSettings(kind);
    return this.public(kind);
  }

  /** The saved key, but only for the address it belongs to. */
  keyFor(kind: AiKind, baseUrl: string): string | null {
    const current = this.effective(kind);
    return current.baseUrl === baseUrl ? current.apiKey : null;
  }
}
