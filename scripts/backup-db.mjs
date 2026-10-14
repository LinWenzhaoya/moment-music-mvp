// Daily snapshot of the live database into BACKUP_DIR (on the server: the OSS mount), keeping the newest 14.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { databasePath } from "../local-music/config.mjs";

const dir = process.env.BACKUP_DIR || join(process.cwd(), "local-music", "backups");
const keep = Number(process.env.BACKUP_KEEP || 14);
mkdirSync(dir, { recursive: true });
const target = join(dir, `moment-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
// VACUUM INTO writes a consistent copy even while the server is using the database.
new DatabaseSync(databasePath).exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
const old = readdirSync(dir).filter((name) => /^moment-.*\.sqlite$/.test(name)).sort().slice(0, -keep);
for (const name of old) rmSync(join(dir, name));
console.log(`backup ${target}; removed ${old.length} old`);
