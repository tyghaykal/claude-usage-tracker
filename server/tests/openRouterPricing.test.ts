import { describe, expect, it, vi } from 'vitest';
import {
  buildRateMap,
  fetchOpenRouterRateMap,
  SLUG_OVERRIDES,
} from '../src/services/openRouterPricing.js';

const model = (id: string, pricing: Record<string, string> = {}) => ({
  id,
  pricing: { prompt: '0.000002', completion: '0.00001', ...pricing },
});

describe('buildRateMap', () => {
  it('converts USD-per-token strings to USD-per-million', () => {
    const map = buildRateMap([
      model('anthropic/claude-sonnet-5', {
        prompt: '0.000002',
        completion: '0.00001',
        input_cache_read: '0.0000002',
        input_cache_write: '0.0000025',
      }),
    ]);
    const rates = map.ratesFor('claude-sonnet-5');
    expect(rates?.inputPerMTok).toBeCloseTo(2, 10);
    expect(rates?.cacheWritePerMTok).toBeCloseTo(2.5, 10);
    expect(rates?.cacheReadPerMTok).toBeCloseTo(0.2, 10);
    expect(rates?.outputPerMTok).toBeCloseTo(10, 10);
  });

  it('matches by basename when exactly one vendor lists that name', () => {
    const map = buildRateMap([model('xai/grok-4.6')]);
    expect(map.ratesFor('grok-4.6')).not.toBeNull();
  });

  it('refuses to guess when two vendors ship the same basename', () => {
    const map = buildRateMap([model('vendor-a/shared-name'), model('vendor-b/shared-name')]);
    expect(map.ratesFor('shared-name')).toBeNull();
  });

  it('returns null for a model OpenRouter does not list', () => {
    const map = buildRateMap([model('anthropic/claude-sonnet-5')]);
    expect(map.ratesFor('not-listed')).toBeNull();
  });

  it('skips :free / :batch / ~ aliases', () => {
    const map = buildRateMap([model('vendor/thing:free'), model('vendor/thing~beta')]);
    expect(map.ratesFor('thing')).toBeNull();
  });

  it('treats a missing cache rate as zero, not a skip', () => {
    const map = buildRateMap([model('vendor/no-cache', { input_cache_read: undefined as never })]);
    expect(map.ratesFor('no-cache')).toMatchObject({ cacheReadPerMTok: 0 });
  });

  it('uses the recorded override slug ahead of basename matching', () => {
    const overrideSlug = SLUG_OVERRIDES['kimi-k2.7'];
    const map = buildRateMap([
      model(overrideSlug, { prompt: '0.0000006' }),
      model('other-vendor/kimi-k2.7'), // would otherwise be ambiguous/wrong
    ]);
    expect(map.ratesFor('kimi-k2.7')).toMatchObject({ inputPerMTok: 0.6 });
  });

  it('is null for an override slug OpenRouter no longer lists', () => {
    const map = buildRateMap([]);
    expect(map.ratesFor('gpt-5.3-codex-spark')).toBeNull();
  });

  it('ignores a listing with no pricing at all', () => {
    const map = buildRateMap([{ id: 'vendor/unpriced' }]);
    expect(map.ratesFor('unpriced')).toBeNull();
  });

  it('treats an id with no slash as its own basename', () => {
    const map = buildRateMap([model('bare-name')]);
    expect(map.ratesFor('bare-name')).not.toBeNull();
  });
});

describe('fetchOpenRouterRateMap', () => {
  const okResponse = (data: unknown) =>
    ({ ok: true, status: 200, json: async () => ({ data }) }) as Response;

  it('fetches the catalog and returns a usable rate map', async () => {
    const fetchImpl = vi.fn(async () => okResponse([model('anthropic/claude-sonnet-5')]));
    const map = await fetchOpenRouterRateMap(5000, fetchImpl as unknown as typeof fetch);
    expect(map.ratesFor('claude-sonnet-5')).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('502s when the network call fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(
      fetchOpenRouterRateMap(5000, fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('502s with a stringified detail when the network layer throws a non-Error', async () => {
    const fetchImpl = vi.fn(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'boom';
    });
    await expect(
      fetchOpenRouterRateMap(5000, fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 502, message: expect.stringContaining('boom') });
  });

  it('502s on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }) as Response);
    await expect(
      fetchOpenRouterRateMap(5000, fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('502s when the body has no data array', async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => ({ wrong: true }) }) as Response,
    );
    await expect(
      fetchOpenRouterRateMap(5000, fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('502s when the body is not JSON', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('not json');
          },
        }) as unknown as Response,
    );
    await expect(
      fetchOpenRouterRateMap(5000, fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 502 });
  });
});
