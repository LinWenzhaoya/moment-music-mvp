import { readFileSync } from "node:fs";
import { join } from "node:path";
import { here } from "./config.mjs";
import { db, safeJson } from "./db.mjs";
import { logicalTrackKey } from "./recommendation-core.mjs";
import { adaptiveKmeans, dot, fromBlob, toBlob } from "./vector-math.mjs";

export const rankingConfig = JSON.parse(readFileSync(join(here, "ranking-config.json"), "utf8"));
const DAY_MS = 86_400_000;

// SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC; imported events are ISO strings.
export function parseDbTime(value) {
  if (!value) return NaN;
  const text = String(value);
  return Date.parse(/[TZ]/.test(text) ? text : `${text.replace(" ", "T")}Z`);
}

export function decayWeight(ageDays, halfLifeDays) {
  return 0.5 ** (Math.max(0, ageDays) / halfLifeDays);
}

export function eventPoints(event, config = rankingConfig.behavior) {
  if (event.source === "moment" && event.type === "play") return config.momentPlayPoints;
  return config.points[event.type] ?? 0;
}

// events: [{ key, source, type, at(ms) }] → Map<key, { raw, score, lastPositiveAt }>
// Score = sign(raw)·log1p(|raw|): time-decayed, then saturated so 100 plays ≠ 10× 10 plays.
export function aggregateBehavior(events, now = Date.now(), config = rankingConfig.behavior) {
  const songs = new Map();
  for (const event of events) {
    const points = eventPoints(event, config);
    if (!Number.isFinite(event.at)) continue;
    const song = songs.get(event.key) || { raw: 0, lastPositiveAt: null };
    song.raw += points * decayWeight((now - event.at) / DAY_MS, config.halfLifeDays);
    if (points > 0 && (song.lastPositiveAt === null || event.at > song.lastPositiveAt)) song.lastPositiveAt = event.at;
    songs.set(event.key, song);
  }
  for (const song of songs.values()) song.score = Math.sign(song.raw) * Math.log1p(Math.abs(song.raw));
  return songs;
}

// familiar = last positive listen within forgottenDays; forgotten = only longer ago; library = never heard.
export function familiarityBucket(lastPositiveAt, now = Date.now(), config = rankingConfig.familiarity) {
  if (!Number.isFinite(lastPositiveAt)) return "library";
  const ageDays = (now - lastPositiveAt) / DAY_MS;
  return ageDays > config.forgottenDays ? "forgotten" : "familiar";
}

export function loadBehaviorEvents() {
  const rows = [
    ...db.prepare(`SELECT t.title, t.artist, e.source, e.event_type AS type, e.created_at
      FROM listening_events e JOIN tracks t ON t.id=e.track_id`).all(),
    ...db.prepare(`SELECT t.title, t.artist, 'moment' AS source,
        CASE WHEN p.kind='favorites' THEN 'moment_favorite' ELSE 'playlist_add' END AS type, i.added_at AS created_at
      FROM user_playlist_items i JOIN user_playlists p ON p.id=i.playlist_id JOIN tracks t ON t.id=i.track_id`).all(),
    ...db.prepare(`SELECT t.title, t.artist, 'moment' AS source,
        CASE WHEN f.verdict='dislike' THEN 'feedback_dislike' ELSE 'feedback_like' END AS type, f.created_at
      FROM feedback_entries f JOIN tracks t ON t.id=f.track_id`).all(),
  ];
  return rows.map((row) => ({ key: logicalTrackKey(row), source: row.source, type: row.type, at: parseDbTime(row.created_at) }));
}

function eventVersion() {
  return db.prepare(`SELECT (SELECT COUNT(*) FROM listening_events) + (SELECT COUNT(*) FROM user_playlist_items)
    + (SELECT COUNT(*) FROM feedback_entries) AS count`).get().count;
}

// vectorStore: { byKey: Map<logicalKey, Float32Array>, model, dim }
function loadOrBuildClusters(behavior, vectorStore, version) {
  const config = rankingConfig.clusters;
  const cached = db.prepare("SELECT * FROM user_interest_clusters ORDER BY id DESC LIMIT 1").get();
  const fresh = cached && cached.dim === vectorStore.dim
    && safeJson(cached.weights_json, {}).model === vectorStore.model
    && version - cached.event_count < config.rebuildEveryEvents;
  if (fresh) {
    const meta = safeJson(cached.weights_json, {});
    const flat = fromBlob(cached.centers);
    const centers = Array.from({ length: cached.k }, (_, index) => flat.slice(index * cached.dim, (index + 1) * cached.dim));
    return { centers, weights: meta.weights, k: cached.k, silhouette: cached.silhouette, builtAt: cached.built_at, songCount: meta.songCount };
  }
  const liked = [...behavior].filter(([key, song]) => song.score > 0 && vectorStore.byKey.has(key));
  if (liked.length < config.minSongs) return null;
  const result = adaptiveKmeans(liked.map(([key]) => vectorStore.byKey.get(key)), liked.map(([, song]) => song.score), config);
  const flat = new Float32Array(result.k * vectorStore.dim);
  result.centers.forEach((center, index) => flat.set(center, index * vectorStore.dim));
  const total = result.clusterWeights.reduce((sum, value) => sum + value, 0) || 1;
  const weights = result.clusterWeights.map((value) => value / total);
  db.prepare(`INSERT INTO user_interest_clusters (event_count, k, silhouette, centers, weights_json, dim) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(version, result.k, result.silhouette, toBlob(flat), JSON.stringify({ weights, model: vectorStore.model, songCount: liked.length }), vectorStore.dim);
  return { centers: result.centers, weights, k: result.k, silhouette: result.silhouette, builtAt: new Date().toISOString(), songCount: liked.length };
}

// Two independent caches: behavior (cheap to read, used by every serializeTrack call) and clusters
// (needs the vector store, used only when generating). Keeping them apart stops the two callers
// from invalidating each other.
let behaviorCache = null;
let clusterCache = null;

function getBehavior() {
  // Re-check the event count at most every 5s so bulk serialisation does not hit the DB per row.
  if (behaviorCache && Date.now() - behaviorCache.checkedAt < 5_000) return behaviorCache;
  const version = eventVersion();
  if (behaviorCache?.version === version) { behaviorCache.checkedAt = Date.now(); return behaviorCache; }
  const behavior = aggregateBehavior(loadBehaviorEvents());
  const maxAbs = Math.max(1e-9, ...[...behavior.values()].map((song) => Math.abs(song.score)));
  behaviorCache = { version, checkedAt: Date.now(), behavior, maxAbs };
  return behaviorCache;
}

// The user profile: per-song behavior scores, familiarity, and (when embeddings exist) interest clusters.
export function getUserProfile(vectorStore = null) {
  const { version, behavior, maxAbs } = getBehavior();
  let clusters = null;
  if (vectorStore?.byKey.size) {
    const storeTag = `${vectorStore.model}:${vectorStore.byKey.size}`;
    if (clusterCache?.version !== version || clusterCache.storeTag !== storeTag) {
      clusterCache = { version, storeTag, clusters: loadOrBuildClusters(behavior, vectorStore, version) };
    }
    clusters = clusterCache.clusters;
  }
  return { version, behavior, maxAbs, clusters };
}

export function familiarityForRow(row, profile = getUserProfile()) {
  const song = profile.behavior.get(logicalTrackKey(row));
  const moment = parseDbTime(row.last_played_at);
  const last = Math.max(song?.lastPositiveAt ?? -Infinity, Number.isFinite(moment) ? moment : -Infinity);
  return familiarityBucket(Number.isFinite(last) ? last : NaN);
}

// Personal fit of a song: best cosine to any interest center + its own (normalised) behavior score.
// Unheard songs get no behavior term — they are neither rewarded nor penalised.
export function personalSignals(row, vector, profile) {
  const song = profile.behavior.get(logicalTrackKey(row));
  const behaviorNorm = song ? song.score / profile.maxAbs : 0;
  let clusterSim = null; let cluster = null;
  if (vector && profile.clusters) {
    profile.clusters.centers.forEach((center, index) => {
      const sim = dot(vector, center);
      if (clusterSim === null || sim > clusterSim) { clusterSim = sim; cluster = index; }
    });
  }
  return { behaviorNorm, clusterSim, cluster, heard: Boolean(song) };
}
