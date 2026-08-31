import type { Types } from 'mongoose';
import { AuditLog, type AuditAction, type UserDoc } from './models.js';

interface AuditTarget {
  id: Types.ObjectId | null;
  name: string;
  email?: string | null;
}

/** Records one admin/account-management action (FR-4 audit trail). */
export async function recordAudit(
  action: AuditAction,
  actor: UserDoc,
  target: AuditTarget,
  meta?: Record<string, unknown>,
): Promise<void> {
  await AuditLog.create({
    action,
    actorId: actor._id,
    actorName: actor.name,
    targetId: target.id,
    targetName: target.name,
    targetEmail: target.email ?? null,
    meta: meta ?? null,
  });
}
