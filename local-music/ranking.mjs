import { minMaxNormalize } from "./vector-math.mjs";

// total = α·querySim + β·personal, both min-max normalised within this candidate set so the
// weights mean the same thing regardless of the embedding model's raw cosine range.
export function scoreCandidates(items, config) {
  const querySims = minMaxNormalize(items.map((item) => item.querySim));
  const hasClusters = items.some((item) => item.personal.clusterSim !== null);
  const clusterSims = hasClusters ? minMaxNormalize(items.map((item) => item.personal.clusterSim ?? NaN)) : items.map(() => 0);
  const { clusterWeight, behaviorWeight } = config.personal;
  return items.map((item, index) => {
    const personal = hasClusters
      ? clusterWeight * clusterSims[index] + behaviorWeight * item.personal.behaviorNorm
      : item.personal.behaviorNorm;
    return { ...item, queryScore: querySims[index], personalScore: personal, total: config.score.alpha * querySims[index] + config.score.beta * personal };
  }).sort((left, right) => right.total - left.total);
}

// Round-robin so every batch gets a similar quality spread (rank-sliced batches would force weak picks from the last one).
export function splitBatches(items, batchCount) {
  const batches = Array.from({ length: Math.max(1, batchCount) }, () => []);
  items.forEach((item, index) => batches[index % batches.length].push(item));
  return batches.filter((batch) => batch.length);
}

export function perBatchPick(count, config) {
  return Math.max(2, Math.ceil(count * config.llm.perBatchRatio));
}

// Targets per familiarity bucket from the user's mix knob (familiar / forgotten / discover→library).
export function mixTargets(mix, count) {
  const shares = [["familiar", Number(mix.familiar) || 0], ["forgotten", Number(mix.forgotten) || 0], ["library", Number(mix.discover) || 0]];
  const total = shares.reduce((sum, [, value]) => sum + value, 0) || 1;
  const targets = Object.fromEntries(shares.map(([bucket, value]) => [bucket, Math.floor((value / total) * count)]));
  const remainders = shares.map(([bucket, value]) => [bucket, (value / total) * count - targets[bucket]]).sort((left, right) => right[1] - left[1]);
  let left = count - Object.values(targets).reduce((sum, value) => sum + value, 0);
  for (const [bucket] of remainders) { if (left <= 0) break; targets[bucket] += 1; left -= 1; }
  return targets;
}

// Coarse recall that respects the familiarity mix: relevance alone skews the pool toward whichever
// bucket is largest (night-drive recalled 2 familiar songs for a target of 5), so every bucket with a
// target first gets its own most relevant songs, then the general top fills the rest.
// ranked: candidates best-first by query similarity; accept(item) applies caps (e.g. per artist).
export function stratifiedRecall(ranked, bucketOf, targets, limit, { perTarget = 5, minPerBucket = 8, accept = () => true } = {}) {
  const chosen = []; const used = new Set();
  const take = (item) => { if (used.has(item.id) || !accept(item)) return false; chosen.push(item); used.add(item.id); return true; };
  for (const [bucket, target] of Object.entries(targets)) {
    if (!target) continue;
    const want = Math.max(minPerBucket, target * perTarget);
    let got = 0;
    for (const item of ranked) { if (got >= want) break; if (bucketOf(item) === bucket && take(item)) got += 1; }
  }
  const total = Math.max(limit, chosen.length);
  for (const item of ranked) { if (chosen.length >= total) break; take(item); }
  return chosen;
}

// ordered: LLM's final picks (best-first); pool: every batch-approved candidate by total score;
// reserve: recalled but not approved, best-first — used only to cover a bucket the other two cannot.
// Fill each bucket's quota from the LLM picks first, then from the approved pool; any quota that
// still cannot be met is reported and filled from the other buckets rather than silently dropped.
export function applyMixQuota(ordered, pool, targets, count, bucketOf, reserve = []) {
  const chosen = []; const used = new Set(); const filled = { familiar: 0, forgotten: 0, library: 0 };
  const take = (item) => { chosen.push(item); used.add(item.id); filled[bucketOf(item)] += 1; };
  for (const source of [ordered, pool, reserve]) for (const item of source) {
    const bucket = bucketOf(item);
    if (!used.has(item.id) && filled[bucket] < (targets[bucket] ?? 0) && chosen.length < count) take(item);
  }
  const shortfall = Object.fromEntries(Object.entries(targets).map(([bucket, target]) => [bucket, Math.max(0, target - filled[bucket])]).filter(([, value]) => value));
  for (const source of [ordered, pool]) for (const item of source) if (!used.has(item.id) && chosen.length < count) take(item);
  const rank = new Map(ordered.map((item, index) => [item.id, index]));
  chosen.sort((left, right) => (rank.get(left.id) ?? Infinity) - (rank.get(right.id) ?? Infinity));
  return { chosen, filled, shortfall };
}

// Ratio priority: what the user said in the request > the sliders (if they set them) > the planner's
// reading of the situation. Always returns integer shares summing to 100 plus where they came from.
export function resolveMix(planned, slider) {
  const shares = (value) => ["familiar", "forgotten", "discover"].map((key) => Math.max(0, Number(value?.[key]) || 0));
  const normalized = (values, source, reason = "") => {
    const total = values.reduce((sum, value) => sum + value, 0);
    const [familiar, forgotten] = values.map((value) => Math.round((value / total) * 100));
    return { familiar, forgotten, discover: 100 - familiar - forgotten, source, reason };
  };
  const plannedShares = shares(planned);
  const plannedValid = plannedShares.some((value) => value > 0);
  if (plannedValid && (planned.source === "request" || !slider)) return normalized(plannedShares, planned.source === "request" ? "request" : "situation", String(planned.reason || ""));
  if (slider && shares(slider).some((value) => value > 0)) return normalized(shares(slider), "slider", "按你设置的比例");
  return normalized([50, 20, 30], "default", "默认比例");
}
