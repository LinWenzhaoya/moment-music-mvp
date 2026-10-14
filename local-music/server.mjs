import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { extname, join, relative, resolve, sep } from "node:path";
import { parseFile } from "music-metadata";
import { dashscopeApiKey, deepseekApiKey, deepseekModel, isPlaceholderKey, libraryRoot, port, supportedExtensions } from "./config.mjs";
import { db, safeJson } from "./db.mjs";
import { deepseekJson } from "./llm.mjs";
import { familiarityForRow, getUserProfile, personalSignals, rankingConfig } from "./personalization.mjs";
import { applyMixQuota, mixTargets, perBatchPick, resolveMix, scoreCandidates, splitBatches, stratifiedRecall } from "./ranking.mjs";
import { splitArtists } from "./song-matching.mjs";
import { blendWithReferences, EMBEDDING_VARIANTS, embedQuery, loadVectorStore, recallSize, searchTopN } from "./retrieval.mjs";
import { applyHardFilters, loadSongTags, sanitizeHardFilters, TAG_VOCAB, tagSummaries } from "./song-tags.mjs";
import { handleEvalRoute } from "./eval-routes.mjs";
import { buildHistory } from "./history.mjs";
import { liveCopyIndex, looseKey, remapUnavailableTracks } from "./remap.mjs";
import { fixIdentity } from "./metadata-fixes.mjs";
import { handleCommentRoute } from "./comments.mjs";
import { blockedKeys, blockedRows, blockSong, freshSim, previousPlaylist, recentExposure, shiftAway, unblockSong } from "./freshness.mjs";
import { isTitleMention, logicalTrackKey, maximalTitleMatches, nearestTitleAfterArtist, normalizeMatch, sanitizeHardStyles } from "./recommendation-core.mjs";


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
        const identity = fixIdentity(relativePath, common.title?.trim() || fallback.title, common.artist?.trim() || fallback.artist);
        upsertTrack.run(
          relativePath, identity.title,
          identity.artist, common.album?.trim() || null,
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
    const remapped = remapUnavailableTracks();
    if (remapped.mapped) console.log("Re-pointed references to removed files:", JSON.stringify(remapped));
    scanState = { ...scanState, running: false, finishedAt: new Date().toISOString() };
    return scanState;
  })().finally(() => { scanPromise = null; });
  return scanPromise;
}

function moodFields(trackId) {
  const summary = tagSummaries().get(Number(trackId));
  return summary ? { valence: summary.valence, arousal: summary.arousal, chips: summary.chips, language: summary.language, instrumental: summary.instrumental }
    : { valence: null, arousal: null, chips: [], language: null, instrumental: false };
}

// A row whose file is gone is shown as the same song from the current library when there is one;
// otherwise it is marked missing (no audio) instead of failing when clicked.
let liveCopies = null; let liveCopiesAt = 0;
function liveCopyOf(row) {
  if (!liveCopies || Date.now() - liveCopiesAt > 5000) { liveCopies = liveCopyIndex(); liveCopiesAt = Date.now(); }
  const id = liveCopies.get(looseKey(row));
  return id ? db.prepare("SELECT * FROM tracks WHERE id=?").get(id) : null;
}

let blockedCache = null;
const isBlocked = (row) => (blockedCache ??= blockedKeys()).has(logicalTrackKey(row));

function serializeTrack(input) {
  const row = input.available === 0 ? liveCopyOf(input) || input : input;
  const missing = row.available === 0;
  const bitrateKbps = row.bitrate ? Math.round(row.bitrate / 1000) : null;
  const tags = [row.genre, row.folder, bitrateKbps ? `${bitrateKbps}kbps` : null].filter(Boolean);
  const kind = familiarityForRow(row);
  return {
    id: `local-${row.id}`, title: row.title, artist: row.artist,
    album: row.album, genre: row.genre || row.folder,
    kind, energy: 60, vocal: 55,
    tags, instruments: [], color: ["green", "orange", "violet", "blue", "gold", "cyan"][row.id % 6],
    duration: row.duration, bitrate: bitrateKbps, folder: row.folder,
    playCount: row.play_count, lastPlayedAt: row.last_played_at,
    audioUrl: missing ? undefined : `http://localhost:${port}/api/tracks/${row.id}/audio`, missing, blocked: isBlocked(row),
    ...moodFields(row.id),
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

function includesArtist(row, names) {
  const artist = row.artist.toLowerCase();
  return names.some((name) => artist.includes(String(name).toLowerCase()));
}

// Artist constraints and one row per logical song. Tag-based hard filters run on the result in
// vectorCandidates (song-tags.mjs), where the v2 audio tags are available.
function hardFilteredRows(plan) {
  const rawRows = db.prepare("SELECT * FROM tracks WHERE available=1 ORDER BY play_count DESC, COALESCE(bitrate,0) DESC, id").all();
  const canonicalRows = new Map();
  for (const row of rawRows) if (!canonicalRows.has(logicalTrackKey(row))) canonicalRows.set(logicalTrackKey(row), row);
  const allRows = [...canonicalRows.values()];
  const hardArtists = Array.isArray(plan.hardArtists) ? plan.hardArtists.filter(Boolean) : [];
  const excludedArtists = Array.isArray(plan.excludedArtists) ? plan.excludedArtists.filter(Boolean) : [];
  const allowedRows = excludedArtists.length ? allRows.filter((row) => !includesArtist(row, excludedArtists)) : allRows;
  return { base: hardArtists.length ? allowedRows.filter((row) => includesArtist(row, hardArtists)) : allowedRows, hardArtists };
}

// Coarse recall (relevance only, no personalisation) followed by the programmatic part of fine ranking.
async function vectorCandidates({ prompt, plan, includedSeeds, excludedSeedIds, count, store, tagsById, targets, variation, fresh }) {
  const { base: artistFiltered, hardArtists } = hardFilteredRows(plan);
  // Only audio-tagged songs (those with a vector) can be judged; hard filters run on their v2 tags.
  const tagged = artistFiltered.filter((row) => store.byId.has(row.id));
  const { rows: base, relaxed } = applyHardFilters(tagged, tagsById, plan.hardFilters, recallSize(count, rankingConfig.recall));
  const avoidTerms = (plan.mustAvoid || []).map(normalizeMatch).filter((term) => term.length >= 2);
  const avoidText = (row) => { const tags = tagsById.get(Number(row.id)); return tags ? normalizeMatch([tags.genre.primary, ...tags.genre.sub, ...tags.mood, ...tags.instruments].join(" ")) : ""; };
  const seedKeys = new Set(includedSeeds.map(logicalTrackKey));
  const blocked = blockedKeys();
  // 换一批 / 换个口味: never repeat the replaced playlist; 换个口味 also drops its artists.
  const previousKeys = new Set((variation?.previous?.rows || []).map(logicalTrackKey));
  const previousArtists = variation?.mode === "shift" && !hardArtists.length ? new Set(variation.previous.rows.flatMap((row) => splitArtists(row.artist))) : new Set();
  const eligible = base.filter((row) => !excludedSeedIds.has(Number(row.id)) && !seedKeys.has(logicalTrackKey(row))
    && !blocked.has(logicalTrackKey(row)) && !previousKeys.has(logicalTrackKey(row))
    && !splitArtists(row.artist).some((artist) => previousArtists.has(artist))
    && !avoidTerms.some((term) => avoidText(row).includes(term)));
  const referenceVectors = includedSeeds.map((row) => store.byId.get(row.id)).filter(Boolean);
  let queryVector = blendWithReferences(await embedQuery(prompt), referenceVectors, rankingConfig.recall.referenceBlend);
  if (variation?.mode === "shift") {
    const previousVectors = variation.previous.rows.map((row) => store.byId.get(row.id)).filter(Boolean);
    queryVector = shiftAway(queryVector, previousVectors, rankingConfig.freshness.shiftStrength);
  }
  const exposure = fresh ? recentExposure(rankingConfig.freshness) : new Map();
  const limit = recallSize(count, rankingConfig.recall);
  const artistCap = hardArtists.length ? Infinity : 4;
  const artistCounts = new Map();
  const profile = getUserProfile(store);
  // Recently recommended songs sink a little (decaying with age) and a small jitter rotates near-ties,
  // so the same request does not keep returning the same playlist.
  const ranked = searchTopN(queryVector, eligible, store, eligible.length)
    .map((item) => {
      const seen = exposure.get(logicalTrackKey(item.row)) || 0;
      return { ...item, rawSim: item.querySim, exposure: seen, querySim: fresh ? freshSim(item.querySim, seen, rankingConfig.freshness) : item.querySim,
        id: Number(item.row.id), bucket: familiarityForRow(item.row, profile) };
    })
    .sort((left, right) => right.querySim - left.querySim);
  const recalled = stratifiedRecall(ranked, (item) => item.bucket, targets, limit, {
    accept: (item) => {
      const artists = splitArtists(item.row.artist);
      if (artists.some((artist) => (artistCounts.get(artist) || 0) >= artistCap)) return false;
      for (const artist of artists) artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1);
      return true;
    },
  });
  const scored = scoreCandidates(recalled.map((item) => ({
    id: Number(item.row.id), row: item.row, querySim: item.querySim, rawSim: item.rawSim, exposure: item.exposure,
    personal: personalSignals(item.row, item.vector, profile), bucket: item.bucket,
  })), rankingConfig);
  return { scored, profile, eligibleCount: eligible.length, taggedCount: tagged.length, relaxed, referenceCount: referenceVectors.length,
    blockedCount: blocked.size, recentlyRecommended: exposure.size };
}

const round3 = (value) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null);

function referencePolicy(plan, seeds) {
  const instructions = Array.isArray(plan.referenceTracks) ? plan.referenceTracks : [];
  // "ignore": the title only appears as ordinary words ("深夜一个人开车" is not a request for the song 一个人).
  const policyById = new Map(instructions.map((item) => [Number(item?.id), ["exclude", "ignore"].includes(item?.policy) ? item.policy : "include"]));
  return seeds.map((row) => ({ row, policy: policyById.get(Number(row.id)) || "include" }));
}

// mix: explicit slider ratios, or null to let the planner choose them from the situation.
async function generateRecommendation(prompt, mix, count, seedIds = [], options = {}) {
  const variant = EMBEDDING_VARIANTS.includes(options.embeddingVariant) ? options.embeddingVariant : rankingConfig.recall.embeddingVariant || "rich";
  const store = loadVectorStore(variant);
  if (!store.byId.size) throw new Error("曲库还没有歌曲向量：请先运行 scripts/tag-audio-omni.mjs 打标，再运行 scripts/build-embeddings.mjs");
  if (isPlaceholderKey(dashscopeApiKey)) throw new Error("DASHSCOPE_API_KEY 尚未配置，无法把需求转成向量");
  const tagsById = loadSongTags();
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
  const exactMentionedTracks = maximalTitleMatches(availableTracks.filter((row) => isTitleMention(prompt, row.title))).sort((left, right) => normalizeMatch(right.title).length - normalizeMatch(left.title).length);
  let mentionedTracks = exactMentionedTracks.slice(0, 5);
  if (!mentionedTracks.length && mentionedArtists.length) {
    mentionedTracks = mentionedArtists.map((item) => nearestTitleAfterArtist(
      prompt, item.artist, availableTracks.filter((row) => includesArtist(row, [item.artist])),
    )).filter(Boolean).slice(0, 5);
  }
  const seeds = dedupeTrackRows([...explicitSeeds, ...mentionedTracks]).slice(0, 5);
  const planningArtists = [...new Map([...mentionedArtists, ...artistCatalog.slice(0, 240)].map((row) => [row.artist, row])).values()];
  const planningSystem = `你是 Moment 的检索规划器。不要直接选歌，先把用户的一整段自然语言需求转换成数据库检索计划。参考歌曲、心情、场景、数量和排除条件都来自同一个 request；referencedTracksFoundInLibrary 是系统从这段话中识别出的本地歌曲，tags 是模型听整首歌得到的标签。
曲库每首歌有这些可过滤的标签：语言 ${TAG_VOCAB.languages.join("/")}；人声 ${TAG_VOCAB.vocalPresence.join("/")}；演唱者 ${TAG_VOCAB.vocalTypes.join("/")}；体感节奏 ${TAG_VOCAB.tempo.join("/")}；原声/电子 ${TAG_VOCAB.acousticElectronic.join("/")}；曲风文本（中英混写，如"古典（Classical）""节奏布鲁斯（R&B）""管弦乐（Orchestral）"）；BPM；valence 情绪正负（0消极-1积极）；arousal 激烈程度（0平静-1激烈）。
hardFilters 只放用户原话明确要求、不满足就算推荐错误的条件，其余一律放 softPreferences，交给向量检索和精排：
- languages/vocalPresence/vocalTypes/tempo/acousticElectronic 只能用上面列出的取值。"粤语歌"→languages ["粤语"]；"纯音乐"→vocalPresence ["纯音乐"]；"女声"→vocalTypes ["女声"]。
- genres：用户点名的曲风，给出该曲风在标签里可能出现的中英文关键词，可以包含它的子类，不能扩展到相邻曲风。"古典"→["古典","Classical","管弦","Orchestral","交响"]；"说唱"→["说唱","Rap","嘻哈","Hip"]。
- bpmRange/valenceRange/arousalRange 只在用户明确给出强度边界时填写，并留宽余量。"别太吵"→arousalRange [0,0.6]；"跑步用，160左右"→bpmRange [145,175]。"激昂""伤感"这类情绪词不填区间，放 softPreferences。
mix 是本次歌单的熟悉度比例（familiar=近期常听，forgotten=很久没听的旧爱，discover=曲库里从没听过的歌，三项合计100）：
- 用户原话说了比例或倾向（"八成要听过的""多推点新歌"）时按原话换算，source="request"。
- 没说但 desiredMix 不为 null 时照抄 desiredMix，source="slider"。
- 都没有时按此刻的情境判断，source="situation"：情绪低落、需要安慰时熟悉的歌多一些；兴奋、想探索、做专注背景时新歌可以多一些。reason 用一句话向用户说明为什么这样配。
只返回JSON：{"intentSummary":"","hardArtists":[""],"excludedArtists":[""],"candidateArtists":[""],"hardFilters":{"languages":[],"vocalPresence":[],"vocalTypes":[],"tempo":[],"acousticElectronic":[],"genres":[],"bpmRange":null,"valenceRange":null,"arousalRange":null},"mustAvoid":[""],"softPreferences":[""],"mix":{"familiar":0,"forgotten":0,"discover":0,"source":"","reason":""},"referenceTracks":[{"id":1,"policy":"include","reason":""}]}。
referenceTracks必须覆盖所有识别出的参考歌，不得填写 referencedTracksFoundInLibrary 之外的ID。识别是按字面匹配的，可能误判：如果歌名在原话里只是普通词语、用户并没有在提这首歌（如"深夜一个人开车"里的"一个人"、"想听点歌"里的"想听"），policy 填 ignore。用户说"和X类似"时policy默认为include，参考歌占用歌单一个名额；只有用户明确说"不要X""排除X""以X为参考但不要X"或"除了X再找"时，对应歌曲才设为exclude。参考歌的标签只是相似性目标，绝对不能自动复制到hardFilters。hardArtists只有用户明确限定歌手时才填写，"和某歌手的X类似"不等于限定该歌手；candidateArtists只能从提供的歌手目录选择；mustAvoid 只放用户明确排除的曲风、乐器或情绪词；不要把本次偏好写成长期偏好。`;
  const planning = await deepseekJson(planningSystem, {
    request: prompt, desiredMix: mix,
    referencedTracksFoundInLibrary: seeds.map((row) => ({
      id: row.id, title: row.title, artist: row.artist, album: row.album,
      tags: tagsById.get(Number(row.id)) || null,
    })),
    longTermMemories: memories, favoriteTracks, recentSessionFeedback: recentFeedback,
    recentRequests, mentionedArtists, availableArtists: planningArtists,
  }, 1600);
  planning.value.hardFilters = sanitizeHardFilters(planning.value.hardFilters);
  // A genre filter must be grounded in the user's own words: at least one keyword has to appear in the request.
  if (!sanitizeHardStyles(prompt, planning.value.hardFilters.genres).length) planning.value.hardFilters.genres = [];
  mix = resolveMix(planning.value.mix, mix);
  planning.value.mix = mix;
  const recognizedSeedIds = new Set(seeds.map((row) => Number(row.id)));
  planning.value.referenceTracks = (Array.isArray(planning.value.referenceTracks) ? planning.value.referenceTracks : [])
    .filter((item) => recognizedSeedIds.has(Number(item?.id)));
  const references = referencePolicy(planning.value, seeds);
  const includedSeeds = references.filter((item) => item.policy === "include").map((item) => item.row);
  const excludedSeedIds = new Set(references.filter((item) => item.policy === "exclude").map((item) => Number(item.row.id)));
  const pipeline = { retrieval: "vector", embeddingVariant: variant, queryText: prompt, hardFilters: planning.value.hardFilters, mix };
  const targets = mixTargets(mix, Math.max(0, count - includedSeeds.length));
  const previous = options.variation ? previousPlaylist(Number(options.previousId)) : null;
  const variation = previous ? { mode: options.variation === "shift" ? "shift" : "refresh", previous } : null;
  const fresh = options.freshness !== false;
  const { scored, profile, eligibleCount, taggedCount, relaxed, referenceCount, blockedCount, recentlyRecommended } = await vectorCandidates({ prompt, plan: planning.value, includedSeeds, excludedSeedIds, count, store, tagsById, targets, variation, fresh });
  Object.assign(pipeline, { variation: variation ? { mode: variation.mode, previousId: previous.id } : null, freshness: fresh, blockedSongs: blockedCount, recentlyRecommended });
  pipeline.taggedSongs = taggedCount;
  pipeline.relaxedFilters = relaxed;
  const candidateEntries = [
    ...includedSeeds.map((row) => ({ row, tier: "reference", evidence: ["用户指定的参考歌曲"] })),
    ...scored.map((item) => ({ row: item.row, tier: "vector", evidence: [], item })),
  ];
  pipeline.eligibleAfterHardFilters = eligibleCount;
  pipeline.referenceVectorsBlended = referenceCount;
  pipeline.clusters = profile.clusters ? { k: profile.clusters.k, silhouette: round3(profile.clusters.silhouette), songCount: profile.clusters.songCount } : null;
  pipeline.recalled = scored.map((item) => ({ id: item.id, title: item.row.title, artist: item.row.artist, bucket: item.bucket,
    querySim: round3(item.rawSim), freshSim: round3(item.querySim), exposure: round3(item.exposure), personalScore: round3(item.personalScore), total: round3(item.total) }));
  const candidates = candidateEntries.map((entry) => entry.row);
  if (!candidateEntries.length) throw new Error("没有找到满足硬条件的本地歌曲");
  const candidatePayload = candidateEntries.map(({ row, tier, item }) => ({
    id: row.id, title: row.title, artist: row.artist, album: row.album, sourceKind: serializeTrack(row).kind,
    tags: tagsById.get(Number(row.id)) || null, recallTier: tier,
    ...(item ? { querySim: round3(item.queryScore), personalScore: round3(item.personalScore) } : {}),
  }));
  const tagGuide = `候选的 tags 是模型完整听过这首歌后的标签：language 语言、vocalPresence/vocalType 人声、genre 曲风、instruments/texture 声音、tempo/bpm 节奏、arcShape/arc 能量走向、mood 情绪词、valence 情绪正负(0消极-1积极)、arousal 激烈程度(0平静-1激烈)、lyricTheme 歌词主题、scene 适合的处境、description 综合描述。依据这些判断它能否承接用户此刻想要的体验；标签由模型生成，可能有少量误差，与常识明显冲突时以常识为准并在理由中说明。`;
  const rankingSystem = `你是 Moment 的歌单策展模型。只能从候选歌曲中选择，不能编造歌曲事实。${tagGuide}不能因为共享"忧伤""深情"这类宽泛情绪词，就判定歌曲适合；要看曲风、声音、能量和歌词主题是否真正对得上此刻的需求。referenceTracksToKeep 中的参考歌必须保留并占用名额。当用户没有限定歌手时，同一歌手最多选2首；当前需求和参考歌高于长期歌手偏好，长期记忆只能在两首歌同样匹配时用于决胜。
retrievalPlan.hardFilters 已由程序严格执行，候选都满足；用户明确排除的内容（mustAvoid、excludedArtists）绝不能入选。证据不足或合格歌曲不够时允许少选，不能拿不合适的歌凑数。理由要具体到这首歌的声音、情绪或歌词，并说明它为什么适合此刻，不要套话。
只返回JSON：{"title":"","summary":"","intent":{"summary":"","mustHave":[""],"avoid":[""],"softPreferences":[""]},"selections":[{"id":1,"reason":"","evidence":[""]}]}。尽量选满请求数量并保持歌手和听感的多样性。`;
  const rankingContext = {
    request: prompt, requestedCount: count, desiredMix: mix,
    retrievalPlan: planning.value, longTermMemories: memories, favoriteTracks,
    recentSessionFeedback: recentFeedback,
    referenceTracksToKeep: includedSeeds.map((row) => ({ id: row.id, title: row.title, artist: row.artist })),
    ...(variation ? { variation: {
      mode: variation.mode,
      instruction: variation.mode === "shift"
        ? "用户对上一版点了「换个口味」：保持同样的情绪和场景，但换一种声音方向（曲风、语言、年代、编制至少有一项明显不同），标题也要体现新的方向。"
        : "用户对上一版点了「换一批」：同样的需求，换一批不同的歌，标题不要与上一版重复。",
      previousTitle: previous.title,
      previousSongs: previous.rows.slice(0, 20).map((row) => ({ title: row.title, artist: row.artist, genre: tagsById.get(Number(row.id))?.genre?.primary || null })),
    } } : {}),
  };
  let rankingTokens = 0;
  const payloadById = new Map(candidatePayload.map((item) => [Number(item.id), item]));
  // Fine ranking: the vector pool is already ordered by total = α·需求 + β·口味. The LLM only
  // chooses (never scores): 3 round-robin batches → each keeps k → one final choice from the union.
  const scoreRule = `
候选已按综合分排序（querySim=本次需求匹配度，personalScore=用户长期口味匹配度，均为0到1）。它们只是程序给的参考排序，不能替代你的语义判断：先判断是否满足本次需求，语义同样合格时优先 personalScore 更高、排序更靠前的歌。sourceKind 表示熟悉度：familiar=近期熟悉，forgotten=遗忘旧爱，library=从未听过。`;
  const vectorItems = candidateEntries.filter((entry) => entry.item).map((entry) => entry.item);
  const batches = splitBatches(vectorItems, rankingConfig.llm.batches);
  const pick = perBatchPick(count, rankingConfig);
  const mixRule = `用户这次希望最终歌单里 familiar ${targets.familiar} 首、forgotten ${targets.forgotten} 首、library ${targets.library} 首（看候选的 sourceKind）。初筛时在符合需求的前提下，各类别都要按这个比例留够备选，配额多的类别多留；不要因为某一类整体更顺手就把另一类全部淘汰。`;
  const batchSystem = `${rankingSystem}${scoreRule}
这是分批初筛：只从本批候选中选出最多 ${pick} 首最符合需求的歌，按合适程度从高到低排列，宁缺毋滥。${mixRule}title、summary、intent 可留空。`;
  const batchResults = await Promise.all(batches.map((batch) => deepseekJson(batchSystem, {
    ...rankingContext, requestedCount: pick, candidates: batch.map((item) => payloadById.get(item.id)),
  }, Math.min(3000, 800 + pick * 120))));
  const batchReasons = new Map();
  const batchPicks = batchResults.map((result, index) => {
    const allowed = new Set(batches[index].map((item) => item.id));
    const picks = (Array.isArray(result.value?.selections) ? result.value.selections : []).filter((selection) => allowed.has(Number(selection.id))).slice(0, pick);
    for (const selection of picks) if (!batchReasons.has(Number(selection.id))) batchReasons.set(Number(selection.id), selection);
    rankingTokens += Number(result.usage?.total_tokens || 0);
    return picks.map((selection) => Number(selection.id));
  });
  const vectorPool = vectorItems.filter((item) => batchReasons.has(item.id));
  const finalSystem = `${rankingSystem}${scoreRule}
这是终选：候选已经过分批初筛。用户希望的熟悉度配额为 ${JSON.stringify(targets)}，在满足需求的前提下尽量贴近这个配额。`;
  const ranking = await deepseekJson(finalSystem, {
    ...rankingContext, mixTargets: targets,
    candidates: [...includedSeeds.map((row) => payloadById.get(Number(row.id))), ...vectorPool.map((item) => payloadById.get(item.id))],
  }, Math.min(4200, 1200 + count * 100));
  rankingTokens += Number(ranking.usage?.total_tokens || 0);
  const poolById = new Map(vectorPool.map((item) => [item.id, item]));
  const finalSelections = Array.isArray(ranking.value?.selections) ? ranking.value.selections : [];
  const ordered = finalSelections.filter((selection) => poolById.has(Number(selection.id)))
    .map((selection) => ({ id: Number(selection.id), reason: selection.reason, evidence: selection.evidence }));
  const pool = vectorPool.map((item) => ({ id: item.id, reason: batchReasons.get(item.id)?.reason, evidence: batchReasons.get(item.id)?.evidence }));
  // Reserve: recalled songs the batches did not keep, best total score first — only used to cover a bucket.
  const allById = new Map(vectorItems.map((item) => [item.id, item]));
  const reserve = vectorItems.filter((item) => !poolById.has(item.id)).sort((left, right) => right.total - left.total)
    .map((item) => ({ id: item.id, reason: "按你要的熟悉度比例补入：在这一类里与需求最接近的一首。", evidence: [`需求匹配 ${round3(item.queryScore)}`] }));
  const bucketOf = (item) => (poolById.get(item.id) || allById.get(item.id)).bucket;
  const quota = applyMixQuota(ordered, pool, targets, Math.max(0, count - includedSeeds.length), bucketOf, reserve);
  const referenceSelections = finalSelections.filter((selection) => includedSeeds.some((seed) => Number(seed.id) === Number(selection.id)));
  ranking.value.selections = [...referenceSelections, ...quota.chosen];
  Object.assign(pipeline, { batches: batches.map((batch) => batch.map((item) => item.id)), perBatchPick: pick, batchPicks,
    finalPicks: ordered.map((item) => item.id), mixTargets: targets, mixFilled: quota.filled, mixShortfall: quota.shortfall });
  planning.value.pipeline = pipeline;
  const modelResult = ranking.value;
  const candidateMap = new Map(candidates.map((row) => [Number(row.id), row]));
  const excludedArtists = Array.isArray(planning.value.excludedArtists) ? planning.value.excludedArtists.map((value) => String(value).trim()).filter(Boolean) : [];
  // Tag filters and mustAvoid already ran at recall; excluded artists are re-checked here for reference songs.
  const violatesMustAvoid = (row) => excludedArtists.length > 0 && includesArtist(row, excludedArtists);
  const seen = new Set();
  const playlist = [];
  const artistCounts = new Map();
  const hardArtists = Array.isArray(planning.value.hardArtists) ? planning.value.hardArtists.filter(Boolean) : [];
  const maxPerArtist = hardArtists.length ? Infinity : includedSeeds.length ? 2 : 3;
  // Count every credited artist, so "A&周杰伦" and "周杰伦&B" both use up 周杰伦's allowance.
  const canAddArtist = (row, isReference = false) => isReference || splitArtists(row.artist).every((artist) => (artistCounts.get(artist) || 0) < maxPerArtist);
  const recordArtist = (row) => { for (const artist of splitArtists(row.artist)) artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1); };
  for (const selection of Array.isArray(modelResult.selections) ? modelResult.selections : []) {
    const id = Number(selection.id);
    const row = candidateMap.get(id);
    const isIncludedReference = includedSeeds.some((seed) => Number(seed.id) === id);
    if (!row || seen.has(id) || !canAddArtist(row, isIncludedReference) || (!isIncludedReference && violatesMustAvoid(row))) continue;
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
  // Fallback fill: only songs an LLM batch already approved.
  for (const item of vectorPool) {
    const row = item.row;
    if (playlist.length >= count) break;
    if (!seen.has(row.id) && canAddArtist(row) && !violatesMustAvoid(row)) {
      playlist.push({ ...serializeTrack(row), score: 0, reason: "分批精排中被判定符合需求，作为候选补入。",
        evidence: [`需求匹配 ${round3(item.queryScore)} · 口味匹配 ${round3(item.personalScore)}`] });
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
  const totalTokens = Number(planning.usage?.total_tokens || 0) + rankingTokens;
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

{
  const remapped = remapUnavailableTracks();
  if (remapped.mapped) console.log("Re-pointed references to removed files:", JSON.stringify(remapped));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "OPTIONS") { response.writeHead(204, corsHeaders()); return response.end(); }
    if (await handleEvalRoute(request, response, url, { sendJson, readJson })) return;
    if (await handleCommentRoute(request, response, url, { sendJson, readJson })) return;
    if (request.method === "GET" && url.pathname === "/api/history") return sendJson(response, 200, buildHistory());
    if (request.method === "GET" && url.pathname === "/api/health") {
      const count = db.prepare(`SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM tracks WHERE available=1 GROUP BY lower(trim(title)), lower(trim(artist))
      )`).get().count;
      return sendJson(response, 200, { ok: true, count, libraryRoot, scan: scanState, ai: { configured: !isPlaceholderKey(deepseekApiKey), model: deepseekModel } });
    }
    if (request.method === "POST" && url.pathname === "/api/library/scan") {
      scanLibrary().catch(console.error);
      return sendJson(response, 202, { ok: true, scan: scanState });
    }
    if (request.method === "GET" && url.pathname === "/api/library/scan") return sendJson(response, 200, scanState);
    if (request.method === "GET" && url.pathname === "/api/tracks") {
      const limit = Math.min(20000, Math.max(1, Number(url.searchParams.get("limit") || 20000)));
      const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
      const query = url.searchParams.get("q")?.trim();
      const physicalRows = query
        ? db.prepare("SELECT * FROM tracks WHERE available=1 AND (title LIKE ? OR artist LIKE ? OR album LIKE ?) ORDER BY artist, title, play_count DESC, COALESCE(bitrate,0) DESC, id").all(`%${query}%`, `%${query}%`, `%${query}%`)
        : db.prepare("SELECT * FROM tracks WHERE available=1 ORDER BY artist, title, play_count DESC, COALESCE(bitrate,0) DESC, id").all();
      const logicalRows = dedupeTrackRows(physicalRows);
      // Total plays per logical song: YouTube history + plays in this app, summed over every copy.
      const playsByKey = new Map();
      const eventPlays = new Map(db.prepare("SELECT track_id, COUNT(*) AS plays FROM listening_events WHERE event_type='play' AND track_id IS NOT NULL GROUP BY track_id").all()
        .map((row) => [Number(row.track_id), row.plays]));
      for (const row of physicalRows) {
        const key = logicalTrackKey(row);
        playsByKey.set(key, (playsByKey.get(key) || 0) + (eventPlays.get(Number(row.id)) || 0));
      }
      return sendJson(response, 200, { total: logicalRows.length, tracks: logicalRows.slice(offset, offset + limit)
        .map((row) => ({ ...serializeTrack(row), totalPlays: playsByKey.get(logicalTrackKey(row)) || 0 })) });
    }
    if (request.method === "POST" && url.pathname === "/api/recommendations") {
      const body = await readJson(request);
      const prompt = String(body.prompt || "").trim();
      if (!prompt) return sendJson(response, 400, { error: "请描述此刻想听的音乐" });
      const countMention = prompt.match(/(?:生成|给我|要|想听)?\s*([1-9]|[12]\d|30)\s*首/);
      const count = Math.min(30, Math.max(1, countMention ? Number(countMention[1]) : Number(body.count || 10)));
      // mixMode "auto" (or no mix) lets the planner pick the ratio from the situation; ratios in the request text always win.
      const mix = body.mixMode !== "auto" && body.mix && typeof body.mix === "object" ? body.mix : null;
      const seedTrackIds = Array.isArray(body.seedTrackIds) ? body.seedTrackIds : [];
      const requestText = prompt.slice(0, 1000);
      const requestLog = db.prepare("INSERT INTO request_logs (request_text, requested_count, mix_json) VALUES (?, ?, ?)").run(requestText, count, JSON.stringify(mix));
      const requestLogId = Number(requestLog.lastInsertRowid);
      try {
        const recommendation = await generateRecommendation(requestText, mix, count, seedTrackIds, {
          embeddingVariant: body.embeddingVariant, freshness: body.freshness,
          variation: ["refresh", "shift"].includes(body.variation) ? body.variation : null, previousId: body.previousId,
        });
        db.prepare("UPDATE request_logs SET status='succeeded', recommendation_id=?, completed_at=CURRENT_TIMESTAMP WHERE id=?").run(recommendation.id, requestLogId);
        return sendJson(response, 200, recommendation);
      } catch (error) {
        db.prepare("UPDATE request_logs SET status='failed', error_text=?, completed_at=CURRENT_TIMESTAMP WHERE id=?").run(String(error instanceof Error ? error.message : error).slice(0, 500), requestLogId);
        throw error;
      }
    }
    if (request.method === "GET" && url.pathname === "/api/blocks") {
      return sendJson(response, 200, { blocks: blockedRows() });
    }
    const blockMatch = url.pathname.match(/^\/api\/tracks\/(\d+)\/block$/);
    if (blockMatch && (request.method === "POST" || request.method === "DELETE")) {
      const row = db.prepare("SELECT id, title, artist FROM tracks WHERE id=?").get(Number(blockMatch[1]));
      if (!row) return sendJson(response, 404, { error: "歌曲不存在" });
      if (request.method === "POST") blockSong(row); else unblockSong(row);
      blockedCache = null;
      return sendJson(response, 200, { ok: true, blocked: request.method === "POST", blocks: blockedRows() });
    }
    const unblockKeyMatch = request.method === "DELETE" && url.pathname === "/api/blocks" ? url.searchParams.get("key") : null;
    if (unblockKeyMatch) {
      db.prepare("DELETE FROM song_blocks WHERE song_key=?").run(unblockKeyMatch);
      blockedCache = null;
      return sendJson(response, 200, { ok: true, blocks: blockedRows() });
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
      db.prepare("INSERT INTO listening_events (source, event_type, track_id, context, created_at) VALUES ('moment', 'play', ?, '', ?)").run(id, new Date().toISOString());
      return sendJson(response, 200, { ok: true });
    }
    const listenEventMatch = url.pathname.match(/^\/api\/tracks\/(\d+)\/events$/);
    if (request.method === "POST" && listenEventMatch) {
      const id = Number(listenEventMatch[1]);
      const body = await readJson(request);
      if (!["complete", "skip", "partial"].includes(body.type)) return sendJson(response, 400, { error: "未知的播放事件" });
      if (!db.prepare("SELECT id FROM tracks WHERE id=?").get(id)) return sendJson(response, 404, { error: "歌曲不存在" });
      const playedSeconds = Number.isFinite(Number(body.playedSeconds)) ? Math.max(0, Number(body.playedSeconds)) : null;
      db.prepare("INSERT INTO listening_events (source, event_type, track_id, played_seconds, context, created_at) VALUES ('moment', ?, ?, ?, '', ?)").run(body.type, id, playedSeconds, new Date().toISOString());
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
