import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { TtlCache } from '../cache.js';
import type { Config } from '../config.js';
import { asyncHandler, requireApiKey, validate } from '../middleware.js';
import { UsageLog, type ApiTokenDoc } from '../models.js';
import { lookupPricing, priceTokens } from '../pricing.js';
import type { Broadcaster } from '../realtime.js';

/**
 * The claude-usage-reporter payload, verified against that plugin's
 * `src/report.mjs` `buildPayload()`. `model` and `user` are omitted entirely
 * when unset upstream, so both are optional here — do not tighten them.
 */
export const usagePayloadSchema = z.object({
  project: z.string().min(1).max(200),
  project_label: z.string().min(1).max(200).optional(),
  datetime: z.string().datetime({ offset: true }),
  prompt: z.string().default(''),
  session_id: z.string().min(1).max(200),
  model: z.string().min(1).max(200).optional(),
  user: z.string().max(200).optional(),
  tokens: z.object({
    input: z.number().int().nonnegative(),
    cache_read: z.number().int().nonnegative(),
    cache_write: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
});

export type UsagePayload = z.infer<typeof usagePayloadSchema>;

/**
 * Best-effort "last seen" stamp. The plugin never reads it and nothing depends
 * on it, so a write failure here — a token revoked or deleted mid-request, say
 * — must not fail an ingestion whose usage row is already safely stored.
 */
export async function touchToken(token: ApiTokenDoc): Promise<void> {
  token.lastUsedAt = new Date();
  await token.save().catch(() => undefined);
}

/** FR-9. Mounted at POST /api/usage. */
export function ingestRoutes(config: Config, cache: TtlCache, broadcaster: Broadcaster): Router {
  const router = Router();

  const limiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    limit: config.RATE_LIMIT_USAGE_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.post(
    '/',
    limiter,
    requireApiKey,
    validate(usagePayloadSchema),
    asyncHandler(async (req, res) => {
      const payload = req.body as UsagePayload;
      const pricing = await lookupPricing(payload.model, cache, config.PRICING_CACHE_TTL_MS);

      // The rates in force *right now* are persisted onto the record itself,
      // not referenced — so a later pricing edit cannot silently restate what
      // this prompt cost (FRD §6, FR-9).
      const { estimatedCostUsd, pricingSnapshot } = priceTokens(payload.tokens, pricing);

      await UsageLog.create({
        userId: req.user!._id,
        apiTokenId: req.apiToken!._id,
        project: payload.project,
        projectLabel: payload.project_label ?? null,
        promptDatetime: new Date(payload.datetime),
        receivedAt: new Date(),
        prompt: payload.prompt,
        sessionId: payload.session_id,
        modelId: payload.model ?? null,
        userLabel: payload.user ?? null,
        tokens: payload.tokens,
        estimatedCostUsd,
        pricingSnapshot,
        recalculatedAt: null,
        rawPayload: payload,
      });

      // Fresh rows change every dashboard aggregate.
      cache.invalidatePrefix('dashboard:');
      broadcaster.emit({ type: 'data-changed' });

      await touchToken(req.apiToken!);

      res.status(204).end();
    }),
  );

  return router;
}
