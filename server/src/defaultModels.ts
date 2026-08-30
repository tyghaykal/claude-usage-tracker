import { ModelPricing } from './models.js';
import { hasPricedRates, stripAmanaiPrefix, type Rates } from './pricing.js';

export { stripAmanaiPrefix };

/**
 * Chat model ids from https://ai.amanai.dev/docs/models/ (also GET /v1/models).
 * The live inventory is `amanai/<name>`; this app matches the plugin's unprefixed
 * `model` string, so the prefix is stripped before anything is stored or shown.
 */
const AMANAI_CHAT_MODELS = [
  'amanai/glm-5.3',
  'amanai/glm-5.3-flash',
  'amanai/glm-5.2',
  'amanai/glm-5.1',
  'amanai/glm-5v-turbo',
  'amanai/muse-spark-1.1',
  'amanai/muse-spark-1.2',
  'amanai/qwen3.8-max-preview',
  'amanai/qwen3.7-max',
  'amanai/qwen3.7-plus',
  'amanai/kimi-k3',
  'amanai/kimi-k2.7',
  'amanai/kimi-k2.6',
  'amanai/kimi-k2.5',
  'amanai/deepseek-v4-pro',
  'amanai/deepseek-v4-pro-0813',
  'amanai/deepseek-v4-flash',
  'amanai/deepseek-v4-flash-0731',
  'amanai/minimax-m3',
  'amanai/minimax-m2.7',
  'amanai/hy3-preview',
  'amanai/grok-4.5',
  'amanai/grok-4.6',
  'amanai/gpt-5.3-codex-spark',
  'amanai/gpt-5.4-mini',
  'amanai/gpt-5.4',
  'amanai/gpt-5.5',
  'amanai/gpt-5.6-sol',
  'amanai/gpt-5.6-terra',
  'amanai/gpt-5.6-luna',
  'amanai/claude-fable-5',
  'amanai/claude-opus-5',
  'amanai/claude-opus-4.8',
  'amanai/claude-opus-4.7',
  'amanai/claude-opus-4.6',
  'amanai/claude-sonnet-5',
  'amanai/claude-sonnet-4.6',
  'amanai/claude-haiku-4.5',
] as const;

export const DEFAULT_MODEL_IDS: readonly string[] = AMANAI_CHAT_MODELS.map(stripAmanaiPrefix);

/**
 * OpenRouter list prices (GET https://openrouter.ai/api/v1/models), converted
 * from USD-per-token to USD-per-million-tokens. Matched on the unprefixed slug,
 * skipping `:free` / `:batch` / `~` aliases.
 *
 * Close substitutes when the exact slug is not listed:
 * - qwen3.8-max-preview → qwen/qwen3.8-max
 * - kimi-k2.7 → moonshotai/kimi-k2.7-code
 * - gpt-5.3-codex-spark → openai/gpt-5.3-codex
 */
export const DEFAULT_MODEL_RATES: Readonly<Record<string, Rates>> = {
  'glm-5.3': { inputPerMTok: 1.4, cacheWritePerMTok: 0, cacheReadPerMTok: 0.26, outputPerMTok: 4.4 },
  'glm-5.3-flash': {
    inputPerMTok: 0.075,
    cacheWritePerMTok: 0,
    cacheReadPerMTok: 0.015,
    outputPerMTok: 0.25,
  },
  'glm-5.2': { inputPerMTok: 1.19, cacheWritePerMTok: 0, cacheReadPerMTok: 0.221, outputPerMTok: 3.74 },
  'glm-5.1': { inputPerMTok: 1.26, cacheWritePerMTok: 0, cacheReadPerMTok: 0.234, outputPerMTok: 3.96 },
  'glm-5v-turbo': { inputPerMTok: 1.2, cacheWritePerMTok: 0, cacheReadPerMTok: 0.24, outputPerMTok: 4 },
  'muse-spark-1.1': {
    inputPerMTok: 1.25,
    cacheWritePerMTok: 0,
    cacheReadPerMTok: 0.15,
    outputPerMTok: 4.25,
  },
  'muse-spark-1.2': {
    inputPerMTok: 1.25,
    cacheWritePerMTok: 0,
    cacheReadPerMTok: 0.15,
    outputPerMTok: 4.25,
  },
  'qwen3.8-max-preview': {
    inputPerMTok: 2,
    cacheWritePerMTok: 2.5,
    cacheReadPerMTok: 0.25,
    outputPerMTok: 6,
  },
  'qwen3.7-max': {
    inputPerMTok: 1.475,
    cacheWritePerMTok: 1.84375,
    cacheReadPerMTok: 0.295,
    outputPerMTok: 4.425,
  },
  'qwen3.7-plus': {
    inputPerMTok: 0.32,
    cacheWritePerMTok: 0.4,
    cacheReadPerMTok: 0.064,
    outputPerMTok: 1.28,
  },
  'kimi-k3': { inputPerMTok: 3, cacheWritePerMTok: 0, cacheReadPerMTok: 0.3, outputPerMTok: 15 },
  'kimi-k2.7': { inputPerMTok: 0.66, cacheWritePerMTok: 0, cacheReadPerMTok: 0.18, outputPerMTok: 3.4 },
  'kimi-k2.6': { inputPerMTok: 0.95, cacheWritePerMTok: 0, cacheReadPerMTok: 0.16, outputPerMTok: 4 },
  'kimi-k2.5': { inputPerMTok: 0.6, cacheWritePerMTok: 0, cacheReadPerMTok: 0.1, outputPerMTok: 3 },
  'deepseek-v4-pro': {
    inputPerMTok: 0.751854,
    cacheWritePerMTok: 0,
    cacheReadPerMTok: 0.0626545,
    outputPerMTok: 1.503708,
  },
  'deepseek-v4-pro-0813': {
    inputPerMTok: 0.66,
    cacheWritePerMTok: 0,
    cacheReadPerMTok: 0.022,
    outputPerMTok: 1.98,
  },
  'deepseek-v4-flash': {
    inputPerMTok: 0.0868,
    cacheWritePerMTok: 0,
    cacheReadPerMTok: 0.01736,
    outputPerMTok: 0.1736,
  },
  'deepseek-v4-flash-0731': {
    inputPerMTok: 0.06,
    cacheWritePerMTok: 0,
    cacheReadPerMTok: 0.012,
    outputPerMTok: 0.12,
  },
  'minimax-m3': { inputPerMTok: 0.3, cacheWritePerMTok: 0, cacheReadPerMTok: 0.06, outputPerMTok: 1.2 },
  'minimax-m2.7': { inputPerMTok: 0.3, cacheWritePerMTok: 0, cacheReadPerMTok: 0.06, outputPerMTok: 1.2 },
  'hy3-preview': { inputPerMTok: 0.18, cacheWritePerMTok: 0, cacheReadPerMTok: 0.06, outputPerMTok: 0.6 },
  'grok-4.5': { inputPerMTok: 2, cacheWritePerMTok: 0, cacheReadPerMTok: 0.3, outputPerMTok: 6 },
  'grok-4.6': { inputPerMTok: 2, cacheWritePerMTok: 0, cacheReadPerMTok: 0.5, outputPerMTok: 6 },
  'gpt-5.3-codex-spark': {
    inputPerMTok: 1.75,
    cacheWritePerMTok: 0,
    cacheReadPerMTok: 0.175,
    outputPerMTok: 14,
  },
  'gpt-5.4-mini': {
    inputPerMTok: 0.75,
    cacheWritePerMTok: 0,
    cacheReadPerMTok: 0.075,
    outputPerMTok: 4.5,
  },
  'gpt-5.4': { inputPerMTok: 2.5, cacheWritePerMTok: 0, cacheReadPerMTok: 0.25, outputPerMTok: 15 },
  'gpt-5.5': { inputPerMTok: 5, cacheWritePerMTok: 0, cacheReadPerMTok: 0.5, outputPerMTok: 30 },
  'gpt-5.6-sol': { inputPerMTok: 2, cacheWritePerMTok: 2.5, cacheReadPerMTok: 0.2, outputPerMTok: 10 },
  'gpt-5.6-terra': { inputPerMTok: 2, cacheWritePerMTok: 2.5, cacheReadPerMTok: 0.2, outputPerMTok: 12 },
  'gpt-5.6-luna': {
    inputPerMTok: 0.2,
    cacheWritePerMTok: 0.25,
    cacheReadPerMTok: 0.02,
    outputPerMTok: 1.2,
  },
  'claude-fable-5': {
    inputPerMTok: 10,
    cacheWritePerMTok: 12.5,
    cacheReadPerMTok: 1,
    outputPerMTok: 50,
  },
  'claude-opus-5': { inputPerMTok: 5, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5, outputPerMTok: 25 },
  'claude-opus-4.8': {
    inputPerMTok: 5,
    cacheWritePerMTok: 6.25,
    cacheReadPerMTok: 0.5,
    outputPerMTok: 25,
  },
  'claude-opus-4.7': {
    inputPerMTok: 5,
    cacheWritePerMTok: 6.25,
    cacheReadPerMTok: 0.5,
    outputPerMTok: 25,
  },
  'claude-opus-4.6': {
    inputPerMTok: 5,
    cacheWritePerMTok: 6.25,
    cacheReadPerMTok: 0.5,
    outputPerMTok: 25,
  },
  'claude-sonnet-5': { inputPerMTok: 2, cacheWritePerMTok: 2.5, cacheReadPerMTok: 0.2, outputPerMTok: 10 },
  'claude-sonnet-4.6': {
    inputPerMTok: 3,
    cacheWritePerMTok: 3.75,
    cacheReadPerMTok: 0.3,
    outputPerMTok: 15,
  },
  'claude-haiku-4.5': { inputPerMTok: 1, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1, outputPerMTok: 5 },
};

const ZERO_RATES: Rates = {
  inputPerMTok: 0,
  cacheWritePerMTok: 0,
  cacheReadPerMTok: 0,
  outputPerMTok: 0,
};

const SEED_META = { currency: 'USD', source: 'manual' as const, updatedBy: null };

/** OpenRouter rates for a catalog id, or zeros when OpenRouter has no listing. */
export function seedRatesFor(modelId: string): Rates {
  return DEFAULT_MODEL_RATES[modelId] ?? ZERO_RATES;
}

export interface SeedResult {
  inserted: number;
  updated: number;
}

/**
 * Inserts any catalog id that is not already priced, and fills leftover all-zero
 * name rows with OpenRouter rates. Existing rows that already have a real rate
 * — including anything an admin set — are left alone.
 */
export async function seedDefaultModels(): Promise<SeedResult> {
  const existing = await ModelPricing.find({ modelId: { $in: [...DEFAULT_MODEL_IDS] } }).exec();
  const byId = new Map(existing.map((row) => [row.modelId, row]));

  const missing: Array<{ modelId: string } & Rates & typeof SEED_META> = [];
  const backfill: Array<{ id: unknown; rates: Rates }> = [];

  for (const modelId of DEFAULT_MODEL_IDS) {
    const rates = seedRatesFor(modelId);
    const row = byId.get(modelId);
    if (!row) {
      missing.push({ modelId, ...rates, ...SEED_META });
      continue;
    }
    if (!hasPricedRates(row) && hasPricedRates(rates)) {
      backfill.push({ id: row._id, rates });
    }
  }

  if (missing.length > 0) await ModelPricing.insertMany(missing);

  let updated = 0;
  for (const { id, rates } of backfill) {
    await ModelPricing.updateOne({ _id: id }, { $set: rates });
    updated += 1;
  }

  return { inserted: missing.length, updated };
}
