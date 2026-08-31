import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate, validated } from '../middleware.js';
import { AuditLog, type AuditLogDoc } from '../models.js';

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const publicEntry = (log: AuditLogDoc) => ({
  id: log._id.toString(),
  action: log.action,
  actorId: log.actorId?.toString() ?? null,
  actorName: log.actorName,
  targetId: log.targetId?.toString() ?? null,
  targetName: log.targetName,
  targetEmail: log.targetEmail,
  meta: log.meta,
  createdAt: log.createdAt,
});

/** Mounted behind requireAuth + requireAdmin. Read-only: entries are written
 *  by the actions themselves, never through this surface. */
export function auditLogRoutes(): Router {
  const router = Router();

  router.get(
    '/',
    validate(listQuery, 'query'),
    asyncHandler(async (req, res) => {
      const { page, limit } = validated<z.infer<typeof listQuery>>(req, 'query');
      const [logs, total] = await Promise.all([
        AuditLog.find()
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .exec(),
        AuditLog.countDocuments().exec(),
      ]);
      res.json({ logs: logs.map(publicEntry), total, totalPages: Math.max(1, Math.ceil(total / limit)) });
    }),
  );

  return router;
}
