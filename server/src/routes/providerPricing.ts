import { Router } from 'express';
import { z } from 'zod';
import type { TtlCache } from '../cache.js';
import { asyncHandler, requireAdmin, validate, validated } from '../middleware.js';
import { ProviderPricingConfig, UsageLog, type ProviderPricingConfigDoc } from '../models.js';
import { invalidateProviderPricingCache } from '../pricing.js';

const providerParams = z.object({ provider: z.string().trim().min(1).max(200) });
const updateSchema = z.object({ pricingDisabled: z.boolean() });

const publicConfig = (provider: string, doc: ProviderPricingConfigDoc | null) => ({
  provider,
  pricingDisabled: doc?.pricingDisabled ?? false,
});

/**
 * The `provider` field reported alongside usage (FR-9), and whether cost
 * estimation is disabled for it. Mounted behind requireAuth; only the toggle
 * itself is admin-only, same split as /api/models.
 */
export function providerPricingRoutes(cache: TtlCache): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const [seen, configs] = await Promise.all([
        UsageLog.distinct('provider').exec(),
        ProviderPricingConfig.find().exec(),
      ]);
      const configMap = new Map(configs.map((c) => [c.provider, c]));
      // Union: a provider toggled once must not vanish from the list just
      // because none of its logs remain (e.g. reassigned via /usage-logs).
      const names = new Set<string>([
        ...(seen as (string | null)[]).filter((p): p is string => Boolean(p)),
        ...configMap.keys(),
      ]);
      res.json({
        providers: [...names]
          .sort()
          .map((provider) => publicConfig(provider, configMap.get(provider) ?? null)),
      });
    }),
  );

  router.patch(
    '/:provider',
    requireAdmin,
    validate(providerParams, 'params'),
    validate(updateSchema),
    asyncHandler(async (req, res) => {
      const { provider } = validated<z.infer<typeof providerParams>>(req, 'params');
      const { pricingDisabled } = req.body as z.infer<typeof updateSchema>;
      const doc = await ProviderPricingConfig.findOneAndUpdate(
        { provider },
        { pricingDisabled, updatedBy: req.user!._id },
        { new: true, upsert: true },
      ).exec();
      invalidateProviderPricingCache(cache);
      res.json({ provider: publicConfig(provider, doc) });
    }),
  );

  return router;
}
