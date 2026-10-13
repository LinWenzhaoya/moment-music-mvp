import * as OpenCC from "opencc-js";
import { normalizeMatch } from "./recommendation-core.mjs";

const toSimplified = OpenCC.Converter({ from: "t", to: "cn" });
const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

// Google Takeout English timestamps, e.g. "28 Sept 2026, 04:23:11 GMT-07:00" → ISO UTC.
export function parseTakeoutTime(text) {
  const match = String(text).trim().match(/^(\d{1,2}) (\w+) (\d{4}), (\d{2}):(\d{2}):(\d{2}) GMT([+-]\d{2}):?(\d{2})$/);
  if (!match) return null;
  const [, day, monthName, year, hour, minute, second, offsetHour, offsetMinute] = match;
  const month = months[monthName.toLowerCase()];
  if (month === undefined) return null;
  const sign = offsetHour.startsWith("-") ? -1 : 1;
  const offsetMs = sign * (Math.abs(Number(offsetHour)) * 60 + Number(offsetMinute)) * 60_000;
  const utc = Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second)) - offsetMs;
  return new Date(utc).toISOString();
}

export function cleanArtistName(value) {
  return String(value || "").replace(/\s*-\s*Topic$/i, "").trim();
}

export function normalizeTitle(value) {
  const stripped = String(value || "")
    .replace(/^\s*\d{1,3}[\s.、_-]+(?=\D)/, "")
    .replace(/[(（[【][^)）\]】]*(?:feat|ft\.|with|remaster|live|version|ver\.|mv|lyric|歌词|官方|official|audio)[^)）\]】]*[)）\]】]/gi, "")
    .replace(/\s+-\s+(?:remaster|live|single|radio edit).*$/i, "");
  return normalizeMatch(toSimplified(stripped));
}

export function normalizeArtist(value) {
  return normalizeMatch(toSimplified(cleanArtistName(value)));
}

export function splitArtists(value) {
  return cleanArtistName(value).split(/\s*(?:、|&|,|，|\/|;|；| x | X | feat\.? | ft\.? | and |和)\s*/i)
    .map(normalizeArtist).filter(Boolean);
}

export function titlesMatch(left, right) {
  const a = normalizeTitle(left); const b = normalizeTitle(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a));
}

// aliases: Map<normalizedAlias, Set<normalizedCanonicalArtist>>
export function artistsMatch(externalArtist, localArtist, aliases = new Map()) {
  const local = new Set(splitArtists(localArtist));
  local.add(normalizeArtist(localArtist));
  for (const name of [normalizeArtist(externalArtist), ...splitArtists(externalArtist)]) {
    if (local.has(name)) return true;
    for (const canonical of aliases.get(name) || []) if (local.has(canonical)) return true;
  }
  return false;
}

export function buildTitleIndex(tracks) {
  const index = new Map();
  for (const track of tracks) {
    const key = normalizeTitle(track.title);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(track);
  }
  return index;
}

// Returns candidate local tracks sharing the title (exact key first, then prefix matches).
export function titleCandidates(title, titleIndex) {
  const key = normalizeTitle(title);
  if (!key) return [];
  const exact = titleIndex.get(key);
  if (exact) return exact;
  if (key.length < 3) return [];
  const result = [];
  for (const [other, tracks] of titleIndex) if (other.length >= 3 && (other.startsWith(key) || key.startsWith(other))) result.push(...tracks);
  return result;
}

export function matchExternalSong(song, titleIndex, aliases) {
  const candidates = titleCandidates(song.title, titleIndex);
  const hit = candidates.find((track) => artistsMatch(song.artist, track.artist, aliases));
  return hit ? { track: hit, candidates } : { track: null, candidates };
}
