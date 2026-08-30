import { vi } from 'vitest';
import { encryptSecret } from '../src/crypto.js';
import { AiProviderConfig } from '../src/models.js';
import type { searchPricing, testProvider } from '../src/services/aiPricing.js';
import { testConfig } from './helpers.js';

export const SUGGESTED = {
  inputPerMTok: 3,
  cacheWritePerMTok: 3.75,
  cacheReadPerMTok: 0.3,
  outputPerMTok: 15,
  currency: 'USD',
};

/** A stubbed connector that always succeeds — no network in tests. */
export const okSearch = () =>
  vi.fn<typeof searchPricing>(async () => ({
    suggested: SUGGESTED,
    raw: JSON.stringify(SUGGESTED),
  }));

export async function makeProvider(overrides: { apiKey?: string; baseUrl?: string } = {}) {
  return AiProviderConfig.create({
    label: 'Test Provider',
    baseUrl: overrides.baseUrl ?? 'https://api.example.com/v1',
    modelName: 'gpt-test',
    apiKeyEnc: encryptSecret(overrides.apiKey ?? 'sk-test', testConfig().SETTINGS_ENCRYPTION_KEY),
  });
}

/** The OpenAI-compatible envelope, for exercising the real connector. */
export function buildJsonReply(payload: unknown) {
  return { choices: [{ message: { content: JSON.stringify(payload) } }] };
}

/** Anthropic Messages envelope (`POST {baseUrl}/messages`). */
export function buildAnthropicReply(payload: unknown) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
  };
}

/** A stubbed connectivity probe that always reports a healthy provider. */
export const okProbe = () =>
  vi.fn<typeof testProvider>(async () => ({
    ok: true,
    status: 200,
    latencyMs: 12,
    message: 'Reached the provider and got a reply from "gpt-test" in 12ms.',
  }));

/** A stubbed probe that reports a specific failure. */
export const failingProbe = (message = 'The provider rejected the API key (HTTP 401).') =>
  vi.fn<typeof testProvider>(async () => ({ ok: false, status: 401, latencyMs: 8, message }));

function jsonResponse(body: unknown, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch stub returning `body` with the given status. */
export function stubFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => jsonResponse(body, status)) as unknown as typeof fetch;
}

/** Route-aware fetch stub so OpenAI vs Anthropic fallback can be exercised. */
export function stubByUrl(
  map: Record<string, { body: unknown; status?: number }>,
): typeof fetch {
  return vi.fn(async (url: string) => {
    const hit = map[String(url)];
    if (!hit) return jsonResponse({ error: `unexpected ${url}` }, 500);
    return jsonResponse(hit.body, hit.status ?? 200);
  }) as unknown as typeof fetch;
}
