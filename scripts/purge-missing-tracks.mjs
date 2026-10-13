import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { databasePath, here } from "../local-music/config.mjs";
import { db } from "../local-music/db.mjs";
import { remapUnavailableTracks } from "../local-music/remap.mjs";

// Manual clean-up after the library was rebuilt (never automatic: an unplugged drive also marks every
// file unavailable). Backs up the database, re-points references to the current library, drops the
// abandoned v1 profile / calibration data, then deletes old track rows nothing refers to any more.
//   node scripts/purge-missing-tracks.mjs            dry run: show what would go
//   node scripts/purge-missing-tracks.mjs --apply
const apply = process.argv.includes("--apply");
const remapped = remapUnavailableTracks();
console.log("re-pointed:", JSON.stringify(remapped.updated));

const v1Tables = ["song_experience_profiles", "similarity_annotations", "similarity_calibration_tracks", "similarity_comparisons"]
  .filter((table) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
// Tables whose rows describe the track itself go with it; every other table with a track_id keeps it alive.
const derived = new Set(["track_embeddings", "song_tags_v2", "track_audio_features", ...v1Tables]);
const referencing = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name)
  .filter((table) => !derived.has(table) && table !== "external_songs" && db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === "track_id"));
const stillUsed = new Set(referencing.flatMap((table) => db.prepare(`SELECT DISTINCT x.track_id AS id FROM ${table} x JOIN tracks t ON t.id=x.track_id WHERE t.available=0`).all().map((row) => Number(row.id))));
const removable = db.prepare("SELECT id FROM tracks WHERE available=0").all().map((row) => Number(row.id)).filter((id) => !stillUsed.has(id));
console.log(`v1 rows: ${v1Tables.map((table) => `${table} ${db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n}`).join(", ")}`);
console.log(`old track rows: ${removable.length} removable, ${stillUsed.size} kept (still in playlists / history / feedback)`);
if (!apply) { console.log("dry run — add --apply to delete"); process.exit(0); }

const backupDir = join(here, "backups");
mkdirSync(backupDir, { recursive: true });
db.exec("PRAGMA wal_checkpoint(FULL)");
const backup = join(backupDir, `music-library-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
copyFileSync(databasePath, backup);
console.log(`backup: ${backup}`);
db.exec("BEGIN");
try {
  for (const table of v1Tables) db.exec(`DELETE FROM ${table}`);
  db.prepare("UPDATE external_songs SET track_id=NULL, match_method=NULL WHERE track_id IN (SELECT id FROM tracks WHERE available=0)").run();
  const remove = db.prepare("DELETE FROM tracks WHERE id=?");
  for (const id of removable) {
    for (const table of derived) if (!v1Tables.includes(table)) db.prepare(`DELETE FROM ${table} WHERE track_id=?`).run(id);
    remove.run(id);
  }
  db.exec("COMMIT");
} catch (error) { db.exec("ROLLBACK"); throw error; }
db.exec("VACUUM");
console.log(`deleted ${removable.length} old track rows and the v1 data`);
