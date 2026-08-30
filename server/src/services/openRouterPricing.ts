import { badGateway } from '../errors.js';
import type { Rates } from '../pricing.js';

/**
 * "Update all" pricing refresh (models view). Pulls the public OpenRouter
 * catalog and matches it against our stored (unprefixed) model ids the same
 * way `defaultModels.ts`'s rates were originally hand-derived: by basename —
 * the part of `vendor/name` after the slash — plus a short list of manually
 * verified substitutes for ids whose OpenRouter slug doesn't share it.
 */

interface OpenRouterModel {
  id: string;
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
}

const PER_MILLION = 1_000_000;

/** OpenRouter prices are USD-per-token strings; convert to USD-per-million. */
function toPerMillion(value: string | undefined): number {
  return value ? Number(value) * PER_MILLION : 0;
}

/** Same substitutes recorded in `defaultModels.ts` — kept here so both agree. */
export const SLUG_OVERRIDES: Readonly<Record<string, string>> = {
  'qwen3.8-max-preview': 'qwen/qwen3.8-max',
  'kimi-k2.7': 'moonshotai/kimi-k2.7-code',
  'gpt-5.3-codex-spark': 'openai/gpt-5.3-codex',
};

function basename(slug: string): string {
  const i = slug.lastIndexOf('/');
  return i === -1 ? slug : slug.slice(i + 1);
}

function rateFrom(model: OpenRouterModel): Rates | null {
  if (!model.pricing?.prompt) return null;
  return {
    inputPerMTok: toPerMillion(model.pricing.prompt),
    cacheWritePerMTok: toPerMillion(model.pricing.input_cache_write),
    cacheReadPerMTok: toPerMillion(model.pricing.input_cache_read),
    outputPerMTok: toPerMillion(model.pricing.completion),
  };
}

export interface OpenRouterRateMap {
  /** Current OpenRouter rate for a stored model id, or null if unmatched/ambiguous. */
  ratesFor(modelId: string): Rates | null;
}

export function buildRateMap(models: OpenRouterModel[]): OpenRouterRateMap {
  const byId = new Map<string, OpenRouterModel>();
  const byBasename = new Map<string, OpenRouterModel[]>();

  for (const model of models) {
    // `:free` / `:batch` / `~` variants are aliases of a priced slug, not new models.
    if (!model.id || /[:~]/.test(model.id)) continue;
    byId.set(model.id, model);
    const base = basename(model.id);
    const list = byBasename.get(base) ?? [];
    list.push(model);
    byBasename.set(base, list);
  }

  return {
    ratesFor(modelId: string): Rates | null {
      const overrideSlug = SLUG_OVERRIDES[modelId];
      if (overrideSlug) {
        const hit = byId.get(overrideSlug);
        return hit ? rateFrom(hit) : null;
      }
      // Only trust an unambiguous basename match — several vendors ship a
      // model under the same short name, and guessing wrong silently
      // mis-prices a model rather than just leaving it unmatched.
      const candidates = byBasename.get(modelId);
      return candidates?.length === 1 ? rateFrom(candidates[0]!) : null;
    },
  };
}

export async function fetchOpenRouterRateMap(
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterRateMap> {
  let response: Response;
  try {
    response = await fetchImpl('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw badGateway(`Could not reach OpenRouter: ${detail}`);
  }
  if (!response.ok) throw badGateway(`OpenRouter returned HTTP ${response.status}`);

  const body = (await response.json().catch(() => null)) as { data?: OpenRouterModel[] } | null;
  if (!body || !Array.isArray(body.data)) {
    throw badGateway('OpenRouter returned an unexpected response shape');
  }
  return buildRateMap(body.data);
}
