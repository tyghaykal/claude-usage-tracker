import { z } from 'zod';
import { badGateway } from '../errors.js';

/**
 * AI-assisted pricing lookup (FR-11).
 *
 * Speaks OpenAI `POST {baseUrl}/chat/completions` first, then Anthropic
 * `POST {baseUrl}/messages` if that path is missing or the body is not an
 * OpenAI envelope. The endpoint is admin-supplied and unknown at build time —
 * Anthropic, an aggregator (`9router`, `amanai`, …), or any other compatible
 * proxy. See FRD §13 decision 7: this stays a generic HTTP call, not an SDK.
 */

export const suggestedPricingSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  cacheWritePerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  currency: z.string().min(1).default('USD'),
  notes: z.string().optional(),
});

export type SuggestedPricing = z.infer<typeof suggestedPricingSchema>;

export interface AiSearchResult {
  suggested: SuggestedPricing;
  /** The model's unparsed reply, so an admin can sanity-check the source. */
  raw: string;
}

export const PRICING_SYSTEM_PROMPT = [
  'You are a pricing lookup tool for LLM APIs.',
  'Given a model identifier, reply with that model\'s public list price.',
  'Prices are per MILLION tokens, in the listed currency.',
  'Reply with ONLY a JSON object, no prose and no code fences, shaped exactly:',
  '{"inputPerMTok":number,"cacheWritePerMTok":number,"cacheReadPerMTok":number,',
  '"outputPerMTok":number,"currency":string,"notes":string}',
  'If a model has no cache pricing, use 0 for the cache fields.',
  'Put any uncertainty about the figures in "notes".',
].join(' ');

export function buildUserPrompt(modelId: string): string {
  return `Model identifier: ${modelId}\nReturn its current public list price as JSON.`;
}

/**
 * Pulls the JSON object out of a model reply. Models wrap JSON in code fences
 * or a sentence often enough that demanding a bare object would fail on
 * otherwise-correct answers, so take the outermost {...} span.
 */
export function extractJson(content: string): unknown {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw badGateway('AI provider did not return a JSON object');
  }
  try {
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    throw badGateway('AI provider returned malformed JSON');
  }
}

export interface AiSearchParams {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  modelId: string;
  timeoutMs: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** Trailing slashes are the single most common paste error in a base URL. */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${trimBase(baseUrl)}/chat/completions`;
}

export function messagesUrl(baseUrl: string): string {
  return `${trimBase(baseUrl)}/messages`;
}

/* ------------------------------------------------- connectivity probe --- */

export interface ProviderTestResult {
  ok: boolean;
  /** Upstream HTTP status, or null when the request never got a response. */
  status: number | null;
  latencyMs: number;
  message: string;
}

/**
 * Turns an upstream status into something an admin can act on. Never includes
 * the provider's response body — it can echo back the key we just sent.
 */
export function explainStatus(status: number, baseUrl: string, modelName: string): string {
  if (status === 401 || status === 403) {
    return `The provider rejected the API key (HTTP ${status}). Check the key and that it is valid for this endpoint.`;
  }
  if (status === 404) {
    return `No chat-completions endpoint at ${chatCompletionsUrl(baseUrl)} (HTTP 404). Check the base URL — for most providers it ends in /v1. Anthropic-style APIs use ${messagesUrl(baseUrl)}.`;
  }
  if (status === 400 || status === 422) {
    return `The provider rejected the request (HTTP ${status}). The model name "${modelName}" is probably wrong for this endpoint.`;
  }
  if (status >= 500) {
    return `The provider returned a server error (HTTP ${status}). It may be temporarily down — try again shortly.`;
  }
  return `The provider returned HTTP ${status}.`;
}

const SHAPE_ERROR =
  'The endpoint answered, but not in the OpenAI chat-completions or Anthropic messages format this app speaks. Check that the base URL points at an OpenAI- or Anthropic-compatible API.';

function jsonHeaders(apiKey: string, style: 'openai' | 'anthropic'): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${apiKey}`,
  };
  if (style === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }
  return headers;
}

function textFromContent(content: unknown): string | null {
  if (content === null || content === undefined) return null;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (block && typeof block === 'object' && 'text' in block) {
      const text = (block as { text: unknown }).text;
      if (typeof text === 'string' && text) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join('') : null;
}

function looksLikeAnthropicBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false;
  const rec = block as { type?: unknown; text?: unknown };
  return rec.type === 'text' || typeof rec.text === 'string';
}

/** OpenAI `choices[0].message.content` or Anthropic `content[]` text blocks. */
export function extractAssistantText(
  body: unknown,
): { recognised: true; content: string | null } | { recognised: false } {
  if (!body || typeof body !== 'object') return { recognised: false };
  const rec = body as Record<string, unknown>;

  if (Array.isArray(rec.choices) && rec.choices.length > 0) {
    const first = rec.choices[0];
    if (!first || typeof first !== 'object') return { recognised: false };
    const message = (first as { message?: unknown }).message;
    if (!message || typeof message !== 'object' || !('content' in message)) {
      return { recognised: false };
    }
    return { recognised: true, content: textFromContent((message as { content: unknown }).content) };
  }

  if (Array.isArray(rec.content)) {
    const looksAnthropic =
      rec.type === 'message' || rec.role === 'assistant' || rec.content.some(looksLikeAnthropicBlock);
    if (looksAnthropic) {
      return { recognised: true, content: textFromContent(rec.content) };
    }
  }

  return { recognised: false };
}

type ChatAttempt =
  | { kind: 'network'; detail: string }
  | { kind: 'http'; status: number }
  | { kind: 'rateLimit'; status: 429 }
  | { kind: 'ok'; status: number; content: string | null }
  | { kind: 'shape'; status: number };

async function postChat(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<ChatAttempt> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: 'network', detail };
  }

  if (response.status === 429) return { kind: 'rateLimit', status: 429 };
  if (!response.ok) return { kind: 'http', status: response.status };

  const parsed = extractAssistantText(await response.json().catch(() => null));
  if (!parsed.recognised) return { kind: 'shape', status: response.status };
  return { kind: 'ok', status: response.status, content: parsed.content };
}

function shouldTryAnthropic(attempt: ChatAttempt): boolean {
  return (attempt.kind === 'http' && attempt.status === 404) || attempt.kind === 'shape';
}

async function fetchAssistantMessage({
  baseUrl,
  apiKey,
  timeoutMs,
  fetchImpl,
  openaiBody,
  anthropicBody,
}: {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  openaiBody: Record<string, unknown>;
  anthropicBody: Record<string, unknown>;
}): Promise<ChatAttempt> {
  const openai = await postChat(
    fetchImpl,
    chatCompletionsUrl(baseUrl),
    jsonHeaders(apiKey, 'openai'),
    openaiBody,
    timeoutMs,
  );
  if (!shouldTryAnthropic(openai)) return openai;

  const anthropic = await postChat(
    fetchImpl,
    messagesUrl(baseUrl),
    jsonHeaders(apiKey, 'anthropic'),
    anthropicBody,
    timeoutMs,
  );
  // A 2xx OpenAI body we couldn't read is still the better diagnosis than a
  // follow-up /messages miss — the first endpoint answered.
  if (openai.kind === 'shape' && anthropic.kind !== 'ok' && anthropic.kind !== 'rateLimit') {
    return openai;
  }
  return anthropic;
}

/**
 * A minimal, cheap round-trip that answers one question: does this base URL +
 * key + model actually work? Run before an AiProviderConfig is saved, so a
 * typo surfaces at configuration time rather than halfway through a pricing
 * lookup days later.
 *
 * `max_tokens: 1` keeps the cost of the check to a rounding error. Unlike
 * `searchPricing` this never throws — a failed probe is a *result*, and the
 * caller decides what it means.
 */
export async function testProvider({
  baseUrl,
  apiKey,
  modelName,
  timeoutMs,
  fetchImpl = fetch,
}: Omit<AiSearchParams, 'modelId'>): Promise<ProviderTestResult> {
  const startedAt = Date.now();
  const attempt = await fetchAssistantMessage({
    baseUrl,
    apiKey,
    timeoutMs,
    fetchImpl,
    openaiBody: {
      model: modelName,
      max_tokens: 1,
      stream: false,
      messages: [{ role: 'user', content: 'ping' }],
    },
    anthropicBody: {
      model: modelName,
      max_tokens: 1,
      stream: false,
      messages: [{ role: 'user', content: 'ping' }],
    },
  });
  const latencyMs = Date.now() - startedAt;

  if (attempt.kind === 'network') {
    return {
      ok: false,
      status: null,
      latencyMs,
      message: `Could not reach ${baseUrl}: ${attempt.detail}`,
    };
  }

  // A 429 proves the endpoint exists and answered us; the provider is simply
  // throttling this probe. Failing the save here would block a correct config
  // over a transient condition, so treat it as reachable and say what we could
  // not confirm.
  if (attempt.kind === 'rateLimit') {
    return {
      ok: true,
      status: 429,
      latencyMs,
      message:
        'Endpoint reached, but it rate-limited the check (HTTP 429), so the key and model were not fully verified.',
    };
  }

  if (attempt.kind === 'http') {
    return {
      ok: false,
      status: attempt.status,
      latencyMs,
      message: explainStatus(attempt.status, baseUrl, modelName),
    };
  }

  if (attempt.kind === 'shape') {
    return { ok: false, status: attempt.status, latencyMs, message: SHAPE_ERROR };
  }

  return {
    ok: true,
    status: attempt.status,
    latencyMs,
    message: `Reached the provider and got a reply from "${modelName}" in ${latencyMs}ms.`,
  };
}

export async function searchPricing({
  baseUrl,
  apiKey,
  modelName,
  modelId,
  timeoutMs,
  fetchImpl = fetch,
}: AiSearchParams): Promise<AiSearchResult> {
  const attempt = await fetchAssistantMessage({
    baseUrl,
    apiKey,
    timeoutMs,
    fetchImpl,
    openaiBody: {
      model: modelName,
      temperature: 0,
      stream: false,
      messages: [
        { role: 'system', content: PRICING_SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(modelId) },
      ],
    },
    anthropicBody: {
      model: modelName,
      max_tokens: 1024,
      temperature: 0,
      stream: false,
      system: PRICING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(modelId) }],
    },
  });

  if (attempt.kind === 'network') {
    throw badGateway(`Could not reach the AI provider: ${attempt.detail}`);
  }
  if (attempt.kind === 'http' || attempt.kind === 'rateLimit') {
    // Never echo the provider's body back — it can contain the key we sent.
    throw badGateway(`AI provider returned HTTP ${attempt.status}`);
  }
  if (attempt.kind === 'shape') {
    throw badGateway('AI provider returned an unrecognised response shape');
  }

  const content = attempt.content;
  if (!content) throw badGateway('AI provider returned an empty message');

  const parsedPricing = suggestedPricingSchema.safeParse(extractJson(content));
  if (!parsedPricing.success) {
    throw badGateway('AI provider returned JSON without valid pricing fields');
  }

  return { suggested: parsedPricing.data, raw: content };
}
