import { Router } from 'express';
import { z } from 'zod';
import { CacheKeys, type TtlCache } from '../cache.js';
import type { Config } from '../config.js';
import { asyncHandler, objectIdSchema, validate, validated } from '../middleware.js';
import { UsageLog } from '../models.js';
import { buildFilterQuery } from './usageLogs.js';

const querySchema = z.object({
  project: z.string().trim().min(1).optional(),
  userId: objectIdSchema.optional(),
  model: z.string().trim().min(1).optional(),
  dateFrom: z.string().datetime({ offset: true }).optional(),
  dateTo: z.string().datetime({ offset: true }).optional(),
});

const TOTALS = {
  prompts: { $sum: 1 },
  totalTokens: { $sum: '$tokens.total' },
  inputTokens: { $sum: '$tokens.input' },
  cacheReadTokens: { $sum: '$tokens.cache_read' },
  cacheWriteTokens: { $sum: '$tokens.cache_write' },
  outputTokens: { $sum: '$tokens.output' },
  // Unpriced rows hold null; $sum skips non-numeric, so they contribute 0.
  estimatedCostUsd: { $sum: '$estimatedCostUsd' },
} as const;

const emptyTotals = {
  prompts: 0,
  totalTokens: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: 0,
};

/** FR-10. Mounted behind requireAuth. */
export function dashboardRoutes(config: Config, cache: TtlCache): Router {
  const router = Router();

  router.get(
    '/summary',
    validate(querySchema, 'query'),
    asyncHandler(async (req, res) => {
      const query = validated<z.infer<typeof querySchema>>(req, 'query');
      const match = buildFilterQuery(query);
      const cacheKey = `${CacheKeys.dashboard}${JSON.stringify(query)}`;

      const summary = await cache.wrap(cacheKey, config.DASHBOARD_CACHE_TTL_MS, async () => {
        const [totals, byDay, byModel, byProject, byUser] = await Promise.all([
          UsageLog.aggregate([{ $match: match }, { $group: { _id: null, ...TOTALS } }]).exec(),
          UsageLog.aggregate([
            { $match: match },
            {
              $group: {
                _id: {
                  $dateToString: { format: '%Y-%m-%d', date: '$promptDatetime', timezone: 'UTC' },
                },
                ...TOTALS,
              },
            },
            { $sort: { _id: 1 } },
          ]).exec(),
          UsageLog.aggregate([
            { $match: match },
            { $group: { _id: '$modelId', ...TOTALS } },
            { $sort: { totalTokens: -1 } },
          ]).exec(),
          UsageLog.aggregate([
            { $match: match },
            // Sorted ascending first so `$last` below picks each project's
            // most recently reported label, not an arbitrary one.
            { $sort: { receivedAt: 1 } },
            { $group: { _id: '$project', label: { $last: '$projectLabel' }, ...TOTALS } },
            { $sort: { totalTokens: -1 } },
          ]).exec(),
          UsageLog.aggregate([
            { $match: match },
            { $group: { _id: '$userId', ...TOTALS } },
            { $sort: { totalTokens: -1 } },
          ]).exec(),
        ]);

        const strip = <T extends { _id: unknown }>(rows: T[]) =>
          rows.map(({ _id, ...rest }) => ({ key: _id === null ? null : String(_id), ...rest }));

        return {
          totals: totals[0] ? { ...totals[0], _id: undefined } : emptyTotals,
          byDay: strip(byDay),
          byModel: strip(byModel),
          byProject: strip(byProject),
          byUser: strip(byUser),
        };
      });

      res.json(summary);
    }),
  );

  return router;
}
