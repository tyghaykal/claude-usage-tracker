import { describe, expect, it } from 'vitest';
import { verifyPassword } from '../src/crypto.js';
import { isOfflineCommand, runCommand, USAGE } from '../src/cli/commands.js';
import { User } from '../src/models.js';
import { makeUser } from './helpers.js';

describe('cli create-admin', () => {
  const args = ['create-admin', '--email', 'root@example.com', '--name', 'Root', '--password', 'password123'];

  it('creates the first admin', async () => {
    const result = await runCommand(args);
    expect(result.code).toBe(0);
    expect(result.message).toMatch(/Created admin root@example.com/);

    const user = await User.findOne({ email: 'root@example.com' }).exec();
    expect(user!.role).toBe('admin');
    expect(await verifyPassword('password123', user!.passwordHash)).toBe(true);
  });

  it('refuses once any admin exists — same guard as the HTTP route', async () => {
    await makeUser({ role: 'admin' });
    const result = await runCommand(args);
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/already exists/);
    expect(await User.countDocuments({ email: 'root@example.com' })).toBe(0);
  });

  it('is still allowed when only non-admin users exist', async () => {
    await makeUser({ role: 'user' });
    expect((await runCommand(args)).code).toBe(0);
  });

  it('refuses an email already taken by a non-admin', async () => {
    await makeUser({ email: 'root@example.com', role: 'user' });
    const result = await runCommand(args);
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/already exists/);
  });

  it('requires every flag', async () => {
    for (const partial of [
      ['create-admin'],
      ['create-admin', '--email', 'a@b.co'],
      ['create-admin', '--email', 'a@b.co', '--name', 'A'],
    ]) {
      const result = await runCommand(partial);
      expect(result.code).toBe(1);
      expect(result.message).toMatch(/requires --email, --name and --password/);
    }
  });

  it('rejects a short password', async () => {
    const result = await runCommand([
      'create-admin',
      '--email',
      'a@b.co',
      '--name',
      'A',
      '--password',
      'short',
    ]);
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/at least 8 characters/);
  });
});

describe('cli reset-password', () => {
  it('sets a new password on any account — the only forgot-password path', async () => {
    const user = await makeUser({ email: 'admin@example.com', role: 'admin' });
    const result = await runCommand([
      'reset-password',
      '--email',
      'admin@example.com',
      '--password',
      'recovered-1234',
    ]);

    expect(result.code).toBe(0);
    const updated = await User.findById(user._id).exec();
    expect(await verifyPassword('recovered-1234', updated!.passwordHash)).toBe(true);
  });

  it('matches the email case-insensitively', async () => {
    await makeUser({ email: 'mixed@example.com' });
    const result = await runCommand([
      'reset-password',
      '--email',
      'MIXED@example.com',
      '--password',
      'recovered-1234',
    ]);
    expect(result.code).toBe(0);
  });

  it('fails on an unknown account', async () => {
    const result = await runCommand([
      'reset-password',
      '--email',
      'ghost@example.com',
      '--password',
      'recovered-1234',
    ]);
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/No user with email/);
  });

  it('requires both flags and a long enough password', async () => {
    expect((await runCommand(['reset-password'])).code).toBe(1);
    expect((await runCommand(['reset-password', '--email', 'a@b.co'])).code).toBe(1);
    const short = await runCommand([
      'reset-password',
      '--email',
      'a@b.co',
      '--password',
      'short',
    ]);
    expect(short.message).toMatch(/at least 8 characters/);
  });
});

describe('cli list-users', () => {
  it('says so when there are no users', async () => {
    const result = await runCommand(['list-users']);
    expect(result.code).toBe(0);
    expect(result.message).toMatch(/No users yet/);
  });

  it('lists each account with its role', async () => {
    await makeUser({ email: 'a@example.com', name: 'Ada', role: 'admin' });
    await makeUser({ email: 'b@example.com', name: 'Bob', role: 'user' });

    const result = await runCommand(['list-users']);
    expect(result.message).toContain('admin  a@example.com  Ada');
    expect(result.message).toContain('user   b@example.com  Bob');
  });
});

describe('cli generate-key', () => {
  it('prints a valid encryption key and needs no database', async () => {
    const result = await runCommand(['generate-key']);
    expect(result.code).toBe(0);
    expect(result.message).toMatch(/^[0-9a-f]{64}$/);
    expect(isOfflineCommand(['generate-key'])).toBe(true);
    expect(isOfflineCommand(['list-users'])).toBe(false);
  });
});

describe('cli argument handling', () => {
  it('prints usage with no command', async () => {
    const result = await runCommand([]);
    expect(result.code).toBe(1);
    expect(result.message).toBe(USAGE);
  });

  it('rejects an unknown command', async () => {
    const result = await runCommand(['frobnicate']);
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/Unknown command "frobnicate"/);
  });

  it('reports an unknown flag rather than ignoring it', async () => {
    const result = await runCommand(['list-users', '--wat']);
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/--wat/);
  });
});
