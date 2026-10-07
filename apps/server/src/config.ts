import path from 'node:path';
import { z } from 'zod';
import { isValidCidr } from './network';

export class ConfigError extends Error {}

const DEFAULT_ALLOWED_NETWORKS =
  '127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7,fe80::/10';

/** Empty strings count as "not set", so `.env` files can list a key without a value. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

const url = z
  .url({ protocol: /^https?$/ })
  .transform((value) => value.replace(/\/+$/, ''));

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
  STT_BASE_URL: optional(url.default('http://localhost:8000')),
  STT_MODEL: optional(z.string().default('Systran/faster-whisper-large-v3')),
  STT_LANGUAGE: optional(z.string().regex(/^[a-z]{2,3}$/).optional()),
  STT_API_KEY: optional(z.string().optional()),
  STT_TIMEOUT_MS: optional(z.coerce.number().int().positive().default(3_600_000)),
  WEB_DIST_DIR: optional(z.string().optional()),
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
  stt: {
    baseUrl: string;
    model: string;
    language: string | null;
    apiKey: string | null;
    timeoutMs: number;
  };
  webDistDir: string;
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
      baseUrl: e.STT_BASE_URL,
      model: e.STT_MODEL,
      language: e.STT_LANGUAGE ?? null,
      apiKey: e.STT_API_KEY ?? null,
      timeoutMs: e.STT_TIMEOUT_MS,
    },
    webDistDir: path.resolve(rootDir, e.WEB_DIST_DIR ?? 'apps/web/dist'),
    logLevel: e.LOG_LEVEL,
  };
}
