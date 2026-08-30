import { Router } from 'express';
import { z } from 'zod';
import { generateApiToken } from '../crypto.js';
import { notFound } from '../errors.js';
import { asyncHandler, objectIdSchema, validate, validated } from '../middleware.js';
import { ApiToken, type ApiTokenDoc } from '../models.js';

const createSchema = z.object({ label: z.string().max(120).default('') });
const idParams = z.object({ id: objectIdSchema });

const publicToken = (token: ApiTokenDoc) => ({
  id: token._id.toString(),
  label: token.label,
  tokenPrefix: token.tokenPrefix,
  revoked: token.revoked,
  lastUsedAt: token.lastUsedAt,
  createdAt: token.createdAt,
});

/**
 * FR-8. Every route is scoped to `req.user` — a token belongs to the person
 * who made it, and admins do not get to read or revoke other people's tokens
 * through this surface.
 */
export function tokenRoutes(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const tokens = await ApiToken.find({ userId: req.user!._id }).sort({ createdAt: -1 }).exec();
      res.json({ tokens: tokens.map(publicToken) });
    }),
  );

  router.post(
    '/',
    validate(createSchema),
    asyncHandler(async (req, res) => {
      const { label } = req.body as z.infer<typeof createSchema>;
      const { token, tokenHash, tokenPrefix } = generateApiToken();
      const created = await ApiToken.create({
        userId: req.user!._id,
        label,
        tokenHash,
        tokenPrefix,
      });
      // The only time the plaintext is ever returned. Not recoverable later.
      res.status(201).json({ token, apiToken: publicToken(created) });
    }),
  );

  router.post(
    '/:id/revoke',
    validate(idParams, 'params'),
    asyncHandler(async (req, res) => {
      const { id } = validated<z.infer<typeof idParams>>(req, 'params');
      const token = await ApiToken.findOne({ _id: id, userId: req.user!._id }).exec();
      if (!token) throw notFound('API token not found');
      token.revoked = true;
      await token.save();
      res.json({ apiToken: publicToken(token) });
    }),
  );

  router.delete(
    '/:id',
    validate(idParams, 'params'),
    asyncHandler(async (req, res) => {
      const { id } = validated<z.infer<typeof idParams>>(req, 'params');
      const deleted = await ApiToken.findOneAndDelete({ _id: id, userId: req.user!._id }).exec();
      if (!deleted) throw notFound('API token not found');
      res.status(204).end();
    }),
  );

  return router;
}
