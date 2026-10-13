import { db, safeJson } from "./db.mjs";

// v2.2 audio tags + locally measured audio features, in the shape the planner, the hard filters and
// the ranking model all read. Fields with fixed vocabularies are the ones hard filters may use.
export const TAG_VOCAB = {
  languages: ["国语", "粤语", "英语", "韩语", "日语", "闽南语", "其他", "无人声"],
  vocalPresence: ["有人声", "人声很少", "纯音乐"],
  vocalTypes: ["男声", "女声", "男女合唱", "多人组合", "无"],
  tempo: ["慢", "中", "快"],
  acousticElectronic: ["原声为主", "电子为主", "混合"],
};

export function loadSongTags() {
  const rows = db.prepare(`SELECT v.*, f.bpm, f.bpm_perceived, f.loudness_lufs FROM song_tags_v2 v
    LEFT JOIN track_audio_features f ON f.track_id=v.track_id`).all();
  return new Map(rows.map((row) => [Number(row.track_id), compactTags(row)]));
}

export function compactTags(row) {
  const genre = safeJson(row.genre_json, {});
  const sound = safeJson(row.sound_json, {});
  const arc = safeJson(row.arc_json, {});
  return {
    language: row.language, vocalPresence: row.vocal_presence, vocalType: row.vocal_type, vocalTimbre: sound.vocalTimbre || "",
    genre: { primary: genre.primary || "", sub: genre.sub || [], era: genre.era || "", region: genre.region || "" },
    instruments: sound.instruments || [], acousticElectronic: row.acoustic_electronic, texture: sound.texture || "",
    tempo: row.tempo, bpm: row.bpm_perceived ?? row.bpm ?? null, loudnessLufs: row.loudness_lufs ?? null,
    arcShape: row.arc_shape, arc: arc.summary || "",
    mood: safeJson(row.mood_json, []), valence: row.valence, arousal: row.arousal,
    lyricTheme: safeJson(row.lyric_theme_json, []), scene: safeJson(row.scene_json, []),
    description: row.description,
  };
}

const norm = (value) => String(value || "").toLowerCase().replace(/[\s()（）\-_/·.,，、&]+/g, "");
const inRange = (value, range) => !Array.isArray(range) || range.length !== 2 || value == null
  || (value >= Number(range[0]) && value <= Number(range[1]));
const listFilter = (values, allowed) => (Array.isArray(values) ? values.filter((value) => allowed.includes(value)) : []);

// Keep only filters the planner filled with valid values; anything else is ignored rather than trusted.
export function sanitizeHardFilters(raw = {}) {
  const range = (value, low, high) => (Array.isArray(value) && value.length === 2 && value.every((item) => Number.isFinite(Number(item)))
    ? [Math.max(low, Number(value[0])), Math.min(high, Number(value[1]))] : null);
  return {
    languages: listFilter(raw.languages, TAG_VOCAB.languages),
    vocalPresence: listFilter(raw.vocalPresence, TAG_VOCAB.vocalPresence),
    vocalTypes: listFilter(raw.vocalTypes, TAG_VOCAB.vocalTypes),
    tempo: listFilter(raw.tempo, TAG_VOCAB.tempo),
    acousticElectronic: listFilter(raw.acousticElectronic, TAG_VOCAB.acousticElectronic),
    genres: (Array.isArray(raw.genres) ? raw.genres : []).map((value) => String(value).trim()).filter((value) => norm(value).length >= 2),
    bpmRange: range(raw.bpmRange, 30, 250),
    valenceRange: range(raw.valenceRange, 0, 1),
    arousalRange: range(raw.arousalRange, 0, 1),
  };
}

export function hasHardFilters(filters) {
  return Object.values(filters).some((value) => (Array.isArray(value) ? value.length : value));
}

// Ranges come from fuzzy words ("别太吵", "160 左右"); when they would leave too few songs they are
// relaxed first, while categorical filters ("粤语", "纯音乐", "古典") are never relaxed.
const SOFT_RANGES = ["valenceRange", "arousalRange", "bpmRange"];

export function matchesHardFilters(tags, filters, skip = new Set()) {
  if (!tags) return false;
  if (filters.languages.length && !filters.languages.includes(tags.language)) return false;
  if (filters.vocalPresence.length && !filters.vocalPresence.includes(tags.vocalPresence)) return false;
  if (filters.vocalTypes.length && !filters.vocalTypes.includes(tags.vocalType)) return false;
  if (filters.tempo.length && !filters.tempo.includes(tags.tempo)) return false;
  if (filters.acousticElectronic.length && !filters.acousticElectronic.includes(tags.acousticElectronic)) return false;
  if (filters.genres.length) {
    // Match each genre label on its own, and skip pop hybrids unless pop itself was asked for:
    // "管弦乐流行（Orchestral Pop）" is pop, not the classical music a "古典" request means.
    const labels = [tags.genre.primary, ...tags.genre.sub].map(norm);
    const isPop = (label) => /流行|pop/.test(label);
    if (!filters.genres.some((genre) => labels.some((label) => label.includes(norm(genre)) && (!isPop(label) || isPop(norm(genre)))))) return false;
  }
  if (!skip.has("bpmRange") && !inRange(tags.bpm, filters.bpmRange)) return false;
  if (!skip.has("valenceRange") && !inRange(tags.valence, filters.valenceRange)) return false;
  if (!skip.has("arousalRange") && !inRange(tags.arousal, filters.arousalRange)) return false;
  return true;
}

export function applyHardFilters(rows, tagsById, filters, minimum) {
  if (!hasHardFilters(filters)) return { rows, relaxed: [] };
  const skip = new Set();
  let kept = rows.filter((row) => matchesHardFilters(tagsById.get(Number(row.id)), filters, skip));
  for (const range of SOFT_RANGES) {
    if (kept.length >= minimum || !filters[range]) continue;
    skip.add(range);
    kept = rows.filter((row) => matchesHardFilters(tagsById.get(Number(row.id)), filters, skip));
  }
  return { rows: kept, relaxed: [...skip] };
}

// Small per-song summary for every list in the app: drives the mood cover (valence → warm/cool,
// arousal → intensity) and 2–3 short chips. Cached until any tag row changes.
let summaryCache = null;
const shortGenre = (value) => String(value || "").replace(/[（(].*?[）)]/g, "").split(/[/、]/)[0].trim();

export function tagSummaries() {
  // Called once per serialized track: re-check the table at most once a second, not per row.
  if (summaryCache && Date.now() - summaryCache.checkedAt < 1000) return summaryCache.map;
  const stamp = db.prepare("SELECT COUNT(*) AS n, MAX(updated_at) AS latest FROM song_tags_v2").get();
  const key = `${stamp.n}:${stamp.latest}`;
  if (summaryCache?.key === key) { summaryCache.checkedAt = Date.now(); return summaryCache.map; }
  const map = new Map();
  for (const row of db.prepare("SELECT track_id, valence, arousal, mood_json, genre_json, language, vocal_presence FROM song_tags_v2").all()) {
    const mood = safeJson(row.mood_json, []);
    const genre = shortGenre(safeJson(row.genre_json, {}).primary);
    map.set(Number(row.track_id), {
      valence: row.valence, arousal: row.arousal, language: row.language, instrumental: row.vocal_presence === "纯音乐",
      chips: [...new Set([...mood.slice(0, 2), genre].filter((chip) => chip && chip.length <= 8))].slice(0, 3),
    });
  }
  summaryCache = { key, map, checkedAt: Date.now() };
  return map;
}
