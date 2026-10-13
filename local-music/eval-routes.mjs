import { spawn } from "node:child_process";
import { openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { here, projectRoot } from "./config.mjs";
import { db } from "./db.mjs";
import { logicalTrackKey } from "./recommendation-core.mjs";
import { compactTags, loadSongTags } from "./song-tags.mjs";

// Human evaluation, served next to the music API so the review page can play the songs:
//   /review                       blind A/B scoring of scripts/run-eval.mjs results + tag spot check
//   /api/eval/latest              newest run (sides keep their A/B order; which variant is which stays server-side)
//   /api/eval/ratings|preference  per-song 0/1/2 scores and per-query A/B preference
//   /api/eval/tag-sample|tag-review   40 well-known songs and per-field ✓/✗ on their tags
db.exec(`CREATE TABLE IF NOT EXISTS eval_ratings (
  run_id TEXT NOT NULL, query_id TEXT NOT NULL, side TEXT NOT NULL, track_id INTEGER NOT NULL, score INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(run_id, query_id, side, track_id)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS eval_preferences (
  run_id TEXT NOT NULL, query_id TEXT NOT NULL, preferred TEXT NOT NULL, note TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(run_id, query_id)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS tag_reviews (
  track_id INTEGER NOT NULL, field TEXT NOT NULL, verdict TEXT NOT NULL, note TEXT, prompt_version TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(track_id, field)
)`);

const TAG_FIELDS = ["genre", "mood", "scene", "lyricTheme", "description", "language_vocal"];

function latestRun() {
  const dir = join(here, "eval-results");
  const files = readdirSync(dir).filter((name) => /^run-.*\.json$/.test(name)).sort();
  if (!files.length) return null;
  const run = JSON.parse(readFileSync(join(dir, files.at(-1)), "utf8"));
  const ratings = db.prepare("SELECT query_id, side, track_id, score FROM eval_ratings WHERE run_id=?").all(run.runId);
  const preferences = db.prepare("SELECT query_id, preferred, note FROM eval_preferences WHERE run_id=?").all(run.runId);
  return {
    runId: run.runId, createdAt: run.createdAt, ratings, preferences,
    queries: run.queries.map((query) => ({
      id: query.id, type: query.type, text: query.text, error: query.error,
      // The variant name is withheld so scoring stays blind.
      sides: query.sides && Object.fromEntries(Object.entries(query.sides).map(([side, value]) => [side, { mix: value.mix, tracks: value.tracks }])),
    })),
  };
}

// Songs you know well: tagged songs you played at least 5 times. Slots follow your own language mix
// (largest remainder), with at least one per language so every language gets checked.
function tagSample(size = 40, minPlays = 5) {
  const tags = loadSongTags();
  const plays = db.prepare(`SELECT t.id, t.title, t.artist, COUNT(e.id) AS plays FROM tracks t
    JOIN listening_events e ON e.track_id=t.id WHERE t.available=1 AND e.event_type='play' GROUP BY t.id ORDER BY plays DESC`).all()
    .filter((row) => tags.has(Number(row.id)) && row.plays >= minPlays);
  const unique = [...new Map(plays.map((row) => [logicalTrackKey(row), row])).values()];
  const byLanguage = new Map();
  for (const row of unique) {
    const language = tags.get(Number(row.id)).language || "其他";
    if (!byLanguage.has(language)) byLanguage.set(language, []);
    byLanguage.get(language).push(row);
  }
  const quotas = new Map([...byLanguage].map(([language, list]) => [language, Math.max(1, Math.floor((list.length / unique.length) * size))]));
  let left = size - [...quotas.values()].reduce((sum, value) => sum + value, 0);
  for (const [language] of [...byLanguage].sort((a, b) => b[1].length - a[1].length)) { if (left <= 0) break; quotas.set(language, quotas.get(language) + 1); left -= 1; }
  const picked = [...byLanguage].flatMap(([language, list]) => list.slice(0, quotas.get(language))).slice(0, size);
  const reviews = db.prepare("SELECT track_id, field, verdict, note FROM tag_reviews").all();
  return { fields: TAG_FIELDS, reviews, songs: picked.map((row) => ({ id: row.id, title: row.title, artist: row.artist, plays: row.plays, tags: tags.get(Number(row.id)) })) };
}

// Favorites live in the built-in "我喜欢的音乐" playlist (id 1); matched by logical song so any copy counts.
function favoriteTrackIds() {
  return db.prepare(`SELECT t2.id FROM user_playlist_items i JOIN tracks t ON t.id=i.track_id
    JOIN tracks t2 ON lower(trim(t2.title))=lower(trim(t.title)) AND lower(trim(t2.artist))=lower(trim(t.artist))
    WHERE i.playlist_id=1`).all().map((row) => Number(row.id));
}

// A new evaluation round runs scripts/run-eval.mjs in the background (it calls this server's own
// recommendation API); the review page picks up the new run when it finishes.
let evalRun = null;
function startEvalRun() {
  if (evalRun?.running) return evalRun;
  const logPath = join(projectRoot, "logs", "eval-run.log");
  const child = spawn(process.execPath, ["scripts/run-eval.mjs"], { cwd: projectRoot, stdio: ["ignore", openSync(logPath, "w"), openSync(logPath, "a")] });
  evalRun = { running: true, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, logPath };
  child.on("exit", (code) => Object.assign(evalRun, { running: false, finishedAt: new Date().toISOString(), exitCode: code }));
  return evalRun;
}
function evalRunStatus() {
  if (!evalRun) return { running: false };
  let progress = "";
  try { progress = readFileSync(evalRun.logPath, "utf8").trim().split("\n").filter((line) => /^[✓✗]/.test(line)).slice(-1)[0] || ""; } catch { /* no log yet */ }
  let done = 0;
  try { done = readFileSync(evalRun.logPath, "utf8").split("\n").filter((line) => /^[✓✗]/.test(line)).length; } catch { /* no log yet */ }
  return { ...evalRun, done, progress };
}

export async function handleEvalRoute(request, response, url, { sendJson, readJson }) {
  if (request.method === "POST" && url.pathname === "/api/eval/run") { sendJson(response, 200, startEvalRun()); return true; }
  if (request.method === "GET" && url.pathname === "/api/eval/run") { sendJson(response, 200, evalRunStatus()); return true; }
  if (request.method === "GET" && url.pathname === "/api/eval/favorites") { sendJson(response, 200, { ids: favoriteTrackIds() }); return true; }
  // Full v2 tags of one song, for the library view (loaded on demand).
  const tagMatch = url.pathname.match(/^\/api\/tracks\/(\d+)\/tags$/);
  if (request.method === "GET" && tagMatch) {
    const row = db.prepare(`SELECT v.*, f.bpm, f.bpm_perceived, f.loudness_lufs FROM song_tags_v2 v
      LEFT JOIN track_audio_features f ON f.track_id=v.track_id WHERE v.track_id=?`).get(Number(tagMatch[1]));
    sendJson(response, 200, row ? { ...compactTags(row), lyricContrast: row.lyric_contrast || "", promptVersion: row.prompt_version } : { missing: true });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/review") {
    const html = readFileSync(join(here, "review.html"));
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": html.length });
    response.end(html);
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/eval/latest") { sendJson(response, 200, latestRun() || { queries: [] }); return true; }
  if (request.method === "POST" && url.pathname === "/api/eval/ratings") {
    const body = await readJson(request);
    const score = Number(body.score);
    if (![0, 1, 2].includes(score) || !["A", "B"].includes(body.side)) { sendJson(response, 400, { error: "score 0/1/2, side A/B" }); return true; }
    db.prepare(`INSERT INTO eval_ratings (run_id, query_id, side, track_id, score) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id, query_id, side, track_id) DO UPDATE SET score=excluded.score, updated_at=CURRENT_TIMESTAMP`)
      .run(String(body.runId), String(body.queryId), body.side, Number(body.trackId), score);
    sendJson(response, 200, { ok: true }); return true;
  }
  // Choice and note are saved independently: a note typed before (or without) picking a side is kept.
  if (request.method === "POST" && url.pathname === "/api/eval/preference") {
    const body = await readJson(request);
    if (body.preferred !== undefined && !["A", "B", "same", ""].includes(body.preferred)) { sendJson(response, 400, { error: "preferred A/B/same" }); return true; }
    const key = [String(body.runId), String(body.queryId)];
    const current = db.prepare("SELECT preferred, note FROM eval_preferences WHERE run_id=? AND query_id=?").get(...key) || { preferred: "", note: "" };
    db.prepare(`INSERT INTO eval_preferences (run_id, query_id, preferred, note) VALUES (?, ?, ?, ?)
      ON CONFLICT(run_id, query_id) DO UPDATE SET preferred=excluded.preferred, note=excluded.note, updated_at=CURRENT_TIMESTAMP`)
      .run(...key, body.preferred ?? current.preferred, body.note !== undefined ? String(body.note).slice(0, 1000) : current.note);
    sendJson(response, 200, { ok: true }); return true;
  }
  if (request.method === "GET" && url.pathname === "/api/eval/tag-sample") { sendJson(response, 200, tagSample()); return true; }
  if (request.method === "POST" && url.pathname === "/api/eval/tag-review") {
    const body = await readJson(request);
    if (!TAG_FIELDS.includes(body.field) || (body.verdict !== undefined && !["ok", "wrong", "made_up", ""].includes(body.verdict))) { sendJson(response, 400, { error: "bad field/verdict" }); return true; }
    const key = [Number(body.trackId), body.field];
    const current = db.prepare("SELECT verdict, note FROM tag_reviews WHERE track_id=? AND field=?").get(...key) || { verdict: "", note: "" };
    const version = db.prepare("SELECT prompt_version FROM song_tags_v2 WHERE track_id=?").get(key[0])?.prompt_version || null;
    db.prepare(`INSERT INTO tag_reviews (track_id, field, verdict, note, prompt_version) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(track_id, field) DO UPDATE SET verdict=excluded.verdict, note=excluded.note, prompt_version=excluded.prompt_version, updated_at=CURRENT_TIMESTAMP`)
      .run(...key, body.verdict ?? current.verdict, body.note !== undefined ? String(body.note).slice(0, 1000) : current.note, version);
    sendJson(response, 200, { ok: true }); return true;
  }
  return false;
}
