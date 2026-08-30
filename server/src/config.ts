import { z } from 'zod';

/** `"true"` is the only truthy spelling — plain `z.coerce.boolean()` would make
 *  the string `"false"` true, which is the classic env-var footgun. */
const envBool = (fallback: 'true' | 'false') =>
  z.enum(['true', 'false']).default(fallback).transform((v) => v === 'true');

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGO_URI: z.string().min(1, 'is required'),

  JWT_SECRET: z.string().min(16, 'must be at least 16 characters'),
  JWT_REFRESH_SECRET: z.string().min(16, 'must be at least 16 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  /** AES-256-GCM key for AiProviderConfig.apiKeyEnc — 32 bytes, hex-encoded. */
  SETTINGS_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)'),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  COOKIE_SECURE: envBool('false'),
  TRUST_PROXY: envBool('false'),

  PRICING_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(300_000),
  DASHBOARD_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(60_000),
  AI_SEARCH_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(86_400_000),

  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_USAGE_MAX: z.coerce.number().int().positive().default(240),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Parses and validates process env. Throws with every problem listed at once
 * rather than one-at-a-time, so a misconfigured deploy is fixed in one pass.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
