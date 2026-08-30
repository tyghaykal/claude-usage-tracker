import { Router, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Config } from '../config.js';
import { hashPassword, verifyPassword } from '../crypto.js';
import { conflict, unauthorized } from '../errors.js';
import {
  asyncHandler,
  signAccessToken,
  signRefreshToken,
  validate,
  verifyRefreshToken,
} from '../middleware.js';
import { User, type UserDoc } from '../models.js';

const REFRESH_COOKIE = 'refresh_token';

export const publicUser = (user: UserDoc) => ({
  id: user._id.toString(),
  name: user.name,
  email: user.email,
  role: user.role,
  createdAt: user.createdAt,
});

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const bootstrapSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8, 'must be at least 8 characters'),
});

/** FR-1: is there an admin yet? Derived live, never a stored "setup done" flag. */
export async function adminExists(): Promise<boolean> {
  return (await User.countDocuments({ role: 'admin' }).exec()) > 0;
}

export function authRoutes(config: Config): Router {
  const router = Router();

  const loginLimiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    limit: config.RATE_LIMIT_LOGIN_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  });

  const setRefreshCookie = (res: Response, user: UserDoc) => {
    res.cookie(REFRESH_COOKIE, signRefreshToken(user, config), {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.COOKIE_SECURE,
      maxAge: config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
      path: '/api/auth',
    });
  };

  router.get(
    '/bootstrap-status',
    asyncHandler(async (_req, res) => {
      res.json({ needsBootstrap: !(await adminExists()) });
    }),
  );

  // FR-1: open only while zero admins exist. The guard is the live count, so
  // this self-disables the instant the first admin is created — by this route
  // or by the CLI.
  router.post(
    '/bootstrap-admin',
    validate(bootstrapSchema),
    asyncHandler(async (req, res) => {
      if (await adminExists()) {
        throw conflict('An admin already exists; ask an admin to create your account');
      }
      const { name, email, password } = req.body as z.infer<typeof bootstrapSchema>;
      const user = await User.create({
        name,
        email,
        passwordHash: await hashPassword(password),
        role: 'admin',
      });
      res.status(201).json({ user: publicUser(user) });
    }),
  );

  router.post(
    '/login',
    loginLimiter,
    validate(credentialsSchema),
    asyncHandler(async (req, res) => {
      const { email, password } = req.body as z.infer<typeof credentialsSchema>;
      const user = await User.findOne({ email: email.toLowerCase() }).exec();
      // Same message either way — don't leak which addresses have accounts.
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        throw unauthorized('Invalid email or password');
      }
      setRefreshCookie(res, user);
      res.json({ accessToken: signAccessToken(user, config), user: publicUser(user) });
    }),
  );

  router.post(
    '/refresh',
    asyncHandler(async (req, res) => {
      const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
      if (!token) throw unauthorized('Missing refresh token');
      const user = await User.findById(verifyRefreshToken(token, config)).exec();
      if (!user) throw unauthorized('Account no longer exists');
      setRefreshCookie(res, user);
      res.json({ accessToken: signAccessToken(user, config), user: publicUser(user) });
    }),
  );

  router.post('/logout', (_req, res) => {
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    res.status(204).end();
  });

  return router;
}
