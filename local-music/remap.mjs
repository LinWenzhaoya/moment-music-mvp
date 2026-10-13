import { db } from "./db.mjs";
import { logicalTrackKey } from "./recommendation-core.mjs";

// When the library is rebuilt, rows that point at tracks whose file is gone (available=0) are moved to
// the same song in the current library (same artist + title). Favourites, playlists, play history,
// feedback and notes then keep working instead of pointing at a file that no longer exists.
const TABLES = ["listening_events", "feedback_entries", "recommendation_items", "song_comments", "play_events"];

// Spacing and punctuation differ between sources ("G.E.M. 邓紫棋" vs "G.E.M.邓紫棋"); versions such as
// "(Live)" stay distinct because the brackets' content is kept.
// Duet credits are also joined differently ("韩红、林俊杰" / "韩红&林俊杰").
export const looseKey = (row) => logicalTrackKey(row).replace(/[\s.·・_\-、&,，/]/g, "");

export function liveCopyIndex() {
  const index = new Map();
  for (const row of db.prepare("SELECT id, title, artist FROM tracks WHERE available=1 ORDER BY COALESCE(bitrate,0) DESC, id").all()) {
    const key = looseKey(row);
    if (!index.has(key)) index.set(key, Number(row.id));
  }
  return index;
}

export function remapUnavailableTracks() {
  const index = liveCopyIndex();
  const gone = db.prepare("SELECT id, title, artist FROM tracks WHERE available=0").all();
  const map = new Map(gone.map((row) => [Number(row.id), index.get(looseKey(row))]).filter(([, target]) => target));
  if (!map.size) return { mapped: 0, updated: {} };
  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  const updated = {};
  db.exec("BEGIN");
  try {
    for (const table of TABLES) {
      if (!columns(table).has("track_id")) continue;
      const update = db.prepare(`UPDATE ${table} SET track_id=? WHERE track_id=?`);
      let changes = 0;
      for (const [from, to] of map) changes += Number(update.run(to, from).changes || 0);
      if (changes) updated[table] = changes;
    }
    // Playlist items are unique per (playlist, track): move what can move, drop what is now a duplicate.
    const moveItem = db.prepare("UPDATE OR IGNORE user_playlist_items SET track_id=? WHERE track_id=?");
    const dropItem = db.prepare("DELETE FROM user_playlist_items WHERE track_id=?");
    let items = 0;
    for (const [from, to] of map) { items += Number(moveItem.run(to, from).changes || 0); dropItem.run(from); }
    if (items) updated.user_playlist_items = items;
    // AI playlists also keep an ordered id list in playlist_json.
    const setPlaylist = db.prepare("UPDATE recommendation_events SET playlist_json=? WHERE id=?");
    let playlists = 0;
    for (const event of db.prepare("SELECT id, playlist_json FROM recommendation_events").all()) {
      let ids; try { ids = JSON.parse(event.playlist_json || "[]"); } catch { continue; }
      let changed = false;
      const next = ids.map((id) => { const target = map.get(Number(String(id).replace("local-", ""))); if (target) { changed = true; return target; } return id; });
      if (changed) { setPlaylist.run(JSON.stringify(next), event.id); playlists += 1; }
    }
    if (playlists) updated.recommendation_events = playlists;
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { mapped: map.size, updated };
}
