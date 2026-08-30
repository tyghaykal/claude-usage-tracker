import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { User } from '../src/models.js';
import { buildApp, login, makeUser, makeUserAndLogin, PASSWORD } from './helpers.js';

const { app } = buildApp();

describe('GET /api/auth/bootstrap-status', () => {
  it('reports needsBootstrap while no admin exists', async () => {
    const res = await request(app).get('/api/auth/bootstrap-status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ needsBootstrap: true });
  });

  it('a non-admin user does not satisfy the bootstrap check', async () => {
    await makeUser({ role: 'user' });
    const res = await request(app).get('/api/auth/bootstrap-status');
    expect(res.body.needsBootstrap).toBe(true);
  });

  it('reports false once an admin exists', async () => {
    await makeUser({ role: 'admin' });
    const res = await request(app).get('/api/auth/bootstrap-status');
    expect(res.body.needsBootstrap).toBe(false);
  });
});

describe('POST /api/auth/bootstrap-admin', () => {
  const payload = { name: 'Root', email: 'root@example.com', password: 'super-secret-1' };

  it('creates the first admin', async () => {
    const res = await request(app).post('/api/auth/bootstrap-admin').send(payload);
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'root@example.com', role: 'admin' });
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it('self-disables the moment an admin exists', async () => {
    await request(app).post('/api/auth/bootstrap-admin').send(payload);
    const second = await request(app)
      .post('/api/auth/bootstrap-admin')
      .send({ ...payload, email: 'other@example.com' });
    expect(second.status).toBe(409);
    expect(await User.countDocuments()).toBe(1);
  });

  it('rejects a short password', async () => {
    const res = await request(app)
      .post('/api/auth/bootstrap-admin')
      .send({ ...payload, password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.details.fieldErrors.password).toBeDefined();
  });

  it('rejects a malformed email', async () => {
    const res = await request(app)
      .post('/api/auth/bootstrap-admin')
      .send({ ...payload, email: 'not-an-email' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  it('returns an access token and sets a refresh cookie', async () => {
    const user = await makeUser({ email: 'dev@example.com' });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body.user.email).toBe('dev@example.com');

    const cookie = res.headers['set-cookie'][0] as string;
    expect(cookie).toContain('refresh_token=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/api/auth');
  });

  it('is case-insensitive on the email', async () => {
    await makeUser({ email: 'mixed@example.com' });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'MIXED@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it('gives the same error for a wrong password and an unknown account', async () => {
    const user = await makeUser();
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'nope-nope-nope' });
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@example.com', password: PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongPassword.body.error).toBe(unknown.body.error);
  });

  it('rejects a malformed body', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/refresh', () => {
  it('issues a fresh access token from the cookie', async () => {
    const user = await makeUser();
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: PASSWORD });

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', loginRes.headers['set-cookie']);

    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body.user.email).toBe(user.email);
  });

  it('401s with no cookie', async () => {
    const res = await request(app).post('/api/auth/refresh');
    expect(res.status).toBe(401);
  });

  it('401s on a forged cookie', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', ['refresh_token=not.a.jwt']);
    expect(res.status).toBe(401);
  });

  it('401s when the account was deleted after the cookie was issued', async () => {
    const user = await makeUser();
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: PASSWORD });
    await User.findByIdAndDelete(user._id);

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', loginRes.headers['set-cookie']);
    expect(res.status).toBe(401);
  });

  it('rejects a refresh token signed with the wrong secret', async () => {
    const { app: otherApp } = buildApp({}, { JWT_REFRESH_SECRET: 'a-completely-different-secret' });
    const user = await makeUser();
    const loginRes = await request(otherApp)
      .post('/api/auth/login')
      .send({ email: user.email, password: PASSWORD });

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', loginRes.headers['set-cookie']);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the refresh cookie', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(204);
    expect(res.headers['set-cookie'][0]).toContain('refresh_token=;');
  });
});

describe('auth middleware', () => {
  it('401s without a bearer token', async () => {
    expect((await request(app).get('/api/me')).status).toBe(401);
  });

  it('401s on a non-bearer authorization header', async () => {
    const res = await request(app).get('/api/me').set('Authorization', 'Basic abc');
    expect(res.status).toBe(401);
  });

  it('401s on a bearer scheme with no value', async () => {
    const res = await request(app).get('/api/me').set('Authorization', 'Bearer');
    expect(res.status).toBe(401);
  });

  it('401s on a garbage token', async () => {
    const res = await request(app).get('/api/me').set('Authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
  });

  it('401s when the account is deleted while the token is still valid', async () => {
    const { user, auth } = await makeUserAndLogin(app);
    await User.findByIdAndDelete(user._id);
    const res = await request(app).get('/api/me').set('Authorization', auth);
    expect(res.status).toBe(401);
  });

  it('picks up a role change immediately, without waiting for token expiry', async () => {
    const { user, auth } = await makeUserAndLogin(app, { role: 'user' });
    expect((await request(app).get('/api/users').set('Authorization', auth)).status).toBe(403);

    await User.findByIdAndUpdate(user._id, { role: 'admin' });
    expect((await request(app).get('/api/users').set('Authorization', auth)).status).toBe(200);
  });
});

describe('app-level handlers', () => {
  it('serves a health check', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('404s an unknown route as JSON', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Route not found');
  });

  it('translates a duplicate-key error into a 409', async () => {
    await makeUser({ email: 'dup@example.com', role: 'admin' });
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    // Slips past the route's own existence check by racing the unique index.
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', auth)
      .send({ name: 'Dup', email: 'DUP@example.com', password: 'password123' });
    expect(res.status).toBe(409);
  });

  it('trusts a proxy when configured to', async () => {
    const { app: proxied } = buildApp({}, { TRUST_PROXY: 'true' });
    expect(proxied.get('trust proxy')).toBe(1);
    expect((await request(proxied).get('/api/health')).status).toBe(200);
  });

  it('logs and 500s an unexpected error outside test mode', async () => {
    const { app: prodApp } = buildApp({}, { NODE_ENV: 'production' });
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    // A 24-hex id that is not a valid ObjectId cast target for `_id`… is valid,
    // so force a genuine failure with an unparseable JSON body instead.
    const res = await request(prodApp)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    console.error = original;

    expect(res.status).toBe(500);
    expect(errors.length).toBe(1);
  });

  it('does not log in test mode', async () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    console.error = original;

    expect(res.status).toBe(500);
    expect(errors.length).toBe(0);
  });

  it('rejects a login flood once the rate limit is reached', async () => {
    const { app: limited } = buildApp({}, { RATE_LIMIT_LOGIN_MAX: '2' });
    const body = { email: 'nobody@example.com', password: 'whatever1' };
    await request(limited).post('/api/auth/login').send(body);
    await request(limited).post('/api/auth/login').send(body);
    const third = await request(limited).post('/api/auth/login').send(body);
    expect(third.status).toBe(429);
  });
});

describe('login helper', () => {
  it('throws a useful error when credentials are wrong', async () => {
    await expect(login(app, 'ghost@example.com')).rejects.toThrow(/login failed: 401/);
  });
});
