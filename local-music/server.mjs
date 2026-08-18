import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { parseFile } from "music-metadata";
import { classifyProfileEvidence, maximalTitleMatches, nearestTitleAfterArtist, normalizeMatch, sanitizeHardStyles } from "./recommendation-core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
try { process.loadEnvFile(join(projectRoot, ".env.local")); } catch { /* optional local configuration */ }
const libraryRoot = resolve(process.env.MUSIC_LIBRARY_PATH || join(projectRoot, "..", "music-repo"));
const databasePath = resolve(process.env.MUSIC_DATABASE_PATH || join(here, "music-library.sqlite"));
const port = Number(process.env.MUSIC_SERVER_PORT || 3001);
const deepseekBaseUrl = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const deepseekModel = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const deepseekApiKey = process.env.DEEPSEEK_API_KEY || "";
const supportedExtensions = new Set([".mp3", ".flac", ".m4a", ".aac", ".wav", ".ogg"]);

const db = new DatabaseSync(databasePath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec(`CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  artist TEXT NOT NULL, album TEXT, genre TEXT, year INTEGER, duration REAL,
  bitrate INTEGER, sample_rate INTEGER, file_size INTEGER NOT NULL, folder TEXT NOT NULL,
  modified_at INTEGER NOT NULL, play_count INTEGER NOT NULL DEFAULT 0,
  last_played_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
const trackColumns = new Set(db.prepare("PRAGMA table_info(tracks)").all().map((column) => column.name));
if (!trackColumns.has("available")) db.exec("ALTER TABLE tracks ADD COLUMN available INTEGER NOT NULL DEFAULT 1");
db.exec(`CREATE TABLE IF NOT EXISTS play_events (
  id INTEGER PRIMARY KEY, track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, played_seconds REAL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY, track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  feedback_type TEXT NOT NULL, reason TEXT, session_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY, scope TEXT NOT NULL, content TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5, evidence_count INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS preference_memories (
  id INTEGER PRIMARY KEY, memory_key TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 0, evidence_count INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'feedback',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS recommendation_events (
  id INTEGER PRIMARY KEY, request_text TEXT NOT NULL, intent_json TEXT NOT NULL,
  playlist_json TEXT NOT NULL, model TEXT NOT NULL, total_tokens INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY,
  request_text TEXT NOT NULL,
  requested_count INTEGER NOT NULL DEFAULT 10,
  mix_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  recommendation_id INTEGER UNIQUE REFERENCES recommendation_events(id) ON DELETE SET NULL,
  error_text TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS preference_statements (
  id INTEGER PRIMARY KEY, memory_key TEXT NOT NULL UNIQUE, statement TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'general', polarity INTEGER NOT NULL DEFAULT 1,
  weight INTEGER NOT NULL DEFAULT 1, confidence REAL NOT NULL DEFAULT 0.7,
  evidence_json TEXT NOT NULL DEFAULT '[]', reason TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'feedback', active INTEGER NOT NULL DEFAULT 1,
  evidence_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
const preferenceStatementColumns = new Set(db.prepare("PRAGMA table_info(preference_statements)").all().map((column) => column.name));
if (!preferenceStatementColumns.has("category")) db.exec("ALTER TABLE preference_statements ADD COLUMN category TEXT NOT NULL DEFAULT 'taste'");
if (!preferenceStatementColumns.has("status")) db.exec("ALTER TABLE preference_statements ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'");
db.exec(`UPDATE preference_statements SET category=CASE
  WHEN memory_key LIKE 'artist:%' THEN 'anchor'
  WHEN polarity < 0 THEN 'boundary'
  WHEN scope != 'general' THEN 'context'
  WHEN statement LIKE '%《%' THEN 'reference'
  ELSE category END`);
db.exec(`CREATE TABLE IF NOT EXISTS feedback_entries (
  id INTEGER PRIMARY KEY, track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL, explanation TEXT NOT NULL, scope TEXT NOT NULL,
  parsed_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS recommendation_items (
  id INTEGER PRIMARY KEY, recommendation_id INTEGER NOT NULL REFERENCES recommendation_events(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, source_kind TEXT NOT NULL, reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]'
)`);
db.exec(`CREATE TABLE IF NOT EXISTS user_playlists (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'custom',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS user_playlist_items (
  id INTEGER PRIMARY KEY, playlist_id INTEGER NOT NULL REFERENCES user_playlists(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(playlist_id, track_id)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS similarity_calibration_tracks (
  track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft',
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS similarity_annotations (
  id INTEGER PRIMARY KEY,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  dimension_key TEXT NOT NULL,
  observation TEXT NOT NULL DEFAULT '',
  boundary TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(track_id, dimension_key)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS song_experience_profiles (
  track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  style_json TEXT NOT NULL DEFAULT '[]',
  felt_json TEXT NOT NULL DEFAULT '[]',
  energy_json TEXT NOT NULL DEFAULT '[]',
  sound_json TEXT NOT NULL DEFAULT '[]',
  identity_text TEXT NOT NULL DEFAULT '',
  avoid_text TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'codex_curated',
  review_status TEXT NOT NULL DEFAULT 'needs_user_review',
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS similarity_comparisons (
  id INTEGER PRIMARY KEY,
  left_track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  right_track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  dimensions_json TEXT NOT NULL DEFAULT '[]',
  similarity_text TEXT NOT NULL,
  difference_text TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
const similarityComparisonColumns = new Set(db.prepare("PRAGMA table_info(similarity_comparisons)").all().map((column) => column.name));
if (!similarityComparisonColumns.has("source")) db.exec("ALTER TABLE similarity_comparisons ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
if (!similarityComparisonColumns.has("review_status")) db.exec("ALTER TABLE similarity_comparisons ADD COLUMN review_status TEXT NOT NULL DEFAULT 'draft'");
db.prepare("INSERT OR IGNORE INTO user_playlists (id, name, kind) VALUES (1, '我喜欢的音乐', 'favorites')").run();
const recommendationColumns = new Set(db.prepare("PRAGMA table_info(recommendation_events)").all().map((column) => column.name));
if (!recommendationColumns.has("plan_json")) db.exec("ALTER TABLE recommendation_events ADD COLUMN plan_json TEXT");
if (!recommendationColumns.has("seed_json")) db.exec("ALTER TABLE recommendation_events ADD COLUMN seed_json TEXT");
if (!recommendationColumns.has("title")) db.exec("ALTER TABLE recommendation_events ADD COLUMN title TEXT");
if (!recommendationColumns.has("summary")) db.exec("ALTER TABLE recommendation_events ADD COLUMN summary TEXT");
db.exec(`UPDATE recommendation_events SET
  title=COALESCE(NULLIF(title, ''), '历史歌单'),
  summary=COALESCE(NULLIF(summary, ''), json_extract(intent_json, '$.summary'), request_text)`);
db.exec(`INSERT OR IGNORE INTO request_logs
  (request_text, requested_count, mix_json, status, recommendation_id, created_at, completed_at)
  SELECT request_text, json_array_length(playlist_json), '{}', 'succeeded', id, created_at, created_at
  FROM recommendation_events`);
db.prepare(`INSERT OR IGNORE INTO preference_statements
  (memory_key, statement, scope, polarity, weight, confidence, evidence_json, reason, source, evidence_count, created_at, updated_at)
  SELECT memory_key,
    CASE WHEN source='explicit' AND memory_key LIKE 'artist:%' THEN '喜欢歌手 ' || label
         WHEN weight < 0 THEN '倾向避开 ' || label ELSE '偏好 ' || label END,
    'general', CASE WHEN weight < 0 THEN -1 ELSE 1 END, ABS(weight),
    CASE WHEN source='explicit' THEN 1.0 ELSE 0.65 END, '[]', reason, source,
    evidence_count, created_at, updated_at FROM preference_memories`).run();
db.exec("CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist)");
db.exec("CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title)");
db.exec("CREATE INDEX IF NOT EXISTS idx_tracks_folder ON tracks(folder)");
db.exec("CREATE INDEX IF NOT EXISTS idx_tracks_last_played ON tracks(last_played_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_play_events_track_created ON play_events(track_id, created_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_feedback_track_created ON feedback(track_id, created_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_recommendation_events_created ON recommendation_events(created_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs(created_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_preference_statements_active_weight ON preference_statements(active, weight)");
db.exec("CREATE INDEX IF NOT EXISTS idx_feedback_entries_created ON feedback_entries(created_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_recommendation_items_recommendation ON recommendation_items(recommendation_id, position)");
for (const event of db.prepare("SELECT id, playlist_json FROM recommendation_events").all()) {
  const validIds = new Set(safeJson(event.playlist_json, []).map((id) => Number(String(id).replace("local-", ""))).filter(Number.isFinite));
  for (const item of db.prepare("SELECT id, track_id FROM recommendation_items WHERE recommendation_id=?").all(event.id)) {
    if (!validIds.has(Number(item.track_id))) db.prepare("DELETE FROM recommendation_items WHERE id=?").run(item.id);
  }
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_recommendation_items_position_unique ON recommendation_items(recommendation_id, position)");
db.exec("CREATE INDEX IF NOT EXISTS idx_user_playlist_items_playlist ON user_playlist_items(playlist_id, added_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_user_playlist_items_track ON user_playlist_items(track_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_similarity_annotations_track ON similarity_annotations(track_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_similarity_comparisons_tracks ON similarity_comparisons(left_track_id, right_track_id)");
db.exec("PRAGMA optimize");

const upsertTrack = db.prepare(`INSERT INTO tracks (
  relative_path, title, artist, album, genre, year, duration, bitrate,
  sample_rate, file_size, folder, modified_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
ON CONFLICT(relative_path) DO UPDATE SET
  title=excluded.title, artist=excluded.artist, album=excluded.album,
  genre=excluded.genre, year=excluded.year, duration=excluded.duration,
  bitrate=excluded.bitrate, sample_rate=excluded.sample_rate,
  file_size=excluded.file_size, folder=excluded.folder,
  modified_at=excluded.modified_at, available=1, updated_at=CURRENT_TIMESTAMP`);

function fallbackIdentity(filename) {
  const stem = filename.slice(0, -extname(filename).length);
  if (stem.includes(" - ")) {
    const index = stem.lastIndexOf(" - ");
    return { title: stem.slice(0, index).trim(), artist: stem.slice(index + 3).trim().replaceAll(" _ ", " / ") };
  }
  const index = stem.indexOf("-");
  if (index > 0) return { artist: stem.slice(0, index).trim(), title: stem.slice(index + 1).trim() };
  return { title: stem.trim(), artist: "未知艺人" };
}

async function* walk(directory) {
  const entries = await opendir(directory);
  for await (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && supportedExtensions.has(extname(entry.name).toLowerCase())) yield path;
  }
}

let scanPromise = null;
let scanState = { running: false, total: 0, processed: 0, failed: 0, startedAt: null, finishedAt: null };

async function scanLibrary() {
  if (scanPromise) return scanPromise;
  scanPromise = (async () => {
    scanState = { running: true, total: 0, processed: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null };
    const files = [];
    for await (const file of walk(libraryRoot)) files.push(file);
    scanState.total = files.length;
    for (const path of files) {
      try {
        const fileStat = await stat(path);
        const relativePath = relative(libraryRoot, path);
        const existing = db.prepare("SELECT modified_at FROM tracks WHERE relative_path = ?").get(relativePath);
        if (existing?.modified_at === Math.trunc(fileStat.mtimeMs)) {
          scanState.processed += 1;
          continue;
        }
        const metadata = await parseFile(path, { duration: true, skipCovers: true });
        const fallback = fallbackIdentity(path.split(sep).at(-1));
        const common = metadata.common;
        const format = metadata.format;
        upsertTrack.run(
          relativePath, common.title?.trim() || fallback.title,
          common.artist?.trim() || fallback.artist, common.album?.trim() || null,
          common.genre?.join(" / ") || null, common.year || null,
          format.duration || null, format.bitrate ? Math.round(format.bitrate) : null,
          format.sampleRate || null, fileStat.size, relativePath.split(sep)[0] || "未分类",
          Math.trunc(fileStat.mtimeMs),
        );
      } catch (error) {
        scanState.failed += 1;
        console.error("scan failed", path, error instanceof Error ? error.message : error);
      }
      scanState.processed += 1;
    }
    const livePaths = new Set(files.map((path) => relative(libraryRoot, path)));
    const setAvailability = db.prepare("UPDATE tracks SET available=? WHERE relative_path=?");
    db.exec("BEGIN");
    try {
      for (const row of db.prepare("SELECT relative_path FROM tracks").all()) setAvailability.run(livePaths.has(row.relative_path) ? 1 : 0, row.relative_path);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    db.exec("PRAGMA optimize");
    scanState = { ...scanState, running: false, finishedAt: new Date().toISOString() };
    return scanState;
  })().finally(() => { scanPromise = null; });
  return scanPromise;
}

function serializeTrack(row) {
  const bitrateKbps = row.bitrate ? Math.round(row.bitrate / 1000) : null;
  const tags = [row.genre, row.folder, bitrateKbps ? `${bitrateKbps}kbps` : null].filter(Boolean);
  const forgotten = row.last_played_at && Date.now() - new Date(row.last_played_at).getTime() > 1000 * 60 * 60 * 24 * 90;
  const kind = !row.play_count ? "library" : forgotten ? "forgotten" : "familiar";
  return {
    id: `local-${row.id}`, title: row.title, artist: row.artist,
    album: row.album, genre: row.genre || row.folder,
    kind, energy: 60, vocal: 55,
    tags, instruments: [], color: ["green", "orange", "violet", "blue", "gold", "cyan"][row.id % 6],
    duration: row.duration, bitrate: bitrateKbps, folder: row.folder,
    playCount: row.play_count, lastPlayedAt: row.last_played_at,
    audioUrl: `http://localhost:${port}/api/tracks/${row.id}/audio`,
  };
}

function corsHeaders() {
  return { "Access-Control-Allow-Origin": "http://localhost:3000", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS" };
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function memoryRows() {
  return db.prepare(`SELECT id, memory_key, statement AS label, statement, scope,
    polarity, polarity * weight AS weight, confidence, evidence_json,
    evidence_count, reason, source, category, status, updated_at
    FROM preference_statements WHERE active=1
    ORDER BY CASE status WHEN 'pending' THEN 1 ELSE 0 END, weight DESC, confidence DESC, updated_at DESC`).all();
}

function requestLogRows(limit = 20) {
  return db.prepare(`SELECT l.id, l.request_text, l.requested_count, l.status,
    l.recommendation_id, l.error_text, l.created_at, l.completed_at,
    e.title, e.summary, e.intent_json
    FROM request_logs l LEFT JOIN recommendation_events e ON e.id=l.recommendation_id
    ORDER BY l.id DESC LIMIT ?`).all(limit).map((row) => ({
      id: row.id, request: row.request_text, requestedCount: row.requested_count,
      status: row.status, recommendationId: row.recommendation_id,
      error: row.error_text, createdAt: row.created_at, completedAt: row.completed_at,
      title: row.title, summary: row.summary,
      intent: safeJson(row.intent_json, null),
    }));
}

function safeJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function logicalTrackKey(row) {
  return `${String(row.artist || "").trim().toLowerCase()}\u0000${String(row.title || "").trim().toLowerCase()}`;
}

function dedupeTrackRows(rows) {
  const songs = new Map();
  for (const row of rows) if (!songs.has(logicalTrackKey(row))) songs.set(logicalTrackKey(row), row);
  return [...songs.values()];
}

function playlistRows(limit = 50) {
  const events = db.prepare(`SELECT id, request_text, intent_json, playlist_json, model,
    total_tokens, created_at, plan_json, seed_json, title, summary
    FROM recommendation_events ORDER BY id DESC LIMIT ?`).all(limit);
  const itemQuery = db.prepare(`SELECT ri.position, ri.reason, ri.evidence_json, t.*
    FROM recommendation_items ri JOIN tracks t ON t.id=ri.track_id
    WHERE ri.recommendation_id=? ORDER BY ri.position`);
  const trackQuery = db.prepare("SELECT * FROM tracks WHERE id=?");
  return events.map((event) => {
    const detailsByTrackId = new Map(itemQuery.all(event.id).map((item) => [Number(item.id), item]));
    let authoritativeIds = safeJson(event.playlist_json, []).map((id) => Number(String(id).replace("local-", ""))).filter(Number.isFinite);
    if (!authoritativeIds.length) authoritativeIds = [...detailsByTrackId.keys()];
    let items = authoritativeIds.map((id) => {
      const detail = detailsByTrackId.get(id);
      const row = detail || trackQuery.get(id);
      if (!row) return null;
      return {
        ...serializeTrack(row),
        reason: detail?.reason || "早期生成记录未保存逐首解释。",
        evidence: safeJson(detail?.evidence_json, []), score: 0,
      };
    }).filter(Boolean);
    items = dedupeTrackRows(items);
    return {
      id: event.id, title: event.title || "历史歌单",
      summary: event.summary || event.request_text, request: event.request_text,
      createdAt: event.created_at, model: event.model, totalTokens: event.total_tokens,
      intent: safeJson(event.intent_json, null), plan: safeJson(event.plan_json, null),
      seedTrackIds: safeJson(event.seed_json, []), tracks: items,
    };
  });
}

function userPlaylistRows() {
  const playlists = db.prepare(`SELECT p.id, p.name, p.kind, p.created_at, p.updated_at,
    COUNT(i.id) AS track_count FROM user_playlists p
    LEFT JOIN user_playlist_items i ON i.playlist_id=p.id
    GROUP BY p.id ORDER BY CASE WHEN p.kind='favorites' THEN 0 ELSE 1 END, p.updated_at DESC`).all();
  const itemQuery = db.prepare(`SELECT t.* FROM user_playlist_items i
    JOIN tracks t ON t.id=i.track_id WHERE i.playlist_id=? ORDER BY i.added_at DESC, i.id DESC`);
  return playlists.map((playlist) => {
    const tracks = dedupeTrackRows(itemQuery.all(playlist.id)).map(serializeTrack);
    return {
      id: playlist.id, name: playlist.name, kind: playlist.kind,
      createdAt: playlist.created_at, updatedAt: playlist.updated_at,
      trackCount: tracks.length, tracks,
    };
  });
}

function calibrationRows() {
  const rows = db.prepare(`WITH ranked AS (
      SELECT t.*, p.review_status AS calibration_status, p.updated_at AS calibration_added_at,
        ROW_NUMBER() OVER (
          PARTITION BY lower(trim(t.title)), lower(trim(t.artist))
          ORDER BY t.play_count DESC, COALESCE(t.bitrate, 0) DESC, t.id
        ) AS song_rank
      FROM song_experience_profiles p JOIN tracks t ON t.id=p.track_id
      WHERE t.available=1
    ) SELECT * FROM ranked WHERE song_rank=1
    ORDER BY calibration_added_at DESC, artist, title`).all();
  const profileQuery = db.prepare(`SELECT style_json, felt_json, energy_json, sound_json,
    identity_text, avoid_text, source, review_status, notes, updated_at
    FROM song_experience_profiles WHERE track_id=?`);
  return rows.map((row) => ({
    track: serializeTrack(row), status: row.calibration_status, addedAt: row.calibration_added_at,
    annotations: {},
    profile: (() => {
      const profile = profileQuery.get(row.id);
      return profile ? {
        style: safeJson(profile.style_json, []), feltExperience: safeJson(profile.felt_json, []),
        energyArc: safeJson(profile.energy_json, []), sound: safeJson(profile.sound_json, []),
        identity: profile.identity_text, avoid: profile.avoid_text, source: profile.source,
        reviewStatus: profile.review_status, notes: profile.notes, updatedAt: profile.updated_at,
      } : null;
    })(),
  }));
}

function comparisonRows() {
  return db.prepare(`SELECT c.*, lt.title AS left_title, lt.artist AS left_artist,
    rt.title AS right_title, rt.artist AS right_artist
    FROM similarity_comparisons c
    JOIN tracks lt ON lt.id=c.left_track_id JOIN tracks rt ON rt.id=c.right_track_id
    ORDER BY c.id DESC LIMIT 100`).all().map((row) => ({
      id: row.id,
      leftTrack: { id: `local-${row.left_track_id}`, title: row.left_title, artist: row.left_artist },
      rightTrack: { id: `local-${row.right_track_id}`, title: row.right_title, artist: row.right_artist },
      dimensions: safeJson(row.dimensions_json, []), similarity: row.similarity_text,
      difference: row.difference_text, evidence: row.evidence, source: row.source,
      reviewStatus: row.review_status, createdAt: row.created_at,
    }));
}

function upsertStatement({ statement, scope = "general", polarity = 1, weight = 1, confidence = 0.75, evidence = [], reason, source = "feedback", category, status = "confirmed" }) {
  const normalized = statement.trim().toLowerCase().replace(/\s+/g, " ");
  const memoryKey = `statement:${createHash("sha1").update(`${scope}:${normalized}`).digest("hex")}`;
  const resolvedCategory = category || (polarity < 0 ? "boundary" : scope !== "general" ? "context" : /《.+》/.test(statement) ? "reference" : "taste");
  db.prepare(`INSERT INTO preference_statements
    (memory_key, statement, scope, polarity, weight, confidence, evidence_json, reason, source, category, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(memory_key) DO UPDATE SET
      polarity=excluded.polarity,
      weight=MIN(5, preference_statements.weight + 1),
      confidence=MAX(preference_statements.confidence, excluded.confidence),
      evidence_json=excluded.evidence_json, reason=excluded.reason,
      source=CASE WHEN preference_statements.status='confirmed' THEN preference_statements.source ELSE excluded.source END,
      category=excluded.category,
      status=CASE WHEN preference_statements.status='confirmed' THEN 'confirmed' ELSE excluded.status END,
      evidence_count=preference_statements.evidence_count + 1,
      active=1, updated_at=CURRENT_TIMESTAMP`).run(
        memoryKey, statement.trim(), scope, polarity < 0 ? -1 : 1,
        Math.max(1, Math.min(5, Number(weight) || 1)),
        Math.max(0.1, Math.min(1, Number(confidence) || 0.75)),
        JSON.stringify(evidence), reason, source, resolvedCategory, status,
      );
}

function recordPromptSignals({ prompt, plan, seeds, recommendationId }) {
  const evidence = [{ title: `原始需求：${prompt.slice(0, 180)}`, trackId: `recommendation-${recommendationId}` }];
  const signals = [];
  for (const row of seeds.slice(0, 3)) signals.push({
    statement: `近期将《${row.title}》作为相似歌曲参照`, category: "reference",
    evidence: [{ trackId: `local-${row.id}`, title: `${row.title} · ${row.artist}` }, ...evidence],
  });
  for (const artist of (!seeds.length && Array.isArray(plan.hardArtists) ? plan.hardArtists : []).slice(0, 2)) signals.push({
    statement: `近期主动选择歌手 ${artist}`, category: "anchor", evidence,
  });
  for (const style of sanitizeHardStyles(prompt, plan.hardStyles).slice(0, 2)) signals.push({
    statement: `近期明确提出曲风条件：${style}`, category: "taste", evidence,
  });
  const normalizedPrompt = normalizeMatch(prompt);
  const explicitBoundaries = (Array.isArray(plan.mustAvoid) ? plan.mustAvoid : [])
    .filter((value) => normalizeMatch(value).length >= 2 && normalizedPrompt.includes(normalizeMatch(value)));
  for (const boundary of explicitBoundaries.slice(0, 2)) signals.push({
    statement: `近期明确提出排除条件：${boundary}`, category: "boundary", evidence,
  });
  for (const signal of signals.slice(0, 5)) upsertStatement({
    ...signal, scope: "general", weight: 1, confidence: 0.65,
    polarity: signal.category === "boundary" ? -1 : 1,
    reason: "来自一次歌单生成需求；需要用户确认后才会参与推荐",
    source: "prompt_signal", status: "pending",
  });
}

function shuffled(values) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function parseModelJson(content) {
  if (!content) throw new Error("模型没有返回正文，请重试");
  const cleaned = content.trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

async function deepseekJson(system, value, maxTokens = 1400) {
  if (!deepseekApiKey || /在这里|填入|your/i.test(deepseekApiKey)) throw new Error("DeepSeek API Key 尚未配置");
  let lastError;
  let totalTokens = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const retryRule = attempt ? "\n上一次结构化输出无法解析。这次必须返回一个完整、简洁、无 Markdown 的 JSON 对象；缩短文字，不得在字符串中换行。" : "";
    let apiResponse;
    try {
      apiResponse = await fetch(`${deepseekBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${deepseekApiKey}` },
        body: JSON.stringify({ model: deepseekModel, messages: [{ role: "system", content: `${system}${retryRule}` }, { role: "user", content: JSON.stringify(value) }], thinking: { type: "disabled" }, response_format: { type: "json_object" }, temperature: attempt ? 0.1 : 0.35, max_tokens: attempt ? Math.ceil(maxTokens * 1.5) : maxTokens }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (error) {
      lastError = error;
      if (attempt === 0) continue;
      throw new Error(`DeepSeek 请求超时或网络异常：${error?.message || "未知错误"}`);
    }
    const result = await apiResponse.json().catch(() => ({}));
    if (!apiResponse.ok) throw new Error(result.error?.message || `DeepSeek 请求失败 (${apiResponse.status})`);
    totalTokens += Number(result.usage?.total_tokens || 0);
    try {
      return { value: parseModelJson(result.choices?.[0]?.message?.content), usage: { ...(result.usage || {}), total_tokens: totalTokens }, model: result.model || deepseekModel };
    } catch (error) { lastError = error; }
  }
  throw new Error(`DeepSeek 连续返回了无法解析的 JSON：${lastError?.message || "未知错误"}`);
}

function includesArtist(row, names) {
  const artist = row.artist.toLowerCase();
  return names.some((name) => artist.includes(String(name).toLowerCase()));
}

function candidateRows(plan, seeds, count) {
  const songKey = logicalTrackKey;
  const rawRows = db.prepare("SELECT * FROM tracks WHERE available=1 ORDER BY play_count DESC, COALESCE(bitrate,0) DESC, id").all();
  const canonicalRows = new Map();
  for (const row of rawRows) if (!canonicalRows.has(songKey(row))) canonicalRows.set(songKey(row), row);
  const allRows = [...canonicalRows.values()];
  const uniqueSeeds = [...new Map(seeds.map((row) => [songKey(row), row])).values()];
  const hardArtists = Array.isArray(plan.hardArtists) ? plan.hardArtists.filter(Boolean) : [];
  const excludedArtists = Array.isArray(plan.excludedArtists) ? plan.excludedArtists.filter(Boolean) : [];
  const allowedRows = excludedArtists.length ? allRows.filter((row) => !includesArtist(row, excludedArtists)) : allRows;
  let base = hardArtists.length ? allowedRows.filter((row) => includesArtist(row, hardArtists)) : allowedRows;
  const profileRows = db.prepare(`SELECT track_id, style_json, felt_json, energy_json, sound_json, identity_text, avoid_text, source, review_status
    FROM song_experience_profiles`).all();
  const profileByTrack = new Map(profileRows.map((profile) => [profile.track_id, {
    style: safeJson(profile.style_json, []), feltExperience: safeJson(profile.felt_json, []),
    energyArc: safeJson(profile.energy_json, []), sound: safeJson(profile.sound_json, []),
    identity: profile.identity_text, avoid: profile.avoid_text, source: profile.source, reviewStatus: profile.review_status,
  }]));
  const seedProfiles = uniqueSeeds.map((row) => profileByTrack.get(row.id)).filter(Boolean);
  const hardStyles = Array.isArray(plan.hardStyles) ? plan.hardStyles.filter(Boolean) : [];
  const mustAvoid = Array.isArray(plan.mustAvoid) ? plan.mustAvoid.filter(Boolean) : [];
  const positiveText = (profile) => profile ? [...profile.style, ...profile.feltExperience, ...profile.energyArc, ...profile.sound, profile.identity].join(" ") : "";
  if (hardStyles.length) base = base.filter((row) => {
    const profile = profileByTrack.get(row.id);
    return profile && hardStyles.every((required) => profile.style.some((actual) => {
      const left = normalizeMatch(required); const right = normalizeMatch(actual);
      return left && (left === right || right.includes(left));
    }));
  });
  if (mustAvoid.length) base = base.filter((row) => {
    const text = normalizeMatch(positiveText(profileByTrack.get(row.id)));
    return !mustAvoid.some((term) => normalizeMatch(term).length >= 2 && text.includes(normalizeMatch(term)));
  });
  const classified = base.map((row) => ({ row,
    ...(classifyProfileEvidence({ profile: profileByTrack.get(row.id), seedProfiles, plan }) || {
      tier: "explore", exactCount: 0, relatedCount: 0,
      evidence: ["没有足够的直接档案证据，仅作为探索候选"],
    }),
  })).sort((left, right) => {
    const order = { direct: 2, related: 1, explore: 0 };
    return order[right.tier] - order[left.tier]
      || right.exactCount - left.exactCount
      || right.relatedCount - left.relatedCount
      || right.row.play_count - left.row.play_count
      || (right.row.bitrate || 0) - (left.row.bitrate || 0)
      || left.row.id - right.row.id;
  });
  const selected = [];
  const selectedKeys = new Set();
  const artistCounts = new Map();
  const add = (entry, artistCap = Infinity) => {
    const key = songKey(entry.row); const artistKey = normalizeMatch(entry.row.artist);
    if (selectedKeys.has(key) || (artistCounts.get(artistKey) || 0) >= artistCap) return false;
    selected.push(entry); selectedKeys.add(key); artistCounts.set(artistKey, (artistCounts.get(artistKey) || 0) + 1); return true;
  };
  for (const row of uniqueSeeds) add({ row, tier: "reference", exactCount: 0, relatedCount: 0, evidence: ["用户指定的参考歌曲"] });
  const artistCap = hardArtists.length ? Infinity : 4;
  for (const entry of classified) {
    if (selected.length >= 80) break;
    add(entry, artistCap);
  }
  return selected.slice(0, 80);
}

function experienceProfileForTrack(row) {
  const experience = db.prepare(`SELECT style_json, felt_json, energy_json, sound_json,
    identity_text, avoid_text, source, review_status FROM song_experience_profiles WHERE track_id=?`).get(row.id);
  return experience ? {
    style: safeJson(experience.style_json, []),
    feltExperience: safeJson(experience.felt_json, []),
    energyArc: safeJson(experience.energy_json, []),
    sound: safeJson(experience.sound_json, []),
    identity: experience.identity_text,
    avoid: experience.avoid_text,
    source: experience.source,
    reviewStatus: experience.review_status,
  } : null;
}

function referencePolicy(plan, seeds) {
  const instructions = Array.isArray(plan.referenceTracks) ? plan.referenceTracks : [];
  const policyById = new Map(instructions.map((item) => [Number(item?.id), item?.policy === "exclude" ? "exclude" : "include"]));
  return seeds.map((row) => ({ row, policy: policyById.get(Number(row.id)) || "include" }));
}

async function generateRecommendation(prompt, mix, count, seedIds = []) {
  const memories = memoryRows().filter((row) => row.status === "confirmed").slice(0, 24).map((row) => ({ statement: row.statement, scope: row.scope, weight: row.weight, confidence: row.confidence }));
  const favoriteTracks = db.prepare(`SELECT t.id, t.title, t.artist, t.album FROM user_playlist_items i
    JOIN tracks t ON t.id=i.track_id JOIN user_playlists p ON p.id=i.playlist_id
    WHERE p.kind='favorites' AND t.available=1 ORDER BY i.added_at DESC LIMIT 80`).all();
  const recentRequests = db.prepare("SELECT request_text FROM recommendation_events ORDER BY id DESC LIMIT 3").all().map((row) => row.request_text);
  const recentFeedback = db.prepare("SELECT verdict, explanation, scope FROM feedback_entries WHERE created_at >= datetime('now','-6 hours') ORDER BY id DESC LIMIT 10").all();
  const numericSeedIds = seedIds.map((id) => Number(String(id).replace("local-", ""))).filter(Number.isFinite).slice(0, 5);
  const explicitSeeds = numericSeedIds.length ? db.prepare(`SELECT * FROM tracks WHERE available=1 AND id IN (${numericSeedIds.map(() => "?").join(",")})`).all(...numericSeedIds) : [];
  const artistCatalog = db.prepare("SELECT artist, COUNT(*) AS count FROM tracks WHERE available=1 GROUP BY artist ORDER BY count DESC, artist LIMIT 400").all();
  const availableTracks = db.prepare("SELECT * FROM tracks WHERE available=1").all();
  const normalizedPrompt = normalizeMatch(prompt);
  const mentionedArtists = artistCatalog.filter((row) => row.artist.length > 1 && normalizedPrompt.includes(normalizeMatch(row.artist)));
  const exactMentionedTracks = maximalTitleMatches(availableTracks.filter((row) => {
    const title = normalizeMatch(row.title);
    return title.length >= 2 && normalizedPrompt.includes(title);
  })).sort((left, right) => normalizeMatch(right.title).length - normalizeMatch(left.title).length);
  let mentionedTracks = exactMentionedTracks.slice(0, 5);
  if (!mentionedTracks.length && mentionedArtists.length) {
    mentionedTracks = mentionedArtists.map((item) => nearestTitleAfterArtist(
      prompt, item.artist, availableTracks.filter((row) => includesArtist(row, [item.artist])),
    )).filter(Boolean).slice(0, 5);
  }
  const seeds = dedupeTrackRows([...explicitSeeds, ...mentionedTracks]).slice(0, 5);
  const planningArtists = [...new Map([...mentionedArtists, ...artistCatalog.slice(0, 240)].map((row) => [row.artist, row])).values()];
  const planningSystem = `你是 Moment 的检索规划器。不要直接选歌，先把用户的一整段自然语言需求转换成数据库检索计划。参考歌曲、心情、场景、数量和排除条件都来自同一个 request；referencedTracksFoundInLibrary 是系统从这段话中识别出的本地歌曲，其 experienceProfile 是本地听感档案，source 和 reviewStatus 表明来源与复检状态；用户校准和已审核档案优先，llm_bulk_draft 可用但需保留不确定性。歌曲内容特征可能不完整，因此必须区分硬条件和软偏好。
只返回JSON：{"intentSummary":"","hardArtists":[""],"hardStyles":[""],"excludedArtists":[""],"candidateArtists":[""],"mustKeep":[""],"mustAvoid":[""],"softPreferences":[""],"seedRelations":[""],"requiredEvidence":[""],"mixExplanation":"","referenceTracks":[{"id":1,"policy":"include","reason":""}]}。
referenceTracks必须覆盖所有识别出的参考歌，不得填写 referencedTracksFoundInLibrary 之外的ID。用户说“和X类似”时policy默认为include，参考歌占用歌单一个名额；只有用户明确说“不要X”“排除X”“以X为参考但不要X”或“除了X再找”时，对应歌曲才设为exclude。参考歌档案里的style只是相似性目标，绝对不能自动复制到hardStyles。hardArtists只有用户明确限定歌手时才填写，“和某歌手的X类似”不等于限定该歌手；hardStyles只能收录用户原文明确说出的必须曲风；candidateArtists只能从提供的歌手目录选择；不要把本次偏好写成长期偏好。`;
  const planning = await deepseekJson(planningSystem, {
    request: prompt, desiredMix: mix,
    referencedTracksFoundInLibrary: seeds.map((row) => ({
      id: row.id, title: row.title, artist: row.artist, album: row.album,
      experienceProfile: experienceProfileForTrack(row),
    })),
    longTermMemories: memories, favoriteTracks, recentSessionFeedback: recentFeedback,
    recentRequests, mentionedArtists, availableArtists: planningArtists,
  }, 1400);
  planning.value.hardStyles = sanitizeHardStyles(prompt, planning.value.hardStyles);
  const recognizedSeedIds = new Set(seeds.map((row) => Number(row.id)));
  planning.value.referenceTracks = (Array.isArray(planning.value.referenceTracks) ? planning.value.referenceTracks : [])
    .filter((item) => recognizedSeedIds.has(Number(item?.id)));
  const references = referencePolicy(planning.value, seeds);
  const includedSeeds = references.filter((item) => item.policy === "include").map((item) => item.row);
  const excludedSeedIds = new Set(references.filter((item) => item.policy === "exclude").map((item) => Number(item.row.id)));
  const candidateEntries = candidateRows(planning.value, includedSeeds, count).filter((entry) => !excludedSeedIds.has(Number(entry.row.id)));
  const candidates = candidateEntries.map((entry) => entry.row);
  if (!candidateEntries.length) throw new Error("没有找到满足硬条件的本地歌曲");
  const candidatePayload = candidateEntries.map(({ row, tier, evidence }) => {
    const experienceProfile = experienceProfileForTrack(row);
    return {
      id: row.id, title: row.title, artist: row.artist, album: row.album,
      genre: row.genre, year: row.year, folder: row.folder, playCount: row.play_count,
      lastPlayedAt: row.last_played_at, sourceKind: serializeTrack(row).kind,
      experienceProfile, recallTier: tier, recallEvidence: evidence,
      evidenceAvailable: [row.genre ? "原始流派" : null, row.album ? "专辑" : null,
        experienceProfile ? (experienceProfile.source === "llm_bulk_draft" ? "模型批量听感草稿（待复检）" : "已策展听感档案") : null,
        row.play_count ? "本应用播放记录" : "个人曲库/历史未知"].filter(Boolean),
    };
  });
  const rankingSystem = `你是 Moment 的歌单策展模型。只能从候选歌曲中选择，不能编造歌曲事实。用户导入但从未在本应用播放的歌属于“个人曲库/历史未知”，不能称为新歌或遗忘旧爱。候选中若存在 experienceProfile，依据曲风指纹、实际听感、能量走向、声音表现和排除边界，判断它能否承接用户此刻想获得的体验。recallTier 和 recallEvidence 只解释程序为何召回这首歌，不是相似度分数，不能代替你的语义判断。不能因为歌手相同、主题相似或共享“忧伤/内省”等宽泛词语，就判定两首歌适合连续推荐；identity 和 avoid 是防止误推的重要边界。referenceTracksToKeep 中的参考歌必须保留并占用名额。当用户没有限定歌手时，同一歌手最多选2首；当前需求和参考歌高于长期歌手偏好，长期记忆只能在两首歌同样匹配时用于决胜。
把 hardArtists、hardStyles、用户明确排除项和 intent.mustHave 当作不可违反规则。歌曲只满足“嗨”“悲伤”等情绪、却不满足用户明确指定的曲风时绝对不能入选；歌手偏好也不能覆盖曲风硬条件。优先从 direct 和 related 中选择；explore 只是防止召回遗漏，只有完整档案经语义判断确实匹配时才能选，不能拿它凑数量。证据不足或合格歌曲不够时允许少选。软偏好允许基于常识判断，但理由必须指出依据，证据不足时直说“基于歌曲与歌手的已知风格判断”。
只返回JSON：{"title":"","summary":"","intent":{"summary":"","mustHave":[""],"avoid":[""],"softPreferences":[""]},"selections":[{"id":1,"reason":"","evidence":[""]}]}。尽量选满请求数量并保持歌手、专辑和听感的多样性。`;
  const ranking = await deepseekJson(rankingSystem, {
    request: prompt, requestedCount: count, desiredMix: mix,
    retrievalPlan: planning.value, longTermMemories: memories, favoriteTracks,
    recentSessionFeedback: recentFeedback,
    referenceTracksToKeep: includedSeeds.map((row) => ({ id: row.id, title: row.title, artist: row.artist })),
    candidates: candidatePayload,
  }, Math.min(4200, 1200 + count * 100));
  const modelResult = ranking.value;
  const candidateMap = new Map(candidates.map((row) => [Number(row.id), row]));
  const hardStyles = Array.isArray(planning.value.hardStyles) ? planning.value.hardStyles.map((value) => String(value).trim()).filter(Boolean) : [];
  const normalizedStyle = (value) => String(value).toLowerCase().replace(/[\s·・_\-/]/g, "");
  const payloadById = new Map(candidatePayload.map((item) => [Number(item.id), item]));
  const mustAvoid = Array.isArray(planning.value.mustAvoid) ? planning.value.mustAvoid.map((value) => String(value).trim()).filter(Boolean) : [];
  const excludedArtists = Array.isArray(planning.value.excludedArtists) ? planning.value.excludedArtists.map((value) => String(value).trim()).filter(Boolean) : [];
  const violatesMustAvoid = (row) => {
    if (excludedArtists.length && includesArtist(row, excludedArtists)) return true;
    if (!mustAvoid.length) return false;
    const profile = payloadById.get(Number(row.id))?.experienceProfile;
    if (!profile) return false;
    const positiveText = [...profile.style, ...profile.feltExperience, ...profile.energyArc, ...profile.sound, profile.identity].join(" ");
    const normalized = normalizeMatch(positiveText);
    return mustAvoid.some((value) => normalizeMatch(value).length >= 2 && normalized.includes(normalizeMatch(value)));
  };
  const matchesHardStyles = (row) => {
    if (!hardStyles.length) return true;
    const profile = payloadById.get(Number(row.id))?.experienceProfile;
    if (!profile) return false;
    return hardStyles.every((hardStyle) => profile.style.some((style) => {
      const required = normalizedStyle(hardStyle);
      const actual = normalizedStyle(style);
      return actual === required || actual.includes(required);
    }));
  };
  const seen = new Set();
  const playlist = [];
  const artistCounts = new Map();
  const hardArtists = Array.isArray(planning.value.hardArtists) ? planning.value.hardArtists.filter(Boolean) : [];
  const maxPerArtist = hardArtists.length ? Infinity : includedSeeds.length ? 2 : 3;
  const artistKey = (row) => normalizeMatch(row.artist);
  const canAddArtist = (row, isReference = false) => isReference || (artistCounts.get(artistKey(row)) || 0) < maxPerArtist;
  const recordArtist = (row) => artistCounts.set(artistKey(row), (artistCounts.get(artistKey(row)) || 0) + 1);
  for (const selection of Array.isArray(modelResult.selections) ? modelResult.selections : []) {
    const id = Number(selection.id);
    const row = candidateMap.get(id);
    const isIncludedReference = includedSeeds.some((seed) => Number(seed.id) === id);
    if (!row || seen.has(id) || !canAddArtist(row, isIncludedReference) || (!isIncludedReference && (!matchesHardStyles(row) || violatesMustAvoid(row)))) continue;
    seen.add(id);
    recordArtist(row);
    playlist.push({ ...serializeTrack(row), score: 0, reason: String(selection.reason || "符合你此刻的听歌需求。"), evidence: Array.isArray(selection.evidence) ? selection.evidence.slice(0, 5) : [] });
    if (playlist.length >= count) break;
  }
  for (const seed of [...includedSeeds].reverse()) {
    if (playlist.length >= count && playlist.some((track) => Number(track.id.replace("local-", "")) === Number(seed.id))) continue;
    if (!playlist.some((track) => Number(track.id.replace("local-", "")) === Number(seed.id))) {
      playlist.unshift({ ...serializeTrack(seed), score: 0,
        reason: "这是你指定的参考歌曲，默认保留在本次歌单中。",
        evidence: ["用户指定的参考歌曲"] });
      seen.add(Number(seed.id));
      recordArtist(seed);
    }
  }
  if (playlist.length > count) playlist.length = count;
  const fallbackCandidates = candidateEntries.filter((entry) => (!hardStyles.length || matchesHardStyles(entry.row)) && !violatesMustAvoid(entry.row) && (entry.tier === "direct" || entry.tier === "related"));
  for (const entry of fallbackCandidates) {
    const row = entry.row;
    if (playlist.length >= count) break;
    if (!seen.has(row.id) && canAddArtist(row)) {
      const tierText = entry.tier === "direct" ? "直接证据" : entry.tier === "related" ? "关联证据" : "探索候选";
      playlist.push({ ...serializeTrack(row), score: 0,
        reason: `本地听感档案提供了${tierText}，作为候选补入。`,
        evidence: entry.evidence.slice(0, 4) });
      seen.add(Number(row.id));
      recordArtist(row);
    }
  }
  const intent = {
    summary: String(modelResult.intent?.summary || planning.value.intentSummary || prompt),
    mustHave: Array.isArray(modelResult.intent?.mustHave) ? modelResult.intent.mustHave.slice(0, 8) : [],
    avoid: Array.isArray(modelResult.intent?.avoid) ? modelResult.intent.avoid.slice(0, 8) : [],
    softPreferences: Array.isArray(modelResult.intent?.softPreferences) ? modelResult.intent.softPreferences.slice(0, 8) : [],
  };
  const totalTokens = Number(planning.usage?.total_tokens || 0) + Number(ranking.usage?.total_tokens || 0);
  const title = String(modelResult.title || "此刻歌单");
  const summary = String(modelResult.summary || "根据你的表达、参考歌曲和音乐记忆生成。");
  let recommendationId;
  db.exec("BEGIN");
  try {
    const event = db.prepare("INSERT INTO recommendation_events (request_text, intent_json, playlist_json, model, total_tokens, plan_json, seed_json, title, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(prompt, JSON.stringify(intent), JSON.stringify(playlist.map((track) => track.id)), ranking.model, totalTokens || null, JSON.stringify(planning.value), JSON.stringify(includedSeeds.map((row) => row.id)), title, summary);
    recommendationId = Number(event.lastInsertRowid);
    const insertItem = db.prepare("INSERT INTO recommendation_items (recommendation_id, track_id, position, source_kind, reason, evidence_json) VALUES (?, ?, ?, ?, ?, ?)");
    playlist.forEach((track, index) => insertItem.run(recommendationId, Number(track.id.replace("local-", "")), index + 1, track.kind, track.reason, JSON.stringify(track.evidence || [])));
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  try { recordPromptSignals({ prompt, plan: planning.value, seeds: includedSeeds, recommendationId }); }
  catch (error) { console.error("Failed to record prompt signals", error); }
  return { id: recommendationId, title, summary, intent, plan: planning.value, tracks: playlist, model: ranking.model, usage: { total_tokens: totalTokens } };
}

async function interpretFeedback(track, verdict, explanation, scope) {
  const system = `你是 Moment 的音乐偏好记忆整理器。用户会解释为什么喜欢或不喜欢一首歌。提取完整、可修正的偏好陈述，不要退化成宽泛流派标签，不要推断用户没有说过的歌手偏好。
只返回JSON：{"summary":"","statements":[{"statement":"","polarity":1或-1,"confidence":0到1,"reason":""}]}。
statement应保留对象、方面和条件，例如“喜欢歌曲从克制前奏逐渐进入明显鼓点”，而不是“喜欢鼓点”。如果这是仅本次偏好，仍然解析但不要称为长期偏好。`;
  return deepseekJson(system, {
    verdict, explanation, scope,
    track: { id: track.id, title: track.title, artist: track.artist, album: track.album, genre: track.genre },
  }, 700);
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

function safeTrackPath(relativePath) {
  const path = resolve(libraryRoot, relativePath);
  if (path !== libraryRoot && !path.startsWith(`${libraryRoot}${sep}`)) throw new Error("Invalid track path");
  return path;
}

async function streamTrack(request, response, id) {
  const row = db.prepare("SELECT relative_path, file_size FROM tracks WHERE id = ? AND available=1").get(id);
  if (!row) return sendJson(response, 404, { error: "Track not found" });
  const path = safeTrackPath(row.relative_path);
  const size = row.file_size;
  const headers = { ...corsHeaders(), "Accept-Ranges": "bytes", "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=3600" };
  const range = request.headers.range;
  if (!range) {
    response.writeHead(200, { ...headers, "Content-Length": size });
    return createReadStream(path).pipe(response);
  }
  const [startText, endText] = range.replace("bytes=", "").split("-");
  const start = Number(startText);
  const end = endText ? Math.min(Number(endText), size - 1) : size - 1;
  if (!Number.isFinite(start) || start < 0 || end < start) {
    response.writeHead(416, { "Content-Range": `bytes */${size}` });
    return response.end();
  }
  response.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}` });
  createReadStream(path, { start, end }).pipe(response);
}

if (!db.prepare("SELECT 1 FROM preference_statements WHERE source='prompt_signal' LIMIT 1").get()) {
  const historicalRequests = db.prepare(`SELECT * FROM (
    SELECT id, request_text, plan_json, seed_json FROM recommendation_events ORDER BY id DESC LIMIT 20
  ) ORDER BY id`).all();
  const trackQuery = db.prepare("SELECT * FROM tracks WHERE id=? AND available=1");
  for (const event of historicalRequests) {
    const seeds = safeJson(event.seed_json, []).map((id) => trackQuery.get(Number(id))).filter(Boolean);
    try { recordPromptSignals({ prompt: event.request_text, plan: safeJson(event.plan_json, {}), seeds, recommendationId: event.id }); }
    catch (error) { console.error("Failed to backfill prompt signals", error); }
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "OPTIONS") { response.writeHead(204, corsHeaders()); return response.end(); }
    if (request.method === "GET" && url.pathname === "/api/health") {
      const count = db.prepare(`SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM tracks WHERE available=1 GROUP BY lower(trim(title)), lower(trim(artist))
      )`).get().count;
      return sendJson(response, 200, { ok: true, count, libraryRoot, scan: scanState, ai: { configured: Boolean(deepseekApiKey && !/在这里|填入|your/i.test(deepseekApiKey)), model: deepseekModel } });
    }
    if (request.method === "POST" && url.pathname === "/api/library/scan") {
      scanLibrary().catch(console.error);
      return sendJson(response, 202, { ok: true, scan: scanState });
    }
    if (request.method === "GET" && url.pathname === "/api/library/scan") return sendJson(response, 200, scanState);
    if (request.method === "GET" && url.pathname === "/api/tracks") {
      const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit") || 2000)));
      const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
      const query = url.searchParams.get("q")?.trim();
      const physicalRows = query
        ? db.prepare("SELECT * FROM tracks WHERE available=1 AND (title LIKE ? OR artist LIKE ? OR album LIKE ?) ORDER BY artist, title, play_count DESC, COALESCE(bitrate,0) DESC, id").all(`%${query}%`, `%${query}%`, `%${query}%`)
        : db.prepare("SELECT * FROM tracks WHERE available=1 ORDER BY artist, title, play_count DESC, COALESCE(bitrate,0) DESC, id").all();
      const logicalRows = dedupeTrackRows(physicalRows);
      return sendJson(response, 200, { total: logicalRows.length, tracks: logicalRows.slice(offset, offset + limit).map(serializeTrack) });
    }
    if (request.method === "POST" && url.pathname === "/api/recommendations") {
      const body = await readJson(request);
      const prompt = String(body.prompt || "").trim();
      if (!prompt) return sendJson(response, 400, { error: "请描述此刻想听的音乐" });
      const countMention = prompt.match(/(?:生成|给我|要|想听)?\s*([1-9]|[12]\d|30)\s*首/);
      const count = Math.min(30, Math.max(1, countMention ? Number(countMention[1]) : Number(body.count || 10)));
      const mix = body.mix && typeof body.mix === "object" ? body.mix : { familiar: 50, forgotten: 20, discover: 30 };
      const seedTrackIds = Array.isArray(body.seedTrackIds) ? body.seedTrackIds : [];
      const requestText = prompt.slice(0, 1000);
      const requestLog = db.prepare("INSERT INTO request_logs (request_text, requested_count, mix_json) VALUES (?, ?, ?)").run(requestText, count, JSON.stringify(mix));
      const requestLogId = Number(requestLog.lastInsertRowid);
      try {
        const recommendation = await generateRecommendation(requestText, mix, count, seedTrackIds);
        db.prepare("UPDATE request_logs SET status='succeeded', recommendation_id=?, completed_at=CURRENT_TIMESTAMP WHERE id=?").run(recommendation.id, requestLogId);
        return sendJson(response, 200, recommendation);
      } catch (error) {
        db.prepare("UPDATE request_logs SET status='failed', error_text=?, completed_at=CURRENT_TIMESTAMP WHERE id=?").run(String(error instanceof Error ? error.message : error).slice(0, 500), requestLogId);
        throw error;
      }
    }
    if (request.method === "GET" && url.pathname === "/api/playlists") {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50)));
      return sendJson(response, 200, { playlists: playlistRows(limit) });
    }
    const aiPlaylistMatch = url.pathname.match(/^\/api\/playlists\/(\d+)$/);
    if (request.method === "DELETE" && aiPlaylistMatch) {
      const recommendationId = Number(aiPlaylistMatch[1]);
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM recommendation_items WHERE recommendation_id=?").run(recommendationId);
        db.prepare("DELETE FROM recommendation_events WHERE id=?").run(recommendationId);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return sendJson(response, 200, { ok: true, playlists: playlistRows(50) });
    }
    const aiPlaylistTrackMatch = url.pathname.match(/^\/api\/playlists\/(\d+)\/tracks\/(\d+)$/);
    if (request.method === "DELETE" && aiPlaylistTrackMatch) {
      const recommendationId = Number(aiPlaylistTrackMatch[1]);
      const trackId = Number(aiPlaylistTrackMatch[2]);
      const track = db.prepare("SELECT title, artist FROM tracks WHERE id=?").get(trackId);
      if (track) db.prepare(`DELETE FROM recommendation_items WHERE recommendation_id=? AND track_id IN (
        SELECT id FROM tracks WHERE lower(trim(title))=lower(trim(?)) AND lower(trim(artist))=lower(trim(?))
      )`).run(recommendationId, track.title, track.artist);
      const event = db.prepare("SELECT playlist_json FROM recommendation_events WHERE id=?").get(recommendationId);
      if (event) {
        const ids = safeJson(event.playlist_json, []).filter((id) => {
          const candidate = db.prepare("SELECT title, artist FROM tracks WHERE id=?").get(Number(String(id).replace("local-", "")));
          return !track || !candidate || logicalTrackKey(candidate) !== logicalTrackKey(track);
        });
        db.prepare("UPDATE recommendation_events SET playlist_json=? WHERE id=?").run(JSON.stringify(ids), recommendationId);
      }
      return sendJson(response, 200, { ok: true, playlists: playlistRows(50) });
    }
    if (request.method === "GET" && url.pathname === "/api/user-playlists") {
      return sendJson(response, 200, { playlists: userPlaylistRows() });
    }
    if (request.method === "POST" && url.pathname === "/api/user-playlists") {
      const body = await readJson(request);
      const name = String(body.name || "").trim().slice(0, 60);
      if (!name) return sendJson(response, 400, { error: "请输入歌单名称" });
      const result = db.prepare("INSERT INTO user_playlists (name, kind) VALUES (?, 'custom')").run(name);
      return sendJson(response, 201, { id: Number(result.lastInsertRowid), playlists: userPlaylistRows() });
    }
    const userPlaylistMatch = url.pathname.match(/^\/api\/user-playlists\/(\d+)$/);
    if (request.method === "DELETE" && userPlaylistMatch) {
      const playlistId = Number(userPlaylistMatch[1]);
      const playlist = db.prepare("SELECT kind FROM user_playlists WHERE id=?").get(playlistId);
      if (!playlist) return sendJson(response, 404, { error: "歌单不存在" });
      if (playlist.kind === "favorites") return sendJson(response, 400, { error: "默认收藏歌单不能删除" });
      db.prepare("DELETE FROM user_playlists WHERE id=?").run(playlistId);
      return sendJson(response, 200, { ok: true, playlists: userPlaylistRows() });
    }
    const playlistTrackMatch = url.pathname.match(/^\/api\/user-playlists\/(\d+)\/tracks$/);
    if (playlistTrackMatch && ["POST", "DELETE"].includes(request.method)) {
      const playlistId = Number(playlistTrackMatch[1]);
      const body = await readJson(request);
      const trackId = Number(String(body.trackId || "").replace("local-", ""));
      const target = db.prepare("SELECT id FROM user_playlists WHERE id=?").get(playlistId);
      const track = db.prepare("SELECT id, title, artist FROM tracks WHERE id=? AND available=1").get(trackId);
      if (!target || !track) return sendJson(response, 404, { error: "歌单或歌曲不存在" });
      if (request.method === "POST") {
        const existing = db.prepare(`SELECT i.id FROM user_playlist_items i JOIN tracks t ON t.id=i.track_id
          WHERE i.playlist_id=? AND lower(trim(t.title))=lower(trim(?)) AND lower(trim(t.artist))=lower(trim(?)) LIMIT 1`).get(playlistId, track.title, track.artist);
        if (!existing) db.prepare("INSERT OR IGNORE INTO user_playlist_items (playlist_id, track_id) VALUES (?, ?)").run(playlistId, trackId);
      } else db.prepare(`DELETE FROM user_playlist_items WHERE playlist_id=? AND track_id IN (
        SELECT id FROM tracks WHERE lower(trim(title))=lower(trim(?)) AND lower(trim(artist))=lower(trim(?))
      )`).run(playlistId, track.title, track.artist);
      db.prepare("UPDATE user_playlists SET updated_at=CURRENT_TIMESTAMP WHERE id=?").run(playlistId);
      return sendJson(response, 200, { ok: true, playlists: userPlaylistRows() });
    }
    const favoriteMatch = url.pathname.match(/^\/api\/favorites\/(\d+)$/);
    if (favoriteMatch && ["PUT", "DELETE"].includes(request.method)) {
      const trackId = Number(favoriteMatch[1]);
      const track = db.prepare("SELECT id, title, artist FROM tracks WHERE id=? AND available=1").get(trackId);
      if (!track) return sendJson(response, 404, { error: "歌曲不存在" });
      if (request.method === "PUT") {
        const existing = db.prepare(`SELECT i.id FROM user_playlist_items i JOIN tracks t ON t.id=i.track_id
          WHERE i.playlist_id=1 AND lower(trim(t.title))=lower(trim(?)) AND lower(trim(t.artist))=lower(trim(?)) LIMIT 1`).get(track.title, track.artist);
        if (!existing) db.prepare("INSERT OR IGNORE INTO user_playlist_items (playlist_id, track_id) VALUES (1, ?)").run(trackId);
      } else db.prepare(`DELETE FROM user_playlist_items WHERE playlist_id=1 AND track_id IN (
        SELECT id FROM tracks WHERE lower(trim(title))=lower(trim(?)) AND lower(trim(artist))=lower(trim(?))
      )`).run(track.title, track.artist);
      db.prepare("UPDATE user_playlists SET updated_at=CURRENT_TIMESTAMP WHERE id=1").run();
      return sendJson(response, 200, { ok: true, favorite: request.method === "PUT", playlists: userPlaylistRows() });
    }
    if (request.method === "GET" && url.pathname === "/api/similarity/calibration") {
      return sendJson(response, 200, { tracks: calibrationRows(), comparisons: comparisonRows() });
    }
    const calibrationTrackMatch = url.pathname.match(/^\/api\/similarity\/calibration\/(\d+)$/);
    if (calibrationTrackMatch && ["POST", "DELETE"].includes(request.method)) {
      const trackId = Number(calibrationTrackMatch[1]);
      if (!db.prepare("SELECT id FROM tracks WHERE id=?").get(trackId)) return sendJson(response, 404, { error: "歌曲不存在" });
      if (request.method === "POST") {
        const count = db.prepare("SELECT COUNT(*) AS count FROM similarity_calibration_tracks").get().count;
        if (count >= 30 && !db.prepare("SELECT track_id FROM similarity_calibration_tracks WHERE track_id=?").get(trackId)) return sendJson(response, 400, { error: "校准集合最多保存30首歌曲" });
        db.prepare("INSERT OR IGNORE INTO similarity_calibration_tracks (track_id) VALUES (?)").run(trackId);
      } else {
        db.prepare("DELETE FROM similarity_annotations WHERE track_id=?").run(trackId);
        db.prepare("DELETE FROM similarity_calibration_tracks WHERE track_id=?").run(trackId);
      }
      return sendJson(response, 200, { ok: true, tracks: calibrationRows() });
    }
    const calibrationDraftMatch = url.pathname.match(/^\/api\/similarity\/calibration\/(\d+)\/draft$/);
    if (request.method === "POST" && calibrationDraftMatch) {
      const trackId = Number(calibrationDraftMatch[1]);
      const track = db.prepare("SELECT id, title, artist, album, genre, year, folder FROM tracks WHERE id=?").get(trackId);
      if (!track) return sendJson(response, 404, { error: "歌曲不存在" });
      if (!db.prepare("SELECT track_id FROM similarity_calibration_tracks WHERE track_id=?").get(trackId)) return sendJson(response, 404, { error: "请先把歌曲加入校准集合" });
      const dimensionGuide = {
        emotion: "情绪性质：方向、唤醒、力量、释放、明暗质地",
        dynamics: "情绪动态：积累方式、副歌抬升、段落对比、峰值和结尾",
        vocal: "演唱姿态：克制或外放、张力、距离、合唱感、音色质地",
        melody: "旋律体验：鲜明度、跟唱感、音域、起伏、副歌钩子",
        rhythm: "节奏推进：推进感、律动、稳定、冲击、速度感",
        arrangement: "编曲空间：密度、空间、原声或电子、层次、副歌扩张",
        narrative: "主题姿态：主动或被动、勇敢或犹疑、对抗或接受、行动感",
        culture: "文化体验：语言地域、时代质感、共同记忆、表演文化和场景",
      };
      const draftSystem = `你是音乐相似性标注的初稿助手，而不是事实裁判。你只能依据给出的歌曲元数据和你对知名作品的已有知识提出待审核草稿；你没有听到音频，也没有看到歌词，不得伪装成已完成音频分析。知识不足时必须明确写“信息不足，待人工确认”。
对八个维度分别返回 observation、boundary、evidence。observation用完整句子描述该维度；boundary说明容易混淆但并不等同的特征。元数据仅包含歌名、歌手、专辑、流派和年份，不能证明情绪、旋律、节奏、动态、演唱或编曲；这些判断即使你熟悉作品，也必须把evidence写成“模型已有知识（未核验）；未进行音频或歌词分析”。只有直接复述元数据字段时才能写“歌曲元数据”。不能捏造具体音频证据。
只返回JSON：{"annotations":{"emotion":{"observation":"","boundary":"","evidence":""},"dynamics":{},"vocal":{},"melody":{},"rhythm":{},"arrangement":{},"narrative":{},"culture":{}}}。`;
      const draft = await deepseekJson(draftSystem, { track, dimensionGuide }, 2600);
      const annotations = {};
      for (const key of Object.keys(dimensionGuide)) {
        const item = draft.value?.annotations?.[key] || {};
        annotations[key] = {
          observation: String(item.observation || "信息不足，待人工确认").slice(0, 1500),
          boundary: String(item.boundary || "信息不足，待人工确认").slice(0, 1500),
          evidence: String(item.evidence || "信息不足").slice(0, 1000),
          source: "llm_draft",
        };
      }
      return sendJson(response, 200, { ok: true, annotations, model: draft.model, usage: draft.usage });
    }
    const experienceProfileMatch = url.pathname.match(/^\/api\/similarity\/calibration\/(\d+)\/profile$/);
    if (request.method === "PUT" && experienceProfileMatch) {
      const trackId = Number(experienceProfileMatch[1]);
      const track = db.prepare("SELECT id, title, artist FROM tracks WHERE id=? AND available=1").get(trackId);
      if (!track) return sendJson(response, 404, { error: "歌曲不存在或文件已移除" });
      const body = await readJson(request);
      const cleanTags = (value) => Array.isArray(value) ? [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].slice(0, 8) : [];
      const style = cleanTags(body.style);
      const felt = cleanTags(body.feltExperience);
      const energy = cleanTags(body.energyArc);
      const sound = cleanTags(body.sound);
      const identity = String(body.identity || "").trim().slice(0, 1200);
      const avoid = String(body.avoid || "").trim().slice(0, 1200);
      if (!style.length || !felt.length || !energy.length || !sound.length || !identity || !avoid) return sendJson(response, 400, { error: "五类听感档案都需要填写" });
      const source = body.source === "user_calibrated" ? "user_calibrated" : "codex_curated";
      const reviewStatus = body.reviewStatus === "approved" ? "approved" : "needs_user_review";
      const upsertProfile = db.prepare(`INSERT INTO song_experience_profiles
        (track_id, style_json, felt_json, energy_json, sound_json, identity_text, avoid_text, source, review_status, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(track_id) DO UPDATE SET style_json=excluded.style_json, felt_json=excluded.felt_json,
        energy_json=excluded.energy_json, sound_json=excluded.sound_json, identity_text=excluded.identity_text,
        avoid_text=excluded.avoid_text, source=excluded.source, review_status=excluded.review_status,
        notes=excluded.notes, updated_at=CURRENT_TIMESTAMP`);
      const matchingTracks = db.prepare(`SELECT id FROM tracks WHERE available=1
        AND lower(trim(title))=lower(trim(?)) AND lower(trim(artist))=lower(trim(?))`).all(track.title, track.artist);
      db.exec("BEGIN");
      try {
        for (const matching of matchingTracks) upsertProfile.run(
          matching.id, JSON.stringify(style), JSON.stringify(felt), JSON.stringify(energy), JSON.stringify(sound),
          identity, avoid, source, reviewStatus, String(body.notes || "").trim().slice(0, 1200),
        );
        db.prepare(`UPDATE similarity_calibration_tracks SET status=?, updated_at=CURRENT_TIMESTAMP
          WHERE track_id IN (SELECT id FROM tracks WHERE available=1
            AND lower(trim(title))=lower(trim(?)) AND lower(trim(artist))=lower(trim(?)))`).run(reviewStatus, track.title, track.artist);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return sendJson(response, 200, { ok: true, tracks: calibrationRows() });
    }
    const annotationMatch = url.pathname.match(/^\/api\/similarity\/calibration\/(\d+)\/annotations\/([a-z_]+)$/);
    if (request.method === "PUT" && annotationMatch) {
      const trackId = Number(annotationMatch[1]);
      const dimension = annotationMatch[2];
      const allowedDimensions = new Set(["emotion", "dynamics", "vocal", "melody", "rhythm", "arrangement", "narrative", "culture"]);
      if (!allowedDimensions.has(dimension)) return sendJson(response, 400, { error: "未知的相似性维度" });
      if (!db.prepare("SELECT track_id FROM similarity_calibration_tracks WHERE track_id=?").get(trackId)) return sendJson(response, 404, { error: "请先把歌曲加入校准集合" });
      const body = await readJson(request);
      const observation = String(body.observation || "").trim().slice(0, 1500);
      const boundary = String(body.boundary || "").trim().slice(0, 1500);
      const evidence = String(body.evidence || "").trim().slice(0, 1000);
      const source = ["manual", "llm_draft", "codex_reviewed", "human_reviewed"].includes(body.source) ? body.source : "manual";
      db.prepare(`INSERT INTO similarity_annotations (track_id, dimension_key, observation, boundary, evidence, source)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(track_id, dimension_key) DO UPDATE SET
        observation=excluded.observation, boundary=excluded.boundary, evidence=excluded.evidence,
        source=excluded.source, updated_at=CURRENT_TIMESTAMP`).run(trackId, dimension, observation, boundary, evidence, source);
      db.prepare("UPDATE similarity_calibration_tracks SET updated_at=CURRENT_TIMESTAMP WHERE track_id=?").run(trackId);
      return sendJson(response, 200, { ok: true, tracks: calibrationRows() });
    }
    if (request.method === "POST" && url.pathname === "/api/similarity/comparisons/draft") {
      const entries = calibrationRows();
      if (entries.length < 4) return sendJson(response, 400, { error: "至少需要4首校准歌曲" });
      const payload = entries.map((entry) => ({
        id: Number(entry.track.id.replace("local-", "")), title: entry.track.title, artist: entry.track.artist,
        dimensions: Object.fromEntries(Object.entries(entry.annotations).map(([key, value]) => [key, { observation: value.observation, boundary: value.boundary }])),
      }));
      const system = `你是音乐相似性标注体系的校准策划器。请从提供的歌曲中挑选8组有验证价值的两两比较：既要有表面相似但关键维度不同的反例，也要有跨年代或语言但核心体验相似的正例。只能使用提供的歌曲ID和维度描述，不得补充未提供的音频事实。
每组选择1到3个最关键维度，说明相似在哪里、不同在哪里，以及使用了哪些已提供标注作为证据。不要仅按歌手、语言或年代配对。
只返回JSON：{"pairs":[{"leftId":1,"rightId":2,"dimensions":["emotion"],"similarity":"","difference":"","evidence":""}]}。`;
      const result = await deepseekJson(system, { tracks: payload }, 3600);
      const allowedIds = new Set(payload.map((item) => item.id));
      const allowedDimensions = new Set(["emotion", "dynamics", "vocal", "melody", "rhythm", "arrangement", "narrative", "culture"]);
      const saved = [];
      for (const pair of Array.isArray(result.value?.pairs) ? result.value.pairs.slice(0, 8) : []) {
        const leftId = Number(pair.leftId); const rightId = Number(pair.rightId);
        const dimensions = (Array.isArray(pair.dimensions) ? pair.dimensions : []).filter((item) => allowedDimensions.has(item)).slice(0, 3);
        const similarity = String(pair.similarity || "").trim().slice(0, 2000);
        const difference = String(pair.difference || "").trim().slice(0, 2000);
        const evidence = String(pair.evidence || "").trim().slice(0, 1000);
        if (!allowedIds.has(leftId) || !allowedIds.has(rightId) || leftId === rightId || !dimensions.length || !similarity || !difference) continue;
        db.prepare(`INSERT INTO similarity_comparisons
          (left_track_id, right_track_id, dimensions_json, similarity_text, difference_text, evidence, source, review_status)
          VALUES (?, ?, ?, ?, ?, ?, 'llm_draft', 'codex_qa')`).run(leftId, rightId, JSON.stringify(dimensions), similarity, difference,
            `基于本地校准标注的模型组合（未进行音频分析）；${evidence}`.slice(0, 1000));
        saved.push([leftId, rightId]);
      }
      return sendJson(response, 201, { ok: true, saved: saved.length, comparisons: comparisonRows(), model: result.model, usage: result.usage });
    }
    if (request.method === "POST" && url.pathname === "/api/similarity/comparisons") {
      const body = await readJson(request);
      const leftId = Number(String(body.leftTrackId || "").replace("local-", ""));
      const rightId = Number(String(body.rightTrackId || "").replace("local-", ""));
      if (!leftId || !rightId || leftId === rightId) return sendJson(response, 400, { error: "请选择两首不同的歌曲" });
      const dimensions = (Array.isArray(body.dimensions) ? body.dimensions : []).filter((item) => typeof item === "string").slice(0, 8);
      const similarity = String(body.similarity || "").trim().slice(0, 2000);
      const difference = String(body.difference || "").trim().slice(0, 2000);
      const evidence = String(body.evidence || "").trim().slice(0, 1000);
      if (!dimensions.length || !similarity || !difference) return sendJson(response, 400, { error: "请选择比较维度，并写清相似与不同之处" });
      db.prepare(`INSERT INTO similarity_comparisons
        (left_track_id, right_track_id, dimensions_json, similarity_text, difference_text, evidence, source, review_status)
        VALUES (?, ?, ?, ?, ?, ?, 'human_reviewed', 'approved')`).run(leftId, rightId, JSON.stringify(dimensions), similarity, difference, evidence);
      return sendJson(response, 201, { ok: true, comparisons: comparisonRows() });
    }
    const comparisonMatch = url.pathname.match(/^\/api\/similarity\/comparisons\/(\d+)$/);
    if (request.method === "DELETE" && comparisonMatch) {
      db.prepare("DELETE FROM similarity_comparisons WHERE id=?").run(Number(comparisonMatch[1]));
      return sendJson(response, 200, { ok: true, comparisons: comparisonRows() });
    }
    if (request.method === "GET" && url.pathname === "/api/memories") {
      return sendJson(response, 200, { memories: memoryRows(), recentRequests: requestLogRows(20) });
    }
    if (request.method === "POST" && url.pathname === "/api/memories") {
      const body = await readJson(request);
      const statement = String(body.statement || "").trim().slice(0, 500);
      if (!statement) return sendJson(response, 400, { error: "请写下希望保存的推荐偏好" });
      const allowedCategories = new Set(["taste", "context", "boundary", "anchor", "reference"]);
      const category = allowedCategories.has(body.category) ? body.category : "taste";
      const scope = String(body.scope || "general").trim().slice(0, 60) || "general";
      const weight = Math.max(1, Math.min(3, Number(body.importance) || 2));
      const evidence = (Array.isArray(body.evidence) ? body.evidence : []).slice(0, 10).map((item) => ({
        trackId: String(item?.trackId || "").slice(0, 80), title: String(item?.title || "").slice(0, 200),
      })).filter((item) => item.trackId || item.title);
      upsertStatement({
        statement, scope, weight, category,
        polarity: category === "boundary" ? -1 : 1,
        confidence: 1,
        evidence,
        reason: "由用户直接创建并确认",
        source: "explicit_manual",
        status: "confirmed",
      });
      return sendJson(response, 201, { ok: true, memories: memoryRows() });
    }
    const memoryMatch = url.pathname.match(/^\/api\/memories\/(\d+)$/);
    if (request.method === "PATCH" && memoryMatch) {
      const id = Number(memoryMatch[1]);
      const existing = db.prepare("SELECT * FROM preference_statements WHERE id=? AND active=1").get(id);
      if (!existing) return sendJson(response, 404, { error: "偏好不存在" });
      const body = await readJson(request);
      const statement = String(body.statement ?? existing.statement).trim().slice(0, 500);
      if (!statement) return sendJson(response, 400, { error: "偏好内容不能为空" });
      const allowedCategories = new Set(["taste", "context", "boundary", "anchor", "reference"]);
      const category = allowedCategories.has(body.category) ? body.category : existing.category;
      const scope = String(body.scope ?? existing.scope).trim().slice(0, 60) || "general";
      const weight = Math.max(1, Math.min(3, Number(body.importance) || Number(existing.weight) || 2));
      const status = body.status === "pending" ? "pending" : "confirmed";
      const evidence = (Array.isArray(body.evidence) ? body.evidence : safeJson(existing.evidence_json, [])).slice(0, 10).map((item) => ({
        trackId: String(item?.trackId || "").slice(0, 80), title: String(item?.title || "").slice(0, 200),
      })).filter((item) => item.trackId || item.title);
      db.prepare(`UPDATE preference_statements SET statement=?, scope=?, polarity=?, weight=?,
        confidence=1, evidence_json=?, evidence_count=?, reason=?, source='explicit_manual', category=?, status=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?`).run(statement, scope, category === "boundary" ? -1 : 1, weight,
          JSON.stringify(evidence), Math.max(1, evidence.length), "由用户直接编辑并确认", category, status, id);
      return sendJson(response, 200, { ok: true, memories: memoryRows() });
    }
    if (request.method === "DELETE" && memoryMatch) {
      db.prepare("UPDATE preference_statements SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id = ?").run(Number(memoryMatch[1]));
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/feedback") {
      const body = await readJson(request);
      const id = Number(String(body.trackId || "").replace("local-", ""));
      const type = body.value === "dislike" ? "dislike" : "like";
      const track = db.prepare("SELECT id, title, artist, album, genre, folder FROM tracks WHERE id = ?").get(id);
      if (!track) return sendJson(response, 404, { error: "歌曲不存在" });
      const explanation = String(body.explanation || "").trim().slice(0, 1000);
      const scope = body.scope === "this_session" ? "this_session" : "long_term";
      const parsed = explanation
        ? (await interpretFeedback(track, type, explanation, scope)).value
        : { summary: type === "like" ? `喜欢《${track.title}》` : `不喜欢《${track.title}》`, statements: [] };
      db.prepare("INSERT INTO feedback (track_id, feedback_type, reason, session_id) VALUES (?, ?, ?, ?)").run(id, type, explanation, "local-user");
      db.prepare("INSERT INTO feedback_entries (track_id, verdict, explanation, scope, parsed_json) VALUES (?, ?, ?, ?, ?)").run(id, type, explanation, scope, JSON.stringify(parsed));
      if (type === "like") {
        db.prepare("INSERT OR IGNORE INTO user_playlist_items (playlist_id, track_id) VALUES (1, ?)").run(id);
        db.prepare("UPDATE user_playlists SET updated_at=CURRENT_TIMESTAMP WHERE id=1").run();
      }
      if (scope === "long_term") {
        for (const item of Array.isArray(parsed.statements) ? parsed.statements.slice(0, 5) : []) {
          const statement = String(item.statement || "").trim();
          if (!statement) continue;
          upsertStatement({ statement, scope: "general", polarity: Number(item.polarity) < 0 ? -1 : 1, confidence: Number(item.confidence) || 0.8, evidence: [{ trackId: `local-${id}`, title: track.title }], reason: String(item.reason || `来自你对《${track.title}》的明确解释`), source: "explicit_feedback" });
        }
      }
      return sendJson(response, 200, { ok: true, interpretation: parsed, scope, memories: memoryRows(), playlists: userPlaylistRows() });
    }
    const audioMatch = url.pathname.match(/^\/api\/tracks\/(\d+)\/audio$/);
    if (request.method === "GET" && audioMatch) return streamTrack(request, response, Number(audioMatch[1]));
    const playMatch = url.pathname.match(/^\/api\/tracks\/(\d+)\/play$/);
    if (request.method === "POST" && playMatch) {
      const id = Number(playMatch[1]);
      db.prepare("UPDATE tracks SET play_count=play_count+1, last_played_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
      db.prepare("INSERT INTO play_events (track_id, event_type) VALUES (?, 'play')").run(id);
      return sendJson(response, 200, { ok: true });
    }
    return sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return sendJson(response, 500, { error: error instanceof Error ? error.message : "Internal error" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Moment music service: http://localhost:${port}`);
  console.log(`Library: ${libraryRoot}`);
  const count = db.prepare("SELECT COUNT(*) AS count FROM tracks").get().count;
  if (count === 0) scanLibrary().catch(console.error);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { server.close(); db.close(); process.exit(0); });
}
