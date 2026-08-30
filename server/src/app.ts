import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { TtlCache } from './cache.js';
import type { Config } from './config.js';
import { errorHandler, notFoundHandler, requireAdmin, requireAuth } from './middleware.js';
import { aiProviderRoutes, type AiProviderDeps } from './routes/aiProviders.js';
import { authRoutes } from './routes/auth.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { ingestRoutes } from './routes/ingest.js';
import { meRoutes } from './routes/me.js';
import { modelPricingRoutes, type ModelPricingDeps } from './routes/modelPricing.js';
import { projectRoutes } from './routes/projects.js';
import { issueWsTicket, createBroadcaster, type Broadcaster } from './realtime.js';
import { tokenRoutes } from './routes/tokens.js';
import { usageLogRoutes } from './routes/usageLogs.js';
import { userRoutes } from './routes/users.js';

export interface AppDeps extends ModelPricingDeps, AiProviderDeps {
  /** Shared so tests (and the CLI, one day) can inspect or reset it. */
  cache?: TtlCache;
  /** Shared so tests can assert an event fired, and so index.ts can wire the WS server. */
  broadcaster?: Broadcaster;
}

export interface BuiltApp {
  app: Express;
  cache: TtlCache;
  broadcaster: Broadcaster;
}

export function createApp(config: Config, deps: AppDeps = {}): BuiltApp {
  const cache = deps.cache ?? new TtlCache();
  const broadcaster = deps.broadcaster ?? createBroadcaster();
  const app = express();

  if (config.TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGIN, credentials: true }));
  // Prompts can be long, but a single prompt is never megabytes.
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Public: bootstrap + login.
  app.use('/api/auth', authRoutes(config));

  // Plugin ingestion — authenticated by X-API-Key, not by a session.
  app.use('/api/usage', ingestRoutes(config, cache, broadcaster));

  // Everything below needs a logged-in user.
  const auth = requireAuth(config);
  app.use('/api/me', auth, meRoutes());
  app.use('/api/tokens', auth, tokenRoutes());
  app.use('/api/usage-logs', auth, usageLogRoutes(config, cache, broadcaster));
  app.use('/api/models', auth, modelPricingRoutes(config, cache, deps));
  app.use('/api/projects', auth, projectRoutes(cache, broadcaster));
  app.use('/api/dashboard', auth, dashboardRoutes(config, cache));

  // One-time credential for the WS handshake (browsers can't set a header
  // while opening a socket) — 20s TTL, single-use, checked in realtime.ts.
  app.post('/api/ws-ticket', auth, (_req, res) => {
    res.json({ ticket: issueWsTicket(cache) });
  });

  // Admin-only surfaces.
  app.use('/api/users', auth, requireAdmin, userRoutes());
  app.use('/api/ai-providers', auth, requireAdmin, aiProviderRoutes(config, cache, deps));

  app.use(notFoundHandler);
  app.use(errorHandler(config));

  return { app, cache, broadcaster };
}
