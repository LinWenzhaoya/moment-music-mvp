// Pure vector helpers: unit-normalised Float32Arrays, cosine via dot product, spherical K-means.

export function normalize(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return Float32Array.from(vector, (value) => value / norm);
}

export function dot(left, right) {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += left[index] * right[index];
  return sum;
}

export function weightedMean(vectors, weights = vectors.map(() => 1)) {
  const result = new Float32Array(vectors[0].length);
  vectors.forEach((vector, row) => { for (let index = 0; index < vector.length; index += 1) result[index] += vector[index] * weights[row]; });
  return normalize(result);
}

export function toBlob(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function fromBlob(blob) {
  const bytes = Uint8Array.from(blob);
  return new Float32Array(bytes.buffer, 0, bytes.byteLength / 4);
}

// Deterministic PRNG so clustering is reproducible across runs.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Weighted spherical K-means with k-means++ seeding. Vectors must be unit-normalised.
export function kmeans(vectors, weights, k, { iterations = 40, seed = 7 } = {}) {
  const random = mulberry32(seed);
  const centers = [vectors[Math.floor(random() * vectors.length)]];
  while (centers.length < k) {
    const distances = vectors.map((vector, index) => weights[index] * Math.max(0, 1 - Math.max(...centers.map((center) => dot(vector, center)))) ** 2);
    const total = distances.reduce((sum, value) => sum + value, 0);
    let target = random() * total; let chosen = 0;
    for (; chosen < distances.length - 1; chosen += 1) { target -= distances[chosen]; if (target <= 0) break; }
    centers.push(vectors[chosen]);
  }
  let assignments = new Array(vectors.length).fill(-1);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = vectors.map((vector) => {
      let best = 0; let bestSim = -Infinity;
      centers.forEach((center, index) => { const sim = dot(vector, center); if (sim > bestSim) { bestSim = sim; best = index; } });
      return best;
    });
    const changed = next.some((value, index) => value !== assignments[index]);
    assignments = next;
    for (let cluster = 0; cluster < k; cluster += 1) {
      const members = vectors.map((vector, index) => [vector, weights[index], assignments[index]]).filter((item) => item[2] === cluster);
      if (members.length) centers[cluster] = weightedMean(members.map((item) => item[0]), members.map((item) => item[1]));
    }
    if (!changed) break;
  }
  const clusterWeights = centers.map((_, cluster) => assignments.reduce((sum, value, index) => sum + (value === cluster ? weights[index] : 0), 0));
  return { centers, assignments, clusterWeights };
}

// Mean silhouette with cosine distance; O(n²), fine for a personal library.
export function silhouette(vectors, assignments, k) {
  if (k < 2) return -1;
  let total = 0; let counted = 0;
  for (let row = 0; row < vectors.length; row += 1) {
    const sums = new Array(k).fill(0); const counts = new Array(k).fill(0);
    for (let other = 0; other < vectors.length; other += 1) {
      if (other === row) continue;
      sums[assignments[other]] += 1 - dot(vectors[row], vectors[other]);
      counts[assignments[other]] += 1;
    }
    const own = assignments[row];
    if (!counts[own]) continue;
    const a = sums[own] / counts[own];
    let b = Infinity;
    for (let cluster = 0; cluster < k; cluster += 1) if (cluster !== own && counts[cluster]) b = Math.min(b, sums[cluster] / counts[cluster]);
    if (!Number.isFinite(b)) continue;
    total += (b - a) / Math.max(a, b || 1e-9); counted += 1;
  }
  return counted ? total / counted : -1;
}

// Pick K adaptively: the K in [kMin, kMax] with the best silhouette.
export function adaptiveKmeans(vectors, weights, { kMin = 2, kMax = 8 } = {}) {
  const upper = Math.min(kMax, Math.floor(vectors.length / 4));
  let best = null;
  for (let k = kMin; k <= upper; k += 1) {
    const result = kmeans(vectors, weights, k);
    const score = silhouette(vectors, result.assignments, k);
    if (!best || score > best.silhouette) best = { ...result, k, silhouette: score };
  }
  if (!best) best = { ...kmeans(vectors, weights, 1), k: 1, silhouette: null };
  return best;
}

export function minMaxNormalize(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return values.map(() => 0);
  const low = Math.min(...finite); const high = Math.max(...finite);
  return values.map((value) => (Number.isFinite(value) ? (high > low ? (value - low) / (high - low) : 0.5) : 0));
}
