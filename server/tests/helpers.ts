import type { Express } from 'express';
import request from 'supertest';
import { createApp, type AppDeps } from '../src/app.js';
import type { TtlCache } from '../src/cache.js';
import { loadConfig, type Config } from '../src/config.js';
import { encryptSecret, generateApiToken, hashPassword } from '../src/crypto.js';
import { ApiToken, ModelPricing, User, type Role } from '../src/models.js';
import type { Broadcaster } from '../src/realtime.js';

export const TEST_ENV = {
  NODE_ENV: 'test',
  MONGO_URI: 'mongodb://unused-in-tests/db',
  JWT_SECRET: 'test-jwt-secret-value-long-enough',
  JWT_REFRESH_SECRET: 'test-refresh-secret-value-long-enough',
  SETTINGS_ENCRYPTION_KEY: 'a'.repeat(64),
  // High enough that the rate limiters never fire mid-suite.
  RATE_LIMIT_LOGIN_MAX: '10000',
  RATE_LIMIT_USAGE_MAX: '10000',
} satisfies NodeJS.ProcessEnv;

export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  return loadConfig({ ...TEST_ENV, ...overrides });
}

export interface TestApp {
  app: Express;
  cache: TtlCache;
  config: Config;
  broadcaster: Broadcaster;
}

/**
 * Every cache built by a test, so `setup.ts` can flush them between tests.
 * Test teardown truncates the collections directly, which is exactly the one
 * thing the app's own invalidation cannot observe — without this, a cached
 * pricing row outlives the document it was read from.
 */
export const createdCaches: TtlCache[] = [];

export function buildApp(deps: AppDeps = {}, env: Partial<NodeJS.ProcessEnv> = {}): TestApp {
  const config = testConfig(env);
  const { app, cache, broadcaster } = createApp(config, deps);
  createdCaches.push(cache);
  return { app, cache, config, broadcaster };
}

export const PASSWORD = 'correct-horse-battery';

export async function makeUser(
  overrides: { email?: string; name?: string; role?: Role; password?: string } = {},
) {
  return User.create({
    name: overrides.name ?? 'Test User',
    email: overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`,
    role: overrides.role ?? 'user',
    passwordHash: await hashPassword(overrides.password ?? PASSWORD),
  });
}

/** Logs in over HTTP so the token is produced exactly as a real client's is. */
export async function login(app: Express, email: string, password = PASSWORD): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.text}`);
  return res.body.accessToken as string;
}

export async function makeUserAndLogin(
  app: Express,
  overrides: Parameters<typeof makeUser>[0] = {},
) {
  const user = await makeUser(overrides);
  const token = await login(app, user.email, overrides.password ?? PASSWORD);
  return { user, token, auth: `Bearer ${token}` };
}

export async function makeApiToken(
  userId: unknown,
  opts: { revoked?: boolean; amanaiKey?: string } = {},
) {
  const { token, tokenHash, tokenPrefix } = generateApiToken();
  const doc = await ApiToken.create({
    userId,
    label: 'test',
    tokenHash,
    tokenPrefix,
    revoked: opts.revoked ?? false,
    // Encrypt with the test SETTINGS_ENCRYPTION_KEY so a token can carry an
    // amanai key for the ingestion attribution tests.
    amanaiKeyEnc: opts.amanaiKey
      ? encryptSecret(opts.amanaiKey, TEST_ENV.SETTINGS_ENCRYPTION_KEY)
      : null,
  });
  return { token, doc };
}

export const RATES = {
  inputPerMTok: 3,
  cacheWritePerMTok: 3.75,
  cacheReadPerMTok: 0.3,
  outputPerMTok: 15,
};

export async function makePricing(modelId = 'claude-sonnet-5', overrides: Partial<typeof RATES> = {}) {
  return ModelPricing.create({ modelId, ...RATES, ...overrides, currency: 'USD' });
}

export const SAMPLE_TOKENS = {
  input: 1000,
  cache_read: 2000,
  cache_write: 500,
  output: 300,
  total: 3800,
};

/** A payload shaped exactly like claude-usage-reporter's `buildPayload()`. */
export function usagePayload(overrides: Record<string, unknown> = {}) {
  return {
    project: 'my-project',
    datetime: '2026-08-28T10:15:00.000Z',
    prompt: 'fix the login bug',
    session_id: 'abc-123',
    model: 'claude-sonnet-5',
    tokens: SAMPLE_TOKENS,
    ...overrides,
  };
}
