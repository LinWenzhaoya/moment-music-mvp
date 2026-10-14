import { db } from "./db.mjs";
import { logicalTrackKey } from "./recommendation-core.mjs";
import { dot, normalize, weightedMean } from "./vector-math.mjs";

// Keeps repeated requests from returning the same playlist, and enforces the "不喜欢" blocklist.
//  - every generation: songs recommended in recent AI playlists lose a little recall similarity
//    (decays with age), plus a small random jitter so ties rotate;
//  - 换一批 (refresh): additionally excludes the songs of the playlist being replaced;
//  - 换个口味 (shift): also excludes its artists and pushes the query away from its sound.
const DAY = 86_400_000;

export function blockedKeys() {
  return new Set(db.prepare("SELECT song_key FROM song_blocks").all().map((row) => row.song_key));
}

export function blockedRows() {
  return db.prepare("SELECT song_key, track_id, title, artist, created_at FROM song_blocks ORDER BY created_at DESC").all();
}

export function blockSong(row) {
  db.prepare("INSERT OR IGNORE INTO song_blocks (song_key, track_id, title, artist) VALUES (?, ?, ?, ?)")
    .run(logicalTrackKey(row), Number(row.id), row.title, row.artist);
}

export function unblockSong(row) {
  db.prepare("DELETE FROM song_blocks WHERE song_key=?").run(logicalTrackKey(row));
}

// song key → decayed count of recent AI-playlist appearances.
export function recentExposure(config, now = Date.now()) {
  const since = new Date(now - config.windowDays * DAY).toISOString().replace("T", " ").slice(0, 19);
  const rows = db.prepare(`SELECT t.title, t.artist, e.created_at FROM recommendation_items i
    JOIN recommendation_events e ON e.id=i.recommendation_id JOIN tracks t ON t.id=i.track_id
    WHERE e.created_at >= ?`).all(since);
  const exposure = new Map();
  for (const row of rows) {
    const at = Date.parse(`${row.created_at.replace(" ", "T")}Z`);
    const ageDays = Math.max(0, (now - at) / DAY);
    const key = logicalTrackKey(row);
    exposure.set(key, (exposure.get(key) || 0) + 0.5 ** (ageDays / config.halfLifeDays));
  }
  return exposure;
}

export function previousPlaylist(id) {
  if (!Number.isFinite(id)) return null;
  const event = db.prepare("SELECT id, title, request_text FROM recommendation_events WHERE id=?").get(id);
  if (!event) return null;
  const rows = db.prepare(`SELECT t.* FROM recommendation_items i JOIN tracks t ON t.id=i.track_id
    WHERE i.recommendation_id=? ORDER BY i.position`).all(id);
  return { id: event.id, title: event.title, request: event.request_text, rows };
}

// Shift the query away from the previous playlist's sound while keeping the request's meaning.
export function shiftAway(queryVector, previousVectors, strength) {
  if (!previousVectors.length) return queryVector;
  const centre = normalize(weightedMean(previousVectors));
  const along = dot(queryVector, centre);
  // Remove part of the component along the old centre, then push slightly past it.
  return normalize(queryVector.map((value, index) => value - strength * (along + 0.15) * centre[index]));
}

// Adjusted recall similarity used for ordering: raw similarity minus exposure penalty, plus jitter.
export function freshSim(rawSim, exposure, config, random = Math.random) {
  return rawSim - config.penalty * Math.min(exposure, config.maxExposure) + (random() * 2 - 1) * config.jitter;
}
