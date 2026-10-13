import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseFile } from "music-metadata";
import { libraryRoot, projectRoot } from "../local-music/config.mjs";
import { db } from "../local-music/db.mjs";
import { deepseekJson } from "../local-music/llm.mjs";
import { buildTitleIndex, cleanArtistName, matchExternalSong, parseTakeoutTime, splitArtists } from "../local-music/song-matching.mjs";

const takeoutRoot = resolve(process.argv[2] || join(projectRoot, "YouTube and YouTube Music"));
const skipAliases = process.env.SKIP_ALIASES === "1";

function decodeHtml(value) {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function parseCsv(text) {
  const rows = []; let row = []; let field = ""; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === "\"" && text[index + 1] === "\"") { field += "\""; index += 1; }
      else if (char === "\"") quoted = false;
      else field += char;
    } else if (char === "\"") quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map((values) => Object.fromEntries(header.map((name, index) => [name.trim(), values[index] ?? ""])));
}

async function parseWatchHistory() {
  const html = await readFile(join(takeoutRoot, "history", "watch-history.html"), "utf8");
  const pattern = /<p class="mdl-typography--title">YouTube Music<br><\/p><\/div><div class="content-cell[^"]*">Watched\u00a0<a href="https:\/\/music\.youtube\.com\/watch\?v=([\w-]+)">(.*?)<\/a><br><a [^>]*>(.*?)<\/a><br>(.*?)<br>/g;
  const plays = [];
  for (const match of html.matchAll(pattern)) {
    const playedAt = parseTakeoutTime(match[4]);
    if (playedAt) plays.push({ videoId: match[1], title: decodeHtml(match[2]), artist: cleanArtistName(decodeHtml(match[3])), playedAt });
  }
  return plays;
}

const plays = await parseWatchHistory();
const library = parseCsv(await readFile(join(takeoutRoot, "music (library and uploads)", "music library songs.csv"), "utf8"));
const playlistDir = join(takeoutRoot, "playlists");
const playlistFiles = (await readdir(playlistDir)).filter((name) => name.endsWith(" videos.csv"));
const exportedAt = (await stat(join(takeoutRoot, "history", "watch-history.html"))).mtime.toISOString();

// Library metadata is cleaner than watch-history titles, so it wins when both exist.
const songs = new Map();
for (const play of plays) if (!songs.has(play.videoId)) songs.set(play.videoId, { title: play.title, artist: play.artist, album: null });
for (const row of library) {
  const artists = Object.keys(row).filter((key) => key.startsWith("Artist Name")).map((key) => row[key]).filter(Boolean);
  songs.set(row["Video ID"], { title: row["Song Title"], artist: artists.join("、") || songs.get(row["Video ID"])?.artist || "未知艺人", album: row["Album Title"] || null });
}

const upsertSong = db.prepare(`INSERT INTO external_songs (source, external_id, title, artist, album) VALUES ('youtube', ?, ?, ?, ?)
  ON CONFLICT(source, external_id) DO UPDATE SET title=excluded.title, artist=excluded.artist, album=excluded.album`);
db.exec("BEGIN");
for (const [videoId, song] of songs) upsertSong.run(videoId, song.title, song.artist, song.album);
db.exec("COMMIT");
const songIdByVideo = new Map(db.prepare("SELECT id, external_id FROM external_songs WHERE source='youtube'").all().map((row) => [row.external_id, row.id]));

// --- match to local library ---
const localTracks = db.prepare("SELECT id, title, artist, relative_path FROM tracks WHERE available=1").all();
const titleIndex = buildTitleIndex(localTracks);
// Files fetched by download_library.py carry "moment:<YouTube link>" in the comment tag — an exact link
// back to the history entry, even when the platform title differs (Hostage ↔ 人质).
const trackByVideo = new Map();
for (const track of localTracks) {
  try {
    const { native } = await parseFile(join(libraryRoot, track.relative_path), { skipCovers: true, duration: false });
    // ffmpeg writes it as an ID3v2.3 TXXX:comment frame, which the parser splits on "/" — rejoin first.
    const comment = Object.values(native).flat().filter((tag) => /^(TXXX:comment|COMM)/i.test(tag.id))
      .map((tag) => String(tag.value?.text ?? tag.value)).join("/");
    const videoId = comment.match(/moment:.*[?&]v=([\w-]{11})/)?.[1];
    if (videoId && !trackByVideo.has(videoId)) trackByVideo.set(videoId, track);
  } catch { /* unreadable tags: fall back to title matching */ }
}
// The downloader also exports every YouTube link that resolved to each MP3 (one song often has an MV,
// an audio upload and an English-title upload); the comment tag can hold only one of them.
const linksPath = resolve(process.env.YOUTUBE_LINKS || join(projectRoot, "..", "曲库下载", "youtube_links.json"));
const trackByFile = new Map(localTracks.map((track) => [basename(track.relative_path), track]));
try {
  for (const [file, links] of Object.entries(JSON.parse(await readFile(linksPath, "utf8")))) {
    const track = trackByFile.get(file);
    for (const link of track ? links : []) {
      const videoId = String(link).match(/[?&]v=([\w-]{11})/)?.[1];
      if (videoId && !trackByVideo.has(videoId)) trackByVideo.set(videoId, track);
    }
  }
} catch (error) { if (error.code !== "ENOENT") throw error; }
console.log(`YouTube ids linked to tracks: ${trackByVideo.size}`);
const matchSong = (videoId, song, aliases) => {
  const linked = trackByVideo.get(videoId);
  if (linked) return { track: linked, method: "youtube_link", candidates: [] };
  const result = matchExternalSong(song, titleIndex, aliases);
  return { ...result, method: result.track ? "title_artist" : null };
};
const loadAliases = () => {
  const aliases = new Map();
  for (const row of db.prepare("SELECT alias_key, canonical_artist FROM artist_aliases WHERE same=1").all()) {
    if (!aliases.has(row.alias_key)) aliases.set(row.alias_key, new Set());
    aliases.get(row.alias_key).add(row.canonical_artist);
  }
  return aliases;
};

if (!skipAliases) {
  // Only ask about single-artist pairs that already share a song title — keeps the LLM call small and precise.
  // Pairs are per individual artist so a duet teaches "JJ Lin ↔ 林俊杰" for every other song too.
  const aliases = loadAliases();
  const decided = new Set(db.prepare("SELECT alias_key, canonical_artist FROM artist_aliases").all().map((row) => `${row.alias_key}\u0000${row.canonical_artist}`));
  const pairs = new Map();
  for (const [videoId, song] of songs) {
    const { track, candidates } = matchSong(videoId, song, aliases);
    if (track) continue;
    for (const candidate of candidates) for (const external of splitArtists(song.artist)) for (const local of splitArtists(candidate.artist)) {
      const key = `${external}\u0000${local}`;
      if (external !== local && !decided.has(key)) pairs.set(key, { external, local, title: candidate.title });
    }
  }
  const pending = [...pairs.values()];
  console.log(`Artist alias pairs to verify: ${pending.length}`);
  const insertAlias = db.prepare("INSERT OR IGNORE INTO artist_aliases (alias_key, canonical_artist, same, source) VALUES (?, ?, ?, 'llm')");
  const system = `你在对齐两个音乐库里的歌手名。每一对中，external 来自 YouTube Music（常为英文名、拼音或繁体），local 来自本地曲库，二者有一首同名歌曲 title。判断它们是否指同一位歌手或组合（例如 Jay Chou 与 周杰伦、G.E.M. 与 邓紫棋、Eagles 与 老鹰乐队 为同一位）。同名翻唱、不同歌手唱同名歌必须判为 false。不确定时判 false。
只返回JSON：{"results":[{"i":0,"same":true}]}，i 为输入序号，每一对都要返回。`;
  for (let index = 0; index < pending.length; index += 60) {
    const batch = pending.slice(index, index + 60);
    const result = await deepseekJson(system, { pairs: batch.map((pair, i) => ({ i, external: pair.external, local: pair.local, title: pair.title })) }, 2400);
    const verdicts = new Map((Array.isArray(result.value?.results) ? result.value.results : []).map((item) => [Number(item.i), item.same === true]));
    batch.forEach((pair, i) => { if (verdicts.has(i)) insertAlias.run(pair.external, pair.local, verdicts.get(i) ? 1 : 0); });
    console.log(`Aliases: ${Math.min(index + 60, pending.length)}/${pending.length}`);
  }
}

const aliases = loadAliases();
const setMatch = db.prepare("UPDATE external_songs SET track_id=?, match_method=? WHERE id=?");
let matched = 0;
db.exec("BEGIN");
for (const [videoId, song] of songs) {
  const { track, method } = matchSong(videoId, song, aliases);
  if (track) matched += 1;
  setMatch.run(track?.id ?? null, method, songIdByVideo.get(videoId));
}
db.exec("COMMIT");

// --- events (idempotent via UNIQUE) ---
const trackIdBySong = new Map(db.prepare("SELECT id, track_id FROM external_songs WHERE source='youtube'").all().map((row) => [row.id, row.track_id]));
const insertEvent = db.prepare(`INSERT OR IGNORE INTO listening_events (source, event_type, track_id, external_song_id, context, created_at)
  VALUES ('youtube', ?, ?, ?, ?, ?)`);
const lastPlayed = new Map();
let playlistAdds = 0; let unknownPlaylistVideos = 0;
db.exec("BEGIN");
for (const play of plays) {
  const songId = songIdByVideo.get(play.videoId);
  insertEvent.run("play", trackIdBySong.get(songId), songId, "", play.playedAt);
  if (!lastPlayed.has(songId) || lastPlayed.get(songId) < play.playedAt) lastPlayed.set(songId, play.playedAt);
}
for (const row of library) {
  const songId = songIdByVideo.get(row["Video ID"]);
  insertEvent.run("like", trackIdBySong.get(songId), songId, "", lastPlayed.get(songId) || exportedAt);
}
for (const file of playlistFiles) {
  const playlistName = basename(file, " videos.csv");
  for (const row of parseCsv(await readFile(join(playlistDir, file), "utf8"))) {
    const songId = songIdByVideo.get(row["Video ID"]);
    if (!songId) { unknownPlaylistVideos += 1; continue; }
    insertEvent.run("playlist_add", trackIdBySong.get(songId), songId, playlistName, row["Playlist video creation timestamp"] || exportedAt);
    playlistAdds += 1;
  }
}
// INSERT OR IGNORE leaves earlier rows untouched, so re-point every YouTube event at the current match
// (otherwise a rescanned library keeps events tied to tracks that no longer exist).
db.exec("UPDATE listening_events SET track_id=(SELECT track_id FROM external_songs s WHERE s.id=listening_events.external_song_id) WHERE source='youtube'");
db.exec("COMMIT");

const matchedPlays = plays.filter((play) => trackIdBySong.get(songIdByVideo.get(play.videoId))).length;
const localLogical = new Set(localTracks.map((track) => `${track.artist}\u0000${track.title}`)).size;
const coveredLocal = db.prepare("SELECT COUNT(DISTINCT track_id) AS count FROM external_songs WHERE track_id IS NOT NULL").get().count;
const unmatchedTop = db.prepare(`SELECT s.title, s.artist, COUNT(*) AS plays FROM listening_events e JOIN external_songs s ON s.id=e.external_song_id
  WHERE e.source='youtube' AND e.event_type='play' AND s.track_id IS NULL GROUP BY s.id ORDER BY plays DESC LIMIT 15`).all();
console.log(JSON.stringify({
  plays: plays.length, uniqueSongs: songs.size, librarySongs: library.length, playlists: playlistFiles.length,
  playlistAdds, unknownPlaylistVideos, aliases: db.prepare("SELECT COUNT(*) AS count FROM artist_aliases WHERE same=1").get().count,
  matchedSongs: matched, matchedSongRate: +(matched / songs.size).toFixed(3),
  matchedPlays, matchedPlayRate: +(matchedPlays / plays.length).toFixed(3),
  localTracksWithHistory: coveredLocal, localLogicalTracks: localLogical,
  topUnmatchedByPlays: unmatchedTop.map((row) => `${row.plays}× ${row.title} · ${row.artist}`),
}, null, 2));
