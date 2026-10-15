// Move the database between the cloud (source of truth) and this machine, for tagging new songs locally.
//   node deploy/db-sync.mjs pull   cloud → local (local copy is backed up first; records the cloud's state)
//   node deploy/db-sync.mjs push   local → cloud (pauses the cloud API ~1 min; refuses if the cloud
//                                  got new plays/feedback/etc. since the pull, so nothing is overwritten)
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const env = Object.fromEntries(readFileSync(join(root, ".env.local"), "utf8").split("\n").filter((line) => /^[A-Z_]+=/.test(line)).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
const host = process.env.DEPLOY_HOST || env.DEPLOY_HOST;
if (!host) throw new Error("Set DEPLOY_HOST=admin@<server-ip> in .env.local");
const key = join(process.env.HOME, ".ssh", "moment_aliyun_rsa");
const remoteDb = "/srv/moment/data/music-library.sqlite";
const localDb = join(root, "local-music", "music-library.sqlite");
const stateFile = join(root, "local-music", ".db-sync.json");
const ssh = (command) => execFileSync("ssh", ["-i", key, host, command], { encoding: "utf8" });
const rsync = (from, to) => execFileSync("rsync", ["-az", "-e", `ssh -i ${key}`, from, to], { stdio: "inherit" });
// Tables the app writes while you use it; their row counts and newest ids identify the cloud's state.
const userTables = ["listening_events", "feedback_entries", "feedback", "song_comments", "user_playlist_items", "user_playlists", "recommendation_events", "request_logs", "song_blocks", "preference_statements", "play_events"];
const fingerprint = () => ssh(`sqlite3 -readonly ${remoteDb} "${userTables.map((table) => `SELECT '${table}', COUNT(*), COALESCE(MAX(rowid),0) FROM ${table}`).join(" UNION ALL ")};"`).trim();
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

const mode = process.argv[2];
if (mode === "pull") {
  ssh(`sqlite3 ${remoteDb} ".backup /tmp/moment-pull.sqlite"`);
  const state = { pulledAt: new Date().toISOString(), fingerprint: fingerprint() };
  mkdirSync(join(root, "local-music", "backups"), { recursive: true });
  if (existsSync(localDb)) copyFileSync(localDb, join(root, "local-music", "backups", `before-pull-${stamp()}.sqlite`));
  rsync(`${host}:/tmp/moment-pull.sqlite`, `${localDb}.incoming`);
  for (const suffix of ["-wal", "-shm"]) rmSync(`${localDb}${suffix}`, { force: true });
  renameSync(`${localDb}.incoming`, localDb);
  ssh("rm -f /tmp/moment-pull.sqlite");
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  console.log("Pulled the cloud database. Stop/restart the local server before scanning or tagging.");
} else if (mode === "push") {
  if (!existsSync(stateFile)) throw new Error("Run `pull` first, so the push can check nothing changed in the cloud meanwhile.");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const snapshot = `${localDb}.push`;
  rmSync(snapshot, { force: true });
  execFileSync("sqlite3", [localDb, `VACUUM INTO '${snapshot}'`]);
  rsync(snapshot, `${host}:/srv/moment/data/incoming.sqlite`);
  rmSync(snapshot);
  ssh("sudo systemctl stop moment-api");
  try {
    if (fingerprint() !== state.fingerprint) throw new Error(`The cloud has new activity since the pull at ${state.pulledAt}; pull again, redo the local work, then push.`);
    ssh(`cd /srv/moment/data && mv music-library.sqlite before-push-${stamp()}.sqlite && rm -f music-library.sqlite-wal music-library.sqlite-shm && mv incoming.sqlite music-library.sqlite && ls -t before-push-*.sqlite | tail -n +6 | xargs -r rm --`);
  } finally {
    ssh("rm -f /srv/moment/data/incoming.sqlite; sudo systemctl start moment-api");
  }
  rmSync(stateFile);
  console.log("Pushed. The cloud now serves the local database (previous one kept as before-push-*.sqlite).");
} else {
  console.log("usage: node deploy/db-sync.mjs pull|push");
}
