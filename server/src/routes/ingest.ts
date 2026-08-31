import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { TtlCache } from '../cache.js';
import type { Config } from '../config.js';
import { asyncHandler, requireApiKey, validate } from '../middleware.js';
import { UsageLog, type ApiTokenDoc } from '../models.js';
import { isProviderPricingDisabled, lookupPricing, priceTokens } from '../pricing.js';
import { resolveProjectName } from './projects.js';
import type { Broadcaster } from '../realtime.js';

/**
 * The claude-usage-reporter payload, verified against that plugin's
 * `src/report.mjs` `buildPayload()`. `model`, `user`, and `provider` are
 * omitted entirely when unset upstream, so all three are optional here — do
 * not tighten them.
 */
export const usagePayloadSchema = z.object({
  project: z.string().min(1).max(200),
  project_label: z.string().min(1).max(200).optional(),
  datetime: z.string().datetime({ offset: true }),
  prompt: z.string().default(''),
  session_id: z.string().min(1).max(200),
  model: z.string().min(1).max(200).optional(),
  user: z.string().max(200).optional(),
  /** `claude-session`, or the scheme+host of a custom `ANTHROPIC_BASE_URL`. */
  provider: z.string().min(1).max(200).optional(),
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
      // A reporting client can still send a name from before an admin renamed
      // it (e.g. a plugin caching a cwd-derived project name) — fold it into
      // the renamed project instead of quietly re-founding the old one.
      const project = await resolveProjectName(payload.project);
      // The plugin's default label is just the project name mirrored — when
      // it still matches what was just resolved above, track the same
      // rename so the display (which prefers this label) doesn't keep
      // reverting to the pre-rename name on every single report. A label the
      // admin genuinely set to something else never matched `payload.project`
      // in the first place, so it passes through untouched.
      const projectLabel =
        payload.project_label === payload.project ? project : payload.project_label ?? null;
      // A provider marked "pricing disabled" (e.g. a self-hosted gateway with
      // its own billing) skips the model lookup entirely — same end result as
      // an unpriced model, but without paying for a query that would be thrown away.
      const pricingDisabled = await isProviderPricingDisabled(
        payload.provider,
        cache,
        config.PRICING_CACHE_TTL_MS,
      );
      const pricing = pricingDisabled
        ? null
        : await lookupPricing(payload.model, cache, config.PRICING_CACHE_TTL_MS);

      // The rates in force *right now* are persisted onto the record itself,
      // not referenced — so a later pricing edit cannot silently restate what
      // this prompt cost (FRD §6, FR-9).
      const { estimatedCostUsd, pricingSnapshot } = priceTokens(payload.tokens, pricing);

      await UsageLog.create({
        userId: req.user!._id,
        apiTokenId: req.apiToken!._id,
        project,
        projectLabel,
        promptDatetime: new Date(payload.datetime),
        receivedAt: new Date(),
        prompt: payload.prompt,
        sessionId: payload.session_id,
        modelId: payload.model ?? null,
        userLabel: payload.user ?? null,
        provider: payload.provider ?? null,
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
