import {
  aiKindParamsSchema,
  API_PREFIX,
  listModelsBodySchema,
  updateAiSettingsBodySchema,
  type AiModel,
  type Discovery,
} from '@homescribe/shared';
import type { FastifyInstance } from 'fastify';
import { AiUnreachableError } from '../ai/models';
import { AiSettingsError, type AiSettingsService } from '../ai/settings';
import { AppError, parseInput } from './errors';

export interface AiRouteDeps {
  aiSettings: AiSettingsService;
  discover: () => Promise<Discovery>;
  listModels: (baseUrl: string, apiKey: string | null) => Promise<AiModel[]>;
}

/** Choosing speech-to-text and LLM backends (SPEC.md §7.5). */
export function registerAiRoutes(app: FastifyInstance, deps: AiRouteDeps): void {
  const { aiSettings } = deps;

  app.get(`${API_PREFIX}/settings/ai`, async () => ({
    stt: aiSettings.public('stt'),
    llm: aiSettings.public('llm'),
  }));

  app.put(`${API_PREFIX}/settings/ai/:kind`, async (request) => {
    const { kind } = parseInput(aiKindParamsSchema, request.params, 'kind');
    const body = parseInput(updateAiSettingsBodySchema, request.body ?? {}, 'body');
    try {
      return aiSettings.update(kind, body);
    } catch (error) {
      if (error instanceof AiSettingsError) {
        throw new AppError(400, 'VALIDATION_ERROR', error.message);
      }
      throw error;
    }
  });

  app.delete(`${API_PREFIX}/settings/ai/:kind`, async (request) => {
    const { kind } = parseInput(aiKindParamsSchema, request.params, 'kind');
    return aiSettings.reset(kind);
  });

  app.get(`${API_PREFIX}/ai/discovery`, async () => deps.discover());

  app.post(`${API_PREFIX}/ai/models`, async (request) => {
    const body = parseInput(listModelsBodySchema, request.body ?? {}, 'body');
    const apiKey =
      body.apiKey ??
      (body.useSavedKeyFor ? aiSettings.keyFor(body.useSavedKeyFor, body.baseUrl) : null);
    try {
      return { models: await deps.listModels(body.baseUrl, apiKey) };
    } catch (error) {
      if (error instanceof AiUnreachableError) {
        throw new AppError(502, 'AI_UNREACHABLE', error.message);
      }
      throw error;
    }
  });
}
