import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ProviderPricingConfig } from '../src/models.js';
import { buildApp, makeApiToken, makeUser, makeUserAndLogin, usagePayload } from './helpers.js';

const { app } = buildApp();

async function ingest(provider: string) {
  const user = await makeUser();
  const { token } = await makeApiToken(user._id);
  await request(app).post('/api/usage').set('X-API-Key', token).send(usagePayload({ provider }));
}

describe('GET /api/provider-pricing', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/provider-pricing')).status).toBe(401);
  });

  it('lists providers seen in logs as pricing-enabled by default', async () => {
    await ingest('claude-session');
    const { auth } = await makeUserAndLogin(app);

    const res = await request(app).get('/api/provider-pricing').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual([{ provider: 'claude-session', pricingDisabled: false }]);
  });

  it('reflects a stored disable toggle', async () => {
    await ingest('https://api.amanai.dev');
    await ProviderPricingConfig.create({ provider: 'https://api.amanai.dev', pricingDisabled: true });
    const { auth } = await makeUserAndLogin(app);

    const res = await request(app).get('/api/provider-pricing').set('Authorization', auth);
    expect(res.body.providers).toEqual([
      { provider: 'https://api.amanai.dev', pricingDisabled: true },
    ]);
  });

  it('keeps a configured provider listed even with no matching logs', async () => {
    await ProviderPricingConfig.create({ provider: 'orphaned', pricingDisabled: true });
    const { auth } = await makeUserAndLogin(app);

    const res = await request(app).get('/api/provider-pricing').set('Authorization', auth);
    expect(res.body.providers).toEqual([{ provider: 'orphaned', pricingDisabled: true }]);
  });

  it('omits logs with no provider reported', async () => {
    await ingest('claude-session');
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    await request(app).post('/api/usage').set('X-API-Key', token).send(usagePayload());
    const { auth } = await makeUserAndLogin(app);

    const res = await request(app).get('/api/provider-pricing').set('Authorization', auth);
    expect(res.body.providers).toEqual([{ provider: 'claude-session', pricingDisabled: false }]);
  });
});

describe('PATCH /api/provider-pricing/:provider', () => {
  it('rejects a non-admin user', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'user' });
    const res = await request(app)
      .patch('/api/provider-pricing/claude-session')
      .set('Authorization', auth)
      .send({ pricingDisabled: true });
    expect(res.status).toBe(403);
  });

  it('creates a config row for a provider with none yet', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const res = await request(app)
      .patch('/api/provider-pricing/claude-session')
      .set('Authorization', auth)
      .send({ pricingDisabled: true });

    expect(res.status).toBe(200);
    expect(res.body.provider).toEqual({ provider: 'claude-session', pricingDisabled: true });
    const doc = await ProviderPricingConfig.findOne({ provider: 'claude-session' }).exec();
    expect(doc!.pricingDisabled).toBe(true);
  });

  it('flips an existing toggle back on', async () => {
    await ProviderPricingConfig.create({ provider: 'claude-session', pricingDisabled: true });
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });

    const res = await request(app)
      .patch('/api/provider-pricing/claude-session')
      .set('Authorization', auth)
      .send({ pricingDisabled: false });

    expect(res.body.provider).toEqual({ provider: 'claude-session', pricingDisabled: false });
    expect(await ProviderPricingConfig.countDocuments({})).toBe(1);
  });

  it('accepts a URL-shaped provider name via its encoded path segment', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const res = await request(app)
      .patch(`/api/provider-pricing/${encodeURIComponent('https://api.amanai.dev')}`)
      .set('Authorization', auth)
      .send({ pricingDisabled: true });

    expect(res.status).toBe(200);
    expect(res.body.provider.provider).toBe('https://api.amanai.dev');
  });
});
