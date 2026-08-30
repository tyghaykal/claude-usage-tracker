import { Router } from 'express';
import { z } from 'zod';
import { CacheKeys, type TtlCache } from '../cache.js';
import type { Config } from '../config.js';
import { decryptSecret } from '../crypto.js';
import { conflict, notFound } from '../errors.js';
import {
  asyncHandler,
  objectIdSchema,
  requireAdmin,
  validate,
  validated,
} from '../middleware.js';
import { DEFAULT_MODEL_IDS } from '../defaultModels.js';
import { AiProviderConfig, ModelPricing, type ModelPricingDoc } from '../models.js';
import { invalidatePricingCache, type Rates } from '../pricing.js';
import { searchPricing, type AiSearchResult } from '../services/aiPricing.js';
import { fetchOpenRouterRateMap } from '../services/openRouterPricing.js';

const rateFields = {
  inputPerMTok: z.number().nonnegative(),
  cacheWritePerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  currency: z.string().trim().min(1).max(10).default('USD'),
  source: z.enum(['manual', 'ai']).default('manual'),
};

const createSchema = z.object({
  // Opaque: `claude-sonnet-5`, `9r/claude-sonnet-5`, `amanai/combo-name`, …
  modelId: z.string().trim().min(1).max(200),
  ...rateFields,
});

const updateSchema = z
  .object({
    inputPerMTok: rateFields.inputPerMTok.optional(),
    cacheWritePerMTok: rateFields.cacheWritePerMTok.optional(),
    cacheReadPerMTok: rateFields.cacheReadPerMTok.optional(),
    outputPerMTok: rateFields.outputPerMTok.optional(),
    currency: z.string().trim().min(1).max(10).optional(),
    source: z.enum(['manual', 'ai']).optional(),
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Provide at least one field to update',
  });

const idParams = z.object({ id: objectIdSchema });

const aiSearchSchema = z.object({
  modelId: z.string().trim().min(1).max(200),
  providerId: objectIdSchema,
  /** Bypasses the 24h cache when the admin explicitly asks for a re-check. */
  refresh: z.boolean().default(false),
});

const rateEquals = (a: Rates, b: Rates): boolean =>
  a.inputPerMTok === b.inputPerMTok &&
  a.cacheWritePerMTok === b.cacheWritePerMTok &&
  a.cacheReadPerMTok === b.cacheReadPerMTok &&
  a.outputPerMTok === b.outputPerMTok;

const publicPricing = (doc: ModelPricingDoc) => ({
  id: doc._id.toString(),
  modelId: doc.modelId,
  inputPerMTok: doc.inputPerMTok,
  cacheWritePerMTok: doc.cacheWritePerMTok,
  cacheReadPerMTok: doc.cacheReadPerMTok,
  outputPerMTok: doc.outputPerMTok,
  currency: doc.currency,
  source: doc.source,
  updatedBy: doc.updatedBy?.toString() ?? null,
  updatedAt: doc.updatedAt,
});

export interface ModelPricingDeps {
  /** Injected in tests so no real HTTP call is made. */
  searchPricingImpl?: typeof searchPricing;
  /** Injected in tests so no real HTTP call is made. */
  fetchOpenRouterRateMapImpl?: typeof fetchOpenRouterRateMap;
}

/**
 * FR-7 (+ FR-11's search). Mounted behind requireAuth.
 * Reading pricing is open to any signed-in user; writes (create/update/delete
 * and the OpenRouter bulk refresh) are admin-only.
 */
export function modelPricingRoutes(
  config: Config,
  cache: TtlCache,
  deps: ModelPricingDeps = {},
): Router {
  const router = Router();
  const runSearch = deps.searchPricingImpl ?? searchPricing;
  const runFetchRateMap = deps.fetchOpenRouterRateMapImpl ?? fetchOpenRouterRateMap;

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const rows = await ModelPricing.find().sort({ modelId: 1 }).exec();
      res.json({ models: rows.map(publicPricing), catalog: [...DEFAULT_MODEL_IDS] });
    }),
  );

  router.post(
    '/',
    requireAdmin,
    validate(createSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof createSchema>;
      if (await ModelPricing.exists({ modelId: body.modelId })) {
        throw conflict(`Pricing for "${body.modelId}" already exists`);
      }
      const created = await ModelPricing.create({ ...body, updatedBy: req.user!._id });
      invalidatePricingCache(cache);
      res.status(201).json({ model: publicPricing(created) });
    }),
  );

  router.patch(
    '/:id',
    requireAdmin,
    validate(idParams, 'params'),
    validate(updateSchema),
    asyncHandler(async (req, res) => {
      const { id } = validated<z.infer<typeof idParams>>(req, 'params');
      const updates = req.body as z.infer<typeof updateSchema>;
      const doc = await ModelPricing.findById(id).exec();
      if (!doc) throw notFound('Model pricing not found');

      Object.assign(doc, updates, { updatedBy: req.user!._id });
      await doc.save();
      invalidatePricingCache(cache);
      // Deliberately does NOT touch historical UsageLog rows — that is FR-12,
      // and it is always an explicit action (FRD §13 decision 11).
      res.json({ model: publicPricing(doc) });
    }),
  );

  router.delete(
    '/:id',
    requireAdmin,
    validate(idParams, 'params'),
    asyncHandler(async (req, res) => {
      const { id } = validated<z.infer<typeof idParams>>(req, 'params');
      const deleted = await ModelPricing.findByIdAndDelete(id).exec();
      if (!deleted) throw notFound('Model pricing not found');
      invalidatePricingCache(cache);
      res.status(204).end();
    }),
  );

  /**
   * "Update all" (models view). Refreshes every stored model's rates from the
   * live OpenRouter catalog in one pass — unlike FR-11, this writes directly
   * (OpenRouter list prices are a published source, not a model's recall), and
   * unlike FR-12 it touches `ModelPricing` rows, never historical `UsageLog`s.
   * Rows OpenRouter has no unambiguous match for are left untouched.
   */
  router.post(
    '/refresh-openrouter',
    requireAdmin,
    asyncHandler(async (req, res) => {
      const rateMap = await runFetchRateMap(config.AI_REQUEST_TIMEOUT_MS);
      const rows = await ModelPricing.find().exec();

      let updated = 0;
      let unmatched = 0;
      for (const row of rows) {
        const rates = rateMap.ratesFor(row.modelId);
        if (!rates) {
          unmatched += 1;
          continue;
        }
        if (rateEquals(rates, row)) continue;
        Object.assign(row, rates, { source: 'manual', updatedBy: req.user!._id });
        await row.save();
        updated += 1;
      }

      if (updated > 0) invalidatePricingCache(cache);
      res.json({ checked: rows.length, updated, unmatched });
    }),
  );

  /**
   * FR-11. Returns a *preview* and writes nothing — the admin reviews the
   * numbers and then saves through POST/PATCH above. Confirming is just
   * "call the endpoint you'd have called anyway, pre-filled".
   */
  router.post(
    '/ai-search',
    requireAdmin,
    validate(aiSearchSchema),
    asyncHandler(async (req, res) => {
      const { modelId, providerId, refresh } = req.body as z.infer<typeof aiSearchSchema>;
      const provider = await AiProviderConfig.findById(providerId).exec();
      if (!provider) throw notFound('AI provider not found');

      const cacheKey = `${CacheKeys.aiSearch}${providerId}:${modelId}`;
      if (refresh) cache.delete(cacheKey);

      const cached = cache.get<AiSearchResult>(cacheKey);
      const result =
        cached ??
        cache.set(
          cacheKey,
          await runSearch({
            baseUrl: provider.baseUrl,
            apiKey: decryptSecret(provider.apiKeyEnc, config.SETTINGS_ENCRYPTION_KEY),
            modelName: provider.modelName,
            modelId,
            timeoutMs: config.AI_REQUEST_TIMEOUT_MS,
          }),
          config.AI_SEARCH_CACHE_TTL_MS,
        );

      res.json({
        modelId,
        providerId,
        suggested: result.suggested,
        raw: result.raw,
        fromCache: cached !== undefined,
        // Surfaced verbatim in the UI — this is the only accuracy control the
        // feature has, so it is part of the payload, not a footnote.
        disclaimer:
          'Suggested from the AI provider’s knowledge, which may be stale or wrong. ' +
          'Verify against the vendor’s pricing page before saving.',
      });
    }),
  );

  return router;
}
