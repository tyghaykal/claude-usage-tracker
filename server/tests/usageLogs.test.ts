import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { UsageLog } from '../src/models.js';
import { createBroadcaster } from '../src/realtime.js';
import {
  buildApp,
  makeApiToken,
  makePricing,
  makeUser,
  makeUserAndLogin,
  SAMPLE_TOKENS,
  usagePayload,
} from './helpers.js';

const { app } = buildApp();

/** Ingests through the real endpoint so every log is built the way prod builds it. */
async function ingest(overrides: Record<string, unknown> = {}, ownerName = 'Dev One') {
  const user = await makeUser({ name: ownerName });
  const { token } = await makeApiToken(user._id);
  await request(app).post('/api/usage').set('X-API-Key', token).send(usagePayload(overrides));
  return user;
}

describe('GET /api/usage-logs', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/usage-logs')).status).toBe(401);
  });

  it('lists newest-first with pagination metadata', async () => {
    await makePricing();
    await ingest({ datetime: '2026-08-01T00:00:00.000Z', project: 'old' });
    await ingest({ datetime: '2026-08-20T00:00:00.000Z', project: 'new' });
    const { auth } = await makeUserAndLogin(app);

    const res = await request(app).get('/api/usage-logs').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.logs.map((l: { project: string }) => l.project)).toEqual(['new', 'old']);
    expect(res.body).toMatchObject({ page: 1, limit: 50, total: 2, totalPages: 1 });
  });

  it('paginates', async () => {
    for (const n of [1, 2, 3]) {
      await ingest({ datetime: `2026-08-0${n}T00:00:00.000Z`, project: `p${n}` });
    }
    const { auth } = await makeUserAndLogin(app);

    const res = await request(app)
      .get('/api/usage-logs?page=2&limit=2')
      .set('Authorization', auth);
    expect(res.body.logs).toHaveLength(1);
    expect(res.body).toMatchObject({ page: 2, limit: 2, total: 3, totalPages: 2 });
  });

  it('filters by project as an exact match, not a substring', async () => {
    await ingest({ project: 'ai' });
    await ingest({ project: 'ai-hehe' });
    await ingest({ project: 'ai-b' });
    const { auth } = await makeUserAndLogin(app);

    const res = await request(app).get('/api/usage-logs?project=ai').set('Authorization', auth);
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0].project).toBe('ai');
  });

  it('is case-sensitive: the dropdown only ever sends an exact stored name', async () => {
    await ingest({ project: 'Frontend-App' });
    const { auth } = await makeUserAndLogin(app);

    const res = await request(app)
      .get('/api/usage-logs?project=frontend-app')
      .set('Authorization', auth);
    expect(res.body.logs).toHaveLength(0);
  });

  it('filters by developer', async () => {
    const one = await ingest({ project: 'a' }, 'Dev One');
    await ingest({ project: 'b' }, 'Dev Two');
    const { auth } = await makeUserAndLogin(app);

    const res = await request(app)
      .get(`/api/usage-logs?userId=${one._id.toString()}`)
      .set('Authorization', auth);
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0].project).toBe('a');
  });

  it('filters by model', async () => {
    await ingest({ model: 'claude-opus-5' });
    await ingest({ model: '9r/claude-sonnet-5' });
    const { auth } = await makeUserAndLogin(app);

    const res = await request(app)
      .get('/api/usage-logs?model=9r%2Fclaude-sonnet-5')
      .set('Authorization', auth);
    expect(res.body.logs).toHaveLength(1);
  });

  it('filters by a date range, and by each bound alone', async () => {
    await ingest({ datetime: '2026-08-01T00:00:00.000Z', project: 'aug1' });
    await ingest({ datetime: '2026-08-15T00:00:00.000Z', project: 'aug15' });
    await ingest({ datetime: '2026-08-30T00:00:00.000Z', project: 'aug30' });
    const { auth } = await makeUserAndLogin(app);

    const get = async (qs: string) =>
      (await request(app).get(`/api/usage-logs?${qs}`).set('Authorization', auth)).body.logs.map(
        (l: { project: string }) => l.project,
      );

    expect(
      await get('dateFrom=2026-08-10T00:00:00.000Z&dateTo=2026-08-20T00:00:00.000Z'),
    ).toEqual(['aug15']);
    expect(await get('dateFrom=2026-08-10T00:00:00.000Z')).toEqual(['aug30', 'aug15']);
    expect(await get('dateTo=2026-08-10T00:00:00.000Z')).toEqual(['aug1']);
  });

  it('rejects an invalid filter value', async () => {
    const { auth } = await makeUserAndLogin(app);
    const res = await request(app)
      .get('/api/usage-logs?userId=not-an-id')
      .set('Authorization', auth);
    expect(res.status).toBe(400);
  });

  it('rejects an oversized page limit', async () => {
    const { auth } = await makeUserAndLogin(app);
    const res = await request(app).get('/api/usage-logs?limit=9999').set('Authorization', auth);
    expect(res.status).toBe(400);
  });

  it('flags rows whose snapshot no longer matches current pricing', async () => {
    const pricing = await makePricing('claude-sonnet-5');
    await ingest();
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });

    const before = await request(app).get('/api/usage-logs').set('Authorization', auth);
    expect(before.body.logs[0].pricingOutdated).toBe(false);

    // Through the API, so the pricing cache is invalidated the way it is in prod.
    await request(app)
      .patch(`/api/models/${pricing._id.toString()}`)
      .set('Authorization', auth)
      .send({ inputPerMTok: 99 });

    const after = await request(app).get('/api/usage-logs').set('Authorization', auth);
    expect(after.body.logs[0].pricingOutdated).toBe(true);
  });

  it('flags an unpriced row once pricing appears for its model', async () => {
    await ingest();
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });

    const before = await request(app).get('/api/usage-logs').set('Authorization', auth);
    expect(before.body.logs[0].pricingOutdated).toBe(false);

    await request(app)
      .post('/api/models')
      .set('Authorization', auth)
      .send({
        modelId: 'claude-sonnet-5',
        inputPerMTok: 3,
        cacheWritePerMTok: 3.75,
        cacheReadPerMTok: 0.3,
        outputPerMTok: 15,
      });

    const after = await request(app).get('/api/usage-logs').set('Authorization', auth);
    expect(after.body.logs[0].pricingOutdated).toBe(true);
  });

  it('never flags a row whose catalog seed is still all zeros', async () => {
    await makePricing('claude-sonnet-5', {
      inputPerMTok: 0,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0,
      outputPerMTok: 0,
    });
    await ingest();
    const { auth } = await makeUserAndLogin(app);
    const res = await request(app).get('/api/usage-logs').set('Authorization', auth);
    expect(res.body.logs[0].pricingOutdated).toBe(false);
    expect(res.body.logs[0].estimatedCostUsd).toBeNull();
  });

  it('never flags a row whose model still has no pricing', async () => {
    await ingest({ model: 'unknown-model' });
    const { auth } = await makeUserAndLogin(app);
    const res = await request(app).get('/api/usage-logs').set('Authorization', auth);
    expect(res.body.logs[0].pricingOutdated).toBe(false);
  });

  it('flags an amanai/<name> row once the unprefixed catalog is priced', async () => {
    await ingest({ model: 'amanai/grok-4.6' });
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });

    const before = await request(app).get('/api/usage-logs').set('Authorization', auth);
    expect(before.body.logs[0].pricingOutdated).toBe(false);

    await request(app)
      .post('/api/models')
      .set('Authorization', auth)
      .send({
        modelId: 'grok-4.6',
        inputPerMTok: 2,
        cacheWritePerMTok: 0,
        cacheReadPerMTok: 0.5,
        outputPerMTok: 6,
      });

    const after = await request(app).get('/api/usage-logs').set('Authorization', auth);
    expect(after.body.logs[0].model).toBe('amanai/grok-4.6');
    expect(after.body.logs[0].pricingOutdated).toBe(true);
  });

  it('never flags a row with no model at all', async () => {
    const { model: _drop, ...noModel } = usagePayload();
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    await request(app).post('/api/usage').set('X-API-Key', token).send(noModel);
    await makePricing('claude-sonnet-5');

    const { auth } = await makeUserAndLogin(app);
    const res = await request(app).get('/api/usage-logs').set('Authorization', auth);
    expect(res.body.logs[0].pricingOutdated).toBe(false);
  });
});

describe('GET /api/usage-logs/facets', () => {
  it('returns sorted distinct projects and models, dropping nulls', async () => {
    await ingest({ project: 'zeta', model: 'claude-opus-5' });
    await ingest({ project: 'alpha', model: 'claude-sonnet-5' });
    const { model: _drop, ...noModel } = usagePayload({ project: 'alpha' });
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    await request(app).post('/api/usage').set('X-API-Key', token).send(noModel);

    const { auth } = await makeUserAndLogin(app);
    const res = await request(app).get('/api/usage-logs/facets').set('Authorization', auth);
    expect(res.body.projects).toEqual(['alpha', 'zeta']);
    expect(res.body.models).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });
});

describe('GET /api/usage-logs/:id', () => {
  it('returns the full record including the rates used', async () => {
    await makePricing();
    await ingest({ user: 'label-from-plugin' });
    const { auth } = await makeUserAndLogin(app);
    const log = await UsageLog.findOne().exec();

    const res = await request(app)
      .get(`/api/usage-logs/${log!._id.toString()}`)
      .set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body.log).toMatchObject({
      prompt: 'fix the login bug',
      sessionId: 'abc-123',
      userLabel: 'label-from-plugin',
      tokens: SAMPLE_TOKENS,
      recalculatedAt: null,
    });
    expect(res.body.log.pricingSnapshot).toMatchObject({ inputPerMTok: 3, currency: 'USD' });
  });

  it('404s for a missing id and 400s for a malformed one', async () => {
    const { auth } = await makeUserAndLogin(app);
    expect(
      (
        await request(app)
          .get('/api/usage-logs/aaaaaaaaaaaaaaaaaaaaaaaa')
          .set('Authorization', auth)
      ).status,
    ).toBe(404);
    expect(
      (await request(app).get('/api/usage-logs/nope').set('Authorization', auth)).status,
    ).toBe(400);
  });
});

describe('PATCH /api/usage-logs/:id/provider', () => {
  it('requires authentication', async () => {
    await ingest();
    const log = await UsageLog.findOne().exec();
    const res = await request(app)
      .patch(`/api/usage-logs/${log!._id.toString()}/provider`)
      .send({ provider: 'claude-session' });
    expect(res.status).toBe(401);
  });

  it('rejects a non-admin user', async () => {
    await ingest();
    const log = await UsageLog.findOne().exec();
    const { auth } = await makeUserAndLogin(app, { role: 'user' });

    const res = await request(app)
      .patch(`/api/usage-logs/${log!._id.toString()}/provider`)
      .set('Authorization', auth)
      .send({ provider: 'claude-session' });
    expect(res.status).toBe(403);
  });

  it('sets the provider on a log ingested before this field existed', async () => {
    await ingest();
    const before = await UsageLog.findOne().exec();
    expect(before!.provider).toBeNull();
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });

    const res = await request(app)
      .patch(`/api/usage-logs/${before!._id.toString()}/provider`)
      .set('Authorization', auth)
      .send({ provider: 'https://api.amanai.dev' });

    expect(res.status).toBe(200);
    expect(res.body.log.provider).toBe('https://api.amanai.dev');
    expect((await UsageLog.findById(before!._id).exec())!.provider).toBe('https://api.amanai.dev');
  });

  it('404s for a missing id', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const res = await request(app)
      .patch('/api/usage-logs/aaaaaaaaaaaaaaaaaaaaaaaa/provider')
      .set('Authorization', auth)
      .send({ provider: 'claude-session' });
    expect(res.status).toBe(404);
  });

  it('rejects an empty provider', async () => {
    await ingest();
    const log = await UsageLog.findOne().exec();
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });

    const res = await request(app)
      .patch(`/api/usage-logs/${log!._id.toString()}/provider`)
      .set('Authorization', auth)
      .send({ provider: '' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/usage-logs/set-provider', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/usage-logs/set-provider').send({ filter: {}, provider: 'x' });
    expect(res.status).toBe(401);
  });

  it('rejects a non-admin user', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'user' });
    const res = await request(app)
      .post('/api/usage-logs/set-provider')
      .set('Authorization', auth)
      .send({ filter: {}, provider: 'claude-session' });
    expect(res.status).toBe(403);
  });

  it('sets the provider on an explicit selection of ids', async () => {
    await ingest();
    await ingest();
    await ingest();
    const [a, b] = await UsageLog.find().sort({ createdAt: 1 }).exec();
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });

    const res = await request(app)
      .post('/api/usage-logs/set-provider')
      .set('Authorization', auth)
      .send({ ids: [a!._id.toString(), b!._id.toString()], provider: 'claude-session' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ matched: 2, updated: 2 });
    const rows = await UsageLog.find().sort({ createdAt: 1 }).exec();
    expect(rows.map((r) => r.provider)).toEqual(['claude-session', 'claude-session', null]);
  });

  it('sets the provider on everything matching a filter, not just one page', async () => {
    await ingest({ project: 'legacy' });
    await ingest({ project: 'legacy' });
    await ingest({ project: 'other' });
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });

    const res = await request(app)
      .post('/api/usage-logs/set-provider')
      .set('Authorization', auth)
      .send({ filter: { project: 'legacy' }, provider: 'https://api.amanai.dev' });

    expect(res.body).toEqual({ matched: 2, updated: 2 });
    const rows = await UsageLog.find().sort({ project: 1 }).exec();
    expect(rows.map((r) => [r.project, r.provider])).toEqual([
      ['legacy', 'https://api.amanai.dev'],
      ['legacy', 'https://api.amanai.dev'],
      ['other', null],
    ]);
  });

  it('reports matched separately from updated', async () => {
    await ingest();
    await ingest();
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });

    const res = await request(app)
      .post('/api/usage-logs/set-provider')
      .set('Authorization', auth)
      .send({ filter: {}, provider: 'claude-session' });

    expect(res.body).toEqual({ matched: 2, updated: 2 });
  });

  it('rejects a body missing provider', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const res = await request(app)
      .post('/api/usage-logs/set-provider')
      .set('Authorization', auth)
      .send({ filter: {} });
    expect(res.status).toBe(400);
  });

  it('rejects a body that is neither ids nor filter', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const res = await request(app)
      .post('/api/usage-logs/set-provider')
      .set('Authorization', auth)
      .send({ provider: 'claude-session' });
    expect(res.status).toBe(400);
  });

  it('broadcasts a realtime event only when something actually changed', async () => {
    const broadcaster = createBroadcaster();
    const listener = vi.fn();
    broadcaster.subscribe(listener);
    const { app: withBroadcaster } = buildApp({ broadcaster });
    const { auth } = await makeUserAndLogin(withBroadcaster, { role: 'admin' });

    await request(withBroadcaster)
      .post('/api/usage-logs/set-provider')
      .set('Authorization', auth)
      .send({ filter: { project: 'nothing-here' }, provider: 'claude-session' });
    expect(listener).not.toHaveBeenCalled();

    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    await request(withBroadcaster).post('/api/usage').set('X-API-Key', token).send(usagePayload());
    listener.mockClear();

    await request(withBroadcaster)
      .post('/api/usage-logs/set-provider')
      .set('Authorization', auth)
      .send({ filter: {}, provider: 'claude-session' });
    expect(listener).toHaveBeenCalledWith({ type: 'data-changed' });
  });
});

describe('POST /api/usage-logs/recalculate-cost', () => {
  it('reprices selected ids against current pricing', async () => {
    const pricing = await makePricing('claude-sonnet-5', { inputPerMTok: 3 });
    await ingest();
    const log = await UsageLog.findOne().exec();
    const originalCost = log!.estimatedCostUsd!;

    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    await request(app)
      .patch(`/api/models/${pricing._id.toString()}`)
      .set('Authorization', auth)
      .send({ inputPerMTok: 6 });

    const res = await request(app)
      .post('/api/usage-logs/recalculate-cost')
      .set('Authorization', auth)
      .send({ ids: [log!._id.toString()] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 1, updated: 1, skipped: 0 });

    const after = await UsageLog.findById(log!._id).exec();
    expect(after!.estimatedCostUsd).toBeGreaterThan(originalCost);
    expect(after!.pricingSnapshot!.inputPerMTok).toBe(6);
    expect(after!.recalculatedAt).toBeInstanceOf(Date);
  });

  it('reprices everything matching a filter', async () => {
    const pricing = await makePricing('claude-sonnet-5', { inputPerMTok: 3 });
    await ingest({ project: 'keep' });
    await ingest({ project: 'keep' });
    await ingest({ project: 'other' });
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    await request(app)
      .patch(`/api/models/${pricing._id.toString()}`)
      .set('Authorization', auth)
      .send({ inputPerMTok: 6 });

    const res = await request(app)
      .post('/api/usage-logs/recalculate-cost')
      .set('Authorization', auth)
      .send({ filter: { project: 'keep' } });

    expect(res.body).toEqual({ total: 2, updated: 2, skipped: 0 });
    expect(await UsageLog.countDocuments({ recalculatedAt: null })).toBe(1);
  });

  it('prices a row that had no pricing when it arrived', async () => {
    await ingest();
    await makePricing('claude-sonnet-5');
    const { auth } = await makeUserAndLogin(app);

    const res = await request(app)
      .post('/api/usage-logs/recalculate-cost')
      .set('Authorization', auth)
      .send({ filter: {} });

    expect(res.body.updated).toBe(1);
    expect((await UsageLog.findOne().exec())!.estimatedCostUsd).toBeCloseTo(0.009975, 10);
  });

  it('skips a row whose catalog seed is still all zeros', async () => {
    await makePricing('claude-sonnet-5', {
      inputPerMTok: 0,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0,
      outputPerMTok: 0,
    });
    await ingest();
    const { auth } = await makeUserAndLogin(app);

    const res = await request(app)
      .post('/api/usage-logs/recalculate-cost')
      .set('Authorization', auth)
      .send({ filter: {} });

    expect(res.body).toEqual({ total: 1, updated: 0, skipped: 1 });
    expect((await UsageLog.findOne().exec())!.recalculatedAt).toBeNull();
  });

  it('reprices an amanai/<name> row against the unprefixed catalog', async () => {
    await ingest({ model: 'amanai/grok-4.6' });
    await makePricing('grok-4.6');
    const { auth } = await makeUserAndLogin(app);

    const res = await request(app)
      .post('/api/usage-logs/recalculate-cost')
      .set('Authorization', auth)
      .send({ filter: {} });

    expect(res.body).toEqual({ total: 1, updated: 1, skipped: 0 });
    const after = await UsageLog.findOne().exec();
    expect(after!.modelId).toBe('amanai/grok-4.6');
    expect(after!.estimatedCostUsd).toBeCloseTo(0.009975, 10);
    expect(after!.recalculatedAt).toBeInstanceOf(Date);
  });

  it('skips a 9r/<name> row even when the unprefixed catalog is priced', async () => {
    await ingest({ model: '9r/grok-4.6' });
    await makePricing('grok-4.6');
    const { auth } = await makeUserAndLogin(app);

    const res = await request(app)
      .post('/api/usage-logs/recalculate-cost')
      .set('Authorization', auth)
      .send({ filter: {} });

    expect(res.body).toEqual({ total: 1, updated: 0, skipped: 1 });
    const after = await UsageLog.findOne().exec();
    expect(after!.modelId).toBe('9r/grok-4.6');
    expect(after!.estimatedCostUsd).toBeNull();
    expect(after!.recalculatedAt).toBeNull();
  });

  it('skips — never blanks — a row whose model is still unpriced', async () => {
    await makePricing('claude-sonnet-5');
    await ingest();
    await ingest({ model: 'still-unknown' });
    const { auth } = await makeUserAndLogin(app);

    const res = await request(app)
      .post('/api/usage-logs/recalculate-cost')
      .set('Authorization', auth)
      .send({ filter: {} });

    expect(res.body).toEqual({ total: 2, updated: 1, skipped: 1 });
    const untouched = await UsageLog.findOne({ modelId: 'still-unknown' }).exec();
    expect(untouched!.recalculatedAt).toBeNull();
  });

  it('blanks a priced row whose provider has pricing disabled', async () => {
    await makePricing('claude-sonnet-5');
    await ingest({ provider: 'https://api.amanai.dev' });
    const before = await UsageLog.findOne().exec();
    expect(before!.estimatedCostUsd).not.toBeNull();
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    // Through the route (not a direct model write) so it invalidates the
    // cache the ingest above already populated with "not disabled".
    await request(app)
      .patch(`/api/provider-pricing/${encodeURIComponent('https://api.amanai.dev')}`)
      .set('Authorization', auth)
      .send({ pricingDisabled: true });

    const res = await request(app)
      .post('/api/usage-logs/recalculate-cost')
      .set('Authorization', auth)
      .send({ filter: {} });

    expect(res.body).toEqual({ total: 1, updated: 1, skipped: 0 });
    const after = await UsageLog.findOne().exec();
    expect(after!.estimatedCostUsd).toBeNull();
    expect(after!.pricingSnapshot).toBeNull();
    expect(after!.recalculatedAt).toBeInstanceOf(Date);
  });

  it('leaves an already-blank row from a disabled provider untouched (skipped, not updated)', async () => {
    await ingest({ provider: 'https://api.amanai.dev', model: 'still-unknown' });
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    await request(app)
      .patch(`/api/provider-pricing/${encodeURIComponent('https://api.amanai.dev')}`)
      .set('Authorization', auth)
      .send({ pricingDisabled: true });

    const res = await request(app)
      .post('/api/usage-logs/recalculate-cost')
      .set('Authorization', auth)
      .send({ filter: {} });

    expect(res.body).toEqual({ total: 1, updated: 0, skipped: 1 });
  });

  it('rejects a body that is neither ids nor filter', async () => {
    const { auth } = await makeUserAndLogin(app);
    const res = await request(app)
      .post('/api/usage-logs/recalculate-cost')
      .set('Authorization', auth)
      .send({ nonsense: true });
    expect(res.status).toBe(400);
  });

  it('rejects an empty id list', async () => {
    const { auth } = await makeUserAndLogin(app);
    const res = await request(app)
      .post('/api/usage-logs/recalculate-cost')
      .set('Authorization', auth)
      .send({ ids: [] });
    expect(res.status).toBe(400);
  });

  it('is a no-op when nothing matches', async () => {
    const { auth } = await makeUserAndLogin(app);
    const res = await request(app)
      .post('/api/usage-logs/recalculate-cost')
      .set('Authorization', auth)
      .send({ filter: { project: 'nothing-here' } });
    expect(res.body).toEqual({ total: 0, updated: 0, skipped: 0 });
  });

  it('broadcasts a realtime event when a recalculation actually updates something', async () => {
    const broadcaster = createBroadcaster();
    const listener = vi.fn();
    broadcaster.subscribe(listener);
    const { app: withBroadcaster } = buildApp({ broadcaster });

    await makePricing('claude-sonnet-5');
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    await request(withBroadcaster).post('/api/usage').set('X-API-Key', token).send(usagePayload());
    listener.mockClear(); // ingestion itself also broadcasts; isolate the recalc call

    const { auth } = await makeUserAndLogin(withBroadcaster, { role: 'admin' });
    await request(withBroadcaster)
      .post('/api/usage-logs/recalculate-cost')
      .set('Authorization', auth)
      .send({ filter: {} });

    expect(listener).toHaveBeenCalledWith({ type: 'data-changed' });
  });

  it('does not broadcast when nothing was updated', async () => {
    const broadcaster = createBroadcaster();
    const listener = vi.fn();
    broadcaster.subscribe(listener);
    const { app: withBroadcaster } = buildApp({ broadcaster });
    const { auth } = await makeUserAndLogin(withBroadcaster);

    await request(withBroadcaster)
      .post('/api/usage-logs/recalculate-cost')
      .set('Authorization', auth)
      .send({ filter: { project: 'nothing-here' } });

    expect(listener).not.toHaveBeenCalled();
  });
});
