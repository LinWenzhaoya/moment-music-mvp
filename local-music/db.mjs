import { DatabaseSync } from "node:sqlite";
import { databasePath } from "./config.mjs";

export function safeJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

export const db = new DatabaseSync(databasePath);
db.exec("PRAGMA journal_mode = WAL");
// Several scripts (tagging, audio features, server) share this file; wait for a writer instead of failing.
db.exec("PRAGMA busy_timeout = 30000");
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
db.exec(`CREATE TABLE IF NOT EXISTS external_songs (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL,
  title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT,
  track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL, match_method TEXT,
  UNIQUE(source, external_id)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS listening_events (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, event_type TEXT NOT NULL,
  track_id INTEGER REFERENCES tracks(id) ON DELETE CASCADE,
  external_song_id INTEGER REFERENCES external_songs(id) ON DELETE CASCADE,
  played_seconds REAL, context TEXT, created_at TEXT NOT NULL,
  UNIQUE(source, event_type, external_song_id, created_at, context)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS artist_aliases (
  alias_key TEXT NOT NULL, canonical_artist TEXT NOT NULL, same INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'llm', PRIMARY KEY(alias_key, canonical_artist)
)`);
// One vector per (track, text variant) so recall variants can be compared side by side. Vectors are
// derived data: an old single-variant table is dropped and rebuilt by scripts/build-embeddings.mjs.
const embeddingColumns = new Set(db.prepare("PRAGMA table_info(track_embeddings)").all().map((column) => column.name));
if (embeddingColumns.size && !embeddingColumns.has("variant")) db.exec("DROP TABLE track_embeddings");
db.exec(`CREATE TABLE IF NOT EXISTS track_embeddings (
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, variant TEXT NOT NULL,
  text_hash TEXT NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL, vector BLOB NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(track_id, variant)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS song_tags_v2 (
  track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  genre_json TEXT NOT NULL DEFAULT '{}', sound_json TEXT NOT NULL DEFAULT '{}',
  arc_json TEXT NOT NULL DEFAULT '{}', mood_json TEXT NOT NULL DEFAULT '[]',
  scene_json TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL,
  valence REAL, arousal REAL, model TEXT NOT NULL, prompt_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', raw_json TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
// v2.2 filterable fields: fixed vocabularies so the planner can hard-filter on them.
const songTagColumns = new Set(db.prepare("PRAGMA table_info(song_tags_v2)").all().map((column) => column.name));
for (const [name, type] of [["language", "TEXT"], ["vocal_presence", "TEXT"], ["vocal_type", "TEXT"], ["tempo", "TEXT"],
  ["acoustic_electronic", "TEXT"], ["arc_shape", "TEXT"], ["lyric_theme_json", "TEXT NOT NULL DEFAULT '[]'"],
  ["lyric_contrast", "TEXT"], ["common_use_json", "TEXT NOT NULL DEFAULT '[]'"]]) {
  if (!songTagColumns.has(name)) db.exec(`ALTER TABLE song_tags_v2 ADD COLUMN ${name} ${type}`);
}
// Objective audio measurements computed locally (scripts/audio-features.py), not by the model.
db.exec(`CREATE TABLE IF NOT EXISTS track_audio_features (
  track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  bpm REAL, bpm_perceived REAL, loudness_lufs REAL, modified_at INTEGER, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS user_interest_clusters (
  id INTEGER PRIMARY KEY, built_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  event_count INTEGER NOT NULL, k INTEGER NOT NULL, silhouette REAL,
  centers BLOB NOT NULL, weights_json TEXT NOT NULL, dim INTEGER NOT NULL
)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_external_songs_track ON external_songs(track_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_listening_events_track ON listening_events(track_id, created_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_listening_events_external ON listening_events(external_song_id)");
db.exec("PRAGMA optimize");
