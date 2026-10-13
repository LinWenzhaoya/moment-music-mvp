import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.MUSIC_DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "moment-tags-")), "test.sqlite");
const { applyHardFilters, matchesHardFilters, sanitizeHardFilters } = await import("../local-music/song-tags.mjs");

const song = (id, overrides = {}) => ({ id, tags: {
  language: "国语", vocalPresence: "有人声", vocalType: "男声", tempo: "中", acousticElectronic: "混合",
  genre: { primary: "流行（Pop）", sub: ["抒情 (Ballad)"] }, bpm: 90, valence: 0.3, arousal: 0.6, ...overrides,
} });

test("sanitizeHardFilters drops unknown vocabulary and malformed ranges", () => {
  const filters = sanitizeHardFilters({ languages: ["粤语", "火星语"], tempo: ["很快"], genres: ["古典", " "], bpmRange: [150, "x"], arousalRange: [0.7, 1.4] });
  assert.deepEqual(filters.languages, ["粤语"]);
  assert.deepEqual(filters.tempo, []);
  assert.deepEqual(filters.genres, ["古典"]);
  assert.equal(filters.bpmRange, null);
  assert.deepEqual(filters.arousalRange, [0.7, 1]);
});

test("genre filter matches across Chinese/English spellings and punctuation", () => {
  const filters = sanitizeHardFilters({ genres: ["古典", "orchestral"] });
  assert.equal(matchesHardFilters(song(1, { genre: { primary: "古典（Classical）", sub: [] } }).tags, filters), true);
  assert.equal(matchesHardFilters(song(2, { genre: { primary: "电影配乐（Film Score）", sub: ["管弦乐 (Orchestral)"] } }).tags, filters), true);
  assert.equal(matchesHardFilters(song(3).tags, filters), false);
});

test("untagged songs never pass an active hard filter", () => {
  assert.equal(matchesHardFilters(undefined, sanitizeHardFilters({ languages: ["国语"] })), false);
});

test("soft ranges are relaxed when too few songs remain; categorical filters are not", () => {
  const songs = [song(1, { arousal: 0.9 }), song(2, { arousal: 0.4 }), song(3, { arousal: 0.5 }), song(4, { language: "粤语", arousal: 0.4 })];
  const tagsById = new Map(songs.map((item) => [item.id, item.tags]));
  const filters = sanitizeHardFilters({ languages: ["国语"], arousalRange: [0.8, 1] });
  const strict = applyHardFilters(songs, tagsById, filters, 1);
  assert.deepEqual(strict.rows.map((row) => row.id), [1]);
  assert.deepEqual(strict.relaxed, []);
  const relaxed = applyHardFilters(songs, tagsById, filters, 3);
  assert.deepEqual(relaxed.rows.map((row) => row.id), [1, 2, 3]);
  assert.deepEqual(relaxed.relaxed, ["arousalRange"]);
});

test("a classical request does not pull in orchestral pop", () => {
  const filters = sanitizeHardFilters({ genres: ["古典", "管弦", "Orchestral"] });
  assert.equal(matchesHardFilters(song(1, { genre: { primary: "流行（Pop）", sub: ["管弦乐流行（Orchestral Pop）"] } }).tags, filters), false);
  assert.equal(matchesHardFilters(song(2, { genre: { primary: "电影配乐（Film Score）", sub: ["管弦乐（Orchestral）"] } }).tags, filters), true);
});
