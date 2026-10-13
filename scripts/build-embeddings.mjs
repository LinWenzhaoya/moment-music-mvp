import { createHash } from "node:crypto";
import { embeddingDim, embeddingModel } from "../local-music/config.mjs";
import { db } from "../local-music/db.mjs";
import { embedTexts } from "../local-music/llm.mjs";
import { EMBEDDING_VARIANTS, embeddingTextForTrack } from "../local-music/retrieval.mjs";
import { normalize, toBlob } from "../local-music/vector-math.mjs";

// Embeds every audio-tagged track, once per text variant (VARIANTS=desc,rich by default); copies of
// the same text share one API call. Re-runs only touch tracks whose text or model changed, so it is
// safe to run after re-tagging.
const force = process.env.FORCE === "1";
const variants = (process.env.VARIANTS || EMBEDDING_VARIANTS.join(",")).split(",").filter((variant) => EMBEDDING_VARIANTS.includes(variant));
const rows = db.prepare(`SELECT t.id, v.description, v.genre_json, v.mood_json, v.scene_json, v.lyric_theme_json
  FROM tracks t JOIN song_tags_v2 v ON v.track_id=t.id WHERE t.available=1`).all();
const existing = new Map(db.prepare("SELECT track_id, variant, text_hash, model FROM track_embeddings").all()
  .map((row) => [`${row.track_id}:${row.variant}`, row]));

const byHash = new Map();
for (const variant of variants) {
  for (const row of rows) {
    const text = embeddingTextForTrack(row, variant);
    if (!text) continue;
    const hash = createHash("sha1").update(`${embeddingModel}:${embeddingDim}:${text}`).digest("hex");
    const previous = existing.get(`${row.id}:${variant}`);
    if (!force && previous?.text_hash === hash && previous.model === embeddingModel) continue;
    if (!byHash.has(hash)) byHash.set(hash, { text, hash, targets: [] });
    byHash.get(hash).targets.push({ trackId: row.id, variant });
  }
}

const jobs = [...byHash.values()];
console.log(`Tagged tracks: ${rows.length}, variants: ${variants.join("/")}, to embed: ${jobs.reduce((sum, job) => sum + job.targets.length, 0)} (${jobs.length} unique texts)`);
const upsert = db.prepare(`INSERT INTO track_embeddings (track_id, variant, text_hash, model, dim, vector, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(track_id, variant) DO UPDATE SET
  text_hash=excluded.text_hash, model=excluded.model, dim=excluded.dim, vector=excluded.vector, updated_at=CURRENT_TIMESTAMP`);

for (let index = 0; index < jobs.length; index += 50) {
  const batch = jobs.slice(index, index + 50);
  const vectors = await embedTexts(batch.map((job) => job.text));
  db.exec("BEGIN");
  try {
    batch.forEach((job, position) => {
      const vector = normalize(vectors[position]);
      for (const target of job.targets) upsert.run(target.trackId, target.variant, job.hash, embeddingModel, vector.length, toBlob(vector));
    });
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  console.log(`Embedded ${Math.min(index + 50, jobs.length)}/${jobs.length}`);
}
const summary = db.prepare("SELECT variant, COUNT(*) AS count FROM track_embeddings WHERE model=? GROUP BY variant").all(embeddingModel);
console.log(JSON.stringify({ model: embeddingModel, byVariant: summary }, null, 2));
