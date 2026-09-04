import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp, makeApiToken, makePricing, makeUser, makeUserAndLogin, usagePayload } from './helpers.js';

const { app } = buildApp();

async function ingest(overrides: Record<string, unknown> = {}, user?: Awaited<ReturnType<typeof makeUser>>) {
  const owner = user ?? (await makeUser());
  const { token } = await makeApiToken(owner._id);
  await request(app).post('/api/usage').set('X-API-Key', token).send(usagePayload(overrides));
  return owner;
}

describe('GET /api/dashboard/summary', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/dashboard/summary')).status).toBe(401);
  });

  it('returns zeroed totals and empty series with no data', async () => {
    const { auth } = await makeUserAndLogin(app);
    const res = await request(app).get('/api/dashboard/summary').set('Authorization', auth);

    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({
      prompts: 0,
      totalTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      amanaiCredits: 0,
    });
    expect(res.body.byDay).toEqual([]);
    expect(res.body.byModel).toEqual([]);
  });

  it('sums tokens and cost across prompts', async () => {
    await makePricing('claude-sonnet-5');
    await ingest();
    await ingest();
    const { auth } = await makeUserAndLogin(app);

    const res = await request(app).get('/api/dashboard/summary').set('Authorization', auth);
    expect(res.body.totals).toMatchObject({
      prompts: 2,
      totalTokens: 7600,
      inputTokens: 2000,
      cacheReadTokens: 4000,
      cacheWriteTokens: 1000,
      outputTokens: 600,
    });
    expect(res.body.totals.estimatedCostUsd).toBeCloseTo(0.01995, 8);
  });

  it('treats unpriced prompts as zero cost, not as an error', async () => {
    await ingest({ model: 'unpriced' });
    const { auth } = await makeUserAndLogin(app);
    const res = await request(app).get('/api/dashboard/summary').set('Authorization', auth);
    expect(res.body.totals.prompts).toBe(1);
    expect(res.body.totals.estimatedCostUsd).toBe(0);
  });

  it('buckets by UTC day, ascending', async () => {
    await ingest({ datetime: '2026-08-02T23:00:00.000Z' });
    await ingest({ datetime: '2026-08-01T01:00:00.000Z' });
    await ingest({ datetime: '2026-08-01T05:00:00.000Z' });
    const { auth } = await makeUserAndLogin(app);

    const res = await request(app).get('/api/dashboard/summary').set('Authorization', auth);
    expect(res.body.byDay.map((d: { key: string }) => d.key)).toEqual(['2026-08-01', '2026-08-02']);
    expect(res.body.byDay[0].prompts).toBe(2);
  });

  it('breaks down by model, busiest first, keeping a null model as null', async () => {
    await ingest({ model: 'claude-opus-5' });
    await ingest({ model: 'claude-sonnet-5' });
    await ingest({ model: 'claude-sonnet-5' });
    const { model: _drop, ...noModel } = usagePayload();
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    await request(app).post('/api/usage').set('X-API-Key', token).send(noModel);

    const { auth } = await makeUserAndLogin(app);
    const res = await request(app).get('/api/dashboard/summary').set('Authorization', auth);

    expect(res.body.byModel[0]).toMatchObject({ key: 'claude-sonnet-5', prompts: 2 });
    expect(res.body.byModel.map((m: { key: string | null }) => m.key)).toContain(null);
  });

  it('sums amanai credits across prompts and by model', async () => {
    // deepseek-v4-flash (m_in=2.5): 1000*2.5 + 2000*0.625 + 300*12.5 = 2500+1250+3750 = 7500
    await ingest({ model: 'amanai/deepseek-v4-flash' });
    await ingest({ model: 'amanai/deepseek-v4-flash' });
    await ingest({ model: 'claude-sonnet-5' });
    const { auth } = await makeUserAndLogin(app);

    const res = await request(app).get('/api/dashboard/summary').set('Authorization', auth);
    expect(res.body.totals.amanaiCredits).toBe(15000);
    const amanaiModel = res.body.byModel.find(
      (m: { key: string | null }) => m.key === 'amanai/deepseek-v4-flash',
    );
    expect(amanaiModel.amanaiCredits).toBe(15000);
    const claudeModel = res.body.byModel.find(
      (m: { key: string | null }) => m.key === 'claude-sonnet-5',
    );
    expect(claudeModel.amanaiCredits).toBe(0);
  });

  it('breaks down by project and by user', async () => {
    const alice = await makeUser({ name: 'Alice' });
    await ingest({ project: 'web' }, alice);
    await ingest({ project: 'web' }, alice);
    await ingest({ project: 'api' });

    const { auth } = await makeUserAndLogin(app);
    const res = await request(app).get('/api/dashboard/summary').set('Authorization', auth);

    expect(res.body.byProject[0]).toMatchObject({ key: 'web', prompts: 2 });
    expect(res.body.byUser[0]).toMatchObject({ key: alice._id.toString(), prompts: 2 });
  });

  it('applies the same filters as the log list', async () => {
    const alice = await makeUser({ name: 'Alice' });
    await ingest({ project: 'web', datetime: '2026-08-01T00:00:00.000Z' }, alice);
    await ingest({ project: 'api', datetime: '2026-08-20T00:00:00.000Z' });
    const { auth } = await makeUserAndLogin(app);

    const byProject = await request(app)
      .get('/api/dashboard/summary?project=web')
      .set('Authorization', auth);
    expect(byProject.body.totals.prompts).toBe(1);

    const byUser = await request(app)
      .get(`/api/dashboard/summary?userId=${alice._id.toString()}`)
      .set('Authorization', auth);
    expect(byUser.body.totals.prompts).toBe(1);

    const byDate = await request(app)
      .get('/api/dashboard/summary?dateFrom=2026-08-10T00:00:00.000Z')
      .set('Authorization', auth);
    expect(byDate.body.totals.prompts).toBe(1);

    const byModel = await request(app)
      .get('/api/dashboard/summary?model=claude-sonnet-5')
      .set('Authorization', auth);
    expect(byModel.body.totals.prompts).toBe(2);
  });

  it('rejects a malformed filter', async () => {
    const { auth } = await makeUserAndLogin(app);
    const res = await request(app)
      .get('/api/dashboard/summary?dateFrom=yesterday')
      .set('Authorization', auth);
    expect(res.status).toBe(400);
  });

  it('caches a summary, and drops it when new usage arrives', async () => {
    await ingest();
    const { auth } = await makeUserAndLogin(app);

    const first = await request(app).get('/api/dashboard/summary').set('Authorization', auth);
    expect(first.body.totals.prompts).toBe(1);

    await ingest();
    const afterIngest = await request(app).get('/api/dashboard/summary').set('Authorization', auth);
    expect(afterIngest.body.totals.prompts).toBe(2);
  });

  it('serves a repeat request from cache within the TTL', async () => {
    const { app: cached, cache } = buildApp({}, { DASHBOARD_CACHE_TTL_MS: '60000' });
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    await request(cached).post('/api/usage').set('X-API-Key', token).send(usagePayload());
    const { auth } = await makeUserAndLogin(cached);

    await request(cached).get('/api/dashboard/summary').set('Authorization', auth);
    const keys = cache.size;
    const second = await request(cached).get('/api/dashboard/summary').set('Authorization', auth);

    expect(keys).toBeGreaterThan(0);
    expect(second.body.totals.prompts).toBe(1);
  });

  it('keys the cache per filter, so filters do not shadow each other', async () => {
    await ingest({ project: 'web' });
    await ingest({ project: 'api' });
    const { auth } = await makeUserAndLogin(app);

    const web = await request(app)
      .get('/api/dashboard/summary?project=web')
      .set('Authorization', auth);
    const api = await request(app)
      .get('/api/dashboard/summary?project=api')
      .set('Authorization', auth);

    expect(web.body.byProject[0].key).toBe('web');
    expect(api.body.byProject[0].key).toBe('api');
  });

  it('reflects a recalculation immediately', async () => {
    await ingest();
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const before = await request(app).get('/api/dashboard/summary').set('Authorization', auth);
    expect(before.body.totals.estimatedCostUsd).toBe(0);

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
    await request(app)
      .post('/api/usage-logs/recalculate-cost')
      .set('Authorization', auth)
      .send({ filter: {} });

    const after = await request(app).get('/api/dashboard/summary').set('Authorization', auth);
    expect(after.body.totals.estimatedCostUsd).toBeCloseTo(0.009975, 8);
  });
});
