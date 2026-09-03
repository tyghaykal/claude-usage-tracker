/**
 * In-process TTL cache (FRD §8).
 *
 * ponytail: single-process, in-memory. Correct and cheap at one `api` replica,
 * which is what the compose file ships. Scale the api service horizontally and
 * replicas stop seeing each other's invalidations — swap this module for Redis
 * at that point; every call site already goes through `get`/`set`/`invalidate`.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache {
  private readonly store = new Map<string, Entry<unknown>>();

  constructor(private readonly now: () => number = Date.now) {}

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): T {
    // A zero/negative TTL means "don't cache" rather than "cache forever".
    if (ttlMs > 0) this.store.set(key, { value, expiresAt: this.now() + ttlMs });
    return value;
  }

  /** Read-through helper: returns the cached value or computes, stores, returns. */
  async wrap<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
    const hit = this.get<T>(key);
    if (hit !== undefined) return hit;
    return this.set(key, await compute(), ttlMs);
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  /** Drops every key starting with `prefix` — used to invalidate a namespace. */
  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

/** Cache key namespaces, so `invalidatePrefix` has something stable to match. */
export const CacheKeys = {
  pricing: 'pricing:',
  pricingAll: 'pricing:all',
  providerPricing: 'provider-pricing:',
  dashboard: 'dashboard:',
  aiSearch: 'ai-search:',
  amanaiUsage: 'amanai-usage:',
} as const;
