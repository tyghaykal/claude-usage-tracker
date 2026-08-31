import { Router } from 'express';
import { z } from 'zod';
import type { TtlCache } from '../cache.js';
import { conflict } from '../errors.js';
import { asyncHandler, requireAdmin, validate, validated } from '../middleware.js';
import { Project, UsageLog, type ProjectDoc } from '../models.js';
import type { Broadcaster } from '../realtime.js';

const nameParams = z.object({ name: z.string().trim().min(1).max(200) });
const renameSchema = z.object({
  name: z.string().trim().min(1).max(200),
  newName: z.string().trim().min(1).max(200),
});

/**
 * Resolves a possibly-stale project name to its current canonical one. A
 * report can arrive with an old name after a rename — the reporting client
 * (e.g. a plugin caching a cwd-derived name) has no idea the name changed
 * server-side — so without this, every such report would silently refound
 * the old project instead of joining the renamed one (FR-9 follow-up).
 *
 * ponytail: a live query per ingest, no caching. Renames are rare and the
 * Project collection is small; revisit if ingest volume ever makes this a
 * bottleneck, the way pricing lookups already are cached.
 */
export async function resolveProjectName(name: string): Promise<string> {
  if (await Project.exists({ name })) return name;
  const renamed = await Project.findOne({ 'history.from': name })
    .sort({ 'history.changedAt': -1 })
    .exec();
  return renamed?.name ?? name;
}

const publicProject = (name: string, history: ProjectDoc['history']) => ({
  name,
  history: history.map((entry) => ({
    from: entry.from,
    to: entry.to,
    changedAt: entry.changedAt,
    changedBy: entry.changedBy?.toString() ?? null,
  })),
});

/** Rename history for `UsageLog.project`. Mounted behind requireAuth. */
export function projectRoutes(cache: TtlCache, broadcaster: Broadcaster): Router {
  const router = Router();

  // A project with no rename yet has no document — that's not a 404, it's
  // just an empty history.
  router.get(
    '/:name',
    validate(nameParams, 'params'),
    asyncHandler(async (req, res) => {
      const { name } = validated<z.infer<typeof nameParams>>(req, 'params');
      const doc = await Project.findOne({ name }).exec();
      res.json({ project: publicProject(name, doc?.history ?? []) });
    }),
  );

  router.post(
    '/rename',
    requireAdmin,
    validate(renameSchema),
    asyncHandler(async (req, res) => {
      const { name, newName } = req.body as z.infer<typeof renameSchema>;
      if (name === newName) throw conflict('New name must be different');

      // Renaming onto an existing project name is a merge: both projects'
      // histories fold into one doc under `newName`, in chronological order.
      const [source, dest] = await Promise.all([
        Project.findOne({ name }).exec(),
        Project.findOne({ name: newName }).exec(),
      ]);
      const entry = { from: name, to: newName, changedAt: new Date(), changedBy: req.user!._id };
      const history = [...(source?.history ?? []), entry, ...(dest?.history ?? [])].sort(
        (a, b) => a.changedAt.getTime() - b.changedAt.getTime(),
      );

      let doc: ProjectDoc;
      if (dest) {
        dest.history = history;
        doc = await dest.save();
        if (source) await source.deleteOne();
      } else if (source) {
        source.name = newName;
        source.history = history;
        doc = await source.save();
      } else {
        doc = await Project.create({ name: newName, history });
      }

      await UsageLog.updateMany({ project: name }, { $set: { project: newName } }).exec();
      // A label that was only ever mirroring the technical name (the
      // reporter's default when no custom usageProjectLabel is set) should
      // track the rename too, or the table keeps showing the old name
      // forever. A genuinely distinct custom label (e.g. "Client X") never
      // matched `name` in the first place, so it's untouched here.
      await UsageLog.updateMany(
        { project: newName, projectLabel: name },
        { $set: { projectLabel: newName } },
      ).exec();

      cache.invalidatePrefix('dashboard:');
      broadcaster.emit({ type: 'data-changed' });
      res.json({ project: publicProject(doc.name, doc.history) });
    }),
  );

  return router;
}
