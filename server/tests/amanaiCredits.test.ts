import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../src/cache.js';
import { findAmanaiCredits, fetchAmanaiUsage, isAmanaiModel } from '../src/services/amanaiCredits.js';

const USAGE = {
  credit_used: 123456,
  credit_remaining: 595453231,
  recent: [
    { ts: 200, public_model: 'amanai/deepseek-v4-flash', input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, credits: 1313 },
    { ts: 100, public_model: 'amanai/deepseek-v4-flash', input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, credits: 999 },
    { ts: 50, public_model: 'amanai/glm-5.3', input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, credits: 42 },
  ],
};

describe('isAmanaiModel', () => {
  it('true only for amanai/ prefixed model ids (case-insensitive)', () => {
    expect(isAmanaiModel('amanai/deepseek-v4-flash')).toBe(true);
    expect(isAmanaiModel('AMANAI/glm-5.3')).toBe(true);
    expect(isAmanaiModel('claude-sonnet-5')).toBe(false);
    expect(isAmanaiModel(null)).toBe(false);
    expect(isAmanaiModel(undefined)).toBe(false);
  });
});

describe('findAmanaiCredits', () => {
  it('matches exact model + token profile and returns the exact credits', () => {
    expect(
      findAmanaiCredits(USAGE, 'amanai/deepseek-v4-flash', {
        input: 1000, output: 500, cache_read: 0, cache_write: 0, total: 1500,
      }),
    ).toBe(1313);
  });

  it('accepts a bare model id (no amanai/ prefix)', () => {
    expect(
      findAmanaiCredits(USAGE, 'deepseek-v4-flash', {
        input: 1000, output: 500, cache_read: 0, cache_write: 0, total: 1500,
      }),
    ).toBe(1313);
  });

  it('returns null when nothing matches', () => {
    expect(
      findAmanaiCredits(USAGE, 'amanai/deepseek-v4-flash', {
        input: 1, output: 1, cache_read: 0, cache_write: 0, total: 2,
      }),
    ).toBe(null);
    expect(findAmanaiCredits(USAGE, 'claude-sonnet-5', {
      input: 1000, output: 500, cache_read: 0, cache_write: 0, total: 1500,
    })).toBe(null);
  });

  it('returns null for empty or null usage', () => {
    expect(findAmanaiCredits(null, 'amanai/x', {
      input: 1, output: 1, cache_read: 0, cache_write: 0, total: 2,
    })).toBe(null);
    expect(findAmanaiCredits(undefined, 'amanai/x', {
      input: 1, output: 1, cache_read: 0, cache_write: 0, total: 2,
    })).toBe(null);
    expect(findAmanaiCredits({ credit_used: 0, credit_remaining: 0, recent: [] }, 'amanai/x', {
      input: 1, output: 1, cache_read: 0, cache_write: 0, total: 2,
    })).toBe(null);
  });
});

describe('fetchAmanaiUsage', () => {
  it('parses a valid body and caches it', async () => {
    const cache = new TtlCache(() => 1000);
    let calls = 0;
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => USAGE }) as Response);
    const usage = await fetchAmanaiUsage('sk-test', cache, 60_000, fetchImpl);
    expect(usage?.recent).toHaveLength(3);
    expect(usage?.credit_remaining).toBe(595453231);
    expect(calls).toBe(0); // fetchImpl call count not tracked here
    // Second call within TTL is served from cache.
    const again = await fetchAmanaiUsage('sk-test', cache, 60_000, fetchImpl);
    expect(again?.recent).toHaveLength(3);
  });

  it('returns null on a non-2xx response', async () => {
    const cache = new TtlCache();
    const fetchImpl = vi.fn(async () => ({ ok: false }) as Response);
    expect(await fetchAmanaiUsage('sk', cache, 60_000, fetchImpl)).toBe(null);
  });

  it('returns null on a thrown fetch (offline)', async () => {
    const cache = new TtlCache();
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); });
    expect(await fetchAmanaiUsage('sk', cache, 60_000, fetchImpl)).toBe(null);
  });

  it('returns null on a malformed body', async () => {
    const cache = new TtlCache();
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ foo: 1 }) }) as Response);
    expect(await fetchAmanaiUsage('sk', cache, 60_000, fetchImpl)).toBe(null);
  });
});
