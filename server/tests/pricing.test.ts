import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { decryptSecret } from '../src/crypto.js';
import { badGateway } from '../src/errors.js';
import { AiProviderConfig, ModelPricing } from '../src/models.js';
import {
  buildJsonReply,
  failingProbe,
  makeProvider,
  okProbe,
  okSearch,
  SUGGESTED,
} from './aiFixtures.js';
import { buildApp, makeUserAndLogin, testConfig } from './helpers.js';

// The default app stubs the connectivity probe as healthy — the probe itself
// is unit-tested in aiPricing.test.ts, and no test should touch the network.
const { app } = buildApp({ testProviderImpl: okProbe() });

const VALID = {
  modelId: 'claude-sonnet-5',
  inputPerMTok: 3,
  cacheWritePerMTok: 3.75,
  cacheReadPerMTok: 0.3,
  outputPerMTok: 15,
};

describe('/api/models', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/models')).status).toBe(401);
  });

  it('lets a non-admin read pricing but not write it', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'user' });
    expect((await request(app).get('/api/models').set('Authorization', auth)).status).toBe(200);
    expect(
      (await request(app).post('/api/models').set('Authorization', auth).send(VALID)).status,
    ).toBe(403);
  });

  it('creates and lists pricing, defaulting currency and source', async () => {
    const { user, auth } = await makeUserAndLogin(app, { role: 'admin' });
    const created = await request(app).post('/api/models').set('Authorization', auth).send(VALID);

    expect(created.status).toBe(201);
    expect(created.body.model).toMatchObject({
      modelId: 'claude-sonnet-5',
      currency: 'USD',
      source: 'manual',
      updatedBy: user._id.toString(),
    });

    const list = await request(app).get('/api/models').set('Authorization', auth);
    expect(list.body.models).toHaveLength(1);
    expect(list.body.catalog).toContain('claude-sonnet-5');
    expect(list.body.catalog).not.toContain('amanai/claude-sonnet-5');
  });

  it('accepts aggregator-namespaced model ids verbatim', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    for (const modelId of ['9r/claude-sonnet-5', 'amanai/claude-sonnet-5', '9r/combo-name']) {
      const res = await request(app)
        .post('/api/models')
        .set('Authorization', auth)
        .send({ ...VALID, modelId });
      expect(res.status).toBe(201);
      expect(res.body.model.modelId).toBe(modelId);
    }
    expect(await ModelPricing.countDocuments()).toBe(3);
  });

  it('records an AI-sourced entry as source: ai', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const res = await request(app)
      .post('/api/models')
      .set('Authorization', auth)
      .send({ ...VALID, source: 'ai' });
    expect(res.body.model.source).toBe('ai');
  });

  it('rejects a duplicate modelId', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    await request(app).post('/api/models').set('Authorization', auth).send(VALID);
    const second = await request(app).post('/api/models').set('Authorization', auth).send(VALID);
    expect(second.status).toBe(409);
  });

  it('rejects negative rates and a missing modelId', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    expect(
      (
        await request(app)
          .post('/api/models')
          .set('Authorization', auth)
          .send({ ...VALID, inputPerMTok: -1 })
      ).status,
    ).toBe(400);
    const { modelId: _drop, ...noId } = VALID;
    expect(
      (await request(app).post('/api/models').set('Authorization', auth).send(noId)).status,
    ).toBe(400);
  });

  it('updates rates', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const created = await request(app).post('/api/models').set('Authorization', auth).send(VALID);

    const res = await request(app)
      .patch(`/api/models/${created.body.model.id}`)
      .set('Authorization', auth)
      .send({ inputPerMTok: 9, currency: 'EUR' });

    expect(res.body.model).toMatchObject({ inputPerMTok: 9, currency: 'EUR', outputPerMTok: 15 });
  });

  it('deletes pricing', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const created = await request(app).post('/api/models').set('Authorization', auth).send(VALID);
    const res = await request(app)
      .delete(`/api/models/${created.body.model.id}`)
      .set('Authorization', auth);
    expect(res.status).toBe(204);
    expect(await ModelPricing.countDocuments()).toBe(0);
  });

  it('404s update/delete of a missing id and 400s a malformed one', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const missing = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    expect(
      (
        await request(app)
          .patch(`/api/models/${missing}`)
          .set('Authorization', auth)
          .send({ inputPerMTok: 1 })
      ).status,
    ).toBe(404);
    expect(
      (await request(app).delete(`/api/models/${missing}`).set('Authorization', auth)).status,
    ).toBe(404);
    expect(
      (await request(app).delete('/api/models/nope').set('Authorization', auth)).status,
    ).toBe(400);
  });

  it('rejects an empty update', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const created = await request(app).post('/api/models').set('Authorization', auth).send(VALID);
    const res = await request(app)
      .patch(`/api/models/${created.body.model.id}`)
      .set('Authorization', auth)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/models/refresh-openrouter', () => {
  const rateMap = (rates: Record<string, ReturnType<typeof Object>> = {}) => ({
    ratesFor: (modelId: string) => (modelId in rates ? rates[modelId] : null),
  });

  it('requires authentication', async () => {
    expect((await request(app).post('/api/models/refresh-openrouter')).status).toBe(401);
  });

  it('is admin-only', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'user' });
    const res = await request(app)
      .post('/api/models/refresh-openrouter')
      .set('Authorization', auth);
    expect(res.status).toBe(403);
  });

  it('updates rows OpenRouter has a match for and leaves the rest alone', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const priced = await request(app).post('/api/models').set('Authorization', auth).send(VALID);
    const other = await request(app)
      .post('/api/models')
      .set('Authorization', auth)
      .send({ ...VALID, modelId: 'not-on-openrouter' });

    const app2 = buildApp({
      testProviderImpl: okProbe(),
      fetchOpenRouterRateMapImpl: vi.fn(async () =>
        rateMap({
          'claude-sonnet-5': {
            inputPerMTok: 5,
            cacheWritePerMTok: 6.25,
            cacheReadPerMTok: 0.5,
            outputPerMTok: 25,
          },
        }),
      ),
    }).app;

    const res = await request(app2)
      .post('/api/models/refresh-openrouter')
      .set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ checked: 2, updated: 1, unmatched: 1 });

    const updated = await ModelPricing.findById(priced.body.model.id).exec();
    expect(updated).toMatchObject({ inputPerMTok: 5, outputPerMTok: 25, source: 'manual' });
    const untouched = await ModelPricing.findById(other.body.model.id).exec();
    expect(untouched).toMatchObject({ inputPerMTok: VALID.inputPerMTok });
  });

  it('does not write, and does not invalidate the cache, when nothing changed', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    await request(app).post('/api/models').set('Authorization', auth).send(VALID);

    const app2 = buildApp({
      testProviderImpl: okProbe(),
      fetchOpenRouterRateMapImpl: vi.fn(async () =>
        rateMap({
          'claude-sonnet-5': {
            inputPerMTok: VALID.inputPerMTok,
            cacheWritePerMTok: VALID.cacheWritePerMTok,
            cacheReadPerMTok: VALID.cacheReadPerMTok,
            outputPerMTok: VALID.outputPerMTok,
          },
        }),
      ),
    }).app;

    const res = await request(app2)
      .post('/api/models/refresh-openrouter')
      .set('Authorization', auth);
    expect(res.body).toEqual({ checked: 1, updated: 0, unmatched: 0 });
  });

  it('is a no-op when there is nothing stored yet', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const app2 = buildApp({
      testProviderImpl: okProbe(),
      fetchOpenRouterRateMapImpl: vi.fn(async () => rateMap()),
    }).app;
    const res = await request(app2)
      .post('/api/models/refresh-openrouter')
      .set('Authorization', auth);
    expect(res.body).toEqual({ checked: 0, updated: 0, unmatched: 0 });
  });

  it('surfaces a 502 when the OpenRouter fetch itself fails', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    await request(app).post('/api/models').set('Authorization', auth).send(VALID);
    const app2 = buildApp({
      testProviderImpl: okProbe(),
      fetchOpenRouterRateMapImpl: vi.fn(async () => {
        throw badGateway('Could not reach OpenRouter: down');
      }),
    }).app;
    const res = await request(app2)
      .post('/api/models/refresh-openrouter')
      .set('Authorization', auth);
    expect(res.status).toBe(502);
  });
});

describe('POST /api/models/ai-search', () => {
  it('is admin-only', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'user' });
    const provider = await makeProvider();
    const res = await request(app)
      .post('/api/models/ai-search')
      .set('Authorization', auth)
      .send({ modelId: 'x', providerId: provider._id.toString() });
    expect(res.status).toBe(403);
  });

  it('returns a preview and writes nothing', async () => {
    const searchPricingImpl = okSearch();
    const { app: withAi } = buildApp({ searchPricingImpl, testProviderImpl: okProbe() });
    const { auth } = await makeUserAndLogin(withAi, { role: 'admin' });
    const provider = await makeProvider();

    const res = await request(withAi)
      .post('/api/models/ai-search')
      .set('Authorization', auth)
      .send({ modelId: '9r/claude-sonnet-5', providerId: provider._id.toString() });

    expect(res.status).toBe(200);
    expect(res.body.suggested).toEqual(SUGGESTED);
    expect(res.body.modelId).toBe('9r/claude-sonnet-5');
    expect(res.body.fromCache).toBe(false);
    expect(res.body.disclaimer).toMatch(/may be stale or wrong/);
    // The whole point: nothing was persisted.
    expect(await ModelPricing.countDocuments()).toBe(0);
  });

  it('passes the decrypted key and provider settings to the connector', async () => {
    const searchPricingImpl = okSearch();
    const { app: withAi } = buildApp({ searchPricingImpl, testProviderImpl: okProbe() });
    const { auth } = await makeUserAndLogin(withAi, { role: 'admin' });
    const provider = await makeProvider({ apiKey: 'sk-plaintext-key' });

    await request(withAi)
      .post('/api/models/ai-search')
      .set('Authorization', auth)
      .send({ modelId: 'm', providerId: provider._id.toString() });

    expect(searchPricingImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-plaintext-key',
        baseUrl: 'https://api.example.com/v1',
        modelName: 'gpt-test',
        modelId: 'm',
      }),
    );
  });

  it('caches a result so a repeat lookup does not re-spend an API call', async () => {
    const searchPricingImpl = okSearch();
    const { app: withAi } = buildApp({ searchPricingImpl, testProviderImpl: okProbe() });
    const { auth } = await makeUserAndLogin(withAi, { role: 'admin' });
    const provider = await makeProvider();
    const body = { modelId: 'm', providerId: provider._id.toString() };

    const first = await request(withAi)
      .post('/api/models/ai-search')
      .set('Authorization', auth)
      .send(body);
    const second = await request(withAi)
      .post('/api/models/ai-search')
      .set('Authorization', auth)
      .send(body);

    expect(first.body.fromCache).toBe(false);
    expect(second.body.fromCache).toBe(true);
    expect(searchPricingImpl).toHaveBeenCalledTimes(1);
  });

  it('refresh bypasses the cache', async () => {
    const searchPricingImpl = okSearch();
    const { app: withAi } = buildApp({ searchPricingImpl, testProviderImpl: okProbe() });
    const { auth } = await makeUserAndLogin(withAi, { role: 'admin' });
    const provider = await makeProvider();
    const body = { modelId: 'm', providerId: provider._id.toString() };

    await request(withAi).post('/api/models/ai-search').set('Authorization', auth).send(body);
    const refreshed = await request(withAi)
      .post('/api/models/ai-search')
      .set('Authorization', auth)
      .send({ ...body, refresh: true });

    expect(refreshed.body.fromCache).toBe(false);
    expect(searchPricingImpl).toHaveBeenCalledTimes(2);
  });

  it('404s an unknown provider', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const res = await request(app)
      .post('/api/models/ai-search')
      .set('Authorization', auth)
      .send({ modelId: 'm', providerId: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(res.status).toBe(404);
  });

  it('rejects a malformed body', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const res = await request(app)
      .post('/api/models/ai-search')
      .set('Authorization', auth)
      .send({ providerId: 'not-an-id' });
    expect(res.status).toBe(400);
  });

  it('surfaces a provider failure as a 502', async () => {
    const searchPricingImpl = vi.fn(async () => {
      throw new (await import('../src/errors.js')).HttpError(502, 'AI provider returned HTTP 500');
    });
    const { app: withAi } = buildApp({ searchPricingImpl: searchPricingImpl as never, testProviderImpl: okProbe() });
    const { auth } = await makeUserAndLogin(withAi, { role: 'admin' });
    const provider = await makeProvider();

    const res = await request(withAi)
      .post('/api/models/ai-search')
      .set('Authorization', auth)
      .send({ modelId: 'm', providerId: provider._id.toString() });

    expect(res.status).toBe(502);
  });

  it('the suggested numbers save through the ordinary create endpoint', async () => {
    const { app: withAi } = buildApp({ searchPricingImpl: okSearch(), testProviderImpl: okProbe() });
    const { auth } = await makeUserAndLogin(withAi, { role: 'admin' });
    const provider = await makeProvider();

    const preview = await request(withAi)
      .post('/api/models/ai-search')
      .set('Authorization', auth)
      .send({ modelId: 'claude-sonnet-5', providerId: provider._id.toString() });

    const saved = await request(withAi)
      .post('/api/models')
      .set('Authorization', auth)
      .send({ modelId: 'claude-sonnet-5', ...preview.body.suggested, source: 'ai' });

    expect(saved.status).toBe(201);
    expect(saved.body.model).toMatchObject({ inputPerMTok: 3, source: 'ai' });
  });
});

describe('/api/ai-providers', () => {
  const create = {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelName: 'anthropic/claude-sonnet-5',
    apiKey: 'sk-or-secret',
  };

  it('is admin-only', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'user' });
    expect((await request(app).get('/api/ai-providers').set('Authorization', auth)).status).toBe(
      403,
    );
  });

  it('creates a provider and never returns the key', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const res = await request(app)
      .post('/api/ai-providers')
      .set('Authorization', auth)
      .send(create);

    expect(res.status).toBe(201);
    expect(res.body.provider).toMatchObject({ label: 'OpenRouter', hasKey: true });
    expect(JSON.stringify(res.body)).not.toContain('sk-or-secret');

    const list = await request(app).get('/api/ai-providers').set('Authorization', auth);
    expect(JSON.stringify(list.body)).not.toContain('sk-or-secret');
  });

  it('stores the key encrypted, not in the clear', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    await request(app).post('/api/ai-providers').set('Authorization', auth).send(create);

    const stored = await AiProviderConfig.findOne().exec();
    expect(stored!.apiKeyEnc).not.toContain('sk-or-secret');
    expect(decryptSecret(stored!.apiKeyEnc, testConfig().SETTINGS_ENCRYPTION_KEY)).toBe(
      'sk-or-secret',
    );
  });

  it('rejects a non-http base URL and a malformed one', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    for (const baseUrl of ['file:///etc/passwd', 'not a url']) {
      const res = await request(app)
        .post('/api/ai-providers')
        .set('Authorization', auth)
        .send({ ...create, baseUrl });
      expect(res.status).toBe(400);
    }
  });

  it('updates fields, re-encrypting a replaced key', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const created = await request(app)
      .post('/api/ai-providers')
      .set('Authorization', auth)
      .send(create);

    const res = await request(app)
      .patch(`/api/ai-providers/${created.body.provider.id}`)
      .set('Authorization', auth)
      .send({ label: 'Renamed', modelName: 'other-model', apiKey: 'sk-rotated' });

    expect(res.body.provider).toMatchObject({ label: 'Renamed', modelName: 'other-model' });
    const stored = await AiProviderConfig.findOne().exec();
    expect(decryptSecret(stored!.apiKeyEnc, testConfig().SETTINGS_ENCRYPTION_KEY)).toBe(
      'sk-rotated',
    );
  });

  it('updates the base URL alone', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const created = await request(app)
      .post('/api/ai-providers')
      .set('Authorization', auth)
      .send(create);
    const res = await request(app)
      .patch(`/api/ai-providers/${created.body.provider.id}`)
      .set('Authorization', auth)
      .send({ baseUrl: 'https://new.example.com/v1' });
    expect(res.body.provider.baseUrl).toBe('https://new.example.com/v1');
  });

  it('drops cached suggestions when the provider changes', async () => {
    const searchPricingImpl = okSearch();
    const { app: withAi } = buildApp({ searchPricingImpl, testProviderImpl: okProbe() });
    const { auth } = await makeUserAndLogin(withAi, { role: 'admin' });
    const created = await request(withAi)
      .post('/api/ai-providers')
      .set('Authorization', auth)
      .send(create);
    const providerId = created.body.provider.id as string;

    await request(withAi)
      .post('/api/models/ai-search')
      .set('Authorization', auth)
      .send({ modelId: 'm', providerId });
    await request(withAi)
      .patch(`/api/ai-providers/${providerId}`)
      .set('Authorization', auth)
      .send({ apiKey: 'sk-rotated' });
    const after = await request(withAi)
      .post('/api/models/ai-search')
      .set('Authorization', auth)
      .send({ modelId: 'm', providerId });

    expect(after.body.fromCache).toBe(false);
    expect(searchPricingImpl).toHaveBeenCalledTimes(2);
  });

  it('deletes a provider', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const created = await request(app)
      .post('/api/ai-providers')
      .set('Authorization', auth)
      .send(create);
    const res = await request(app)
      .delete(`/api/ai-providers/${created.body.provider.id}`)
      .set('Authorization', auth);
    expect(res.status).toBe(204);
    expect(await AiProviderConfig.countDocuments()).toBe(0);
  });

  it('404s missing ids, 400s malformed ones and 400s an empty update', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const missing = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    expect(
      (
        await request(app)
          .patch(`/api/ai-providers/${missing}`)
          .set('Authorization', auth)
          .send({ label: 'x' })
      ).status,
    ).toBe(404);
    expect(
      (await request(app).delete(`/api/ai-providers/${missing}`).set('Authorization', auth)).status,
    ).toBe(404);
    expect(
      (await request(app).delete('/api/ai-providers/nope').set('Authorization', auth)).status,
    ).toBe(400);

    const created = await request(app)
      .post('/api/ai-providers')
      .set('Authorization', auth)
      .send(create);
    expect(
      (
        await request(app)
          .patch(`/api/ai-providers/${created.body.provider.id}`)
          .set('Authorization', auth)
          .send({})
      ).status,
    ).toBe(400);
  });
});

describe('AI provider connectivity probe', () => {
  const create = {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelName: 'anthropic/claude-sonnet-5',
    apiKey: 'sk-or-secret',
  };

  it('probes the endpoint before storing it, and reports the result', async () => {
    const testProviderImpl = okProbe();
    const { app: probed } = buildApp({ testProviderImpl });
    const { auth } = await makeUserAndLogin(probed, { role: 'admin' });

    const res = await request(probed)
      .post('/api/ai-providers')
      .set('Authorization', auth)
      .send(create);

    expect(res.status).toBe(201);
    expect(res.body.test).toMatchObject({ ok: true, status: 200 });
    expect(testProviderImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://openrouter.ai/api/v1',
        modelName: 'anthropic/claude-sonnet-5',
        apiKey: 'sk-or-secret',
      }),
    );
  });

  it('refuses to store a provider it could not reach', async () => {
    const { app: probed } = buildApp({
      testProviderImpl: failingProbe('The provider rejected the API key (HTTP 401).'),
    });
    const { auth } = await makeUserAndLogin(probed, { role: 'admin' });

    const res = await request(probed)
      .post('/api/ai-providers')
      .set('Authorization', auth)
      .send(create);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rejected the API key/);
    expect(res.body.details.providerTest.ok).toBe(false);
    // Nothing was written — a broken provider never reaches the database.
    expect(await AiProviderConfig.countDocuments()).toBe(0);
  });

  it('re-probes when the URL, model or key changes', async () => {
    const testProviderImpl = okProbe();
    const { app: probed } = buildApp({ testProviderImpl });
    const { auth } = await makeUserAndLogin(probed, { role: 'admin' });
    const created = await request(probed)
      .post('/api/ai-providers')
      .set('Authorization', auth)
      .send(create);
    testProviderImpl.mockClear();

    const res = await request(probed)
      .patch(`/api/ai-providers/${created.body.provider.id}`)
      .set('Authorization', auth)
      .send({ modelName: 'openai/gpt-4o' });

    expect(res.status).toBe(200);
    expect(res.body.test.ok).toBe(true);
    expect(testProviderImpl).toHaveBeenCalledOnce();
    // The unchanged key is decrypted and reused for the probe.
    expect(testProviderImpl).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-or-secret', modelName: 'openai/gpt-4o' }),
    );
  });

  it('does not spend an API call on a label-only rename', async () => {
    const testProviderImpl = okProbe();
    const { app: probed } = buildApp({ testProviderImpl });
    const { auth } = await makeUserAndLogin(probed, { role: 'admin' });
    const created = await request(probed)
      .post('/api/ai-providers')
      .set('Authorization', auth)
      .send(create);
    testProviderImpl.mockClear();

    const res = await request(probed)
      .patch(`/api/ai-providers/${created.body.provider.id}`)
      .set('Authorization', auth)
      .send({ label: 'Renamed' });

    expect(res.status).toBe(200);
    expect(res.body.provider.label).toBe('Renamed');
    expect(res.body.test).toBeUndefined();
    expect(testProviderImpl).not.toHaveBeenCalled();
  });

  it('leaves the stored provider untouched when an update fails the probe', async () => {
    const testProviderImpl = okProbe();
    const { app: probed } = buildApp({ testProviderImpl });
    const { auth } = await makeUserAndLogin(probed, { role: 'admin' });
    const created = await request(probed)
      .post('/api/ai-providers')
      .set('Authorization', auth)
      .send(create);

    testProviderImpl.mockImplementation(async () => ({
      ok: false,
      status: 404,
      latencyMs: 5,
      message: 'No chat-completions endpoint there.',
    }));

    const res = await request(probed)
      .patch(`/api/ai-providers/${created.body.provider.id}`)
      .set('Authorization', auth)
      .send({ baseUrl: 'https://typo.example.com/v2' });

    expect(res.status).toBe(400);
    const stored = await AiProviderConfig.findById(created.body.provider.id).exec();
    expect(stored!.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('re-tests a stored provider on demand, decrypting its key', async () => {
    const testProviderImpl = okProbe();
    const { app: probed } = buildApp({ testProviderImpl });
    const { auth } = await makeUserAndLogin(probed, { role: 'admin' });
    const created = await request(probed)
      .post('/api/ai-providers')
      .set('Authorization', auth)
      .send(create);
    testProviderImpl.mockClear();

    const res = await request(probed)
      .post(`/api/ai-providers/${created.body.provider.id}/test`)
      .set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body.test.ok).toBe(true);
    expect(testProviderImpl).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-or-secret' }),
    );
  });

  it('reports a failing on-demand test as a 200 result, not an error', async () => {
    const testProviderImpl = okProbe();
    const { app: probed } = buildApp({ testProviderImpl });
    const { auth } = await makeUserAndLogin(probed, { role: 'admin' });
    const created = await request(probed)
      .post('/api/ai-providers')
      .set('Authorization', auth)
      .send(create);

    testProviderImpl.mockImplementation(async () => ({
      ok: false,
      status: null,
      latencyMs: 30_000,
      message: 'Could not reach https://openrouter.ai/api/v1: timeout',
    }));

    const res = await request(probed)
      .post(`/api/ai-providers/${created.body.provider.id}/test`)
      .set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body.test).toMatchObject({ ok: false, status: null });
  });

  it('404s a test for an unknown provider, 400s a malformed id, 403s a non-admin', async () => {
    const { app: probed } = buildApp({ testProviderImpl: okProbe() });
    const { auth } = await makeUserAndLogin(probed, { role: 'admin' });
    expect(
      (
        await request(probed)
          .post('/api/ai-providers/aaaaaaaaaaaaaaaaaaaaaaaa/test')
          .set('Authorization', auth)
      ).status,
    ).toBe(404);
    expect(
      (await request(probed).post('/api/ai-providers/nope/test').set('Authorization', auth)).status,
    ).toBe(400);

    const { auth: userAuth } = await makeUserAndLogin(probed, { role: 'user' });
    expect(
      (
        await request(probed)
          .post('/api/ai-providers/aaaaaaaaaaaaaaaaaaaaaaaa/test')
          .set('Authorization', userAuth)
      ).status,
    ).toBe(403);
  });
});

describe('buildJsonReply fixture', () => {
  it('produces the OpenAI envelope shape the connector expects', () => {
    expect(buildJsonReply({ a: 1 }).choices[0].message.content).toBe('{"a":1}');
  });
});
