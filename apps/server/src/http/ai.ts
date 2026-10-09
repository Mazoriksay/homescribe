import {
  aiKindParamsSchema,
  API_PREFIX,
  listModelsBodySchema,
  takeTurnsBodySchema,
  llmContextBodySchema,
  summarySettingsSchema,
  updateAiSettingsBodySchema,
  type AiModel,
  type Discovery,
} from '@homescribe/shared';
import type { FastifyInstance } from 'fastify';
import { ContextError, type LlmContextService } from '../ai/context';
import type { AiMemoryService } from '../ai/memory';
import type { Repository } from '../db/repository';
import { SUMMARY_INSTRUCTIONS } from '../jobs/runner';
import { AiUnreachableError } from '../ai/models';
import { AiSettingsError, type AiSettingsService } from '../ai/settings';
import { AppError, parseInput } from './errors';

export interface AiRouteDeps {
  aiSettings: AiSettingsService;
  discover: () => Promise<Discovery>;
  listModels: (baseUrl: string, apiKey: string | null) => Promise<AiModel[]>;
  onSettingsChanged?: () => void;
  memory: AiMemoryService;
  repo: Pick<Repository, 'getAppSetting' | 'setAppSetting'>;
  context: LlmContextService;
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

  app.get(`${API_PREFIX}/settings/summary`, async () => ({
    instructions: deps.repo.getAppSetting<string>(SUMMARY_INSTRUCTIONS) ?? '',
  }));

  app.put(`${API_PREFIX}/settings/summary`, async (request) => {
    const body = parseInput(summarySettingsSchema, request.body ?? {}, 'body');
    deps.repo.setAppSetting(SUMMARY_INSTRUCTIONS, body.instructions);
    return body;
  });

  app.get(`${API_PREFIX}/settings/llm-context`, async () => deps.context.status());

  app.put(`${API_PREFIX}/settings/llm-context`, async (request) => {
    const body = parseInput(llmContextBodySchema, request.body ?? {}, 'body');
    try {
      return await deps.context.set(body.value);
    } catch (error) {
      if (error instanceof ContextError) throw new AppError(400, 'VALIDATION_ERROR', error.message);
      throw error;
    }
  });

  app.put(`${API_PREFIX}/ai/take-turns`, async (request) => {
    const body = parseInput(takeTurnsBodySchema, request.body ?? {}, 'body');
    return deps.memory.setTakeTurns(body.enabled);
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
