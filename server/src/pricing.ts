import type { TtlCache } from './cache.js';
import { CacheKeys } from './cache.js';
import {
  ModelPricing,
  ProviderPricingConfig,
  type ModelPricingDoc,
  type PricingSnapshot,
  type TokenCounts,
} from './models.js';

/** The four rates, without the identity/currency fields around them. */
export interface Rates {
  inputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
  outputPerMTok: number;
}

const PER_MILLION = 1_000_000;

/**
 * Cost from the four token *components*.
 *
 * `tokens.total` is deliberately ignored: it is the sum of the components, so
 * pricing it as well would double-count every prompt. Each component has its
 * own rate anyway (a cache read is ~10x cheaper than a fresh input token), so
 * the total could not be priced correctly even if we wanted to.
 */
export function computeCost(tokens: TokenCounts, rates: Rates): number {
  const raw =
    (tokens.input * rates.inputPerMTok +
      tokens.cache_read * rates.cacheReadPerMTok +
      tokens.cache_write * rates.cacheWritePerMTok +
      tokens.output * rates.outputPerMTok) /
    PER_MILLION;
  // Sub-cent amounts are normal here; 10 dp keeps them from rounding to zero
  // while still killing float noise like 0.30000000000000004.
  return Number(raw.toFixed(10));
}

/** Copies a pricing document's rates into a standalone, persistable snapshot. */
export function snapshotFrom(pricing: ModelPricingDoc): PricingSnapshot {
  return {
    modelPricingId: pricing._id,
    inputPerMTok: pricing.inputPerMTok,
    cacheWritePerMTok: pricing.cacheWritePerMTok,
    cacheReadPerMTok: pricing.cacheReadPerMTok,
    outputPerMTok: pricing.outputPerMTok,
    currency: pricing.currency,
  };
}

/** Do two snapshots price identically? Compares rates + currency, not ids. */
export function sameRates(
  a: PricingSnapshot | null | undefined,
  b: PricingSnapshot | null | undefined,
): boolean {
  if (!a || !b) return a === b || (!a && !b);
  return (
    a.inputPerMTok === b.inputPerMTok &&
    a.cacheWritePerMTok === b.cacheWritePerMTok &&
    a.cacheReadPerMTok === b.cacheReadPerMTok &&
    a.outputPerMTok === b.outputPerMTok &&
    a.currency === b.currency
  );
}

export interface PricedResult {
  estimatedCostUsd: number | null;
  pricingSnapshot: PricingSnapshot | null;
}

/**
 * Catalog seed rows (and any admin row that still has every rate at 0) are names,
 * not prices. Treating them as $0 would record usage as free.
 */
export function hasPricedRates(pricing: Rates | null | undefined): boolean {
  if (!pricing) return false;
  return (
    pricing.inputPerMTok > 0 ||
    pricing.cacheWritePerMTok > 0 ||
    pricing.cacheReadPerMTok > 0 ||
    pricing.outputPerMTok > 0
  );
}

const AMANAI_PREFIX = 'amanai/';

/** Drop a leading `amanai/` so aggregator-tagged logs share unprefixed catalog rates. */
export function stripAmanaiPrefix(id: string): string {
  return id.startsWith(AMANAI_PREFIX) ? id.slice(AMANAI_PREFIX.length) : id;
}

/**
 * Exact model id first; if that row is missing or still all zeros, reuse the
 * unprefixed catalog row for `amanai/<name>`. Other vendor prefixes stay distinct.
 */
export function resolvePricing(
  map: Map<string, ModelPricingDoc>,
  modelId: string | null | undefined,
): ModelPricingDoc | undefined {
  if (!modelId) return undefined;
  const exact = map.get(modelId);
  if (hasPricedRates(exact)) return exact;
  const fallbackId = stripAmanaiPrefix(modelId);
  if (fallbackId !== modelId) {
    const fallback = map.get(fallbackId);
    if (hasPricedRates(fallback)) return fallback;
  }
  return exact;
}

/** Prices a set of token counts, or returns nulls when the model is unknown. */
export function priceTokens(
  tokens: TokenCounts,
  pricing: ModelPricingDoc | null | undefined,
): PricedResult {
  if (!hasPricedRates(pricing)) return { estimatedCostUsd: null, pricingSnapshot: null };
  const snapshot = snapshotFrom(pricing!);
  return { estimatedCostUsd: computeCost(tokens, snapshot), pricingSnapshot: snapshot };
}

/**
 * Pricing lookup for the ingestion hot path — cached (FRD §8), invalidated on
 * any write to /api/models. A miss (unknown model) is cached too, so a team
 * using an unpriced model doesn't hit Mongo on every single prompt.
 */
export async function lookupPricing(
  modelId: string | null | undefined,
  cache: TtlCache,
  ttlMs: number,
): Promise<ModelPricingDoc | null> {
  if (!modelId) return null;
  const key = `${CacheKeys.pricing}${modelId}`;
  const cached = cache.get<ModelPricingDoc | null>(key);
  if (cached !== undefined) return cached;
  const found = await ModelPricing.findOne({ modelId }).exec();
  if (hasPricedRates(found)) return cache.set(key, found, ttlMs);

  const fallbackId = stripAmanaiPrefix(modelId);
  if (fallbackId !== modelId) {
    const fallback = await lookupPricing(fallbackId, cache, ttlMs);
    if (hasPricedRates(fallback)) return cache.set(key, fallback, ttlMs);
  }

  return cache.set(key, found, ttlMs);
}

/** All pricing rows as a map, for list views that price many models at once. */
export async function loadPricingMap(
  cache: TtlCache,
  ttlMs: number,
): Promise<Map<string, ModelPricingDoc>> {
  const cached = cache.get<Map<string, ModelPricingDoc>>(CacheKeys.pricingAll);
  if (cached !== undefined) return cached;
  const rows = await ModelPricing.find().exec();
  return cache.set(CacheKeys.pricingAll, new Map(rows.map((r) => [r.modelId, r])), ttlMs);
}

/** Drops every cached pricing entry. Called after any /api/models mutation. */
export function invalidatePricingCache(cache: TtlCache): void {
  cache.invalidatePrefix(CacheKeys.pricing);
  // Dashboard totals are derived from cost, so stale pricing means stale charts.
  cache.invalidatePrefix(CacheKeys.dashboard);
}

/**
 * Is cost estimation turned off for this provider? Cached the same way as
 * `lookupPricing` — the ingestion hot path checks this on every prompt.
 * A provider with no config row at all prices normally (default false).
 */
export async function isProviderPricingDisabled(
  provider: string | null | undefined,
  cache: TtlCache,
  ttlMs: number,
): Promise<boolean> {
  if (!provider) return false;
  const key = `${CacheKeys.providerPricing}${provider}`;
  const cached = cache.get<boolean>(key);
  if (cached !== undefined) return cached;
  const found = await ProviderPricingConfig.findOne({ provider }).exec();
  return cache.set(key, found?.pricingDisabled ?? false, ttlMs);
}

/** Drops every cached provider-pricing entry. Called after a toggle. */
export function invalidateProviderPricingCache(cache: TtlCache): void {
  cache.invalidatePrefix(CacheKeys.providerPricing);
}

/**
 * Is this log's persisted snapshot out of step with current pricing? Drives
 * the "pricing outdated" badge (FR-5) and tells FR-12 what is worth touching.
 */
export function isPricingOutdated(
  snapshot: PricingSnapshot | null,
  current: ModelPricingDoc | undefined,
): boolean {
  // A missing row and an all-zero catalog seed are the same: nothing to update to.
  if (!hasPricedRates(current)) return false;
  if (!snapshot) return true; // Priced as unknown, but we know it now.
  return !sameRates(snapshot, snapshotFrom(current!));
}
