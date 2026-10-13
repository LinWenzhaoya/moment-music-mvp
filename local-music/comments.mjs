import { db } from "./db.mjs";
import { logicalTrackKey } from "./recommendation-core.mjs";

// Song comments ("听歌手记"): what you felt while listening, with the moment it was written —
// time, position in the song and the playlist it played from. Comments belong to the song, not
// the file, so every copy of a song shares them.
export const COMMENT_MOODS = ["有掌控感", "想哭", "被治愈", "很燃", "怀念", "平静"];

db.exec(`CREATE TABLE IF NOT EXISTS song_comments (
  id INTEGER PRIMARY KEY, track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL, song_key TEXT NOT NULL,
  body TEXT NOT NULL, mood TEXT, position_seconds REAL, context TEXT, recommendation_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_song_comments_song ON song_comments(song_key, created_at)");

const trackRow = db.prepare("SELECT id, title, artist FROM tracks WHERE id=?");
const serialize = (row) => ({
  id: row.id, trackId: row.track_id ? `local-${row.track_id}` : null, title: row.title, artist: row.artist,
  body: row.body, mood: row.mood, positionSeconds: row.position_seconds, context: row.context,
  recommendationId: row.recommendation_id, createdAt: row.created_at, updatedAt: row.updated_at,
});

export function validateComment(input) {
  const body = String(input?.body ?? "").trim();
  if (!body) return { error: "写点什么再保存" };
  if (body.length > 2000) return { error: "最多 2000 字" };
  const mood = input?.mood ? String(input.mood).trim().slice(0, 20) : null;
  const position = Number(input?.positionSeconds);
  return {
    value: {
      body, mood: mood || null,
      positionSeconds: Number.isFinite(position) && position >= 0 ? Math.round(position) : null,
      context: input?.context ? String(input.context).trim().slice(0, 200) : null,
      recommendationId: Number.isInteger(Number(input?.recommendationId)) ? Number(input.recommendationId) : null,
    },
  };
}

export function commentsForTrack(trackId) {
  const track = trackRow.get(trackId);
  if (!track) return null;
  return db.prepare(`SELECT c.*, t.title, t.artist FROM song_comments c LEFT JOIN tracks t ON t.id=c.track_id
    WHERE c.song_key=? ORDER BY c.created_at DESC, c.id DESC`).all(logicalTrackKey(track)).map(serialize);
}

export function addComment(trackId, input) {
  const track = trackRow.get(trackId);
  if (!track) return { status: 404, error: "歌曲不存在" };
  const { value, error } = validateComment(input);
  if (error) return { status: 400, error };
  const result = db.prepare(`INSERT INTO song_comments (track_id, song_key, body, mood, position_seconds, context, recommendation_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(track.id, logicalTrackKey(track), value.body, value.mood, value.positionSeconds,
    value.context, value.recommendationId, new Date().toISOString(), new Date().toISOString());
  return { status: 201, comment: serialize({ ...db.prepare("SELECT * FROM song_comments WHERE id=?").get(Number(result.lastInsertRowid)), title: track.title, artist: track.artist }) };
}

export function journal(limit = 200) {
  return db.prepare(`SELECT c.*, t.title, t.artist FROM song_comments c LEFT JOIN tracks t ON t.id=c.track_id
    ORDER BY c.created_at DESC, c.id DESC LIMIT ?`).all(Math.min(1000, Math.max(1, limit))).map(serialize);
}

export async function handleCommentRoute(request, response, url, { sendJson, readJson }) {
  const songMatch = url.pathname.match(/^\/api\/tracks\/(\d+)\/comments$/);
  if (songMatch && request.method === "GET") {
    const comments = commentsForTrack(Number(songMatch[1]));
    sendJson(response, comments ? 200 : 404, comments ? { comments, moods: COMMENT_MOODS } : { error: "歌曲不存在" });
    return true;
  }
  if (songMatch && request.method === "POST") {
    const result = addComment(Number(songMatch[1]), await readJson(request));
    sendJson(response, result.status, result.error ? { error: result.error } : { comment: result.comment });
    return true;
  }
  if (url.pathname === "/api/comments" && request.method === "GET") {
    sendJson(response, 200, { comments: journal(Number(url.searchParams.get("limit") || 200)), moods: COMMENT_MOODS });
    return true;
  }
  const commentMatch = url.pathname.match(/^\/api\/comments\/(\d+)$/);
  if (commentMatch && request.method === "PATCH") {
    const { value, error } = validateComment(await readJson(request));
    if (error) { sendJson(response, 400, { error }); return true; }
    const changed = db.prepare("UPDATE song_comments SET body=?, mood=?, updated_at=? WHERE id=?")
      .run(value.body, value.mood, new Date().toISOString(), Number(commentMatch[1])).changes;
    sendJson(response, changed ? 200 : 404, changed ? { ok: true } : { error: "记录不存在" });
    return true;
  }
  if (commentMatch && request.method === "DELETE") {
    const changed = db.prepare("DELETE FROM song_comments WHERE id=?").run(Number(commentMatch[1])).changes;
    sendJson(response, changed ? 200 : 404, changed ? { ok: true } : { error: "记录不存在" });
    return true;
  }
  return false;
}
