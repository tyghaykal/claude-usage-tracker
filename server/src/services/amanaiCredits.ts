import { AMANAI_MULTIPLIERS } from '../defaultModels.js';
import type { TokenCounts } from '../models.js';

/**
 * Deterministic amanai credit attribution from the per-model multiplier amanai itself
 * publishes at https://ai.amanai.dev/docs/models/, rather than a live per-user API call.
 *
 * Their documented formula is `credits = (input - cache)×m_in + cache×m_cache +
 * output×m_out`. This app's `TokenCounts.input` is already exclusive of `cache_read`
 * (the four components are additive elsewhere, e.g. `computeCost` in pricing.ts), so the
 * translation below does not re-subtract cache from input. `cache_write` has no term in
 * amanai's formula and is treated as unbilled — an assumption, not verified against a
 * real amanai wire payload.
 */

/** m_out is always exactly 5× m_in across every model amanai publishes. */
export const AMANAI_OUTPUT_RATIO = 5;
/** m_cache is always exactly 0.25× m_in across every model amanai publishes. */
export const AMANAI_CACHE_RATIO = 0.25;
/** Confirmed via amanai's credit-pack pricing ("Ultra (1B) — Rp 150K"). */
export const AMANAI_IDR_PER_CREDIT = 150_000 / 1_000_000_000;

/** Model ids that go through amanai. Only these get credit attribution. */
export function isAmanaiModel(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && modelId.toLowerCase().startsWith('amanai/');
}

/** Drop a leading `amanai/` so the local bare model id matches the multiplier table. */
function bareModel(modelId: string): string {
  return modelId.toLowerCase().replace(/^amanai\//, '');
}

/**
 * Computes the exact amanai credit cost of a request from its model's published
 * multiplier. Returns `null` when the model isn't an amanai model, or amanai hasn't
 * published a multiplier for it (an unrecognised/new model) — never a guess.
 */
export function computeAmanaiCredits(
  modelId: string | null | undefined,
  tokens: TokenCounts | null | undefined,
): number | null {
  if (!isAmanaiModel(modelId) || !tokens) return null;
  const mIn = AMANAI_MULTIPLIERS[bareModel(modelId!)];
  if (mIn === undefined) return null;

  const credits =
    (Number(tokens.input) || 0) * mIn +
    (Number(tokens.cache_read) || 0) * mIn * AMANAI_CACHE_RATIO +
    (Number(tokens.output) || 0) * mIn * AMANAI_OUTPUT_RATIO;
  return Number(credits.toFixed(4));
}
