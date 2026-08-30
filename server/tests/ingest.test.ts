import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ApiToken, ModelPricing, UsageLog, User } from '../src/models.js';
import { createBroadcaster } from '../src/realtime.js';
import { touchToken } from '../src/routes/ingest.js';
import { buildApp, makeApiToken, makePricing, makeUser, usagePayload } from './helpers.js';

const { app, cache } = buildApp();

const post = (token: string, body: unknown = usagePayload()) =>
  request(app).post('/api/usage').set('X-API-Key', token).send(body);

describe('POST /api/usage — authentication', () => {
  it('401s with no X-API-Key header', async () => {
    const res = await request(app).post('/api/usage').send(usagePayload());
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Missing X-API-Key/);
  });

  it('401s on an unknown key', async () => {
    const res = await post('cur_definitely-not-a-real-token');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Unknown API key/);
  });

  it('401s on a revoked key', async () => {
    const user = await makeUser();
    const { token } = await makeApiToken(user._id, { revoked: true });
    const res = await post(token);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/revoked/);
  });

  it('401s when the key owner has been deleted', async () => {
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    await User.findByIdAndDelete(user._id);
    const res = await post(token);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/owner no longer exists/);
  });
});

describe('POST /api/usage — payload validation', () => {
  it('rejects a body missing required fields', async () => {
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    const res = await post(token, { project: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.details.fieldErrors.tokens).toBeDefined();
  });

  it('rejects a non-ISO datetime', async () => {
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    const res = await post(token, usagePayload({ datetime: '28/08/2026' }));
    expect(res.status).toBe(400);
  });

  it('rejects negative token counts', async () => {
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    const res = await post(
      token,
      usagePayload({ tokens: { input: -1, cache_read: 0, cache_write: 0, output: 0, total: 0 } }),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/usage — storage', () => {
  it('stores the plugin payload and returns 204', async () => {
    const user = await makeUser();
    const { token, doc } = await makeApiToken(user._id);
    await makePricing('claude-sonnet-5');

    const res = await post(token);
    expect(res.status).toBe(204);

    const log = await UsageLog.findOne().exec();
    expect(log).toMatchObject({
      project: 'my-project',
      projectLabel: null,
      prompt: 'fix the login bug',
      sessionId: 'abc-123',
      modelId: 'claude-sonnet-5',
      userLabel: null,
    });
    expect(log!.userId.toString()).toBe(user._id.toString());
    expect(log!.apiTokenId.toString()).toBe(doc._id.toString());
    expect(log!.promptDatetime.toISOString()).toBe('2026-08-28T10:15:00.000Z');
    expect(log!.recalculatedAt).toBeNull();
  });

  it('stores the optional project_label separately from the derived project name', async () => {
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);

    await post(token, usagePayload({ project_label: 'Client Project' }));

    const log = await UsageLog.findOne().exec();
    expect(log).toMatchObject({ project: 'my-project', projectLabel: 'Client Project' });
  });

  it('persists the pricing snapshot alongside the cost, not just the figure', async () => {
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    const pricing = await makePricing('claude-sonnet-5');

    await post(token);
    const log = await UsageLog.findOne().exec();

    // 1000 in @$3     = 0.003
    // 2000 cache_read @$0.30  = 0.0006
    // 500 cache_write @$3.75  = 0.001875
    // 300 out @$15            = 0.0045
    expect(log!.estimatedCostUsd).toBeCloseTo(0.009975, 10);
    expect(log!.pricingSnapshot).toMatchObject({
      inputPerMTok: 3,
      cacheWritePerMTok: 3.75,
      cacheReadPerMTok: 0.3,
      outputPerMTok: 15,
      currency: 'USD',
    });
    expect(log!.pricingSnapshot!.modelPricingId!.toString()).toBe(pricing._id.toString());
  });

  it('keeps the snapshot frozen when pricing changes afterwards', async () => {
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    await makePricing('claude-sonnet-5');
    await post(token);
    const before = await UsageLog.findOne().exec();

    await ModelPricing.updateOne({ modelId: 'claude-sonnet-5' }, { inputPerMTok: 999 });
    const after = await UsageLog.findById(before!._id).exec();

    expect(after!.estimatedCostUsd).toBe(before!.estimatedCostUsd);
    expect(after!.pricingSnapshot!.inputPerMTok).toBe(3);
  });

  it('stores nulls when the model exists but every rate is still zero', async () => {
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    await makePricing('claude-sonnet-5', {
      inputPerMTok: 0,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0,
      outputPerMTok: 0,
    });

    await post(token);
    const log = await UsageLog.findOne().exec();
    expect(log!.estimatedCostUsd).toBeNull();
    expect(log!.pricingSnapshot).toBeNull();
    expect(log!.tokens.total).toBe(3800);
  });

  it('stores nulls when the model has no pricing entry', async () => {
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    await post(token, usagePayload({ model: 'unpriced-model' }));

    const log = await UsageLog.findOne().exec();
    expect(log!.estimatedCostUsd).toBeNull();
    expect(log!.pricingSnapshot).toBeNull();
    // Token counts are still exact — only the cost is unknown.
    expect(log!.tokens.total).toBe(3800);
  });

  it('prices amanai/<name> using the unprefixed catalog row', async () => {
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    const pricing = await makePricing('grok-4.6');

    await post(token, usagePayload({ model: 'amanai/grok-4.6' }));
    const log = await UsageLog.findOne().exec();

    expect(log!.modelId).toBe('amanai/grok-4.6');
    expect(log!.estimatedCostUsd).toBeCloseTo(0.009975, 10);
    expect(log!.pricingSnapshot!.modelPricingId!.toString()).toBe(pricing._id.toString());
  });

  it('prefers an exact amanai/<name> row over the unprefixed catalog', async () => {
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    await makePricing('grok-4.6');
    const exact = await makePricing('amanai/grok-4.6', { inputPerMTok: 10, outputPerMTok: 20 });

    await post(token, usagePayload({ model: 'amanai/grok-4.6' }));
    const log = await UsageLog.findOne().exec();

    expect(log!.pricingSnapshot!.inputPerMTok).toBe(10);
    expect(log!.pricingSnapshot!.modelPricingId!.toString()).toBe(exact._id.toString());
  });

  it('falls back when the exact amanai row exists but every rate is still zero', async () => {
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    await makePricing('amanai/grok-4.6', {
      inputPerMTok: 0,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0,
      outputPerMTok: 0,
    });
    const catalog = await makePricing('grok-4.6');

    await post(token, usagePayload({ model: 'amanai/grok-4.6' }));
    const log = await UsageLog.findOne().exec();

    expect(log!.estimatedCostUsd).toBeCloseTo(0.009975, 10);
    expect(log!.pricingSnapshot!.modelPricingId!.toString()).toBe(catalog._id.toString());
  });

  it('does not reuse unprefixed rates for a different vendor prefix', async () => {
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    await makePricing('claude-sonnet-5');

    await post(token, usagePayload({ model: '9r/claude-sonnet-5' }));
    const log = await UsageLog.findOne().exec();
    expect(log!.modelId).toBe('9r/claude-sonnet-5');
    expect(log!.estimatedCostUsd).toBeNull();
  });

  it('stores nulls when amanai/<name> has no unprefixed catalog row either', async () => {
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    await post(token, usagePayload({ model: 'amanai/not-in-catalog' }));

    const log = await UsageLog.findOne().exec();
    expect(log!.modelId).toBe('amanai/not-in-catalog');
    expect(log!.estimatedCostUsd).toBeNull();
    expect(log!.pricingSnapshot).toBeNull();
  });

  it('accepts a payload with no model field at all', async () => {
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    const { model: _drop, ...noModel } = usagePayload();

    expect((await post(token, noModel)).status).toBe(204);
    const log = await UsageLog.findOne().exec();
    expect(log!.modelId).toBeNull();
    expect(log!.estimatedCostUsd).toBeNull();
  });

  it('stores the plugin usageUser label without trusting it for ownership', async () => {
    const owner = await makeUser({ name: 'Real Owner' });
    const { token } = await makeApiToken(owner._id);
    await post(token, usagePayload({ user: 'someone-else-entirely' }));

    const log = await UsageLog.findOne().exec();
    expect(log!.userLabel).toBe('someone-else-entirely');
    expect(log!.userId.toString()).toBe(owner._id.toString());
  });

  it('accepts an empty prompt (usagePromptMode: none)', async () => {
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    expect((await post(token, usagePayload({ prompt: '' }))).status).toBe(204);
    expect((await UsageLog.findOne().exec())!.prompt).toBe('');
  });

  it('defaults a missing prompt to an empty string', async () => {
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    const { prompt: _drop, ...noPrompt } = usagePayload();
    expect((await post(token, noPrompt)).status).toBe(204);
    expect((await UsageLog.findOne().exec())!.prompt).toBe('');
  });

  it('records lastUsedAt on the api token', async () => {
    const user = await makeUser();
    const { token, doc } = await makeApiToken(user._id);
    expect(doc.lastUsedAt).toBeNull();

    await post(token);
    expect((await ApiToken.findById(doc._id).exec())!.lastUsedAt).toBeInstanceOf(Date);
  });

  it('swallows a failed lastUsedAt write rather than failing the ingestion', async () => {
    const user = await makeUser();
    const { doc } = await makeApiToken(user._id);
    // The token is deleted after the request resolved it — mongoose's save()
    // then rejects with DocumentNotFoundError. The usage row is already
    // written by that point, so this must not surface as an error.
    await ApiToken.deleteOne({ _id: doc._id });
    await expect(touchToken(doc)).resolves.toBeUndefined();
  });

  it('records lastUsedAt through the same helper on the happy path', async () => {
    const user = await makeUser();
    const { doc } = await makeApiToken(user._id);
    await touchToken(doc);
    expect((await ApiToken.findById(doc._id).exec())!.lastUsedAt).toBeInstanceOf(Date);
  });

  it('rate-limits a flood of ingestion posts', async () => {
    const { app: limited } = buildApp({}, { RATE_LIMIT_USAGE_MAX: '2' });
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    const send = () =>
      request(limited).post('/api/usage').set('X-API-Key', token).send(usagePayload());

    await send();
    await send();
    expect((await send()).status).toBe(429);
  });

  it('broadcasts a realtime event so open dashboards refresh', async () => {
    const broadcaster = createBroadcaster();
    const listener = vi.fn();
    broadcaster.subscribe(listener);
    const { app: withBroadcaster } = buildApp({ broadcaster });
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);

    await request(withBroadcaster)
      .post('/api/usage')
      .set('X-API-Key', token)
      .send(usagePayload());

    expect(listener).toHaveBeenCalledWith({ type: 'data-changed' });
  });
});

describe('pricing cache on the ingestion path', () => {
  it('serves repeat lookups from cache instead of hitting Mongo', async () => {
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    await makePricing('claude-sonnet-5');
    cache.clear();

    await post(token);
    // Pricing removed from the DB — a cached hit is the only way the second
    // request can still price the prompt.
    await ModelPricing.deleteMany({});
    await post(token);

    const logs = await UsageLog.find().exec();
    expect(logs).toHaveLength(2);
    expect(logs[1]!.estimatedCostUsd).toBe(logs[0]!.estimatedCostUsd);
  });

  it('caches a miss so unpriced models do not re-query per prompt', async () => {
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    cache.clear();

    await post(token, usagePayload({ model: 'ghost-model' }));
    await makePricing('ghost-model');
    await post(token, usagePayload({ model: 'ghost-model' }));

    const logs = await UsageLog.find().exec();
    expect(logs[0]!.estimatedCostUsd).toBeNull();
    // Still null: the negative lookup is cached until a /api/models write.
    expect(logs[1]!.estimatedCostUsd).toBeNull();
  });
});
