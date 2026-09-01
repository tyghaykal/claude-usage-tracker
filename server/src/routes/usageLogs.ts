import { Router } from 'express';
import { Types, type FilterQuery } from 'mongoose';
import { z } from 'zod';
import type { TtlCache } from '../cache.js';
import type { Config } from '../config.js';
import { notFound } from '../errors.js';
import { asyncHandler, objectIdSchema, requireAdmin, validate, validated } from '../middleware.js';
import { UsageLog, type UsageLogDoc } from '../models.js';
import {
  hasPricedRates,
  isPricingOutdated,
  isProviderPricingDisabled,
  loadPricingMap,
  priceTokens,
  resolvePricing,
} from '../pricing.js';
import type { Broadcaster } from '../realtime.js';

const filterSchema = z.object({
  project: z.string().trim().min(1).optional(),
  userId: objectIdSchema.optional(),
  model: z.string().trim().min(1).optional(),
  dateFrom: z.string().datetime({ offset: true }).optional(),
  dateTo: z.string().datetime({ offset: true }).optional(),
});

export type UsageFilter = z.infer<typeof filterSchema>;

const listQuerySchema = filterSchema.extend({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

const idParams = z.object({ id: objectIdSchema });
const providerUpdateSchema = z.object({ provider: z.string().trim().min(1).max(200) });

/** FR-12 accepts either an explicit selection or "everything matching this filter". */
const recalculateSchema = z.union([
  z.object({ ids: z.array(objectIdSchema).min(1).max(10_000) }),
  z.object({ filter: filterSchema }),
]);

/** Same "ids or filter" shape as recalculateSchema, plus the value to set. */
const bulkProviderSchema = z.union([
  z.object({
    ids: z.array(objectIdSchema).min(1).max(10_000),
    provider: z.string().trim().min(1).max(200),
  }),
  z.object({ filter: filterSchema, provider: z.string().trim().min(1).max(200) }),
]);

/** Turns the shared filter shape into a Mongo query. */
export function buildFilterQuery(filter: UsageFilter): FilterQuery<UsageLogDoc> {
  const query: FilterQuery<UsageLogDoc> = {};
  // Exact match: the client only ever sends a name picked from /facets, not
  // free text, and projects are distinct renameable entities now — a
  // substring match would silently fold "ai" together with "ai-b"/"ai-hehe".
  if (filter.project) query.project = filter.project;
  // Cast explicitly: `find()` would coerce the hex string for us, but the same
  // query is reused as an aggregation `$match`, which does no casting at all —
  // an uncast string there silently matches nothing.
  if (filter.userId) query.userId = new Types.ObjectId(filter.userId);
  if (filter.model) query.modelId = filter.model;
  if (filter.dateFrom || filter.dateTo) {
    query.promptDatetime = {
      ...(filter.dateFrom ? { $gte: new Date(filter.dateFrom) } : {}),
      ...(filter.dateTo ? { $lte: new Date(filter.dateTo) } : {}),
    };
  }
  return query;
}

const listRow = (log: UsageLogDoc, outdated: boolean) => ({
  id: log._id.toString(),
  userId: log.userId.toString(),
  project: log.project,
  projectLabel: log.projectLabel,
  promptDatetime: log.promptDatetime,
  model: log.modelId,
  provider: log.provider,
  tokens: log.tokens,
  estimatedCostUsd: log.estimatedCostUsd,
  amanaiCredits: log.amanaiCredits ?? null,
  currency: log.pricingSnapshot?.currency ?? null,
  pricingOutdated: outdated,
});

const detail = (log: UsageLogDoc, outdated: boolean) => ({
  ...listRow(log, outdated),
  apiTokenId: log.apiTokenId.toString(),
  prompt: log.prompt,
  sessionId: log.sessionId,
  userLabel: log.userLabel,
  receivedAt: log.receivedAt,
  // The rates themselves, not just the resulting figure (FR-6).
  pricingSnapshot: log.pricingSnapshot,
  recalculatedAt: log.recalculatedAt,
  rawPayload: log.rawPayload,
});

/** FR-5, FR-6, FR-12. Mounted behind requireAuth. */
export function usageLogRoutes(config: Config, cache: TtlCache, broadcaster: Broadcaster): Router {
  const router = Router();

  const pricingMap = () => loadPricingMap(cache, config.PRICING_CACHE_TTL_MS);

  router.get(
    '/',
    validate(listQuerySchema, 'query'),
    asyncHandler(async (req, res) => {
      const query = validated<z.infer<typeof listQuerySchema>>(req, 'query');
      const mongoQuery = buildFilterQuery(query);

      const [logs, total, pricing] = await Promise.all([
        UsageLog.find(mongoQuery)
          .sort({ promptDatetime: -1 })
          .skip((query.page - 1) * query.limit)
          .limit(query.limit)
          .exec(),
        UsageLog.countDocuments(mongoQuery).exec(),
        pricingMap(),
      ]);

      res.json({
        logs: logs.map((log) =>
          listRow(log, isPricingOutdated(log.pricingSnapshot, resolvePricing(pricing, log.modelId))),
        ),
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      });
    }),
  );

  /** Populates the filter dropdowns without a second round of guessing. */
  router.get(
    '/facets',
    asyncHandler(async (_req, res) => {
      const [projects, models] = await Promise.all([
        UsageLog.distinct('project').exec(),
        UsageLog.distinct('modelId').exec(),
      ]);
      res.json({
        projects: (projects as string[]).sort(),
        models: (models as (string | null)[]).filter((m): m is string => Boolean(m)).sort(),
      });
    }),
  );

  // FR-12. Declared before `/:id` so "recalculate-cost" is never read as an id.
  router.post(
    '/recalculate-cost',
    validate(recalculateSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof recalculateSchema>;
      const mongoQuery: FilterQuery<UsageLogDoc> =
        'ids' in body ? { _id: { $in: body.ids } } : buildFilterQuery(body.filter);

      const [logs, pricing] = await Promise.all([UsageLog.find(mongoQuery).exec(), pricingMap()]);

      let updated = 0;
      for (const log of logs) {
        // A provider with pricing disabled always recalculates to null —
        // unlike an unpriced model, this is a deliberate "don't estimate this"
        // rather than "we don't know yet", so it does get to blank out a
        // figure that was already there.
        const providerDisabled = await isProviderPricingDisabled(
          log.provider,
          cache,
          config.PRICING_CACHE_TTL_MS,
        );
        if (providerDisabled) {
          if (log.estimatedCostUsd === null && log.pricingSnapshot === null) continue;
          log.estimatedCostUsd = null;
          log.pricingSnapshot = null;
          log.recalculatedAt = new Date();
          await log.save();
          updated += 1;
          continue;
        }

        const current = resolvePricing(pricing, log.modelId);
        // A model we still have no price for is left exactly as it was —
        // recalculation never blanks out a figure it cannot improve on.
        // All-zero catalog seeds are names, not rates, so they skip too.
        if (!hasPricedRates(current)) continue;
        const { estimatedCostUsd, pricingSnapshot } = priceTokens(log.tokens, current);
        log.estimatedCostUsd = estimatedCostUsd;
        log.pricingSnapshot = pricingSnapshot;
        log.recalculatedAt = new Date();
        await log.save();
        updated += 1;
      }

      cache.invalidatePrefix('dashboard:');
      if (updated > 0) broadcaster.emit({ type: 'data-changed' });
      res.json({ total: logs.length, updated, skipped: logs.length - updated });
    }),
  );

  /**
   * Bulk version of PATCH /:id/provider — an explicit selection or everything
   * matching a filter, same "ids or filter" shape as /recalculate-cost.
   * Deliberately does not touch cost; run recalculate-cost afterwards if the
   * newly-tagged provider has pricing disabled.
   */
  router.post(
    '/set-provider',
    requireAdmin,
    validate(bulkProviderSchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof bulkProviderSchema>;
      const { provider } = body;
      const mongoQuery: FilterQuery<UsageLogDoc> =
        'ids' in body ? { _id: { $in: body.ids } } : buildFilterQuery(body.filter);

      const result = await UsageLog.updateMany(mongoQuery, { $set: { provider } }).exec();
      if (result.modifiedCount > 0) broadcaster.emit({ type: 'data-changed' });
      res.json({ matched: result.matchedCount, updated: result.modifiedCount });
    }),
  );

  /**
   * Tags a log with a `provider` — mainly for records ingested before the
   * plugin sent this field. Same "admin corrects an existing record" shape
   * as /projects/rename, but scoped to one log rather than a shared entity:
   * unlike a project name, a provider isn't unique-keyed, so there's no
   * history to merge. Deliberately does not touch cost — recalculate-cost
   * already accounts for the provider now being set (or changed).
   */
  router.patch(
    '/:id/provider',
    requireAdmin,
    validate(idParams, 'params'),
    validate(providerUpdateSchema),
    asyncHandler(async (req, res) => {
      const { id } = validated<z.infer<typeof idParams>>(req, 'params');
      const { provider } = req.body as z.infer<typeof providerUpdateSchema>;
      const log = await UsageLog.findById(id).exec();
      if (!log) throw notFound('Usage log not found');

      log.provider = provider;
      await log.save();

      const pricing = await pricingMap();
      res.json({
        log: detail(log, isPricingOutdated(log.pricingSnapshot, resolvePricing(pricing, log.modelId))),
      });
    }),
  );

  router.get(
    '/:id',
    validate(idParams, 'params'),
    asyncHandler(async (req, res) => {
      const { id } = validated<z.infer<typeof idParams>>(req, 'params');
      const log = await UsageLog.findById(id).exec();
      if (!log) throw notFound('Usage log not found');
      const pricing = await pricingMap();
      res.json({
        log: detail(log, isPricingOutdated(log.pricingSnapshot, resolvePricing(pricing, log.modelId))),
      });
    }),
  );

  return router;
}
