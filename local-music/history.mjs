import { db } from "./db.mjs";
import { logicalTrackKey } from "./recommendation-core.mjs";

// Play history across YouTube Music (imported) and this app. Plays are grouped per song: a song in
// the library groups by title+artist across copies; a YouTube song not in the library groups by its
// YouTube entry and is still listed (it just cannot be played here). Periods use local time.
const DAY = 86_400_000;
const LIMIT = 500;

export function buildHistory(now = new Date()) {
  const events = db.prepare(`SELECT e.created_at, e.source, e.track_id, t.title AS track_title, t.artist AS track_artist,
      s.id AS external_id, s.title AS external_title, s.artist AS external_artist
    FROM listening_events e
    LEFT JOIN tracks t ON t.id=e.track_id AND t.available=1
    LEFT JOIN external_songs s ON s.id=e.external_song_id
    WHERE e.event_type='play'`).all();
  const plays = [];
  for (const event of events) {
    const at = Date.parse(event.created_at);
    if (!Number.isFinite(at)) continue;
    const inLibrary = Boolean(event.track_title);
    const title = inLibrary ? event.track_title : event.external_title;
    const artist = inLibrary ? event.track_artist : event.external_artist;
    if (!title) continue;
    plays.push({ at, key: inLibrary ? logicalTrackKey({ title, artist }) : `yt:${event.external_id}`,
      trackId: inLibrary ? Number(event.track_id) : null, title, artist, source: event.source });
  }

  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const startOfYear = new Date(now.getFullYear(), 0, 1).getTime();
  const group = (from) => {
    const songs = new Map();
    for (const play of plays) {
      if (play.at < from) continue;
      const song = songs.get(play.key) || { trackId: play.trackId, title: play.title, artist: play.artist, plays: 0, lastPlayedAt: 0, sources: new Set() };
      song.plays += 1;
      song.trackId ??= play.trackId;
      song.sources.add(play.source);
      if (play.at > song.lastPlayedAt) song.lastPlayedAt = play.at;
      songs.set(play.key, song);
    }
    return [...songs.values()].map((song) => ({ ...song, sources: [...song.sources], lastPlayedAt: new Date(song.lastPlayedAt).toISOString() }));
  };
  const byRecent = (list) => list.sort((left, right) => right.lastPlayedAt.localeCompare(left.lastPlayedAt));
  const byPlays = (list) => list.sort((left, right) => right.plays - left.plays || right.lastPlayedAt.localeCompare(left.lastPlayedAt));
  const allSongs = group(0);
  const latest = plays.reduce((max, play) => Math.max(max, play.at), 0);
  return {
    generatedAt: now.toISOString(),
    latestPlayAt: latest ? new Date(latest).toISOString() : null,
    latestBySource: Object.fromEntries(["youtube", "moment"].map((source) => {
      const last = plays.filter((play) => play.source === source).reduce((max, play) => Math.max(max, play.at), 0);
      return [source, last ? new Date(last).toISOString() : null];
    })),
    totalPlays: plays.length,
    // Every list keeps its top 500 songs.
    sections: {
      recent: byRecent([...allSongs]).slice(0, LIMIT),
      week: byRecent(group(now.getTime() - 7 * DAY)).slice(0, LIMIT),
      today: byPlays(group(startOfDay)).slice(0, LIMIT),
      month: byPlays(group(startOfMonth)).slice(0, LIMIT),
      year: byPlays(group(startOfYear)).slice(0, LIMIT),
      allTime: byPlays(allSongs).slice(0, LIMIT),
    },
    counts: { allSongs: allSongs.length },
  };
}
