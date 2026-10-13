import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { parseFile } from "music-metadata";
import { projectRoot } from "../local-music/config.mjs";
import { db } from "../local-music/db.mjs";
import { deepseekJson } from "../local-music/llm.mjs";
import { aggregateBehavior, parseDbTime } from "../local-music/personalization.mjs";
import { buildTitleIndex, cleanArtistName, matchExternalSong, normalizeTitle, splitArtists } from "../local-music/song-matching.mjs";

// Builds the library acquisition plan (曲库清单). Layers:
//   D 现有合集保留：新歌/华语部分全留，80–90 年代粤语 + 欧美老歌只留 OLDIES_KEEP 首
//   A 个人核心：YouTube 收藏 / 加入歌单 / 播放 ≥2 次，且合集里没有
//   B 口味延伸：只播过 1 次的歌，且该歌手你总共听过 ≥ B_MIN_ARTIST_PLAYS 次
//   C 重点场景：从你的场景歌单出发，由模型补充（标记为待核实）
// Re-runnable: after downloading, point COLLECTION_PATH at the grown collection and run again —
// songs you already have drop out of the download list.
const collectionRoot = resolve(process.env.COLLECTION_PATH || join(projectRoot, "..", "歌曲合集"));
const outDir = resolve(process.env.PLAN_OUT || join(projectRoot, "..", "曲库清单"));
const OLDIES_KEEP = Number(process.env.OLDIES_KEEP || 1000);
const B_MIN_ARTIST_PLAYS = Number(process.env.B_MIN_ARTIST_PLAYS || 10);
const SCENES = [
  { name: "专注·读书", playlists: ["读书", "冥想", "Chopin", "yiruma", "bach", "古典", "debussy", "纯音乐"], count: 80 },
  { name: "开车·夜晚", playlists: ["Driving", "开车", "0902R&B", "rnb", "london"], count: 80 },
  { name: "运动·高能", playlists: ["exercise", "运动", "0807high", "电音", "1214燃", "欢乐", "多巴胺"], count: 80 },
  { name: "放松·雨天", playlists: ["小雨天气", "0628舒服的", "柔", "无聊"], count: 80 },
];

// Model judgements (classic-ness, scene picks) are cached so re-runs are stable and free.
mkdirSync(outDir, { recursive: true });
const cachePath = join(outDir, "cache.json");
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : { fame: {}, scenes: {} };
const saveCache = () => writeFileSync(cachePath, JSON.stringify(cache, null, 1));

// ---------- existing collection ----------
const audioFiles = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(mp3|flac|m4a|aac|wav|ogg)$/i.test(name)) audioFiles.push(path);
  }
};
walk(collectionRoot);

function namesFromFilename(path) {
  const stem = basename(path, extname(path)).replace(/^\d+[.\s、_-]+/, "");
  const spaced = stem.lastIndexOf(" - ");
  const index = spaced >= 0 ? spaced : stem.indexOf("-");
  if (index <= 0) return [];
  const left = stem.slice(0, index).trim(); const right = stem.slice(index + (spaced >= 0 ? 3 : 1)).trim().replaceAll("_", "、");
  // Folders mix "歌手-歌名" and "歌名 - 歌手"; keep both readings and let matching decide.
  return [{ title: left, artist: right }, { title: right, artist: left }];
}

const collection = [];
for (const path of audioFiles) {
  const relative = path.slice(collectionRoot.length + 1);
  const [top, sub = ""] = relative.split("/");
  let tag = {};
  try { tag = (await parseFile(path, { skipCovers: true, duration: false })).common; } catch { /* unreadable tags fall back to filename */ }
  const readings = tag.title && tag.artist ? [{ title: tag.title.trim(), artist: tag.artist.trim() }]
    : namesFromFilename(path).length ? namesFromFilename(path)
      : [{ title: basename(path, extname(path)).replace(/^\d+[.\s、_-]+/, ""), artist: path.split("/").at(-2) }];
  const oldie = top === "粤语歌曲精选" || (top === "欧美英文歌曲精选" && !/年流行英文歌曲榜单/.test(sub));
  collection.push({ path: relative, top, sub, readings, size: statSync(path).size, oldie, region: top === "粤语歌曲精选" ? "粤语" : "欧美" });
}
// Deduplicate identical songs across compilations; appearing in several compilations is itself a "classic" signal.
const byKey = new Map();
for (const entry of collection) {
  const key = `${normalizeTitle(entry.readings[0].title)}|${splitArtists(entry.readings[0].artist)[0] || ""}`;
  const existing = byKey.get(key);
  if (!existing) byKey.set(key, { ...entry, copies: 1 });
  else { existing.copies += 1; if (entry.size > existing.size) Object.assign(existing, { ...entry, copies: existing.copies }); }
}
const songsInCollection = [...byKey.values()].map((entry, id) => ({ ...entry, id }));
const indexRows = songsInCollection.flatMap((entry) => entry.readings.map((reading) => ({ id: entry.id, ...reading })));
const collectionIndex = buildTitleIndex(indexRows);
console.log(`Collection: ${audioFiles.length} files → ${songsInCollection.length} songs (${songsInCollection.filter((s) => s.oldie).length} oldies)`);

// ---------- your YouTube history ----------
const aliases = new Map();
for (const row of db.prepare("SELECT alias_key, canonical_artist FROM artist_aliases WHERE same=1").all()) {
  if (!aliases.has(row.alias_key)) aliases.set(row.alias_key, new Set());
  aliases.get(row.alias_key).add(row.canonical_artist);
}
const events = db.prepare(`SELECT external_song_id AS key, source, event_type AS type, created_at FROM listening_events
  WHERE source='youtube' AND external_song_id IS NOT NULL`).all().map((row) => ({ ...row, at: parseDbTime(row.created_at) }));
const behavior = aggregateBehavior(events);
const history = db.prepare(`SELECT s.id, s.external_id, s.title, s.artist, s.album,
    SUM(e.event_type='play') AS plays, MAX(e.event_type='like') AS liked,
    GROUP_CONCAT(DISTINCT CASE WHEN e.event_type='playlist_add' THEN e.context END) AS playlists, MAX(e.created_at) AS last_at
  FROM external_songs s JOIN listening_events e ON e.external_song_id=s.id WHERE e.source='youtube' GROUP BY s.id`).all()
  .map((row) => ({ ...row, artist: cleanArtistName(row.artist), score: behavior.get(row.id)?.score || 0 }))
  // Takeout replaces the title with the URL once a video is removed — nothing left to download.
  .filter((row) => !/^https?:\/\//.test(row.title));
const artistPlays = new Map();
for (const song of history) for (const artist of splitArtists(song.artist)) artistPlays.set(artist, (artistPlays.get(artist) || 0) + song.plays);
const affinity = (artist) => Math.max(0, ...splitArtists(artist).flatMap((name) => [artistPlays.get(name) || 0, ...[...(aliases.get(name) || [])].map((alias) => artistPlays.get(alias) || 0)]));

const coveredCollectionIds = new Map(); // collection id → best history song
for (const song of history) {
  const hit = matchExternalSong(song, collectionIndex, aliases).track;
  song.inCollection = Boolean(hit);
  if (hit && (!coveredCollectionIds.has(hit.id) || coveredCollectionIds.get(hit.id).score < song.score)) coveredCollectionIds.set(hit.id, song);
}

// ---------- layer D: keep list ----------
const oldies = songsInCollection.filter((entry) => entry.oldie);
const fame = new Map(oldies.filter((entry) => cache.fame[entry.path]).map((entry) => [entry.id, cache.fame[entry.path]]));
const unscored = oldies.filter((entry) => !fame.has(entry.id));
const fameSystem = `你是资深乐评人。为每首歌的知名度与经典程度打 1-5 分：5=家喻户晓、跨代传唱的代表作；4=当年的热门金曲；3=歌手的知名作品；2=一般专辑曲目；1=冷门或无法确认。只依据你对这首歌的了解，不确定就给 2。只返回JSON：{"scores":[{"i":0,"s":3}]}，每首都要返回。`;
for (let index = 0; index < unscored.length; index += 80) {
  const batch = unscored.slice(index, index + 80);
  const result = await deepseekJson(fameSystem, { songs: batch.map((entry, i) => ({ i, title: entry.readings[0].title, artist: entry.readings[0].artist, region: entry.region })) }, 1600);
  for (const item of Array.isArray(result.value?.scores) ? result.value.scores : []) {
    const entry = batch[Number(item.i)];
    if (entry) { fame.set(entry.id, Math.max(1, Math.min(5, Number(item.s) || 2))); cache.fame[entry.path] = fame.get(entry.id); }
  }
  saveCache();
  console.log(`Fame scoring: ${Math.min(index + 80, unscored.length)}/${unscored.length}`);
}
// Your own listening dominates; then artists you know; then classic status; then presence in several compilations.
const oldieScore = (entry) => {
  const listened = coveredCollectionIds.get(entry.id);
  const artistAffinity = Math.max(...entry.readings.map((reading) => affinity(reading.artist)));
  return (listened ? 100 + listened.score * 10 : 0) + Math.log1p(artistAffinity) * 6 + (fame.get(entry.id) || 2) * 8 + (entry.copies - 1) * 3;
};
const oldieQuota = { 粤语: Math.round(OLDIES_KEEP * oldies.filter((e) => e.region === "粤语").length / oldies.length) };
oldieQuota.欧美 = OLDIES_KEEP - oldieQuota.粤语;
const keptOldies = new Set();
for (const region of ["粤语", "欧美"]) {
  oldies.filter((entry) => entry.region === region).sort((left, right) => oldieScore(right) - oldieScore(left))
    .slice(0, oldieQuota[region]).forEach((entry) => keptOldies.add(entry.id));
}
const keepRows = songsInCollection.filter((entry) => !entry.oldie || keptOldies.has(entry.id));
const dropRows = songsInCollection.filter((entry) => entry.oldie && !keptOldies.has(entry.id));

// ---------- layers A and B ----------
const youtubeLink = (id) => `https://music.youtube.com/watch?v=${id}`;
const dedupeSongs = (songs) => [...new Map(songs.map((song) => [`${normalizeTitle(song.title)}|${splitArtists(song.artist)[0]}`, song])).values()];
const layerA = dedupeSongs(history.filter((song) => !song.inCollection && (song.liked || song.playlists || song.plays >= 2))
  .sort((left, right) => right.score - left.score));
const layerB = dedupeSongs(history.filter((song) => !song.inCollection && !song.liked && !song.playlists && song.plays <= 1 && affinity(song.artist) >= B_MIN_ARTIST_PLAYS)
  .sort((left, right) => affinity(right.artist) - affinity(left.artist) || right.score - left.score))
  .filter((song) => !layerA.some((core) => normalizeTitle(core.title) === normalizeTitle(song.title) && splitArtists(core.artist)[0] === splitArtists(song.artist)[0]));

// ---------- layer C: focused scenes ----------
const known = new Set([...history, ...indexRows].map((song) => `${normalizeTitle(song.title)}|${splitArtists(song.artist)[0]}`));
const playlistMembers = db.prepare(`SELECT DISTINCT e.context, s.title, s.artist FROM listening_events e JOIN external_songs s ON s.id=e.external_song_id
  WHERE e.event_type='playlist_add'`).all();
const layerC = [];
const sceneSystem = `你在为一个个人音乐推荐系统补充曲库。给定一个听歌场景和用户在这个场景下真实收藏的歌（seeds），推荐同一场景、同一口味方向、但不在 seeds 里的歌。
要求：只推荐真实存在、能在主流音乐平台找到的录音室版本；歌名和歌手名用官方写法；不确定是否存在的不要写；覆盖多位歌手，同一歌手不超过 3 首；贴合 seeds 体现的语言和风格比例。
只返回JSON：{"songs":[{"title":"","artist":""}]}`;
for (const scene of SCENES) {
  const seeds = playlistMembers.filter((row) => scene.playlists.includes(row.context)).map((row) => ({ title: row.title, artist: cleanArtistName(row.artist) }));
  if (!seeds.length) continue;
  if (!cache.scenes[scene.name]) {
    const result = await deepseekJson(sceneSystem, { scene: scene.name, want: Math.round(scene.count * 1.2), seeds: seeds.slice(0, 60) }, 7000);
    cache.scenes[scene.name] = Array.isArray(result.value?.songs) ? result.value.songs : [];
    saveCache();
  }
  const picks = [];
  for (const song of cache.scenes[scene.name]) {
    const key = `${normalizeTitle(song.title)}|${splitArtists(song.artist)[0]}`;
    if (!song.title || !song.artist || known.has(key)) continue;
    known.add(key);
    picks.push({ title: String(song.title).trim(), artist: String(song.artist).trim(), scene: scene.name, seedCount: seeds.length });
    if (picks.length >= scene.count) break;
  }
  layerC.push(...picks);
  console.log(`Scene ${scene.name}: ${seeds.length} seeds → ${picks.length} new songs`);
}

// ---------- write CSVs (UTF-8 BOM so Excel opens Chinese correctly) ----------
const csv = (header, rows) => `\ufeff${[header, ...rows].map((row) => row.map((cell) => {
  const text = String(cell ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}).join(",")).join("\n")}\n`;
const reasonA = (song) => [song.liked ? "收藏" : null, song.playlists ? `歌单:${song.playlists}` : null, song.plays ? `播放${song.plays}次` : null].filter(Boolean).join("；");
const versionNote = (title) => {
  const text = title.toLowerCase();
  if (/halftime|medley|串烧|mashup/.test(text)) return "非单曲（串烧/演出）";
  if (/歌詞|歌词|lyrics|《|【/.test(title)) return "搬运/歌词视频，建议下载官方版";
  if (/\blive\b|现场|現場|演唱会|演唱會|vevo studios|stripped/.test(text)) return "现场版";
  if (/remix|\bmix\b|sped up|slowed|nightcore|phonk/.test(text)) return "Remix/改编版";
  if (/cover|翻唱|acoustic|piano version|instrumental/.test(text)) return "翻唱/改编";
  return "";
};
const searchLink = (song) => `https://music.youtube.com/search?q=${encodeURIComponent(`${song.title} ${song.artist}`)}`;
const downloadRows = [
  ...layerA.map((song, index) => ["A 个人核心", index + 1, song.title, song.artist, song.album || "", reasonA(song), song.plays, song.score.toFixed(2), song.last_at?.slice(0, 10) || "", youtubeLink(song.external_id), versionNote(song.title)]),
  ...layerB.map((song, index) => ["B 口味延伸", index + 1, song.title, song.artist, song.album || "", `歌手累计播放${affinity(song.artist)}次；本曲播放${song.plays}次`, song.plays, song.score.toFixed(2), song.last_at?.slice(0, 10) || "", youtubeLink(song.external_id), versionNote(song.title)]),
  ...layerC.map((song, index) => [`C 场景·${song.scene}`, index + 1, song.title, song.artist, "", `由模型根据你的场景歌单（${song.seedCount} 首）补充`, 0, "", "", searchLink(song), "待核实"]),
];
writeFileSync(join(outDir, "1-下载清单.csv"), csv(["层级", "层内优先级", "歌名", "歌手", "专辑", "入选原因", "你的播放次数", "偏好分", "最近播放", "链接", "版本提示/备注"], downloadRows));
const collectionRow = (entry) => [entry.readings[0].title, entry.readings[0].artist, entry.top, entry.sub, entry.oldie ? `老歌（经典度${fame.get(entry.id) || "-"}）` : "新歌/华语", coveredCollectionIds.has(entry.id) ? "是" : "", entry.copies, entry.path];
writeFileSync(join(outDir, "2-现有合集_保留.csv"), csv(["歌名", "歌手", "合集", "子目录", "类别", "在你的听歌历史里", "重复文件数", "文件路径"], keepRows.map(collectionRow)));
writeFileSync(join(outDir, "3-现有合集_不保留.csv"), csv(["歌名", "歌手", "合集", "子目录", "类别", "在你的听歌历史里", "重复文件数", "文件路径"], dropRows.map(collectionRow)));

const summary = {
  collection: { files: audioFiles.length, songs: songsInCollection.length, keep: keepRows.length, keptOldies: keptOldies.size, drop: dropRows.length, oldieQuota },
  download: { A: layerA.length, B: layerB.length, C: layerC.length, total: layerA.length + layerB.length + layerC.length },
  libraryAfterDownload: keepRows.length + layerA.length + layerB.length + layerC.length,
  outDir,
};
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
