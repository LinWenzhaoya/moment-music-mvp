import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// personalization.mjs opens the database on import; point it at a throwaway file.
process.env.MUSIC_DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "moment-test-")), "test.sqlite");
const { aggregateBehavior, decayWeight, familiarityBucket, parseDbTime } = await import("../local-music/personalization.mjs");
const { adaptiveKmeans, normalize } = await import("../local-music/vector-math.mjs");

const DAY = 86_400_000;
const now = Date.UTC(2026, 8, 29);
const config = { halfLifeDays: 180, momentPlayPoints: 0, points: { like: 4, play: 1, skip: -3, complete: 2 } };

test("半衰期：180 天前的行为权重减半", () => assert.equal(decayWeight(180, 180), 0.5));
test("时间衰减：最近听 10 次胜过两年前听 50 次", () => {
  const events = [
    ...Array.from({ length: 50 }, () => ({ key: "old", source: "youtube", type: "play", at: now - 730 * DAY })),
    ...Array.from({ length: 10 }, () => ({ key: "new", source: "youtube", type: "play", at: now - 3 * DAY })),
  ];
  const songs = aggregateBehavior(events, now, config);
  assert.ok(songs.get("new").score > songs.get("old").score);
});
test("次数饱和：100 次不是 10 次的 10 倍", () => {
  const make = (n) => aggregateBehavior(Array.from({ length: n }, () => ({ key: "s", source: "youtube", type: "play", at: now })), now, config).get("s").score;
  assert.ok(make(100) / make(10) < 3);
});
test("快速跳过得负分，Moment 内的开始播放不计分", () => {
  const songs = aggregateBehavior([
    { key: "skip", source: "moment", type: "skip", at: now },
    { key: "start", source: "moment", type: "play", at: now },
  ], now, config);
  assert.ok(songs.get("skip").score < 0);
  assert.equal(songs.get("start").score, 0);
  assert.equal(songs.get("start").lastPositiveAt, null);
});
test("熟悉度：90 天内=熟悉，更久=遗忘旧爱，从未听=探索", () => {
  assert.equal(familiarityBucket(now - 10 * DAY, now), "familiar");
  assert.equal(familiarityBucket(now - 200 * DAY, now), "forgotten");
  assert.equal(familiarityBucket(NaN, now), "library");
});
test("SQLite 时间与 ISO 时间都按 UTC 解析", () => assert.equal(parseDbTime("2026-09-29 00:00:00"), parseDbTime("2026-09-29T00:00:00Z")));
test("两个明显分开的兴趣群会被自适应聚成 2 类", () => {
  const cluster = (base) => Array.from({ length: 10 }, (_, i) => normalize(base.map((v, j) => v + ((i * 7 + j) % 5) * 0.01)));
  const vectors = [...cluster([1, 0, 0, 0]), ...cluster([0, 0, 1, 0])];
  const result = adaptiveKmeans(vectors, vectors.map(() => 1), { kMin: 2, kMax: 4 });
  assert.equal(result.k, 2);
  assert.notEqual(result.assignments[0], result.assignments[15]);
});
