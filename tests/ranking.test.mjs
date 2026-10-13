import test from "node:test";
import assert from "node:assert/strict";
import { applyMixQuota, mixTargets, perBatchPick, scoreCandidates, splitBatches } from "../local-music/ranking.mjs";

const config = { score: { alpha: 0.7, beta: 0.3 }, personal: { clusterWeight: 0.6, behaviorWeight: 0.4 }, llm: { perBatchRatio: 0.6 } };
const item = (id, querySim, clusterSim, behaviorNorm = 0) => ({ id, querySim, personal: { clusterSim, behaviorNorm } });

test("需求相同时，个人匹配更高的歌排在前面", () => {
  const ranked = scoreCandidates([item("a", 0.5, 0.2), item("b", 0.5, 0.9), item("c", 0.1, 0.1)], config);
  assert.deepEqual(ranked.map((row) => row.id), ["b", "a", "c"]);
});
test("需求权重 0.7 高于个人 0.3：需求明显更匹配的歌不会被口味压下去", () => {
  const ranked = scoreCandidates([item("fit", 0.9, 0.1), item("taste", 0.3, 0.9)], config);
  assert.equal(ranked[0].id, "fit");
});
test("没有兴趣中心时只用行为分，且不报错", () => {
  const ranked = scoreCandidates([item("a", 0.5, null, 0.8), item("b", 0.5, null, 0)], config);
  assert.equal(ranked[0].id, "a");
});
test("轮流分批：每批的质量分布相近", () => {
  const batches = splitBatches([1, 2, 3, 4, 5, 6, 7], 3);
  assert.deepEqual(batches, [[1, 4, 7], [2, 5], [3, 6]]);
});
test("每批挑选数 = ceil(目标×0.6)，10 首时每批 6 首", () => assert.equal(perBatchPick(10, config), 6));
test("比例 50/20/30 在 10 首时为 5/2/3，且总数守恒", () => {
  assert.deepEqual(mixTargets({ familiar: 50, forgotten: 20, discover: 30 }, 10), { familiar: 5, forgotten: 2, library: 3 });
  const odd = mixTargets({ familiar: 33, forgotten: 33, discover: 34 }, 7);
  assert.equal(odd.familiar + odd.forgotten + odd.library, 7);
});
test("配额不足时用其它类补齐并如实标注缺口", () => {
  const bucket = { a: "familiar", b: "familiar", c: "library", d: "library", e: "familiar" };
  const ordered = ["a", "c", "b"].map((id) => ({ id }));
  const pool = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
  const result = applyMixQuota(ordered, pool, { familiar: 2, forgotten: 1, library: 1 }, 4, (x) => bucket[x.id]);
  assert.equal(result.chosen.length, 4);
  assert.deepEqual(result.shortfall, { forgotten: 1 });
  assert.deepEqual(result.chosen.slice(0, 3).map((x) => x.id), ["a", "c", "b"]);
});

test("resolveMix: request text beats sliders, sliders beat the planner's situational guess", async () => {
  const { resolveMix } = await import("../local-music/ranking.mjs");
  const slider = { familiar: 50, forgotten: 20, discover: 30 };
  assert.deepEqual(resolveMix({ familiar: 80, forgotten: 0, discover: 20, source: "request", reason: "你说八成要听过的" }, slider),
    { familiar: 80, forgotten: 0, discover: 20, source: "request", reason: "你说八成要听过的" });
  assert.equal(resolveMix({ familiar: 30, forgotten: 10, discover: 60, source: "situation", reason: "x" }, slider).source, "slider");
  const auto = resolveMix({ familiar: 3, forgotten: 3, discover: 4, source: "situation", reason: "兴奋时多探索" }, null);
  assert.deepEqual([auto.familiar, auto.forgotten, auto.discover, auto.source], [30, 30, 40, "situation"]);
  assert.equal(resolveMix(null, null).source, "default");
});

test("stratifiedRecall gives every targeted bucket its own most relevant songs", async () => {
  const { stratifiedRecall } = await import("../local-music/ranking.mjs");
  // 30 forgotten songs outrank 5 familiar ones; plain top-10 would contain no familiar song at all.
  const ranked = [...Array.from({ length: 30 }, (_, i) => ({ id: i, bucket: "forgotten" })), ...Array.from({ length: 5 }, (_, i) => ({ id: 100 + i, bucket: "familiar" }))];
  const recalled = stratifiedRecall(ranked, (item) => item.bucket, { familiar: 2, forgotten: 1, library: 0 }, 10, { perTarget: 2, minPerBucket: 2 });
  assert.equal(recalled.filter((item) => item.bucket === "familiar").length, 4);
  assert.equal(recalled.length, 10);
  assert.equal(new Set(recalled.map((item) => item.id)).size, 10);
});

test("applyMixQuota covers a short bucket from the reserve, and only then", async () => {
  const { applyMixQuota } = await import("../local-music/ranking.mjs");
  const bucket = { 1: "forgotten", 2: "forgotten", 3: "forgotten", 9: "library" };
  const ordered = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const result = applyMixQuota(ordered, ordered, { familiar: 0, forgotten: 2, library: 1 }, 3, (item) => bucket[item.id], [{ id: 9 }]);
  assert.deepEqual(result.chosen.map((item) => item.id).sort(), [1, 2, 9]);
  assert.deepEqual(result.shortfall, {});
});
