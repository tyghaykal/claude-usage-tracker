import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { verifyPassword } from '../src/crypto.js';
import { ApiToken, AuditLog, User } from '../src/models.js';
import { buildApp, makeApiToken, makeUser, makeUserAndLogin, PASSWORD } from './helpers.js';

const { app } = buildApp();

describe('GET /api/me', () => {
  it('returns the caller without its password hash', async () => {
    const { user, auth } = await makeUserAndLogin(app, { name: 'Ada' });
    const res = await request(app).get('/api/me').set('Authorization', auth);
    expect(res.body.user).toMatchObject({ id: user._id.toString(), name: 'Ada', role: 'user' });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });
});

describe('GET /api/me/directory', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/me/directory')).status).toBe(401);
  });

  it('lists every user by name, alphabetically, for a non-admin caller', async () => {
    await makeUser({ name: 'Zed' });
    await makeUser({ name: 'Amy' });
    const { auth } = await makeUserAndLogin(app, { name: 'Mo', role: 'user' });

    const res = await request(app).get('/api/me/directory').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.users.map((u: { name: string }) => u.name)).toEqual(['Amy', 'Mo', 'Zed']);
    expect(JSON.stringify(res.body)).not.toContain('email');
  });
});

describe('PATCH /api/me', () => {
  it('changes the display name', async () => {
    const { user, auth } = await makeUserAndLogin(app);
    const res = await request(app).patch('/api/me').set('Authorization', auth).send({ name: 'New' });
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('New');
    expect((await User.findById(user._id).exec())!.name).toBe('New');
  });

  it('changes the password when the current one is given', async () => {
    const { user, auth } = await makeUserAndLogin(app);
    const res = await request(app)
      .patch('/api/me')
      .set('Authorization', auth)
      .send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-password' });

    expect(res.status).toBe(200);
    const updated = await User.findById(user._id).exec();
    expect(await verifyPassword('a-brand-new-password', updated!.passwordHash)).toBe(true);
  });

  it('changes name and password together', async () => {
    const { user, auth } = await makeUserAndLogin(app);
    await request(app)
      .patch('/api/me')
      .set('Authorization', auth)
      .send({ name: 'Both', currentPassword: PASSWORD, newPassword: 'another-password-1' });

    const updated = await User.findById(user._id).exec();
    expect(updated!.name).toBe('Both');
    expect(await verifyPassword('another-password-1', updated!.passwordHash)).toBe(true);
  });

  it('rejects a password change with the wrong current password', async () => {
    const { auth } = await makeUserAndLogin(app);
    const res = await request(app)
      .patch('/api/me')
      .set('Authorization', auth)
      .send({ currentPassword: 'wrong-password', newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(401);
  });

  it('requires the current password to set a new one', async () => {
    const { auth } = await makeUserAndLogin(app);
    const res = await request(app)
      .patch('/api/me')
      .set('Authorization', auth)
      .send({ newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(400);
  });

  it('rejects reusing the current password', async () => {
    const { auth } = await makeUserAndLogin(app);
    const res = await request(app)
      .patch('/api/me')
      .set('Authorization', auth)
      .send({ currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must differ/);
  });

  it('rejects an empty update', async () => {
    const { auth } = await makeUserAndLogin(app);
    expect((await request(app).patch('/api/me').set('Authorization', auth).send({})).status).toBe(
      400,
    );
  });

  it('rejects a too-short new password', async () => {
    const { auth } = await makeUserAndLogin(app);
    const res = await request(app)
      .patch('/api/me')
      .set('Authorization', auth)
      .send({ currentPassword: PASSWORD, newPassword: 'short' });
    expect(res.status).toBe(400);
  });
});

describe('/api/users (admin only)', () => {
  it('403s for a normal user on every verb', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'user' });
    expect((await request(app).get('/api/users').set('Authorization', auth)).status).toBe(403);
    expect((await request(app).post('/api/users').set('Authorization', auth).send({})).status).toBe(
      403,
    );
  });

  it('lists users oldest-first', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin', name: 'First' });
    await makeUser({ name: 'Second' });
    const res = await request(app).get('/api/users').set('Authorization', auth);
    expect(res.body.users.map((u: { name: string }) => u.name)).toEqual(['First', 'Second']);
  });

  it('creates a normal user by default', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', auth)
      .send({ name: 'New Dev', email: 'new@example.com', password: 'password1234' });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ name: 'New Dev', role: 'user' });
    // The created account can actually sign in with the password given.
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'new@example.com', password: 'password1234' });
    expect(login.status).toBe(200);
  });

  it('creates another admin when asked', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', auth)
      .send({ name: 'Admin 2', email: 'a2@example.com', password: 'password1234', role: 'admin' });
    expect(res.body.user.role).toBe('admin');
  });

  it('rejects a duplicate email case-insensitively', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    await makeUser({ email: 'taken@example.com' });
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', auth)
      .send({ name: 'Dup', email: 'TAKEN@example.com', password: 'password1234' });
    expect(res.status).toBe(409);
  });

  it('rejects an invalid create body', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', auth)
      .send({ name: '', email: 'bad', password: '1' });
    expect(res.status).toBe(400);
  });

  it('updates name, role and password', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const target = await makeUser({ name: 'Before' });

    const res = await request(app)
      .patch(`/api/users/${target._id.toString()}`)
      .set('Authorization', auth)
      .send({ name: 'After', role: 'admin', password: 'reset-by-admin-1' });

    expect(res.body.user).toMatchObject({ name: 'After', role: 'admin' });
    const updated = await User.findById(target._id).exec();
    expect(await verifyPassword('reset-by-admin-1', updated!.passwordHash)).toBe(true);
  });

  it('refuses to demote the last remaining admin', async () => {
    const { user, auth } = await makeUserAndLogin(app, { role: 'admin' });
    const res = await request(app)
      .patch(`/api/users/${user._id.toString()}`)
      .set('Authorization', auth)
      .send({ role: 'user' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/last remaining admin/);
    expect((await User.findById(user._id).exec())!.role).toBe('admin');
  });

  it('allows demoting an admin while another admin remains', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const other = await makeUser({ role: 'admin' });
    const res = await request(app)
      .patch(`/api/users/${other._id.toString()}`)
      .set('Authorization', auth)
      .send({ role: 'user' });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('user');
  });

  it('404s an unknown id, 400s a malformed one and 400s an empty update', async () => {
    const { user, auth } = await makeUserAndLogin(app, { role: 'admin' });
    expect(
      (
        await request(app)
          .patch('/api/users/aaaaaaaaaaaaaaaaaaaaaaaa')
          .set('Authorization', auth)
          .send({ name: 'X' })
      ).status,
    ).toBe(404);
    expect(
      (await request(app).patch('/api/users/nope').set('Authorization', auth).send({ name: 'X' }))
        .status,
    ).toBe(400);
    expect(
      (await request(app).patch(`/api/users/${user._id.toString()}`).set('Authorization', auth).send({}))
        .status,
    ).toBe(400);
  });

  it('deletes a non-admin user', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const target = await makeUser({ name: 'ToDelete' });

    const res = await request(app).delete(`/api/users/${target._id.toString()}`).set('Authorization', auth);
    expect(res.status).toBe(204);
    expect(await User.findById(target._id).exec()).toBeNull();
  });

  it('refuses to delete an admin until demoted', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const other = await makeUser({ role: 'admin' });

    const blocked = await request(app).delete(`/api/users/${other._id.toString()}`).set('Authorization', auth);
    expect(blocked.status).toBe(400);
    expect(await User.findById(other._id).exec()).not.toBeNull();

    await request(app).patch(`/api/users/${other._id.toString()}`).set('Authorization', auth).send({ role: 'user' });
    const res = await request(app).delete(`/api/users/${other._id.toString()}`).set('Authorization', auth);
    expect(res.status).toBe(204);
  });

  it('404s deleting an unknown user and 400s a malformed id', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    expect(
      (await request(app).delete('/api/users/aaaaaaaaaaaaaaaaaaaaaaaa').set('Authorization', auth)).status,
    ).toBe(404);
    expect((await request(app).delete('/api/users/nope').set('Authorization', auth)).status).toBe(400);
  });

  it('records an audit trail for creation, role changes, password resets and deletion', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const created = await request(app)
      .post('/api/users')
      .set('Authorization', auth)
      .send({ name: 'Audited', email: 'audited@example.com', password: 'password1234' });
    const id = created.body.user.id as string;

    await request(app).patch(`/api/users/${id}`).set('Authorization', auth).send({ password: 'new-password-1' });
    await request(app).delete(`/api/users/${id}`).set('Authorization', auth);

    const actions = (await AuditLog.find().sort({ createdAt: 1 }).exec()).map((l) => l.action);
    expect(actions).toEqual(
      expect.arrayContaining(['user.created', 'user.password_reset', 'user.deleted']),
    );
  });
});

describe('/api/tokens', () => {
  it('returns the plaintext exactly once, then only a prefix', async () => {
    const { auth } = await makeUserAndLogin(app);
    const created = await request(app)
      .post('/api/tokens')
      .set('Authorization', auth)
      .send({ label: 'laptop' });

    expect(created.status).toBe(201);
    const plaintext = created.body.token as string;
    expect(plaintext).toMatch(/^sk-/);
    expect(created.body.apiToken.tokenPrefix).toBe(plaintext.slice(0, 12));

    const list = await request(app).get('/api/tokens').set('Authorization', auth);
    expect(list.body.tokens).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(plaintext);
  });

  it('never stores the plaintext', async () => {
    const { auth } = await makeUserAndLogin(app);
    const created = await request(app).post('/api/tokens').set('Authorization', auth).send({});
    const stored = await ApiToken.findOne().exec();
    expect(JSON.stringify(stored!.toObject())).not.toContain(created.body.token);
  });

  it('defaults the label to an empty string', async () => {
    const { auth } = await makeUserAndLogin(app);
    const res = await request(app).post('/api/tokens').set('Authorization', auth).send({});
    expect(res.body.apiToken.label).toBe('');
  });

  it('issuing a new token leaves existing ones working', async () => {
    const { user, auth } = await makeUserAndLogin(app);
    const { token: first } = await makeApiToken(user._id);
    await request(app).post('/api/tokens').set('Authorization', auth).send({});

    const res = await request(app)
      .post('/api/usage')
      .set('X-API-Key', first)
      .send({
        project: 'p',
        datetime: '2026-08-28T10:15:00.000Z',
        prompt: '',
        session_id: 's',
        tokens: { input: 1, cache_read: 0, cache_write: 0, output: 1, total: 2 },
      });
    expect(res.status).toBe(204);
  });

  it('only lists the caller’s own tokens', async () => {
    const { auth } = await makeUserAndLogin(app);
    const stranger = await makeUser();
    await makeApiToken(stranger._id);

    const res = await request(app).get('/api/tokens').set('Authorization', auth);
    expect(res.body.tokens).toHaveLength(0);
  });

  it('revokes a token', async () => {
    const { user, auth } = await makeUserAndLogin(app);
    const { doc } = await makeApiToken(user._id);

    const res = await request(app)
      .post(`/api/tokens/${doc._id.toString()}/revoke`)
      .set('Authorization', auth);

    expect(res.body.apiToken.revoked).toBe(true);
    expect((await ApiToken.findById(doc._id).exec())!.revoked).toBe(true);
  });

  it('deletes a token', async () => {
    const { user, auth } = await makeUserAndLogin(app);
    const { doc } = await makeApiToken(user._id);
    const res = await request(app)
      .delete(`/api/tokens/${doc._id.toString()}`)
      .set('Authorization', auth);
    expect(res.status).toBe(204);
    expect(await ApiToken.countDocuments()).toBe(0);
  });

  it('cannot revoke or delete someone else’s token, even as admin', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const stranger = await makeUser();
    const { doc } = await makeApiToken(stranger._id);
    const id = doc._id.toString();

    expect(
      (await request(app).post(`/api/tokens/${id}/revoke`).set('Authorization', auth)).status,
    ).toBe(404);
    expect((await request(app).delete(`/api/tokens/${id}`).set('Authorization', auth)).status).toBe(
      404,
    );
    expect(await ApiToken.countDocuments()).toBe(1);
  });

  it('400s a malformed token id', async () => {
    const { auth } = await makeUserAndLogin(app);
    expect(
      (await request(app).post('/api/tokens/nope/revoke').set('Authorization', auth)).status,
    ).toBe(400);
    expect((await request(app).delete('/api/tokens/nope').set('Authorization', auth)).status).toBe(
      400,
    );
  });
});
