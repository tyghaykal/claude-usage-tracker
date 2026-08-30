import AdmZip from 'adm-zip';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { Project, User } from '../src/models.js';
import { buildApp, makeUserAndLogin } from './helpers.js';

describe('GET /api/backup/export', () => {
  const { app } = buildApp();

  it('requires authentication', async () => {
    expect((await request(app).get('/api/backup/export')).status).toBe(401);
  });

  it('requires the admin role', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'user' });
    const res = await request(app).get('/api/backup/export').set('Authorization', auth);
    expect(res.status).toBe(403);
  });

  it('returns a zip with one JSON file per collection', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    await Project.create({ name: 'exported-project', history: [] });

    const res = await request(app)
      .get('/api/backup/export')
      .set('Authorization', auth)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');

    const zip = new AdmZip(res.body as Buffer);
    const projectEntry = zip.getEntry('Project.json');
    expect(projectEntry).not.toBeNull();
    const projects = JSON.parse(projectEntry!.getData().toString('utf8'));
    expect(projects).toEqual([expect.objectContaining({ name: 'exported-project' })]);
  });
});

describe('POST /api/backup/import', () => {
  const { app } = buildApp();

  it('requires the admin role', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'user' });
    const res = await request(app)
      .post('/api/backup/import')
      .set('Authorization', auth)
      .set('Content-Type', 'application/zip')
      .send(Buffer.from('not a zip'));
    expect(res.status).toBe(403);
  });

  it('rejects a body that is not a valid zip', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const res = await request(app)
      .post('/api/backup/import')
      .set('Authorization', auth)
      .set('Content-Type', 'application/zip')
      .send(Buffer.from('not a zip'));
    expect(res.status).toBe(400);
  });

  it('replaces a collection with the contents of its JSON entry', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    await Project.create({ name: 'will-be-wiped', history: [] });

    const zip = new AdmZip();
    zip.addFile(
      'Project.json',
      Buffer.from(JSON.stringify([{ name: 'imported-project', history: [] }])),
    );

    const res = await request(app)
      .post('/api/backup/import')
      .set('Authorization', auth)
      .set('Content-Type', 'application/zip')
      .send(zip.toBuffer());

    expect(res.status).toBe(200);
    const names = (await Project.find().exec()).map((p) => p.name);
    expect(names).toEqual(['imported-project']);
  });

  it('leaves a collection untouched when its JSON entry is absent from the zip', async () => {
    const { auth, user } = await makeUserAndLogin(app, { role: 'admin' });

    const zip = new AdmZip();
    zip.addFile('Project.json', Buffer.from(JSON.stringify([])));

    const res = await request(app)
      .post('/api/backup/import')
      .set('Authorization', auth)
      .set('Content-Type', 'application/zip')
      .send(zip.toBuffer());

    expect(res.status).toBe(200);
    expect(await User.findById(user._id).exec()).not.toBeNull();
  });
});
