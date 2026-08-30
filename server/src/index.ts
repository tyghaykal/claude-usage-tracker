import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { connectDb, disconnectDb } from './db.js';
import { seedDefaultModels } from './defaultModels.js';
import { attachRealtime } from './realtime.js';

const config = loadConfig();

const { app, cache, broadcaster } = createApp(config);

await connectDb(config.MONGO_URI);
await seedDefaultModels();

const server = app.listen(config.PORT, () => {
  console.log(`api listening on :${config.PORT} (${config.NODE_ENV})`);
});
const realtime = attachRealtime(server, cache, broadcaster);

const shutdown = (signal: string) => {
  console.log(`${signal} received, shutting down`);
  realtime.close();
  server.close(() => {
    void disconnectDb().then(() => process.exit(0));
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
