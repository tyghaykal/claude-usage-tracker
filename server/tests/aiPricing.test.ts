import { describe, expect, it, vi } from 'vitest';
import {
  buildUserPrompt,
  chatCompletionsUrl,
  explainStatus,
  extractAssistantText,
  extractJson,
  messagesUrl,
  searchPricing,
  testProvider,
} from '../src/services/aiPricing.js';
import {
  buildAnthropicReply,
  buildJsonReply,
  stubByUrl,
  stubFetch,
  SUGGESTED,
} from './aiFixtures.js';

const base = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  modelName: 'gpt-test',
  modelId: 'claude-sonnet-5',
  timeoutMs: 1000,
};

describe('chatCompletionsUrl', () => {
  it('appends the path', () => {
    expect(chatCompletionsUrl('https://x.dev/v1')).toBe('https://x.dev/v1/chat/completions');
  });

  it('tolerates trailing slashes — the commonest paste error', () => {
    expect(chatCompletionsUrl('https://x.dev/v1/')).toBe('https://x.dev/v1/chat/completions');
    expect(chatCompletionsUrl('https://x.dev/v1///')).toBe('https://x.dev/v1/chat/completions');
  });
});

describe('messagesUrl', () => {
  it('appends the Anthropic path and strips trailing slashes', () => {
    expect(messagesUrl('https://x.dev/v1')).toBe('https://x.dev/v1/messages');
    expect(messagesUrl('https://x.dev/v1/')).toBe('https://x.dev/v1/messages');
  });
});

describe('buildUserPrompt', () => {
  it('names the model being priced', () => {
    expect(buildUserPrompt('9r/combo')).toContain('9r/combo');
  });
});

describe('extractJson', () => {
  it('parses a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses an object wrapped in a code fence', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses an object wrapped in prose', () => {
    expect(extractJson('Sure! Here it is: {"a":1} Hope that helps.')).toEqual({ a: 1 });
  });

  it('takes the outermost span for a nested object', () => {
    expect(extractJson('x {"a":{"b":2}} y')).toEqual({ a: { b: 2 } });
  });

  it('502s when there is no object at all', () => {
    expect(() => extractJson('I am afraid I cannot help with that.')).toThrow(/JSON object/);
  });

  it('502s when the braces are reversed', () => {
    expect(() => extractJson('} nonsense {')).toThrow(/JSON object/);
  });

  it('502s on malformed JSON', () => {
    expect(() => extractJson('{"a": }')).toThrow(/malformed JSON/);
  });
});

describe('searchPricing', () => {
  it('returns the parsed suggestion and the raw reply', async () => {
    const result = await searchPricing({
      ...base,
      fetchImpl: stubFetch(buildJsonReply(SUGGESTED)),
    });
    expect(result.suggested).toEqual(SUGGESTED);
    expect(result.raw).toBe(JSON.stringify(SUGGESTED));
  });

  it('defaults the currency to USD when omitted', async () => {
    const { currency: _drop, ...noCurrency } = SUGGESTED;
    const result = await searchPricing({
      ...base,
      fetchImpl: stubFetch(buildJsonReply(noCurrency)),
    });
    expect(result.suggested.currency).toBe('USD');
  });

  it('keeps the model’s notes when it gives them', async () => {
    const result = await searchPricing({
      ...base,
      fetchImpl: stubFetch(buildJsonReply({ ...SUGGESTED, notes: 'as of 2026-01' })),
    });
    expect(result.suggested.notes).toBe('as of 2026-01');
  });

  it('sends an OpenAI-shaped request with the key as a bearer token', async () => {
    const fetchImpl = stubFetch(buildJsonReply(SUGGESTED));
    await searchPricing({ ...base, fetchImpl });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-test');
    expect(body.temperature).toBe(0);
    expect(body.stream).toBe(false);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].content).toContain('claude-sonnet-5');
    expect((init.headers as Record<string, string>).accept).toBe('application/json');
  });

  it('accepts an Anthropic Messages envelope on the OpenAI path', async () => {
    const result = await searchPricing({
      ...base,
      fetchImpl: stubFetch(buildAnthropicReply(SUGGESTED)),
    });
    expect(result.suggested).toEqual(SUGGESTED);
  });

  it('falls back to Anthropic /messages when chat-completions is missing', async () => {
    const fetchImpl = stubByUrl({
      'https://api.example.com/v1/chat/completions': { body: { error: 'nope' }, status: 404 },
      'https://api.example.com/v1/messages': { body: buildAnthropicReply(SUGGESTED) },
    });
    const result = await searchPricing({ ...base, fetchImpl });
    expect(result.suggested).toEqual(SUGGESTED);

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body as string);
    expect(body.system).toContain('pricing lookup');
    expect(body.messages).toHaveLength(1);
    expect(body.max_tokens).toBe(1024);
    expect(body.stream).toBe(false);
  });

  it('502s on a network failure without leaking the key', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(searchPricing({ ...base, fetchImpl })).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('ECONNREFUSED'),
    });
  });

  it('502s on a non-Error throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw 'string failure';
    }) as unknown as typeof fetch;
    await expect(searchPricing({ ...base, fetchImpl })).rejects.toMatchObject({ status: 502 });
  });

  it('502s on an upstream error status without echoing its body', async () => {
    const fetchImpl = stubFetch({ error: 'your key sk-test is invalid' }, 401);
    const error = await searchPricing({ ...base, fetchImpl }).catch((e) => e);
    expect(error.status).toBe(502);
    expect(error.message).toBe('AI provider returned HTTP 401');
    expect(error.message).not.toContain('sk-test');
  });

  it('502s on an unrecognised envelope', async () => {
    await expect(
      searchPricing({ ...base, fetchImpl: stubFetch({ unexpected: true }) }),
    ).rejects.toMatchObject({ status: 502, message: /unrecognised response shape/ });
  });

  it('falls back to Anthropic when the OpenAI body is the wrong shape', async () => {
    const fetchImpl = stubByUrl({
      'https://api.example.com/v1/chat/completions': { body: { unexpected: true } },
      'https://api.example.com/v1/messages': { body: buildAnthropicReply(SUGGESTED) },
    });
    const result = await searchPricing({ ...base, fetchImpl });
    expect(result.suggested).toEqual(SUGGESTED);
  });

  it('502s on a 429 without retrying Anthropic', async () => {
    const fetchImpl = stubFetch({}, 429);
    await expect(searchPricing({ ...base, fetchImpl })).rejects.toMatchObject({
      status: 502,
      message: 'AI provider returned HTTP 429',
    });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('502s when the response body is not JSON', async () => {
    await expect(
      searchPricing({ ...base, fetchImpl: stubFetch('<html>gateway</html>') }),
    ).rejects.toMatchObject({ status: 502, message: /unrecognised response shape/ });
  });

  it('502s on an empty message', async () => {
    await expect(
      searchPricing({ ...base, fetchImpl: stubFetch({ choices: [{ message: { content: null } }] }) }),
    ).rejects.toMatchObject({ status: 502, message: /empty message/ });
  });

  it('502s when the JSON is missing pricing fields', async () => {
    await expect(
      searchPricing({ ...base, fetchImpl: stubFetch(buildJsonReply({ inputPerMTok: 3 })) }),
    ).rejects.toMatchObject({ status: 502, message: /without valid pricing fields/ });
  });

  it('502s when a rate is negative', async () => {
    await expect(
      searchPricing({
        ...base,
        fetchImpl: stubFetch(buildJsonReply({ ...SUGGESTED, outputPerMTok: -1 })),
      }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('uses the global fetch when none is injected', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch(buildJsonReply(SUGGESTED));
    try {
      const result = await searchPricing(base);
      expect(result.suggested).toEqual(SUGGESTED);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('explainStatus', () => {
  const url = 'https://api.example.com/v1';

  it.each([401, 403])('blames the key on %i', (status) => {
    expect(explainStatus(status, url, 'gpt-x')).toMatch(/rejected the API key/);
  });

  it('blames the base URL on 404 and shows the paths it tried', () => {
    const message = explainStatus(404, url, 'gpt-x');
    expect(message).toContain('https://api.example.com/v1/chat/completions');
    expect(message).toContain('https://api.example.com/v1/messages');
    expect(message).toMatch(/base URL/);
  });

  it.each([400, 422])('blames the model name on %i', (status) => {
    expect(explainStatus(status, url, 'gpt-x')).toContain('"gpt-x"');
  });

  it('calls a 5xx the provider’s problem, not the config’s', () => {
    expect(explainStatus(503, url, 'gpt-x')).toMatch(/server error.*try again/is);
  });

  it('falls back to the bare status for anything else', () => {
    expect(explainStatus(418, url, 'gpt-x')).toBe('The provider returned HTTP 418.');
  });
});

describe('testProvider', () => {
  const base = {
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    modelName: 'gpt-test',
    timeoutMs: 1000,
  };

  it('passes when the endpoint answers in the expected shape', async () => {
    const result = await testProvider({
      ...base,
      fetchImpl: stubFetch({ choices: [{ message: { content: 'pong' } }] }),
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.message).toContain('gpt-test');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('sends a deliberately tiny request so the check is nearly free', async () => {
    const fetchImpl = stubFetch({ choices: [{ message: { content: 'pong' } }] });
    await testProvider({ ...base, fetchImpl });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(1);
    expect(body.stream).toBe(false);
    expect(body.model).toBe('gpt-test');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    expect((init.headers as Record<string, string>).accept).toBe('application/json');
  });

  it('passes when the OpenAI path returns Anthropic content blocks', async () => {
    const result = await testProvider({
      ...base,
      fetchImpl: stubFetch({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'pong' }],
      }),
    });
    expect(result.ok).toBe(true);
  });

  it('falls back to Anthropic /messages after a 404 on chat-completions', async () => {
    const fetchImpl = stubByUrl({
      'https://api.example.com/v1/chat/completions': { body: {}, status: 404 },
      'https://api.example.com/v1/messages': {
        body: { role: 'assistant', content: [{ text: 'pong' }] },
      },
    });
    const result = await testProvider({ ...base, fetchImpl });
    expect(result.ok).toBe(true);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('treats a 429 on the Anthropic fallback as reachable', async () => {
    const fetchImpl = stubByUrl({
      'https://api.example.com/v1/chat/completions': { body: { hello: true } },
      'https://api.example.com/v1/messages': { body: {}, status: 429 },
    });
    const result = await testProvider({ ...base, fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(429);
  });

  it('does not retry Anthropic after a rejected key on the OpenAI path', async () => {
    const fetchImpl = stubFetch({ error: 'bad key' }, 401);
    await testProvider({ ...base, fetchImpl });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('reports the Anthropic 404 when both paths are missing', async () => {
    const fetchImpl = stubByUrl({
      'https://api.example.com/v1/chat/completions': { body: {}, status: 404 },
      'https://api.example.com/v1/messages': { body: {}, status: 404 },
    });
    const result = await testProvider({ ...base, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.message).toContain('/messages');
  });

  it('fails, without throwing, when the host is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;

    const result = await testProvider({ ...base, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.message).toContain('ENOTFOUND');
  });

  it('fails on a non-Error throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw 'boom';
    }) as unknown as typeof fetch;
    const result = await testProvider({ ...base, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('boom');
  });

  it('fails with an actionable message on a bad key', async () => {
    const result = await testProvider({ ...base, fetchImpl: stubFetch({ error: 'bad key' }, 401) });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.message).toMatch(/rejected the API key/);
  });

  it('never echoes the provider body, which can contain the key', async () => {
    const result = await testProvider({
      ...base,
      fetchImpl: stubFetch({ error: 'invalid key sk-test' }, 401),
    });
    expect(result.message).not.toContain('sk-test');
  });

  it('treats a 429 as reachable, and says what it could not confirm', async () => {
    // Failing the save here would block a correct config over a transient limit.
    const result = await testProvider({ ...base, fetchImpl: stubFetch({}, 429) });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(429);
    expect(result.message).toMatch(/not fully verified/);
  });

  it('fails when the endpoint answers but is not OpenAI- or Anthropic-compatible', async () => {
    const result = await testProvider({ ...base, fetchImpl: stubFetch({ hello: 'world' }) });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/OpenAI chat-completions or Anthropic messages format/);
  });

  it('fails when the body is not JSON at all', async () => {
    const result = await testProvider({ ...base, fetchImpl: stubFetch('<html>proxy</html>') });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/OpenAI chat-completions or Anthropic messages format/);
  });

  it('uses the global fetch when none is injected', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = stubFetch({ choices: [{ message: { content: 'pong' } }] });
    try {
      expect((await testProvider(base)).ok).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('extractAssistantText', () => {
  it('reads OpenAI string content and Anthropic text blocks', () => {
    expect(extractAssistantText({ choices: [{ message: { content: 'hi' } }] })).toEqual({
      recognised: true,
      content: 'hi',
    });
    expect(
      extractAssistantText({
        choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'thinking' }, 'b'] } }],
      }),
    ).toEqual({ recognised: true, content: 'ab' });
    expect(
      extractAssistantText({
        type: 'message',
        content: [{ type: 'text', text: 'pong' }, { type: 'text', text: '' }],
      }),
    ).toEqual({ recognised: true, content: 'pong' });
  });

  it('rejects bodies that are neither envelope', () => {
    expect(extractAssistantText(null).recognised).toBe(false);
    expect(extractAssistantText('nope').recognised).toBe(false);
    expect(extractAssistantText({ choices: [] }).recognised).toBe(false);
    expect(extractAssistantText({ choices: [null] }).recognised).toBe(false);
    expect(extractAssistantText({ choices: [{ message: 'x' }] }).recognised).toBe(false);
    expect(extractAssistantText({ choices: [{ message: {} }] }).recognised).toBe(false);
    expect(extractAssistantText({ content: [{ type: 'tool_use' }] }).recognised).toBe(false);
    expect(extractAssistantText({ content: { text: 'x' } }).recognised).toBe(false);
    expect(extractAssistantText({ content: ['hello'] }).recognised).toBe(false);
    expect(extractAssistantText({ content: [null] }).recognised).toBe(false);
  });

  it('treats recognised empty content as null, not as an unknown shape', () => {
    expect(extractAssistantText({ choices: [{ message: { content: null } }] })).toEqual({
      recognised: true,
      content: null,
    });
    expect(extractAssistantText({ role: 'assistant', content: [] })).toEqual({
      recognised: true,
      content: null,
    });
    expect(extractAssistantText({ choices: [{ message: { content: 3 } }] })).toEqual({
      recognised: true,
      content: null,
    });
    expect(
      extractAssistantText({ type: 'message', content: [{ type: 'text' }, { type: 'tool_use' }] }),
    ).toEqual({ recognised: true, content: null });
  });
});
