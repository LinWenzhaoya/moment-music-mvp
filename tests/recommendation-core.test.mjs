import test from "node:test";
import assert from "node:assert/strict";
import { fuzzyTitleDistance, maximalTitleMatches, nearestTitleAfterArtist, sanitizeHardStyles } from "../local-music/recommendation-core.mjs";

test("参考歌允许单字近似写法", () => assert.equal(fuzzyTitleDistance("类似周杰伦漂移的歌", "飘移"), 1));
test("完整标题已命中时不再误认为短同名歌", () => assert.deepEqual(maximalTitleMatches([{ id: 1, title: "Right Now (Na Na Na)" }, { id: 2, title: "Right Now" }]).map((row) => row.id), [1]));
test("模糊歌名只从紧邻歌手的片段识别，不把“歌曲”误认为《夜曲》", () => {
  const rows = [{ id: 1, title: "飘移" }, { id: 2, title: "夜曲" }];
  assert.equal(nearestTitleAfterArtist("给我生成10首类似周杰伦漂移的歌曲歌单", "周杰伦", rows)?.id, 1);
  assert.equal(nearestTitleAfterArtist("想听周杰伦比较high的歌曲", "周杰伦", rows), null);
});
test("参考歌派生风格不得变成硬条件", () => assert.deepEqual(sanitizeHardStyles("生成跟 Love Story 类似的歌", ["乡村流行", "青春流行摇滚"]), []));
test("用户明确写出的曲风保留为硬条件，负向曲风不保留", () => assert.deepEqual(sanitizeHardStyles("想听电子R&B，不要摇滚", ["电子R&B", "摇滚"]), ["电子R&B"]));
test("isTitleMention ignores titles that are ordinary words or fragments of other words", async () => {
  const { isTitleMention } = await import("../local-music/recommendation-core.mjs");
  const prompt = "我刚拿到一个校招offer，非常激动，想听古典、激昂的音乐";
  assert.equal(isTitleMention(prompt, "FE"), false);
  assert.equal(isTitleMention(prompt, "想听"), false);
  assert.equal(isTitleMention("来点像《晴天》那样的", "晴天"), true);
  assert.equal(isTitleMention("想听像年轮说那样的歌", "年轮说"), true);
  assert.equal(isTitleMention("play something like Hotline Bling please", "Hotline Bling"), true);
  assert.equal(isTitleMention("a hotline blingy vibe", "Hotline Bling"), false);
});
