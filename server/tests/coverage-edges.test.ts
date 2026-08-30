/**
 * Edge paths the feature suites do not naturally reach: root-level config
 * failures, the duplicate-key translation, null-model and null-updatedBy
 * rendering, and the real db.ts connect/disconnect pair.
 */
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { UsageLog, User } from '../src/models.js';
import {
  buildApp,
  makeApiToken,
  makePricing,
  makeUser,
  makeUserAndLogin,
  TEST_ENV,
  usagePayload,
} from './helpers.js';

const { app } = buildApp();

describe('config edge cases', () => {
  it('labels a root-level failure as (root)', () => {
    expect(() => loadConfig(null as never)).toThrow(/\(root\)/);
  });
});

describe('refresh token claims', () => {
  it('rejects a correctly-signed refresh token that carries no subject', async () => {
    const orphan = jwt.sign({ notASubject: true }, TEST_ENV.JWT_REFRESH_SECRET, {
      expiresIn: '1h',
    });
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', [`refresh_token=${orphan}`]);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid or expired refresh token/);
  });
});

describe('duplicate-key translation', () => {
  it('turns a raw Mongo 11000 into a 409', async () => {
    // bootstrap-admin has no duplicate pre-check by design — it is only
    // reachable when no admin exists — so the unique index is what rejects it.
    await makeUser({ email: 'taken@example.com', role: 'user' });
    const res = await request(app)
      .post('/api/auth/bootstrap-admin')
      .send({ name: 'Root', email: 'taken@example.com', password: 'password123' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Duplicate value');
    expect(await User.countDocuments({ role: 'admin' })).toBe(0);
  });
});

describe('null-model rows', () => {
  const noModelPayload = () => {
    const { model: _drop, ...rest } = usagePayload();
    return rest;
  };

  it('recalculation skips a row with no model at all', async () => {
    await makePricing('claude-sonnet-5');
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    await request(app).post('/api/usage').set('X-API-Key', token).send(noModelPayload());

    const { auth } = await makeUserAndLogin(app);
    const res = await request(app)
      .post('/api/usage-logs/recalculate-cost')
      .set('Authorization', auth)
      .send({ filter: {} });

    expect(res.body).toEqual({ total: 1, updated: 0, skipped: 1 });
    expect((await UsageLog.findOne().exec())!.recalculatedAt).toBeNull();
  });

  it('the detail view renders a row with no model and no snapshot', async () => {
    const user = await makeUser();
    const { token } = await makeApiToken(user._id);
    await request(app).post('/api/usage').set('X-API-Key', token).send(noModelPayload());
    const log = await UsageLog.findOne().exec();

    const { auth } = await makeUserAndLogin(app);
    const res = await request(app)
      .get(`/api/usage-logs/${log!._id.toString()}`)
      .set('Authorization', auth);

    expect(res.body.log).toMatchObject({
      model: null,
      estimatedCostUsd: null,
      pricingSnapshot: null,
      currency: null,
      pricingOutdated: false,
    });
  });
});

describe('model pricing rendering', () => {
  it('renders updatedBy as null for a row no user has touched', async () => {
    await makePricing('seeded-by-migration');
    const { auth } = await makeUserAndLogin(app);
    const res = await request(app).get('/api/models').set('Authorization', auth);
    expect(res.body.models[0].updatedBy).toBeNull();
  });
});

describe('user updates', () => {
  it('updates only the name, leaving role and password alone', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const target = await makeUser({ name: 'Before', role: 'user' });

    const res = await request(app)
      .patch(`/api/users/${target._id.toString()}`)
      .set('Authorization', auth)
      .send({ name: 'After' });

    expect(res.body.user).toMatchObject({ name: 'After', role: 'user' });
    const updated = await User.findById(target._id).exec();
    expect(updated!.passwordHash).toBe(target.passwordHash);
  });

  it('updates only the role, leaving the name alone', async () => {
    const { auth } = await makeUserAndLogin(app, { role: 'admin' });
    const target = await makeUser({ name: 'Keep', role: 'user' });

    const res = await request(app)
      .patch(`/api/users/${target._id.toString()}`)
      .set('Authorization', auth)
      .send({ role: 'admin' });

    expect(res.body.user).toMatchObject({ name: 'Keep', role: 'admin' });
  });
});

describe('db module', () => {
  it('connects to and disconnects from a real mongod', async () => {
    // The suite's shared connection has to stand aside for this one test.
    const sharedUri = mongoose.connection.host
      ? `mongodb://${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.name}`
      : '';
    await disconnectDb();

    const standalone = await MongoMemoryServer.create();
    await connectDb(standalone.getUri());
    expect(mongoose.connection.readyState).toBe(1);
    // strictQuery is what connectDb configures on the way in.
    expect(mongoose.get('strictQuery')).toBe(true);

    await disconnectDb();
    expect(mongoose.connection.readyState).toBe(0);
    await standalone.stop();

    // Hand the shared connection back to the rest of the suite.
    await connectDb(sharedUri);
  });
});
