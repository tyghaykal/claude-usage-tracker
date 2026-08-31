import { Router } from 'express';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { hashPassword } from '../crypto.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { asyncHandler, objectIdSchema, validate, validated } from '../middleware.js';
import { User } from '../models.js';
import { publicUser } from './auth.js';

const createSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8, 'must be at least 8 characters'),
  role: z.enum(['admin', 'user']).default('user'),
});

const updateSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    email: z.string().email().optional(),
    role: z.enum(['admin', 'user']).optional(),
    password: z.string().min(8, 'must be at least 8 characters').optional(),
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Provide at least one field to update',
  });

const idParams = z.object({ id: objectIdSchema });

/** FR-4. Mounted behind requireAuth + requireAdmin. */
export function userRoutes(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const users = await User.find().sort({ createdAt: 1 }).exec();
      res.json({ users: users.map(publicUser) });
    }),
  );

  router.post(
    '/',
    validate(createSchema),
    asyncHandler(async (req, res) => {
      const { name, email, password, role } = req.body as z.infer<typeof createSchema>;
      if (await User.exists({ email: email.toLowerCase() })) {
        throw conflict('A user with that email already exists');
      }
      const user = await User.create({
        name,
        email,
        role,
        passwordHash: await hashPassword(password),
      });
      await recordAudit('user.created', req.user!, { id: user._id, name: user.name, email: user.email }, { role });
      res.status(201).json({ user: publicUser(user) });
    }),
  );

  router.patch(
    '/:id',
    validate(idParams, 'params'),
    validate(updateSchema),
    asyncHandler(async (req, res) => {
      const { id } = validated<z.infer<typeof idParams>>(req, 'params');
      const { name, email, role, password } = req.body as z.infer<typeof updateSchema>;

      const user = await User.findById(id).exec();
      if (!user) throw notFound('User not found');

      // Guard the one change that can lock everybody out of user management.
      if (role === 'user' && user.role === 'admin') {
        const otherAdmins = await User.countDocuments({
          role: 'admin',
          _id: { $ne: user._id },
        }).exec();
        if (otherAdmins === 0) throw badRequest('Cannot demote the last remaining admin');
      }

      const normalizedEmail = email?.toLowerCase();
      if (normalizedEmail !== undefined && normalizedEmail !== user.email) {
        if (await User.exists({ email: normalizedEmail, _id: { $ne: user._id } })) {
          throw conflict('A user with that email already exists');
        }
      }

      const previousRole = user.role;
      const previousEmail = user.email;

      if (name !== undefined) user.name = name;
      if (email !== undefined) user.email = email;
      if (role !== undefined) user.role = role;
      if (password !== undefined) user.passwordHash = await hashPassword(password);

      await user.save();

      const target = { id: user._id, name: user.name, email: user.email };
      if (role !== undefined && role !== previousRole) {
        await recordAudit('user.role_changed', req.user!, target, { from: previousRole, to: role });
      }
      if (email !== undefined && user.email !== previousEmail) {
        await recordAudit('user.email_changed', req.user!, target, { from: previousEmail, to: user.email });
      }
      if (password !== undefined) {
        await recordAudit('user.password_reset', req.user!, target);
      }

      res.json({ user: publicUser(user) });
    }),
  );

  router.delete(
    '/:id',
    validate(idParams, 'params'),
    asyncHandler(async (req, res) => {
      const { id } = validated<z.infer<typeof idParams>>(req, 'params');

      const user = await User.findById(id).exec();
      if (!user) throw notFound('User not found');

      // Deleting an admin outright is a footgun (and can leave the app with
      // zero admins) — demote them to a regular user first, same as the UI copy says.
      if (user.role === 'admin') {
        throw badRequest('Demote this admin to a regular user before deleting them');
      }

      await user.deleteOne();
      await recordAudit('user.deleted', req.user!, { id: user._id, name: user.name, email: user.email });
      res.status(204).end();
    }),
  );

  return router;
}
