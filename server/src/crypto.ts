import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export interface GeneratedApiToken {
  /** Shown to the user exactly once, at creation. Never stored. */
  token: string;
  /** What we persist and look up by. */
  tokenHash: string;
  /** First 8 chars, so the UI can identify a token it can no longer show. */
  tokenPrefix: string;
}

/**
 * GitHub-PAT shape: a random secret shown once, stored only as a digest.
 *
 * sha256 (not bcrypt) is deliberate — this value is verified on every single
 * ingestion POST, so it must be an indexed equality lookup. It is safe here
 * because the secret is 32 bytes of CSPRNG output, not a user-chosen password:
 * there is no dictionary to attack, so the slow-hash property buys nothing.
 */
export function generateApiToken(): GeneratedApiToken {
  const token = `cur_${randomBytes(32).toString('base64url')}`;
  return {
    token,
    tokenHash: hashApiToken(token),
    tokenPrefix: token.slice(0, 12),
  };
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const IV_BYTES = 12;

/**
 * AES-256-GCM for provider API keys (FRD §8). These must be *decryptable* —
 * we have to present the real key to the upstream provider — so unlike
 * passwords and API tokens they are encrypted, not hashed. The key lives in
 * `SETTINGS_ENCRYPTION_KEY`, never in Mongo.
 *
 * Format: `iv.ciphertext.authTag`, all base64url.
 */
export function encryptSecret(plain: string, keyHex: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, ciphertext, cipher.getAuthTag()]
    .map((buf) => buf.toString('base64url'))
    .join('.');
}

export function decryptSecret(payload: string, keyHex: string): string {
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('Malformed encrypted secret');
  const [iv, ciphertext, authTag] = parts.map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv!);
  decipher.setAuthTag(authTag!);
  return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString('utf8');
}

/** Convenience for `.env.example` / first-run docs. */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString('hex');
}
