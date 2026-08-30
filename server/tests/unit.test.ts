import { describe, expect, it } from 'vitest';
import { CacheKeys, TtlCache } from '../src/cache.js';
import { loadConfig } from '../src/config.js';
import {
  decryptSecret,
  encryptSecret,
  generateApiToken,
  generateEncryptionKey,
  hashApiToken,
  hashPassword,
  verifyPassword,
} from '../src/crypto.js';
import { HttpError } from '../src/errors.js';
import type { ModelPricingDoc } from '../src/models.js';
import {
  computeCost,
  hasPricedRates,
  isPricingOutdated,
  priceTokens,
  resolvePricing,
  sameRates,
  stripAmanaiPrefix,
} from '../src/pricing.js';
import { TEST_ENV } from './helpers.js';

describe('config', () => {
  it('applies defaults and coerces numbers', () => {
    const config = loadConfig(TEST_ENV);
    expect(config.PORT).toBe(4000);
    expect(config.ACCESS_TOKEN_TTL).toBe('15m');
    expect(config.NODE_ENV).toBe('test');
  });

  it('treats only the string "true" as true', () => {
    expect(loadConfig({ ...TEST_ENV, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    expect(loadConfig({ ...TEST_ENV, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
    expect(loadConfig(TEST_ENV).COOKIE_SECURE).toBe(false);
  });

  it('rejects a short JWT secret and reports the field', () => {
    expect(() => loadConfig({ ...TEST_ENV, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('rejects an encryption key that is not 32 hex bytes', () => {
    expect(() => loadConfig({ ...TEST_ENV, SETTINGS_ENCRYPTION_KEY: 'nope' })).toThrow(
      /64 hex characters/,
    );
  });

  it('rejects a missing MONGO_URI', () => {
    const { MONGO_URI: _drop, ...withoutUri } = TEST_ENV;
    expect(() => loadConfig(withoutUri)).toThrow(/MONGO_URI/);
  });

  it('reads process.env when no env is passed', () => {
    const saved = { ...process.env };
    Object.assign(process.env, TEST_ENV);
    expect(loadConfig().JWT_SECRET).toBe(TEST_ENV.JWT_SECRET);
    process.env = saved;
  });
});

describe('TtlCache', () => {
  it('returns undefined for a missing key', () => {
    expect(new TtlCache().get('nope')).toBeUndefined();
  });

  it('stores and reads back a value', () => {
    const cache = new TtlCache();
    cache.set('k', { a: 1 }, 1000);
    expect(cache.get('k')).toEqual({ a: 1 });
    expect(cache.size).toBe(1);
  });

  it('expires entries once the TTL has elapsed', () => {
    let now = 1000;
    const cache = new TtlCache(() => now);
    cache.set('k', 'v', 100);
    now = 1099;
    expect(cache.get('k')).toBe('v');
    now = 1100;
    expect(cache.get('k')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('does not store when the TTL is zero or negative', () => {
    const cache = new TtlCache();
    expect(cache.set('k', 'v', 0)).toBe('v');
    cache.set('j', 'v', -5);
    expect(cache.size).toBe(0);
  });

  it('wrap computes on a miss and reuses on a hit', async () => {
    const cache = new TtlCache();
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return 'value';
    };
    expect(await cache.wrap('k', 1000, compute)).toBe('value');
    expect(await cache.wrap('k', 1000, compute)).toBe('value');
    expect(calls).toBe(1);
  });

  it('deletes a single key and clears everything', () => {
    const cache = new TtlCache();
    cache.set('a', 1, 1000);
    cache.set('b', 2, 1000);
    cache.delete('a');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('invalidates by prefix without touching other namespaces', () => {
    const cache = new TtlCache();
    cache.set(`${CacheKeys.pricing}a`, 1, 1000);
    cache.set(`${CacheKeys.pricing}b`, 2, 1000);
    cache.set(`${CacheKeys.dashboard}x`, 3, 1000);
    cache.invalidatePrefix(CacheKeys.pricing);
    expect(cache.size).toBe(1);
    expect(cache.get(`${CacheKeys.dashboard}x`)).toBe(3);
  });
});

describe('crypto', () => {
  it('round-trips a password and rejects the wrong one', async () => {
    const hash = await hashPassword('hunter2hunter2');
    expect(await verifyPassword('hunter2hunter2', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('generates a prefixed api token whose digest matches', () => {
    const { token, tokenHash, tokenPrefix } = generateApiToken();
    expect(token.startsWith('sk-')).toBe(true);
    expect(tokenPrefix).toBe(token.slice(0, 12));
    expect(hashApiToken(token)).toBe(tokenHash);
    expect(generateApiToken().token).not.toBe(token);
  });

  it('round-trips an encrypted secret', () => {
    const key = generateEncryptionKey();
    const encrypted = encryptSecret('sk-secret-value', key);
    expect(encrypted).not.toContain('sk-secret-value');
    expect(decryptSecret(encrypted, key)).toBe('sk-secret-value');
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const key = generateEncryptionKey();
    expect(encryptSecret('same', key)).not.toBe(encryptSecret('same', key));
  });

  it('rejects a malformed payload', () => {
    expect(() => decryptSecret('not-three-parts', generateEncryptionKey())).toThrow(/Malformed/);
  });

  it('rejects a payload encrypted under a different key', () => {
    const encrypted = encryptSecret('secret', generateEncryptionKey());
    expect(() => decryptSecret(encrypted, generateEncryptionKey())).toThrow();
  });

  it('generates a 64-character hex key', () => {
    expect(generateEncryptionKey()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('computeCost', () => {
  const rates = {
    inputPerMTok: 3,
    cacheWritePerMTok: 3.75,
    cacheReadPerMTok: 0.3,
    outputPerMTok: 15,
  };

  it('prices each token component at its own rate', () => {
    // 1M input @ $3 + 1M cache_read @ $0.30 + 1M cache_write @ $3.75 + 1M output @ $15
    const cost = computeCost(
      { input: 1e6, cache_read: 1e6, cache_write: 1e6, output: 1e6, total: 4e6 },
      rates,
    );
    expect(cost).toBeCloseTo(22.05, 10);
  });

  it('ignores tokens.total so components are not double-counted', () => {
    const withTotal = computeCost(
      { input: 1000, cache_read: 0, cache_write: 0, output: 0, total: 999_999 },
      rates,
    );
    expect(withTotal).toBeCloseTo(0.003, 10);
  });

  it('returns 0 for an empty turn', () => {
    expect(
      computeCost({ input: 0, cache_read: 0, cache_write: 0, output: 0, total: 0 }, rates),
    ).toBe(0);
  });

  it('keeps sub-cent amounts instead of rounding them to zero', () => {
    const cost = computeCost(
      { input: 10, cache_read: 0, cache_write: 0, output: 0, total: 10 },
      rates,
    );
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBe(0.00003);
  });
});

describe('stripAmanaiPrefix', () => {
  it('drops only a leading amanai/ prefix', () => {
    expect(stripAmanaiPrefix('amanai/grok-4.6')).toBe('grok-4.6');
    expect(stripAmanaiPrefix('grok-4.6')).toBe('grok-4.6');
    expect(stripAmanaiPrefix('9r/grok-4.6')).toBe('9r/grok-4.6');
  });
});

describe('resolvePricing', () => {
  const priced = {
    _id: 'priced',
    modelId: 'grok-4.6',
    inputPerMTok: 2,
    cacheWritePerMTok: 0,
    cacheReadPerMTok: 0.5,
    outputPerMTok: 6,
    currency: 'USD',
  } as ModelPricingDoc;
  const zeros = {
    _id: 'zeros',
    modelId: 'amanai/grok-4.6',
    inputPerMTok: 0,
    cacheWritePerMTok: 0,
    cacheReadPerMTok: 0,
    outputPerMTok: 0,
    currency: 'USD',
  } as ModelPricingDoc;
  const exactPriced = { ...priced, _id: 'exact', modelId: 'amanai/grok-4.6' } as ModelPricingDoc;

  it('returns nothing when the log has no model', () => {
    const map = new Map<string, ModelPricingDoc>([['grok-4.6', priced]]);
    expect(resolvePricing(map, null)).toBeUndefined();
    expect(resolvePricing(map, undefined)).toBeUndefined();
    expect(resolvePricing(map, '')).toBeUndefined();
  });

  it('uses an exact priced row when one exists', () => {
    const map = new Map<string, ModelPricingDoc>([
      ['amanai/grok-4.6', exactPriced],
      ['grok-4.6', priced],
    ]);
    expect(resolvePricing(map, 'amanai/grok-4.6')).toBe(exactPriced);
    expect(resolvePricing(map, 'grok-4.6')).toBe(priced);
  });

  it('falls back to the unprefixed catalog row for amanai/<name>', () => {
    const map = new Map<string, ModelPricingDoc>([['grok-4.6', priced]]);
    expect(resolvePricing(map, 'amanai/grok-4.6')).toBe(priced);
  });

  it('falls back when the exact amanai row is still all zeros', () => {
    const map = new Map<string, ModelPricingDoc>([
      ['amanai/grok-4.6', zeros],
      ['grok-4.6', priced],
    ]);
    expect(resolvePricing(map, 'amanai/grok-4.6')).toBe(priced);
  });

  it('does not fall back for a different vendor prefix', () => {
    const map = new Map<string, ModelPricingDoc>([['grok-4.6', priced]]);
    expect(resolvePricing(map, '9r/grok-4.6')).toBeUndefined();
  });

  it('returns the exact unpriced row when there is no priced fallback', () => {
    const map = new Map<string, ModelPricingDoc>([['amanai/grok-4.6', zeros]]);
    expect(resolvePricing(map, 'amanai/grok-4.6')).toBe(zeros);
  });
});

describe('hasPricedRates', () => {
  const zeros = {
    inputPerMTok: 0,
    cacheWritePerMTok: 0,
    cacheReadPerMTok: 0,
    outputPerMTok: 0,
  };

  it('is false for missing or all-zero rates', () => {
    expect(hasPricedRates(null)).toBe(false);
    expect(hasPricedRates(undefined)).toBe(false);
    expect(hasPricedRates(zeros)).toBe(false);
  });

  it.each([
    ['inputPerMTok', 3],
    ['cacheWritePerMTok', 3.75],
    ['cacheReadPerMTok', 0.3],
    ['outputPerMTok', 15],
  ] as const)('is true when only %s is set', (field, value) => {
    expect(hasPricedRates({ ...zeros, [field]: value })).toBe(true);
  });
});

describe('priceTokens', () => {
  const tokens = { input: 1000, cache_read: 0, cache_write: 0, output: 0, total: 1000 };

  function pricing(overrides: Partial<ModelPricingDoc> = {}): ModelPricingDoc {
    return {
      _id: 'pricing-id',
      inputPerMTok: 3,
      cacheWritePerMTok: 3.75,
      cacheReadPerMTok: 0.3,
      outputPerMTok: 15,
      currency: 'USD',
      ...overrides,
    } as ModelPricingDoc;
  }

  it('returns nulls when the model is unknown', () => {
    expect(priceTokens(tokens, null)).toEqual({ estimatedCostUsd: null, pricingSnapshot: null });
  });

  it('returns nulls when every catalog rate is still zero', () => {
    expect(
      priceTokens(
        tokens,
        pricing({
          inputPerMTok: 0,
          cacheWritePerMTok: 0,
          cacheReadPerMTok: 0,
          outputPerMTok: 0,
        }),
      ),
    ).toEqual({ estimatedCostUsd: null, pricingSnapshot: null });
  });

  it('prices against a real rate row', () => {
    const result = priceTokens(tokens, pricing());
    expect(result.estimatedCostUsd).toBeCloseTo(0.003, 10);
    expect(result.pricingSnapshot).toMatchObject({ inputPerMTok: 3, currency: 'USD' });
  });
});

describe('isPricingOutdated', () => {
  const snapshot = {
    modelPricingId: null,
    inputPerMTok: 3,
    cacheWritePerMTok: 3.75,
    cacheReadPerMTok: 0.3,
    outputPerMTok: 15,
    currency: 'USD',
  };

  function current(overrides: Partial<ModelPricingDoc> = {}): ModelPricingDoc {
    return {
      _id: 'pricing-id',
      ...snapshot,
      ...overrides,
    } as ModelPricingDoc;
  }

  it('is false when there is nothing to update to, including an all-zero seed', () => {
    expect(isPricingOutdated(null, undefined)).toBe(false);
    expect(
      isPricingOutdated(
        null,
        current({
          inputPerMTok: 0,
          cacheWritePerMTok: 0,
          cacheReadPerMTok: 0,
          outputPerMTok: 0,
        }),
      ),
    ).toBe(false);
  });

  it('is true when a real price exists but the log was stored as unknown', () => {
    expect(isPricingOutdated(null, current())).toBe(true);
  });

  it('is true when the stored snapshot no longer matches current rates', () => {
    expect(isPricingOutdated(snapshot, current({ inputPerMTok: 99 }))).toBe(true);
  });

  it('is false when the stored snapshot still matches', () => {
    expect(isPricingOutdated(snapshot, current())).toBe(false);
  });
});

describe('sameRates', () => {
  const base = {
    modelPricingId: null,
    inputPerMTok: 3,
    cacheWritePerMTok: 3.75,
    cacheReadPerMTok: 0.3,
    outputPerMTok: 15,
    currency: 'USD',
  };

  it('is true for identical rates regardless of id', () => {
    expect(sameRates(base, { ...base, modelPricingId: null })).toBe(true);
  });

  it.each([
    ['inputPerMTok', 4],
    ['cacheWritePerMTok', 4],
    ['cacheReadPerMTok', 4],
    ['outputPerMTok', 4],
  ] as const)('is false when %s differs', (field, value) => {
    expect(sameRates(base, { ...base, [field]: value })).toBe(false);
  });

  it('is false when only the currency differs', () => {
    expect(sameRates(base, { ...base, currency: 'EUR' })).toBe(false);
  });

  it('treats two nulls as the same and one null as different', () => {
    expect(sameRates(null, null)).toBe(true);
    expect(sameRates(undefined, null)).toBe(true);
    expect(sameRates(base, null)).toBe(false);
    expect(sameRates(null, base)).toBe(false);
  });
});

describe('HttpError', () => {
  it('carries status and details', () => {
    const err = new HttpError(418, 'teapot', { why: 'short and stout' });
    expect(err.status).toBe(418);
    expect(err.details).toEqual({ why: 'short and stout' });
    expect(err.name).toBe('HttpError');
    expect(err).toBeInstanceOf(Error);
  });
});
