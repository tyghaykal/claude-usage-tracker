import { parseArgs } from 'node:util';
import { generateEncryptionKey, hashPassword } from '../crypto.js';
import { User } from '../models.js';

/**
 * FR-1 / FR-2 CLI. Talks to Mongoose directly rather than over HTTP, so an
 * admin can be created — and any password reset — even when the API container
 * is unhealthy or the bootstrap route was never exposed publicly.
 */

export interface CliResult {
  code: number;
  message: string;
}

const ok = (message: string): CliResult => ({ code: 0, message });
const fail = (message: string): CliResult => ({ code: 1, message });

export const USAGE = `
Usage: npm run cli -- <command> [options]

Commands:
  create-admin   --email <e> --name <n> --password <p>
                 Creates the first admin. Refuses once any admin exists.

  reset-password --email <e> --password <p>
                 Sets a new password for any account (FR-2: the only
                 forgot-password path there is).

  list-users     Prints every account and its role.

  generate-key   Prints a fresh SETTINGS_ENCRYPTION_KEY value.
`.trim();

const MIN_PASSWORD = 8;

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      password: { type: 'string' },
    },
  });
}

export async function createAdmin(opts: {
  email?: string;
  name?: string;
  password?: string;
}): Promise<CliResult> {
  if (!opts.email || !opts.name || !opts.password) {
    return fail('create-admin requires --email, --name and --password');
  }
  if (opts.password.length < MIN_PASSWORD) {
    return fail(`Password must be at least ${MIN_PASSWORD} characters`);
  }
  // Same live guard as the HTTP route — one source of truth for "bootstrapped".
  if ((await User.countDocuments({ role: 'admin' }).exec()) > 0) {
    return fail('An admin already exists. Use reset-password, or add users from the web UI.');
  }
  if (await User.exists({ email: opts.email.toLowerCase() })) {
    return fail(`A user with email ${opts.email} already exists`);
  }
  const user = await User.create({
    name: opts.name,
    email: opts.email,
    role: 'admin',
    passwordHash: await hashPassword(opts.password),
  });
  return ok(`Created admin ${user.email} (${user._id.toString()})`);
}

export async function resetPassword(opts: {
  email?: string;
  password?: string;
}): Promise<CliResult> {
  if (!opts.email || !opts.password) {
    return fail('reset-password requires --email and --password');
  }
  if (opts.password.length < MIN_PASSWORD) {
    return fail(`Password must be at least ${MIN_PASSWORD} characters`);
  }
  const user = await User.findOne({ email: opts.email.toLowerCase() }).exec();
  if (!user) return fail(`No user with email ${opts.email}`);
  user.passwordHash = await hashPassword(opts.password);
  await user.save();
  return ok(`Password updated for ${user.email}`);
}

export async function listUsers(): Promise<CliResult> {
  const users = await User.find().sort({ createdAt: 1 }).exec();
  if (users.length === 0) return ok('No users yet. Run create-admin first.');
  return ok(users.map((u) => `${u.role.padEnd(5)}  ${u.email}  ${u.name}`).join('\n'));
}

/** Routes an argv slice to a command. Pure apart from the DB calls it makes. */
export async function runCommand(argv: string[]): Promise<CliResult> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    // parseArgs only ever throws an Error (TypeError/ERR_PARSE_ARGS_*).
    return fail((error as Error).message);
  }

  const [command] = parsed.positionals;
  switch (command) {
    case 'create-admin':
      return createAdmin(parsed.values);
    case 'reset-password':
      return resetPassword(parsed.values);
    case 'list-users':
      return listUsers();
    case 'generate-key':
      return ok(generateEncryptionKey());
    case undefined:
      return fail(USAGE);
    default:
      return fail(`Unknown command "${command}"\n\n${USAGE}`);
  }
}

/** True for commands that need no Mongo connection. */
export function isOfflineCommand(argv: string[]): boolean {
  return argv[0] === 'generate-key';
}
