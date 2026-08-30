import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, dayToIso, setAccessToken, setSessionLostHandler, toQuery } from '../src/api';
import {
  costBreakdown,
  formatCost,
  formatDateTime,
  formatRate,
  formatTokens,
  lineCost,
  truncate,
} from '../src/format';

afterEach(() => {
  setAccessToken(null);
  vi.unstubAllGlobals();
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('toQuery', () => {
  it('returns an empty string when everything is blank', () => {
    expect(toQuery({ a: '', b: undefined, c: null })).toBe('');
  });

  it('keeps only the set values', () => {
    expect(toQuery({ project: 'web', page: 2, model: '' })).toBe('?project=web&page=2');
  });

  it('encodes values that need it', () => {
    expect(toQuery({ model: '9r/claude-sonnet-5' })).toBe('?model=9r%2Fclaude-sonnet-5');
  });

  it('keeps a zero, which is a real value', () => {
    expect(toQuery({ page: 0 })).toBe('?page=0');
  });
});

describe('dayToIso', () => {
  it('returns undefined for an empty date input', () => {
    expect(dayToIso('')).toBeUndefined();
  });

  it('expands a day to the start of that UTC day', () => {
    expect(dayToIso('2026-08-28')).toBe('2026-08-28T00:00:00.000Z');
  });

  it('expands to the end of the day when asked, so "to" is inclusive', () => {
    expect(dayToIso('2026-08-28', true)).toBe('2026-08-28T23:59:59.999Z');
  });
});

describe('api', () => {
  it('returns the parsed body on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })));
    expect(await api('/health')).toEqual({ ok: true });
  });

  it('returns null for a 204', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    expect(await api('/tokens/x')).toBeNull();
  });

  it('sends the bearer token once one is set', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    setAccessToken('token-123');
    await api('/me');

    const init = fetchMock.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer token-123');
  });

  it('sends a JSON content type only when there is a body', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await api('/models', { method: 'POST', body: { a: 1 } });
    await api('/models');

    const withBody = fetchMock.mock.calls[0]![1]!;
    const withoutBody = fetchMock.mock.calls[1]![1]!;
    expect((withBody.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(withBody.body).toBe('{"a":1}');
    expect((withoutBody.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('throws an ApiError carrying the server message and status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Nope', details: { x: 1 } }, 400)));
    const error = (await api('/models').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(400);
    expect(error.message).toBe('Nope');
    expect(error.details).toEqual({ x: 1 });
  });

  it('falls back to a generic message when the body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 502 })));
    await expect(api('/models')).rejects.toThrow('Request failed (502)');
  });

  it('refreshes once on a 401 and retries the original request', async () => {
    setAccessToken('stale');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'fresh' }))
      .mockResolvedValueOnce(jsonResponse({ user: { name: 'Ada' } }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await api('/me')).toEqual({ user: { name: 'Ada' } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The retry carries the refreshed token, not the stale one.
    const retry = fetchMock.mock.calls[2]![1]!;
    expect((retry.headers as Record<string, string>).authorization).toBe('Bearer fresh');
  });

  it('gives up and reports the session lost when the refresh fails', async () => {
    setAccessToken('stale');
    const lost = vi.fn();
    setSessionLostHandler(lost);
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401))
        .mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 401)),
    );

    await expect(api('/me')).rejects.toThrow();
    expect(lost).toHaveBeenCalledOnce();
    setSessionLostHandler(() => {});
  });

  it('does not try to refresh when there is no token to refresh', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ error: 'Unauthorized' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api('/me')).rejects.toThrow('Unauthorized');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not loop when the retried request also 401s', async () => {
    setAccessToken('stale');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'fresh' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'still no' }, 401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api('/me')).rejects.toThrow('still no');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('formatCost', () => {
  it('renders a dash when there is no price, not "$0.00"', () => {
    expect(formatCost(null)).toBe('—');
  });

  it('keeps sub-cent amounts visible instead of rounding them away', () => {
    // The whole point: a single prompt often costs well under a cent.
    expect(formatCost(0.009975)).toBe('$0.009975');
  });

  it('uses ordinary currency formatting once past a cent', () => {
    expect(formatCost(12.5)).toBe('$12.50');
  });

  it('renders an exact zero as zero, not as a dash', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

  it('honours a non-USD currency', () => {
    expect(formatCost(5, 'EUR')).toContain('5.00');
  });
});

describe('formatTokens', () => {
  it('groups thousands', () => {
    expect(formatTokens(1234567)).toBe('1,234,567');
  });
});

describe('formatRate', () => {
  it('labels the rate per million tokens', () => {
    expect(formatRate(3)).toBe('$3.00/MTok');
  });
});

describe('formatDateTime', () => {
  it('renders a dash for null', () => {
    expect(formatDateTime(null)).toBe('—');
  });

  it('renders a real timestamp', () => {
    expect(formatDateTime('2026-08-28T10:15:00.000Z')).toMatch(/2026/);
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('short')).toBe('short');
  });

  it('ellipsises long text', () => {
    expect(truncate('abcdef', 3)).toBe('abc…');
  });
});

describe('costBreakdown', () => {
  const snapshot = {
    modelPricingId: 'pricing-id',
    inputPerMTok: 3,
    cacheWritePerMTok: 3.75,
    cacheReadPerMTok: 0.3,
    outputPerMTok: 15,
    currency: 'USD',
  };

  it('prices each token component at its own rate', () => {
    const result = costBreakdown(
      { input: 1000, cache_read: 2000, cache_write: 500, output: 300, total: 3800 },
      snapshot,
    );
    expect(result.lines.map((line) => [line.key, line.cost])).toEqual([
      ['input', 0.003],
      ['cache_read', 0.0006],
      ['cache_write', 0.001875],
      ['output', 0.0045],
    ]);
    expect(result.total).toBeCloseTo(0.009975, 10);
    expect(result.currency).toBe('USD');
  });

  it('ignores tokens.total so components are not double-counted', () => {
    const result = costBreakdown(
      { input: 1000, cache_read: 0, cache_write: 0, output: 0, total: 999_999 },
      snapshot,
    );
    expect(result.total).toBeCloseTo(0.003, 10);
  });

  it('returns 0 for an empty turn', () => {
    expect(
      costBreakdown({ input: 0, cache_read: 0, cache_write: 0, output: 0, total: 0 }, snapshot)
        .total,
    ).toBe(0);
  });
});

describe('lineCost', () => {
  it('keeps sub-cent amounts instead of rounding them to zero', () => {
    expect(lineCost(10, 3)).toBe(0.00003);
  });
});
