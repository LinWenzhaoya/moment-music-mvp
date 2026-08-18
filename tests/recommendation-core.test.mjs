import test from "node:test";
import assert from "node:assert/strict";
import { classifyProfileEvidence, fuzzyTitleDistance, maximalTitleMatches, nearestTitleAfterArtist, sanitizeHardStyles } from "../local-music/recommendation-core.mjs";

test("参考歌允许单字近似写法", () => assert.equal(fuzzyTitleDistance("类似周杰伦漂移的歌", "飘移"), 1));
test("完整标题已命中时不再误认为短同名歌", () => assert.deepEqual(maximalTitleMatches([{ id: 1, title: "Right Now (Na Na Na)" }, { id: 2, title: "Right Now" }]).map((row) => row.id), [1]));
test("模糊歌名只从紧邻歌手的片段识别，不把“歌曲”误认为《夜曲》", () => {
  const rows = [{ id: 1, title: "飘移" }, { id: 2, title: "夜曲" }];
  assert.equal(nearestTitleAfterArtist("给我生成10首类似周杰伦漂移的歌曲歌单", "周杰伦", rows)?.id, 1);
  assert.equal(nearestTitleAfterArtist("想听周杰伦比较high的歌曲", "周杰伦", rows), null);
});
test("参考歌派生风格不得变成硬条件", () => assert.deepEqual(sanitizeHardStyles("生成跟 Love Story 类似的歌", ["乡村流行", "青春流行摇滚"]), []));
test("用户明确写出的曲风保留为硬条件，负向曲风不保留", () => assert.deepEqual(sanitizeHardStyles("想听电子R&B，不要摇滚", ["电子R&B", "摇滚"]), ["电子R&B"]));
test("曲风直接重合时只给出可解释证据，不生成相似度分", () => {
  const seed = { style:["史诗流行摇滚"],feltExperience:["宏大"],energyArc:["持续推进"],sound:["弦乐"] };
  const profile = { style:["史诗流行摇滚"],feltExperience:["振奋"],energyArc:["副歌释放"],sound:["管弦乐"],identity:"宏大推进" };
  const result = classifyProfileEvidence({ profile, seedProfiles:[seed] });
  assert.equal(result.tier, "direct");
  assert.ok(result.evidence.some((item) => item.includes("曲风直接重合")));
  assert.equal("score" in result, false);
});
test("多个维度有关联时归为关联候选，并保留具体命中证据", () => {
  const seed = { style:["史诗流行摇滚"],feltExperience:["昂扬"],energyArc:["持续推进"],sound:["行进式鼓点"] };
  const profile = { style:["Pop Rock","Folk Pop"],feltExperience:["振奋"],energyArc:["持续推进"],sound:["鼓点有力"],identity:"自由感" };
  const result = classifyProfileEvidence({ profile, seedProfiles:[seed] });
  assert.equal(result.tier, "related");
  assert.ok(result.evidence.length >= 3);
});
test("没有足够证据时不伪造相关性", () => {
  const seed = { style:["乡村流行"],feltExperience:["浪漫"],energyArc:["叙事推进"],sound:["原声吉他"] };
  const profile = { style:["暗黑电子R&B"],feltExperience:["危险冷酷"],energyArc:["低位循环"],sound:["低频合成器"],identity:"夜间危险感" };
  assert.equal(classifyProfileEvidence({ profile, seedProfiles:[seed] }), null);
});
