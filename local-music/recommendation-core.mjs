export function logicalTrackKey(row) {
  return `${String(row.artist || "").trim().toLowerCase()}\u0000${String(row.title || "").trim().toLowerCase()}`;
}

export function normalizeMatch(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, "");
}

function levenshtein(left, right) {
  const a = [...left]; const b = [...right];
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return row[b.length];
}

export function fuzzyTitleDistance(prompt, title) {
  const source = normalizeMatch(prompt); const target = normalizeMatch(title);
  if (!target || target.length < 2) return Infinity;
  if (source.includes(target)) return 0;
  let best = Infinity;
  for (let size = Math.max(2, target.length - 1); size <= target.length + 1; size += 1) {
    for (let index = 0; index + size <= source.length; index += 1) best = Math.min(best, levenshtein(source.slice(index, index + size), target));
  }
  return best;
}

// Does the request name this song? Quoted titles (《晴天》, "Yellow") always count. Unquoted ones must be
// long enough not to be ordinary words: "想听" or the "FE" inside "offer" are not references.
// Short titles still work through the artist path ("周杰伦的晴天").
export function isTitleMention(prompt, title) {
  const text = String(title || "").trim();
  if (!text) return false;
  const quoted = new RegExp(`[《“"「『']\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[》”"」』']`, "i");
  if (quoted.test(prompt)) return true;
  const normalized = normalizeMatch(text);
  if (/^[ -~]+$/.test(text)) {
    if (normalized.length < 4) return false;
    const escaped = text.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(String(prompt).toLowerCase());
  }
  return normalized.length >= 3 && normalizeMatch(prompt).includes(normalized);
}

export function maximalTitleMatches(rows) {
  return rows.filter((row, index) => {
    const title = normalizeMatch(row.title);
    return !rows.some((other, otherIndex) => otherIndex !== index && normalizeMatch(other.title).length > title.length && normalizeMatch(other.title).includes(title));
  });
}

export function nearestTitleAfterArtist(prompt, artist, rows) {
  const source = normalizeMatch(prompt);
  const artistText = normalizeMatch(artist);
  const artistIndex = source.indexOf(artistText);
  if (artistIndex < 0) return null;
  const nearby = source.slice(artistIndex + artistText.length).replace(/^(?:的|这首|那首)/, "");
  if (!nearby || /^(?:比较|歌曲|歌单|音乐|风格|类似|想听|生成)/.test(nearby)) return null;
  const ranked = rows.map((row) => {
    const title = normalizeMatch(row.title);
    return { row, distance: title ? levenshtein(nearby.slice(0, title.length), title) : Infinity, length: title.length };
  }).filter((item) => item.length >= 2 && item.distance <= 1)
    .sort((left, right) => left.distance - right.distance || right.length - left.length);
  return ranked[0]?.row || null;
}

export function sanitizeHardStyles(prompt, values) {
  const normalizedPrompt = normalizeMatch(prompt);
  return (Array.isArray(values) ? values : []).map((value) => String(value).trim()).filter(Boolean)
    .filter((value) => {
      const style = normalizeMatch(value);
      const index = normalizedPrompt.indexOf(style);
      if (index < 0) return false;
      const context = normalizedPrompt.slice(Math.max(0, index - 8), index);
      return !/(?:不要|别放|别要|避开|排除|不想听|拒绝|去掉|不听)$/.test(context);
    });
}
