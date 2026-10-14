import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { here, port, projectRoot } from "../local-music/config.mjs";

// Real-request evaluation. Each query runs through the full pipeline twice — once per embedding
// variant (desc / rich) — against the running music server. The second run reuses the first run's
// mix so the only difference between the two playlists is the recall text. The two lists are shown
// blind (A/B in random order) on http://localhost:3001/review, where you score each song and pick a side.
//
//   npm run music:server   (in another terminal)
//   node scripts/run-eval.mjs [--only breakup,offer] [--count 10]
//   node scripts/run-eval.mjs --retry-failed     re-run the failed queries of the latest run, in place
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : fallback; };
const only = new Set(String(option("only", "")).split(",").filter(Boolean));
const count = Number(option("count", 10));
const spec = JSON.parse(readFileSync(join(projectRoot, "scripts", "eval-queries.json"), "utf8"));
const queries = spec.queries.filter((query) => !only.size || only.has(query.id));
const base = `http://localhost:${port}`;

function upsert(entry) {
  const index = results.findIndex((item) => item.id === entry.id);
  if (index >= 0) results[index] = entry; else results.push(entry);
}

async function recommend(prompt, variant, mix) {
  const response = await fetch(`${base}/api/recommendations`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, count, embeddingVariant: variant, freshness: false, ...(mix ? { mix, mixMode: "manual" } : { mixMode: "auto" }) }),
    signal: AbortSignal.timeout(300_000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  const pipeline = body.plan?.pipeline || {};
  return {
    recommendationId: body.id, variant, mix: body.plan?.mix, hardFilters: body.plan?.hardFilters, relaxedFilters: pipeline.relaxedFilters,
    eligible: pipeline.eligibleAfterHardFilters, shortfall: pipeline.mixShortfall,
    tracks: body.tracks.map((track) => ({ id: Number(String(track.id).replace("local-", "")), title: track.title, artist: track.artist, kind: track.kind, reason: track.reason })),
  };
}

const outDir = join(here, "eval-results");
const retryFailed = args.includes("--retry-failed");
const latestFile = retryFailed ? join(outDir, readdirSync(outDir).filter((name) => /^run-.*\.json$/.test(name)).sort().at(-1)) : null;
const latest = latestFile ? JSON.parse(readFileSync(latestFile, "utf8")) : null;
const runId = latest?.runId || new Date().toISOString().replace(/[:.]/g, "-");
const results = latest ? latest.queries : [];
const todo = latest ? queries.filter((query) => results.find((item) => item.id === query.id)?.error) : queries;
for (const query of todo) {
  try {
    const rich = await recommend(query.text, "rich", null);
    // Same ratio for both sides; a "request"-sourced ratio is re-derived from the text anyway.
    const desc = await recommend(query.text, "desc", { familiar: rich.mix.familiar, forgotten: rich.mix.forgotten, discover: rich.mix.discover });
    const flip = Math.random() < 0.5;
    upsert({ ...query, sides: flip ? { A: desc, B: rich } : { A: rich, B: desc } });
    console.log(`✓ ${query.id}: rich ${rich.tracks.length} / desc ${desc.tracks.length}, overlap ${rich.tracks.filter((track) => desc.tracks.some((other) => other.id === track.id)).length}`);
  } catch (error) {
    upsert({ ...query, error: error.message });
    console.error(`✗ ${query.id}: ${error.message}`);
  }
}
mkdirSync(outDir, { recursive: true });
const file = latestFile || join(outDir, `run-${runId}.json`);
writeFileSync(file, JSON.stringify({ runId, createdAt: latest?.createdAt || new Date().toISOString(), count, queries: results }, null, 2));
console.log(`\n${file}\n打开 ${base}/review 打分（A/B 哪边是哪个版本是隐藏的）`);
