import { describe, expect, it } from 'vitest';
import { computeAmanaiCredits, isAmanaiModel } from '../src/services/amanaiCredits.js';

const TOKENS = { input: 1234, cache_read: 800, cache_write: 200, output: 450, total: 2684 };

describe('isAmanaiModel', () => {
  it('true only for amanai/ prefixed model ids (case-insensitive)', () => {
    expect(isAmanaiModel('amanai/deepseek-v4-flash')).toBe(true);
    expect(isAmanaiModel('AMANAI/glm-5.3')).toBe(true);
    expect(isAmanaiModel('claude-sonnet-5')).toBe(false);
    expect(isAmanaiModel(null)).toBe(false);
    expect(isAmanaiModel(undefined)).toBe(false);
  });
});

describe('computeAmanaiCredits', () => {
  it('matches amanai\'s published formula for a known model', () => {
    // deepseek-v4-flash: m_in=2.5, m_cache=0.625, m_out=12.5
    // 1234*2.5 + 800*0.625 + 450*12.5 = 3085 + 500 + 5625 = 9210
    expect(computeAmanaiCredits('amanai/deepseek-v4-flash', TOKENS)).toBe(9210);
  });

  it('accepts a bare model id (no amanai/ prefix is still required to trigger it)', () => {
    // A bare id (no `amanai/` prefix) is not an amanai model at all — null.
    expect(computeAmanaiCredits('deepseek-v4-flash', TOKENS)).toBeNull();
  });

  it('scales with a different model\'s multiplier', () => {
    // claude-sonnet-5: m_in=10.5, m_cache=2.625, m_out=52.5
    // 1234*10.5 + 800*2.625 + 450*52.5 = 12957 + 2100 + 23625 = 38682
    expect(computeAmanaiCredits('amanai/claude-sonnet-5', TOKENS)).toBe(38682);
  });

  it('returns null for an amanai model with no published multiplier', () => {
    expect(computeAmanaiCredits('amanai/not-a-real-model', TOKENS)).toBeNull();
  });

  it('returns null for a non-amanai model', () => {
    expect(computeAmanaiCredits('claude-sonnet-5', TOKENS)).toBeNull();
  });

  it('returns null for a null/undefined model or missing tokens', () => {
    expect(computeAmanaiCredits(null, TOKENS)).toBeNull();
    expect(computeAmanaiCredits(undefined, TOKENS)).toBeNull();
    expect(computeAmanaiCredits('amanai/deepseek-v4-flash', null)).toBeNull();
  });
});
