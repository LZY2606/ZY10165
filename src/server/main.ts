import { join } from 'node:path';
import { startServer } from './server.js';

function parseArg(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1]) return args[index + 1]!;
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.split('=').slice(1).join('=');
  return fallback;
}

const host = parseArg('host', '127.0.0.1');
const port = Number(parseArg('port', '5505'));
const dbPath = parseArg('db', join(process.cwd(), 'data', 'pulse-clock-visa.sqlite'));

const running = await startServer({ host, port, dbPath });
console.log(`脉钟签证已启动：${running.url}`);
console.log(`SQLite：${dbPath}`);

const shutdown = async () => {
  await running.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
