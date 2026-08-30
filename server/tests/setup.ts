import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { createdCaches } from './helpers.js';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  mongoose.set('strictQuery', true);
  await mongoose.connect(mongod.getUri());
});

afterEach(async () => {
  // Cheaper than dropping the database, and keeps the indexes mongoose built.
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
  // Truncating collections behind the app's back is invisible to its own
  // invalidation, so flush every cache too or rows outlive their documents.
  for (const cache of createdCaches) cache.clear();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
