import { embeddingModel } from "./config.mjs";
import { db, safeJson } from "./db.mjs";
import { embedTexts } from "./llm.mjs";
import { logicalTrackKey } from "./recommendation-core.mjs";
import { dot, fromBlob, normalize, weightedMean } from "./vector-math.mjs";

// Text that represents a song in embedding space, built from the v2 audio tags.
// Artist/title are deliberately excluded: coarse recall matches what a song is like, not who sings it.
//   desc — style + description only (how the song sounds)
//   rich — also mood, lyric themes and situations, so requests phrased as "我现在怎样"
//          ("刚失恋", "拿到 offer 很激动") meet songs on the same terms
export const EMBEDDING_VARIANTS = ["desc", "rich"];

export function embeddingTextForTrack(tags, variant = "rich") {
  if (!tags?.description) return null;
  const genre = safeJson(tags.genre_json, {});
  const styleLine = [genre.primary, ...(genre.sub || []), genre.era, genre.region].filter(Boolean).join("、");
  // The shared opener ("这首歌最独特的地方在于…") carries no information and pulls every vector the same way.
  const description = tags.description.replace(/^这(首|是一首)[^，。]{0,6}?最?(独特|突出|显著)?的?(地方|特点|特征|之处)?(在于|是)其?/, "");
  if (variant === "desc") return `${styleLine ? `风格：${styleLine}。` : ""}${description}`;
  const list = (json) => safeJson(json, []).filter(Boolean).join("、");
  return [
    tags.mood_json && list(tags.mood_json) ? `情绪：${list(tags.mood_json)}` : null,
    tags.lyric_theme_json && list(tags.lyric_theme_json) ? `歌词主题：${list(tags.lyric_theme_json)}` : null,
    tags.scene_json && list(tags.scene_json) ? `适合：${safeJson(tags.scene_json, []).join(" / ")}` : null,
    styleLine ? `风格：${styleLine}` : null,
    `描述：${description}`,
  ].filter(Boolean).join("\n");
}

const storeCache = new Map();

// All song vectors of one variant in memory. ~6k songs × 1024 dims is ~25 MB, so brute-force cosine is
// milliseconds; swap this for an ANN index (sqlite-vec / HNSW) only once the library reaches tens of thousands.
export function loadVectorStore(variant = "rich") {
  const stamp = db.prepare("SELECT COUNT(*) AS count, MAX(updated_at) AS latest FROM track_embeddings WHERE model=? AND variant=?").get(embeddingModel, variant);
  const tag = `${stamp.count}:${stamp.latest}`;
  if (storeCache.get(variant)?.tag === tag) return storeCache.get(variant);
  const rows = db.prepare(`SELECT e.track_id, e.vector, e.dim, t.title, t.artist
    FROM track_embeddings e JOIN tracks t ON t.id=e.track_id WHERE e.model=? AND e.variant=? AND t.available=1`).all(embeddingModel, variant);
  const byId = new Map(); const byKey = new Map();
  for (const row of rows) {
    const vector = fromBlob(row.vector);
    byId.set(row.track_id, vector);
    byKey.set(logicalTrackKey(row), vector);
  }
  const store = { tag, variant, model: embeddingModel, dim: rows[0]?.dim || 0, byId, byKey };
  storeCache.set(variant, store);
  return store;
}

export async function embedQuery(text) {
  const [vector] = await embedTexts([text]);
  return normalize(vector);
}

// Blend the query with reference songs so "类似X但更…" keeps X's sonic neighbourhood.
export function blendWithReferences(queryVector, referenceVectors, referenceBlend) {
  if (!referenceVectors.length) return queryVector;
  const reference = weightedMean(referenceVectors);
  return weightedMean([queryVector, reference], [1 - referenceBlend, referenceBlend]);
}

// rows: candidate track rows already passing hard filters. Returns [{ row, querySim }] best-first.
export function searchTopN(queryVector, rows, store, topN) {
  return rows
    .map((row) => ({ row, vector: store.byId.get(row.id) }))
    .filter((item) => item.vector)
    .map((item) => ({ row: item.row, vector: item.vector, querySim: dot(queryVector, item.vector) }))
    .sort((left, right) => right.querySim - left.querySim)
    .slice(0, topN);
}

export function recallSize(count, config) {
  return Math.max(config.min, Math.min(config.max, count * config.multiplier));
}
