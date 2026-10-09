/**
 * Choosing the AI backends (SPEC.md §7.5): speech-to-text (`stt`) and the
 * summarizing LLM (`llm`). Both speak the OpenAI-compatible HTTP API.
 */
import { z } from 'zod';

export const aiKinds = ['stt', 'llm'] as const;
export const aiKindSchema = z.enum(aiKinds);
export type AiKind = z.infer<typeof aiKindSchema>;

/** `local`: a server on this machine or LAN. `api`: a cloud API with a key. `off`: LLM only. */
export const aiModes = ['local', 'api', 'off'] as const;
export const aiModeSchema = z.enum(aiModes);
export type AiMode = z.infer<typeof aiModeSchema>;

/** http(s) base URL without credentials, query or fragment; `/v1/...` is appended. */
export const baseUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(500)
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  }, 'Use a plain http(s) address without credentials, query or fragment')
  .transform((value) => value.replace(/\/+$/, '').replace(/\/v1$/, ''));

export const aiSettingsSchema = z.object({
  kind: aiKindSchema,
  mode: aiModeSchema,
  /** Preset id for cloud APIs (`openai`, `groq`, ...) or null. */
  provider: z.string().nullable(),
  baseUrl: z.string(),
  model: z.string(),
  hasApiKey: z.boolean(),
  /** `env`: defaults from environment variables; `saved`: chosen in the UI. */
  source: z.enum(['env', 'saved']),
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;

export const aiSettingsPairSchema = z.object({ stt: aiSettingsSchema, llm: aiSettingsSchema });
export type AiSettingsPair = z.infer<typeof aiSettingsPairSchema>;

export const updateAiSettingsBodySchema = z
  .object({
    mode: aiModeSchema,
    provider: z.string().max(40).nullable().default(null),
    baseUrl: baseUrlSchema.optional(),
    model: z.string().trim().min(1).max(200).optional(),
    /** Omit to keep the saved key (only if the address is unchanged), null to remove it. */
    apiKey: z.string().trim().min(1).max(500).nullable().optional(),
  })
  .refine((body) => body.mode === 'off' || (body.baseUrl && body.model), {
    message: 'baseUrl and model are required unless mode is off',
  });
export type UpdateAiSettingsBody = z.infer<typeof updateAiSettingsBodySchema>;

export const aiKindParamsSchema = z.object({ kind: aiKindSchema });

// ---------------------------------------------------------------- models and discovery

export const aiModelSchema = z.object({
  id: z.string(),
  /** Best guess from the model id/task; `null` when it cannot be told. */
  kind: aiKindSchema.nullable(),
});
export type AiModel = z.infer<typeof aiModelSchema>;

export const listModelsBodySchema = z.object({
  baseUrl: baseUrlSchema,
  apiKey: z.string().trim().min(1).max(500).optional(),
  /** Reuse the key saved for this kind (only sent if `baseUrl` is the saved one). */
  useSavedKeyFor: aiKindSchema.optional(),
});
export type ListModelsBody = z.infer<typeof listModelsBodySchema>;

export const modelListSchema = z.object({ models: z.array(aiModelSchema) });
export type ModelList = z.infer<typeof modelListSchema>;

export const discoveredServerSchema = z.object({
  baseUrl: z.string(),
  /** Likely product, guessed from the port (e.g. "Ollama"); null if unknown. */
  product: z.string().nullable(),
  models: z.array(aiModelSchema),
});
export type DiscoveredServer = z.infer<typeof discoveredServerSchema>;

export const discoverySchema = z.object({
  servers: z.array(discoveredServerSchema),
  /** Every address that was probed, so the UI can say where it looked. */
  probed: z.array(z.string()),
});
export type Discovery = z.infer<typeof discoverySchema>;

// ---------------------------------------------------------------- video memory

export const loadedModelSchema = z.object({
  model: z.string(),
  /** GPU memory it holds, when the server says (Ollama does, speaches does not). */
  vramBytes: z.number().nonnegative().nullable(),
  /** Whole size; above vramBytes means part of it runs on the CPU (Ollama). */
  sizeBytes: z.number().nonnegative().nullable().optional(),
});
export type LoadedModel = z.infer<typeof loadedModelSchema>;

/**
 * - `ok`: a local server that can unload on request (Ollama)
 * - `auto`: it unloads by itself after a few idle minutes and must not be
 *   asked to (speaches 0.8.1 hangs on `DELETE /api/ps` and then takes no work)
 * - `unsupported`: a local server without that API (LM Studio, llama.cpp, ...)
 * - `unreachable`: the server did not answer
 * - `remote`: a cloud API, nothing to free here
 * - `off`: summaries are turned off
 */
export const backendMemoryStates = [
  'ok',
  'auto',
  'unsupported',
  'unreachable',
  'remote',
  'off',
] as const;

export const backendMemorySchema = z.object({
  state: z.enum(backendMemoryStates),
  server: z.enum(['speaches', 'ollama']).nullable(),
  loaded: z.array(loadedModelSchema),
});
export type BackendMemory = z.infer<typeof backendMemorySchema>;

export const aiMemorySchema = z.object({
  stt: backendMemorySchema,
  llm: backendMemorySchema,
  /** A job is running: unloading would fail or slow it down. */
  busy: z.boolean(),
  /** Whisper and the summary model take turns on the GPU (SPEC.md §7.5). */
  takeTurns: z.boolean(),
  /** How long speaches keeps Whisper after use (STT_MODEL_TTL). */
  sttIdleSeconds: z.number().int().nonnegative(),
});
export type AiMemory = z.infer<typeof aiMemorySchema>;

export const aiUnloadResultSchema = aiMemorySchema.extend({
  /** Models the server refused or failed to unload. */
  failed: z.array(z.string()),
});
export type AiUnloadResult = z.infer<typeof aiUnloadResultSchema>;

export const takeTurnsBodySchema = z.object({ enabled: z.boolean() });
export type TakeTurnsBody = z.infer<typeof takeTurnsBodySchema>;

/** Well-known local ports of OpenAI-compatible servers, probed by discovery. */
export const localServerPorts: readonly { port: number; product: string }[] = [
  { port: 11434, product: 'Ollama' },
  { port: 1234, product: 'LM Studio' },
  { port: 8000, product: 'speaches / vLLM' },
  { port: 8080, product: 'llama.cpp / LocalAI' },
  { port: 1337, product: 'Jan' },
  { port: 5000, product: 'text-generation-webui' },
];

// ---------------------------------------------------------------- cloud presets

export interface AiPreset {
  id: string;
  name: string;
  baseUrl: string;
  /** Suggested model per kind; a preset without an entry does not offer that kind. */
  models: Partial<Record<AiKind, string>>;
  keyUrl: string;
}

/**
 * Cloud APIs known to work. All are OpenAI-compatible; speech-to-text needs
 * `verbose_json` with segment timestamps, which these STT models return.
 */
export const aiPresets: readonly AiPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    models: { stt: 'whisper-1', llm: 'gpt-4o-mini' },
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai',
    models: { stt: 'whisper-large-v3', llm: 'llama-3.3-70b-versatile' },
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api',
    models: { llm: 'openai/gpt-4o-mini' },
    keyUrl: 'https://openrouter.ai/keys',
  },
];

const STT_MODEL = /whisper|parakeet|canary|transcrib|speech-to-text|\basr\b/i;
const NOT_CHAT = /embed|tts|kokoro|piper|rerank|bark|xtts|clip|vision-encoder/i;

/** Guesses whether a listed model is speech-to-text, a chat LLM, or neither. */
export function classifyModel(id: string, task?: string | null): AiKind | null {
  if (task) {
    if (task === 'automatic-speech-recognition') return 'stt';
    if (task === 'text-generation' || task === 'chat') return 'llm';
    return null;
  }
  if (STT_MODEL.test(id)) return 'stt';
  if (NOT_CHAT.test(id)) return null;
  return 'llm';
}

// ---------------------------------------------------------------- context window

export const CONTEXT_MIN = 2048;
/** Above this a typed size is refused when the model does not say its own maximum. */
export const CONTEXT_FALLBACK_MAX = 262_144;
export const CONTEXT_PRESETS = [4096, 8192, 16384, 32768, 65536, 131072, 262144] as const;

/** Settings → Summaries → Context window (SPEC.md §7.5). */
export const llmContextSchema = z.object({
  supported: z.boolean(),
  value: z.number().int().nullable(),
  min: z.number().int(),
  max: z.number().int().nullable(),
  presets: z.array(z.number().int()),
  loaded: z.number().int().nullable(),
  chunkChars: z.number().int(),
});
export type LlmContext = z.infer<typeof llmContextSchema>;

export const llmContextBodySchema = z.object({
  value: z.number().int().positive().nullable(),
});
export type LlmContextBody = z.infer<typeof llmContextBodySchema>;

/** Part size for a window: 0.3 of it for the transcript, ~3.3 characters per token. */
export function chunkCharsForWindow(tokens: number): number {
  return Math.max(1000, Math.round((tokens * 0.3 * 3.3) / 100) * 100);
}
