import {
  aiKindParamsSchema,
  API_PREFIX,
  listModelsBodySchema,
  updateAiSettingsBodySchema,
  type AiModel,
  type Discovery,
} from '@homescribe/shared';
import type { FastifyInstance } from 'fastify';
import type { AiMemoryService } from '../ai/memory';
import { AiUnreachableError } from '../ai/models';
import { AiSettingsError, type AiSettingsService } from '../ai/settings';
import { AppError, parseInput } from './errors';

export interface AiRouteDeps {
  aiSettings: AiSettingsService;
  discover: () => Promise<Discovery>;
  listModels: (baseUrl: string, apiKey: string | null) => Promise<AiModel[]>;
  onSettingsChanged?: () => void;
  memory: AiMemoryService;
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
      const saved = aiSettings.update(kind, body);
      deps.onSettingsChanged?.();
      return saved;
    } catch (error) {
      if (error instanceof AiSettingsError) {
        throw new AppError(400, 'VALIDATION_ERROR', error.message);
      }
      throw error;
    }
  });

  app.delete(`${API_PREFIX}/settings/ai/:kind`, async (request) => {
    const { kind } = parseInput(aiKindParamsSchema, request.params, 'kind');
    const reset = aiSettings.reset(kind);
    deps.onSettingsChanged?.();
    return reset;
  });

  app.get(`${API_PREFIX}/ai/discovery`, async () => deps.discover());

  app.get(`${API_PREFIX}/ai/memory`, async () => deps.memory.status());

  app.post(`${API_PREFIX}/ai/unload`, async () => {
    const status = await deps.memory.status();
    if (status.busy) {
      // speaches refuses to unload a model in use (409), and it would load again anyway.
      throw new AppError(409, 'JOB_ACTIVE', 'Wait for the current job or cancel it first');
    }
    const { memory, failed } = await deps.memory.unload();
    return { ...memory, failed };
  });

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
