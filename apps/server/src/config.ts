import path from 'node:path';
import { z } from 'zod';
import { isValidCidr } from './network';

export class ConfigError extends Error {}

const DEFAULT_ALLOWED_NETWORKS =
  '127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7,fe80::/10';

/** A bare http(s) origin: scheme, host, optional port; nothing that could extend a CSP. */
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i;

/** Host name, IPv4 address or bracketed IPv6 address; no scheme, port or path. */
const HOST = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/i;

/** Empty strings count as "not set", so `.env` files can list a key without a value. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

const url = z.url({ protocol: /^https?$/ }).transform((value) => value.replace(/\/+$/, ''));

const envSchema = z.object({
  HOST: optional(z.string().default('0.0.0.0')),
  PORT: optional(z.coerce.number().int().min(1).max(65535).default(8080)),
  DATA_DIR: optional(z.string().default('./data')),
  ALLOWED_NETWORKS: optional(
    z
      .string()
      .default(DEFAULT_ALLOWED_NETWORKS)
      .transform((value) =>
        value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      )
      .refine((list) => list.length > 0 && list.every(isValidCidr), {
        message: 'expected a comma-separated list of CIDR networks, e.g. 192.168.0.0/16',
      }),
  ),
  MAX_UPLOAD_MB: optional(z.coerce.number().positive().default(2048)),
  FFMPEG_PATH: optional(z.string().default('ffmpeg')),
  FFPROBE_PATH: optional(z.string().default('ffprobe')),
  STT_MODE: optional(z.enum(['local', 'api']).default('local')),
  STT_BASE_URL: optional(url.default('http://localhost:8000')),
  STT_MODEL: optional(z.string().default('Systran/faster-whisper-large-v3')),
  STT_LANGUAGE: optional(
    z
      .string()
      .regex(/^[a-z]{2,3}$/)
      .optional(),
  ),
  STT_API_KEY: optional(z.string().optional()),
  STT_TIMEOUT_MS: optional(z.coerce.number().int().positive().default(3_600_000)),
  LLM_MODE: optional(z.enum(['local', 'api', 'off']).default('local')),
  LLM_BASE_URL: optional(url.default('http://localhost:11434')),
  LLM_MODEL: optional(z.string().default('llama3.1:8b')),
  LLM_API_KEY: optional(z.string().optional()),
  LLM_TIMEOUT_MS: optional(z.coerce.number().int().positive().default(600_000)),
  LLM_CHUNK_CHARS: optional(z.coerce.number().int().min(1000).default(12_000)),
  AI_DISCOVERY_HOSTS: optional(
    z
      .string()
      .default('localhost,host.docker.internal')
      .transform((value) =>
        value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      )
      .refine((list) => list.every((host) => HOST.test(host)), {
        message: 'expected comma-separated host names or IP addresses',
      }),
  ),
  WEB_DIST_DIR: optional(z.string().optional()),
  BASE_PATH: optional(
    z
      .string()
      .default('')
      .transform((value) => value.trim().replace(/\/+$/, ''))
      .refine((value) => /^(?:\/[A-Za-z0-9._~-]+)*$/.test(value), {
        message: 'expected a path such as /homescribe (letters, digits, . _ ~ -)',
      }),
  ),
  FRAME_ANCESTORS: optional(
    z
      .string()
      .default('')
      .transform((value) => value.split(/\s+/).filter(Boolean))
      .refine((list) => list.every((item) => ORIGIN.test(item)), {
        message: 'expected space-separated origins such as http://hub.lan:3000',
      }),
  ),
  LOG_LEVEL: optional(
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ),
});

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  allowedNetworks: string[];
  maxUploadBytes: number;
  ffmpegPath: string;
  ffprobePath: string;
  /** Defaults until a backend is chosen in the UI (SPEC.md §7.5). */
  stt: {
    mode: 'local' | 'api';
    baseUrl: string;
    model: string;
    language: string | null;
    apiKey: string | null;
    timeoutMs: number;
  };
  llm: {
    mode: 'local' | 'api' | 'off';
    baseUrl: string;
    model: string;
    apiKey: string | null;
    timeoutMs: number;
    /** Transcripts longer than this are summarized in parts, then combined. */
    chunkChars: number;
  };
  /** Hosts probed for local AI servers. */
  discoveryHosts: string[];
  webDistDir: string;
  /** Path everything is served under, e.g. "/homescribe"; "" for the root. */
  basePath: string;
  /** Origins allowed to show the UI in an iframe, besides the app itself. */
  frameAncestors: string[];
  logLevel: string;
}

/**
 * Parses configuration from environment variables (SPEC.md §9). Relative
 * paths are resolved against `rootDir`, the repository root.
 */
export function loadConfig(env: Record<string, string | undefined>, rootDir: string): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  const e = parsed.data;
  return {
    host: e.HOST,
    port: e.PORT,
    dataDir: path.resolve(rootDir, e.DATA_DIR),
    allowedNetworks: e.ALLOWED_NETWORKS,
    maxUploadBytes: Math.floor(e.MAX_UPLOAD_MB * 1024 * 1024),
    ffmpegPath: e.FFMPEG_PATH,
    ffprobePath: e.FFPROBE_PATH,
    stt: {
      mode: e.STT_MODE,
      baseUrl: e.STT_BASE_URL,
      model: e.STT_MODEL,
      language: e.STT_LANGUAGE ?? null,
      apiKey: e.STT_API_KEY ?? null,
      timeoutMs: e.STT_TIMEOUT_MS,
    },
    llm: {
      mode: e.LLM_MODE,
      baseUrl: e.LLM_BASE_URL,
      model: e.LLM_MODEL,
      apiKey: e.LLM_API_KEY ?? null,
      timeoutMs: e.LLM_TIMEOUT_MS,
      chunkChars: e.LLM_CHUNK_CHARS,
    },
    discoveryHosts: e.AI_DISCOVERY_HOSTS,
    webDistDir: path.resolve(rootDir, e.WEB_DIST_DIR ?? 'apps/web/dist'),
    basePath: e.BASE_PATH,
    frameAncestors: e.FRAME_ANCESTORS,
    logLevel: e.LOG_LEVEL,
  };
}
