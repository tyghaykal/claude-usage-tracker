import { Router } from 'express';
import { z } from 'zod';
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
      res.status(201).json({ user: publicUser(user) });
    }),
  );

  router.patch(
    '/:id',
    validate(idParams, 'params'),
    validate(updateSchema),
    asyncHandler(async (req, res) => {
      const { id } = validated<z.infer<typeof idParams>>(req, 'params');
      const { name, role, password } = req.body as z.infer<typeof updateSchema>;

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

      if (name !== undefined) user.name = name;
      if (role !== undefined) user.role = role;
      if (password !== undefined) user.passwordHash = await hashPassword(password);

      await user.save();
      res.json({ user: publicUser(user) });
    }),
  );

  return router;
}
