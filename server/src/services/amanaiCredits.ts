import type { TtlCache } from '../cache.js';
import { CacheKeys } from '../cache.js';
import type { TokenCounts } from '../models.js';

/**
 * Exact credit attribution from the amanai live usage log.
 *
 * amanai's `/v1/usage` endpoint (authenticated with the amanai API key) returns
 * the *exact* credit cost of every request, both as account totals and as a
 * per-request `recent[]` array where each entry carries its own `credits`
 * figure. There is no public multiplier catalog, so the live usage log is the
 * authoritative source for "how many credits did this request actually cost".
 *
 * A local usage log is matched to an amanai usage entry by (model + token
 * counts), because both sides report those fields identically. When no key is
 * configured, or no match is found (the log window rolled past it), the credit
 * figure stays null — never an error, never a guess.
 */

const USAGE_URL = 'https://api.amanai.dev/v1/usage';

export interface AmanaiUsageEntry {
  ts: number;
  public_model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  credits: number;
}

export interface AmanaiUsageSnapshot {
  credit_used: number | null;
  credit_remaining: number | null;
  recent: AmanaiUsageEntry[];
}

/** Model ids that go through amanai. Only these get credit attribution. */
export function isAmanaiModel(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && modelId.toLowerCase().startsWith('amanai/');
}

/**
 * Fetches the amanai usage snapshot. Returns `null` on any failure (offline,
 * bad key, non-2xx, malformed body) so callers never have to handle throws.
 * Cached via the shared TtlCache.
 */
export async function fetchAmanaiUsage(
  apiKey: string,
  cache: TtlCache,
  ttlMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<AmanaiUsageSnapshot | null> {
  return cache.wrap(CacheKeys.amanaiUsage, ttlMs, async () => {
    let response: Response;
    try {
      response = await fetchImpl(USAGE_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch {
      return null; // offline / aborted
    }
    if (!response.ok) return null; // bad key / upstream error
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return null; // not JSON
    }
    if (!body || typeof body !== 'object' || !Array.isArray((body as { recent?: unknown }).recent)) {
      return null;
    }
    const b = body as Record<string, unknown>;
    const recent = (b.recent as unknown[]).map((r) => {
      const e = r as Record<string, unknown>;
      return {
        ts: Number(e.ts) || 0,
        public_model: String(e.public_model ?? ''),
        input_tokens: Number(e.input_tokens) || 0,
        output_tokens: Number(e.output_tokens) || 0,
        cache_read_tokens: Number(e.cache_read_tokens) || 0,
        credits: Number(e.credits) || 0,
      };
    });
    return {
      credit_used: b.credit_used === undefined ? null : Number(b.credit_used) || 0,
      credit_remaining: b.credit_remaining === undefined ? null : Number(b.credit_remaining) || 0,
      recent,
    };
  });
}

/** Drop a leading `amanai/` so the local bare model id matches the public one. */
function bareModel(modelId: string): string {
  return modelId.toLowerCase().replace(/^amanai\//, '');
}

/**
 * Finds the amanai usage entry whose token profile matches a local request,
 * and returns its exact `credits`. Matching is on (model + input/output/cache
 * read tokens); the most recent matching entry wins. Returns `null` when no
 * entry matches (e.g. the log window rolled past the request).
 */
export function findAmanaiCredits(
  usage: AmanaiUsageSnapshot | null | undefined,
  modelId: string | null | undefined,
  tokens: TokenCounts,
): number | null {
  if (!usage || !usage.recent.length || !modelId || !tokens) return null;
  const base = bareModel(modelId);
  if (!base) return null;
  const wantInput = Number(tokens.input) || 0;
  const wantOutput = Number(tokens.output) || 0;
  const wantCacheRead = Number(tokens.cache_read) || 0;

  let best: AmanaiUsageEntry | null = null;
  for (const entry of usage.recent) {
    const m = bareModel(entry.public_model);
    if (m !== base) continue;
    if ((Number(entry.input_tokens) || 0) !== wantInput) continue;
    if ((Number(entry.output_tokens) || 0) !== wantOutput) continue;
    if ((Number(entry.cache_read_tokens) || 0) !== wantCacheRead) continue;
    // Prefer the most recent matching entry.
    if (!best || entry.ts > best.ts) best = entry;
  }
  return best ? best.credits : null;
}
