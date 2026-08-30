import { Router } from 'express';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../crypto.js';
import { badRequest, unauthorized } from '../errors.js';
import { asyncHandler, validate } from '../middleware.js';
import { User } from '../models.js';
import { publicUser } from './auth.js';

const updateSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    currentPassword: z.string().min(1).optional(),
    newPassword: z.string().min(8, 'must be at least 8 characters').optional(),
  })
  .refine((v) => v.name !== undefined || v.newPassword !== undefined, {
    message: 'Provide name and/or newPassword',
  })
  // FR-3: changing your own password always requires proving you know the old
  // one, so a hijacked session cannot lock the real owner out.
  .refine((v) => v.newPassword === undefined || v.currentPassword !== undefined, {
    message: 'currentPassword is required to change your password',
    path: ['currentPassword'],
  });

export function meRoutes(): Router {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({ user: publicUser(req.user!) });
  });

  // Names only — every signed-in user can see who else logged usage (FR-4 only
  // gates account management: email, role, password), so the developer filter
  // and log/dashboard rows can show a name instead of a raw user id.
  router.get(
    '/directory',
    asyncHandler(async (_req, res) => {
      const users = await User.find().sort({ name: 1 }).select('name').exec();
      res.json({ users: users.map((u) => ({ id: u._id.toString(), name: u.name })) });
    }),
  );

  router.patch(
    '/',
    validate(updateSchema),
    asyncHandler(async (req, res) => {
      const { name, currentPassword, newPassword } = req.body as z.infer<typeof updateSchema>;
      const user = req.user!;

      if (newPassword !== undefined) {
        if (!(await verifyPassword(currentPassword!, user.passwordHash))) {
          throw unauthorized('Current password is incorrect');
        }
        if (newPassword === currentPassword) {
          throw badRequest('New password must differ from the current one');
        }
        user.passwordHash = await hashPassword(newPassword);
      }
      if (name !== undefined) user.name = name;

      await user.save();
      res.json({ user: publicUser(user) });
    }),
  );

  return router;
}
