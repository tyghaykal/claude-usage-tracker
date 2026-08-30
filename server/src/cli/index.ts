import { loadConfig } from '../config.js';
import { connectDb, disconnectDb } from '../db.js';
import { isOfflineCommand, runCommand } from './commands.js';

const argv = process.argv.slice(2);
const offline = isOfflineCommand(argv);

if (!offline) {
  await connectDb(loadConfig().MONGO_URI);
}

const { code, message } = await runCommand(argv);

if (!offline) await disconnectDb();

(code === 0 ? console.log : console.error)(message);
process.exit(code);
