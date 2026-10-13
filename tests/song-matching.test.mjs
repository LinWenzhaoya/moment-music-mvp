import test from "node:test";
import assert from "node:assert/strict";
import { artistsMatch, buildTitleIndex, matchExternalSong, normalizeTitle, parseTakeoutTime, splitArtists } from "../local-music/song-matching.mjs";

test("Takeout 英文时间（含 Sept 与时区）转为 UTC", () => assert.equal(parseTakeoutTime("28 Sept 2026, 04:23:11 GMT-07:00"), "2026-09-28T11:23:11.000Z"));
test("无法识别的时间返回 null 而不是错误时间", () => assert.equal(parseTakeoutTime("yesterday"), null));
test("繁体标题与简体本地歌名归一后相同", () => assert.equal(normalizeTitle("止戰之殤"), normalizeTitle("止战之殇")));
test("去掉曲目编号与 feat/with 括号", () => {
  assert.equal(normalizeTitle("03 爱的受害者"), normalizeTitle("爱的受害者"));
  assert.equal(normalizeTitle("Miss Me The Same (with Anson Seabra)"), normalizeTitle("Miss Me The Same"));
});
test("多歌手拆分后任一命中即算同一首", () => {
  assert.deepEqual(splitArtists("Martin Garrix&Dua Lipa"), ["martingarrix", "dualipa"]);
  assert.ok(artistsMatch("Dua Lipa - Topic", "Martin Garrix&Dua Lipa"));
});
test("别名表把英文名映射到中文名", () => {
  const aliases = new Map([["jaychou", new Set(["周杰伦"])]]);
  assert.ok(artistsMatch("Jay Chou", "周杰伦", aliases));
  assert.equal(artistsMatch("Jay Chou", "周杰伦"), false);
});
test("同名不同歌手不匹配", () => {
  const index = buildTitleIndex([{ id: 1, title: "Hotline", artist: "Billie Eilish" }]);
  assert.equal(matchExternalSong({ title: "Hotline", artist: "Drake" }, index, new Map()).track, null);
});
