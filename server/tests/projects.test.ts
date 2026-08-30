import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { Project, UsageLog } from '../src/models.js';
import { createBroadcaster } from '../src/realtime.js';
import { buildApp, makeApiToken, makeUser, makeUserAndLogin, usagePayload } from './helpers.js';

async function ingest(app: Awaited<ReturnType<typeof buildApp>>['app'], project: string) {
  const user = await makeUser();
  const { token } = await makeApiToken(user._id);
  await request(app).post('/api/usage').set('X-API-Key', token).send(usagePayload({ project }));
}

describe('GET /api/projects/:name', () => {
  const { app } = buildApp();

  it('requires authentication', async () => {
    expect((await request(app).get('/api/projects/foo')).status).toBe(401);
  });

  it('returns an empty history for a project that was never renamed', async () => {
    const { auth } = await makeUserAndLogin(app);
    const res = await request(app).get('/api/projects/never-renamed').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.project).toEqual({ name: 'never-renamed', history: [] });
  });

  it('reports an unattributed rename (e.g. a seeded record) as changedBy: null', async () => {
    const { auth } = await makeUserAndLogin(app);
    await Project.create({
      name: 'seeded',
      history: [{ from: 'old-seed', to: 'seeded', changedAt: new Date(), changedBy: null }],
    });

    const res = await request(app).get('/api/projects/seeded').set('Authorization', auth);
    expect(res.body.project.history).toEqual([
      expect.objectContaining({ from: 'old-seed', to: 'seeded', changedBy: null }),
    ]);
  });

  it('returns the rename history under the current name', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    await ingest(app, 'alpha');
    await request(app)
      .post('/api/projects/rename')
      .set('Authorization', auth)
      .send({ name: 'alpha', newName: 'beta' });

    const res = await request(app).get('/api/projects/beta').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.project.name).toBe('beta');
    expect(res.body.project.history).toEqual([
      expect.objectContaining({ from: 'alpha', to: 'beta' }),
    ]);
  });
});

describe('POST /api/projects/rename', () => {
  const { app } = buildApp();

  it('requires authentication', async () => {
    expect(
      (await request(app).post('/api/projects/rename').send({ name: 'a', newName: 'b' })).status,
    ).toBe(401);
  });

  it('rejects a non-admin user', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'user' });
    const res = await request(app)
      .post('/api/projects/rename')
      .set('Authorization', auth)
      .send({ name: 'a', newName: 'b' });
    expect(res.status).toBe(403);
  });

  it('renames a project, rewrites its usage logs, and records history', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    await ingest(app, 'alpha');

    const res = await request(app)
      .post('/api/projects/rename')
      .set('Authorization', auth)
      .send({ name: 'alpha', newName: 'beta' });

    expect(res.status).toBe(200);
    expect(res.body.project.name).toBe('beta');
    expect(res.body.project.history).toHaveLength(1);
    expect(res.body.project.history[0]).toMatchObject({ from: 'alpha', to: 'beta' });

    const logs = await UsageLog.find().exec();
    expect(logs.map((l) => l.project)).toEqual(['beta']);
  });

  it('accumulates multiple renames in order', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    await ingest(app, 'alpha');

    await request(app)
      .post('/api/projects/rename')
      .set('Authorization', auth)
      .send({ name: 'alpha', newName: 'beta' });
    const res = await request(app)
      .post('/api/projects/rename')
      .set('Authorization', auth)
      .send({ name: 'beta', newName: 'gamma' });

    expect(res.body.project.history.map((h: { from: string; to: string }) => [h.from, h.to])).toEqual([
      ['alpha', 'beta'],
      ['beta', 'gamma'],
    ]);
    const logs = await UsageLog.find().exec();
    expect(logs.map((l) => l.project)).toEqual(['gamma']);
  });

  it('rejects renaming to the same name', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const res = await request(app)
      .post('/api/projects/rename')
      .set('Authorization', auth)
      .send({ name: 'alpha', newName: 'alpha' });
    expect(res.status).toBe(409);
  });

  it('merges into a project that already has renamed history, keeping one doc under the target name', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    await ingest(app, 'alpha');
    await ingest(app, 'gamma');
    await request(app)
      .post('/api/projects/rename')
      .set('Authorization', auth)
      .send({ name: 'gamma', newName: 'delta' });

    const res = await request(app)
      .post('/api/projects/rename')
      .set('Authorization', auth)
      .send({ name: 'alpha', newName: 'delta' });

    expect(res.status).toBe(200);
    expect(res.body.project.name).toBe('delta');
    expect(res.body.project.history.map((h: { from: string; to: string }) => [h.from, h.to])).toEqual([
      ['gamma', 'delta'],
      ['alpha', 'delta'],
    ]);
    // Exactly one Project doc survives under the merged name — no leftover
    // "alpha" doc and no duplicate "delta" doc.
    expect(await Project.countDocuments({})).toBe(1);
    const logs = await UsageLog.find().sort({ project: 1 }).exec();
    expect(logs.map((l) => l.project)).toEqual(['delta', 'delta']);
  });

  it('merges onto a name already used by another project with no prior history', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    await ingest(app, 'alpha');
    await ingest(app, 'beta');

    const res = await request(app)
      .post('/api/projects/rename')
      .set('Authorization', auth)
      .send({ name: 'alpha', newName: 'beta' });

    expect(res.status).toBe(200);
    expect(res.body.project.name).toBe('beta');
    expect(res.body.project.history).toEqual([expect.objectContaining({ from: 'alpha', to: 'beta' })]);
    const logs = await UsageLog.find().exec();
    expect(logs.map((l) => l.project)).toEqual(['beta', 'beta']);
  });

  it('merges two projects that both already have their own rename history', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    await ingest(app, 'alpha');
    await ingest(app, 'gamma');
    await request(app).post('/api/projects/rename').set('Authorization', auth).send({ name: 'alpha', newName: 'x' });
    await request(app).post('/api/projects/rename').set('Authorization', auth).send({ name: 'gamma', newName: 'y' });

    const res = await request(app)
      .post('/api/projects/rename')
      .set('Authorization', auth)
      .send({ name: 'x', newName: 'y' });

    expect(res.status).toBe(200);
    expect(res.body.project.history.map((h: { from: string; to: string }) => [h.from, h.to])).toEqual([
      ['alpha', 'x'],
      ['gamma', 'y'],
      ['x', 'y'],
    ]);
    expect(await Project.countDocuments({})).toBe(1);
  });

  it('invalidates the dashboard cache and broadcasts a realtime event', async () => {
    const broadcaster = createBroadcaster();
    const listener = vi.fn();
    broadcaster.subscribe(listener);
    const { app: withBroadcaster } = buildApp({ broadcaster });
    const { auth } = await makeUserAndLogin(withBroadcaster, { role: 'admin' });
    await ingest(withBroadcaster, 'alpha');
    listener.mockClear();

    await request(withBroadcaster)
      .post('/api/projects/rename')
      .set('Authorization', auth)
      .send({ name: 'alpha', newName: 'beta' });

    expect(listener).toHaveBeenCalledWith({ type: 'data-changed' });
  });
});
