import { Router } from 'express';
import { z } from 'zod';
import { CacheKeys, type TtlCache } from '../cache.js';
import type { Config } from '../config.js';
import { decryptSecret, encryptSecret } from '../crypto.js';
import { badRequest, notFound } from '../errors.js';
import { asyncHandler, objectIdSchema, validate, validated } from '../middleware.js';
import { AiProviderConfig, type AiProviderConfigDoc } from '../models.js';
import { testProvider } from '../services/aiPricing.js';

const createSchema = z.object({
  label: z.string().trim().min(1).max(120),
  // http(s) only — this URL is fetched server-side, so no file:// or similar.
  baseUrl: z
    .string()
    .trim()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL'),
  modelName: z.string().trim().min(1).max(200),
  apiKey: z.string().min(1).max(500),
});

const updateSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    baseUrl: createSchema.shape.baseUrl.optional(),
    modelName: z.string().trim().min(1).max(200).optional(),
    apiKey: z.string().min(1).max(500).optional(),
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Provide at least one field to update',
  });

const idParams = z.object({ id: objectIdSchema });

/** The API key is never echoed back — only whether one is set. */
const publicProvider = (doc: AiProviderConfigDoc) => ({
  id: doc._id.toString(),
  label: doc.label,
  baseUrl: doc.baseUrl,
  modelName: doc.modelName,
  hasKey: Boolean(doc.apiKeyEnc),
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

export interface AiProviderDeps {
  /** Injected in tests so no real HTTP call is made. */
  testProviderImpl?: typeof testProvider;
}

/** FR-11 provider management. Mounted behind requireAuth + requireAdmin. */
export function aiProviderRoutes(
  config: Config,
  cache: TtlCache,
  deps: AiProviderDeps = {},
): Router {
  const router = Router();
  const encrypt = (key: string) => encryptSecret(key, config.SETTINGS_ENCRYPTION_KEY);
  const decrypt = (enc: string) => decryptSecret(enc, config.SETTINGS_ENCRYPTION_KEY);
  const probe = deps.testProviderImpl ?? testProvider;

  const runProbe = (baseUrl: string, apiKey: string, modelName: string) =>
    probe({ baseUrl, apiKey, modelName, timeoutMs: config.AI_REQUEST_TIMEOUT_MS });

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const providers = await AiProviderConfig.find().sort({ createdAt: 1 }).exec();
      res.json({ providers: providers.map(publicProvider) });
    }),
  );

  router.post(
    '/',
    validate(createSchema),
    asyncHandler(async (req, res) => {
      const { label, baseUrl, modelName, apiKey } = req.body as z.infer<typeof createSchema>;

      // Prove the endpoint, key and model actually work together before storing
      // them, so a typo fails here rather than during a pricing lookup later.
      const test = await runProbe(baseUrl, apiKey, modelName);
      if (!test.ok) throw badRequest(test.message, { providerTest: test });

      const created = await AiProviderConfig.create({
        label,
        baseUrl,
        modelName,
        apiKeyEnc: encrypt(apiKey),
        createdBy: req.user!._id,
      });
      res.status(201).json({ provider: publicProvider(created), test });
    }),
  );

  router.patch(
    '/:id',
    validate(idParams, 'params'),
    validate(updateSchema),
    asyncHandler(async (req, res) => {
      const { id } = validated<z.infer<typeof idParams>>(req, 'params');
      const { label, baseUrl, modelName, apiKey } = req.body as z.infer<typeof updateSchema>;
      const provider = await AiProviderConfig.findById(id).exec();
      if (!provider) throw notFound('AI provider not found');

      // Re-probe only when something that affects connectivity changed — a
      // label rename must not cost an API call.
      const touchesConnection =
        baseUrl !== undefined || modelName !== undefined || apiKey !== undefined;
      let test: Awaited<ReturnType<typeof runProbe>> | undefined;
      if (touchesConnection) {
        test = await runProbe(
          baseUrl ?? provider.baseUrl,
          apiKey ?? decrypt(provider.apiKeyEnc),
          modelName ?? provider.modelName,
        );
        if (!test.ok) throw badRequest(test.message, { providerTest: test });
      }

      if (label !== undefined) provider.label = label;
      if (baseUrl !== undefined) provider.baseUrl = baseUrl;
      if (modelName !== undefined) provider.modelName = modelName;
      if (apiKey !== undefined) provider.apiKeyEnc = encrypt(apiKey);
      await provider.save();

      // Cached suggestions came from the old endpoint/key/model — drop them.
      cache.invalidatePrefix(`${CacheKeys.aiSearch}${id}:`);
      res.json({ provider: publicProvider(provider), test });
    }),
  );

  /**
   * Re-check a stored provider on demand — for a rotated key, or a provider
   * that has since gone down. Always 200: a failed probe is a diagnostic
   * result, not a failed request.
   */
  router.post(
    '/:id/test',
    validate(idParams, 'params'),
    asyncHandler(async (req, res) => {
      const { id } = validated<z.infer<typeof idParams>>(req, 'params');
      const provider = await AiProviderConfig.findById(id).exec();
      if (!provider) throw notFound('AI provider not found');

      res.json({
        test: await runProbe(
          provider.baseUrl,
          decrypt(provider.apiKeyEnc),
          provider.modelName,
        ),
      });
    }),
  );

  router.delete(
    '/:id',
    validate(idParams, 'params'),
    asyncHandler(async (req, res) => {
      const { id } = validated<z.infer<typeof idParams>>(req, 'params');
      const deleted = await AiProviderConfig.findByIdAndDelete(id).exec();
      if (!deleted) throw notFound('AI provider not found');
      cache.invalidatePrefix(`${CacheKeys.aiSearch}${id}:`);
      res.status(204).end();
    }),
  );

  return router;
}
