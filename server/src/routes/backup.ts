import AdmZip from 'adm-zip';
import express, { Router } from 'express';
import type { Model } from 'mongoose';
import type { TtlCache } from '../cache.js';
import { badRequest } from '../errors.js';
import { asyncHandler } from '../middleware.js';
import {
  AiProviderConfig,
  ApiToken,
  ModelPricing,
  Project,
  User,
  UsageLog,
} from '../models.js';

/** Import order matters no more than export order does — Mongo enforces no
 *  cross-collection foreign keys here — but User first keeps the zip's
 *  entries readable in the order you'd expect. */
const COLLECTIONS: { name: string; model: Model<any> }[] = [
  { name: 'User', model: User },
  { name: 'ApiToken', model: ApiToken },
  { name: 'ModelPricing', model: ModelPricing },
  { name: 'AiProviderConfig', model: AiProviderConfig },
  { name: 'Project', model: Project },
  { name: 'UsageLog', model: UsageLog },
];

/** FR-admin backup/restore. Mounted behind requireAuth + requireAdmin. */
export function backupRoutes(cache: TtlCache): Router {
  const router = Router();

  router.get(
    '/export',
    asyncHandler(async (_req, res) => {
      const zip = new AdmZip();
      for (const { name, model } of COLLECTIONS) {
        const docs = await model.find().lean().exec();
        zip.addFile(`${name}.json`, Buffer.from(JSON.stringify(docs)));
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      res.set('Content-Type', 'application/zip');
      res.set('Content-Disposition', `attachment; filename="ai-usage-backup-${stamp}.zip"`);
      res.send(zip.toBuffer());
    }),
  );

  router.post(
    '/import',
    // A raw zip body, not JSON — the global express.json() parser ignores it
    // since its type doesn't match, so this is scoped to the one route.
    express.raw({ type: 'application/zip', limit: '100mb' }),
    asyncHandler(async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw badRequest('Expected a non-empty application/zip body');
      }

      let zip: AdmZip;
      try {
        zip = new AdmZip(req.body);
      } catch {
        throw badRequest('Not a valid zip file');
      }

      // ponytail: sequential deleteMany+insertMany per collection, no
      // transaction — this Mongo deployment isn't a replica set, so
      // multi-document transactions aren't available. A failure partway
      // through leaves earlier collections already replaced. Upgrade path:
      // run mongo as a single-node replica set and wrap this in a session.
      try {
        for (const { name, model } of COLLECTIONS) {
          const entry = zip.getEntry(`${name}.json`);
          if (!entry) continue;
          const docs = JSON.parse(entry.getData().toString('utf8'));
          await model.deleteMany({}).exec();
          if (Array.isArray(docs) && docs.length > 0) await model.insertMany(docs);
        }
      } catch (err) {
        throw badRequest(
          `Import failed partway through: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      cache.clear();
      res.json({ ok: true });
    }),
  );

  return router;
}
