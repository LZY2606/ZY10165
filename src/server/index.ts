import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { createApp } from "./api.js";

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const host = arg("--host", "127.0.0.1");
const port = Number(arg("--port", "5505"));
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "../../data");
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.PCV_DB ?? join(dataDir, "pulse-clock-visa.sqlite");
const publicDir = join(here, "../../public");

const db = openDb(dbPath);
const server = createApp(db, publicDir);
server.listen(port, host, () => {
  console.log(`脉钟签证 listening on http://${host}:${port} (db: ${dbPath})`);
});
