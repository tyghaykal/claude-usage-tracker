import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z, type ZodTypeAny } from 'zod';
import type { Config } from './config.js';
import { hashApiToken } from './crypto.js';
import { HttpError, badRequest, forbidden, unauthorized } from './errors.js';
import { ApiToken, User, type ApiTokenDoc, type Role, type UserDoc } from './models.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserDoc;
      apiToken?: ApiTokenDoc;
    }
  }
}

export interface AccessTokenPayload {
  sub: string;
  role: Role;
}

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export const asyncHandler =
  (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    handler(req, res, next).catch(next);
  };

export function signAccessToken(user: UserDoc, config: Config): string {
  const payload: AccessTokenPayload = { sub: user._id.toString(), role: user.role };
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: config.ACCESS_TOKEN_TTL,
  } as jwt.SignOptions);
}

export function signRefreshToken(user: UserDoc, config: Config): string {
  return jwt.sign({ sub: user._id.toString() }, config.JWT_REFRESH_SECRET, {
    expiresIn: `${config.REFRESH_TOKEN_TTL_DAYS}d`,
  } as jwt.SignOptions);
}

export function verifyRefreshToken(token: string, config: Config): string {
  try {
    const decoded = jwt.verify(token, config.JWT_REFRESH_SECRET) as { sub?: string };
    if (!decoded.sub) throw new Error('missing sub');
    return decoded.sub;
  } catch {
    throw unauthorized('Invalid or expired refresh token');
  }
}

const bearer = (header: string | undefined): string | null => {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : null;
};

/**
 * Web-session auth. The JWT is only a pointer — the user is re-read every
 * request, so a role change or deletion takes effect immediately instead of
 * lingering until the access token expires.
 */
export function requireAuth(config: Config): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    const token = bearer(req.header('authorization'));
    if (!token) throw unauthorized('Missing bearer token');

    let payload: AccessTokenPayload;
    try {
      payload = jwt.verify(token, config.JWT_SECRET) as AccessTokenPayload;
    } catch {
      throw unauthorized('Invalid or expired token');
    }

    const user = await User.findById(payload.sub).exec();
    if (!user) throw unauthorized('Account no longer exists');
    req.user = user;
    next();
  });
}

/** Must run after `requireAuth`. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (req.user?.role !== 'admin') return next(forbidden('Admin role required'));
  next();
};

/**
 * Ingestion auth (FR-9): the `X-API-Key` header the plugin sends when
 * `usageAuthType` is `Header`. Looked up by digest, so the plaintext token is
 * never stored and the comparison is an indexed equality match in Mongo.
 */
export const requireApiKey: RequestHandler = asyncHandler(async (req, _res, next) => {
  const provided = req.header('x-api-key');
  if (!provided) throw unauthorized('Missing X-API-Key header');

  const apiToken = await ApiToken.findOne({ tokenHash: hashApiToken(provided) }).exec();
  if (!apiToken) throw unauthorized('Unknown API key');
  if (apiToken.revoked) throw unauthorized('API key has been revoked');

  const user = await User.findById(apiToken.userId).exec();
  if (!user) throw unauthorized('API key owner no longer exists');

  req.apiToken = apiToken;
  req.user = user;
  next();
});

type RequestPart = 'body' | 'query' | 'params';

/** Validates one part of the request and replaces it with the parsed value. */
export function validate(schema: ZodTypeAny, part: RequestPart = 'body'): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req[part]);
    if (!result.success) {
      return next(badRequest(`Invalid request ${part}`, result.error.flatten()));
    }
    // `req.query`/`req.params` are getter-only in Express 5-style setups, so
    // stash the parsed value rather than assigning through.
    if (part === 'body') req.body = result.data;
    else Object.defineProperty(req, `validated${part}`, { value: result.data, writable: true });
    next();
  };
}

/** Reads what `validate(schema, 'query'|'params')` stashed. */
export function validated<T>(req: Request, part: Exclude<RequestPart, 'body'>): T {
  return (req as unknown as Record<string, T>)[`validated${part}`]!;
}

export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'must be a 24-character hex id');

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(new HttpError(404, 'Route not found'));
}

/** Terminal error middleware. Never leaks a stack or a secret to the client. */
export function errorHandler(config: Config) {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, details: err.details ?? undefined });
      return;
    }
    // Duplicate key — the only Mongo error we can meaningfully translate.
    if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) {
      res.status(409).json({ error: 'Duplicate value' });
      return;
    }
    if (config.NODE_ENV !== 'test') {
      // eslint-disable-next-line no-console
      console.error('[error]', err);
    }
    res.status(500).json({ error: 'Internal server error' });
  };
}
