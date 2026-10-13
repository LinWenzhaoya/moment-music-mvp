import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectRoot } from "../local-music/config.mjs";
import { deepseekJson } from "../local-music/llm.mjs";

// Second pass over songs the downloader could not find. Most misses are not missing songs but
// messy YouTube metadata ("高慧君 - 忘了 (歌詞 Lyric Video)" uploaded by a lyric channel) or an
// artist alias the table lacked (Firdhaus ↔ 菲道尔). The model cleans each entry, flags non-songs
// (type beats, covers, fan edits), and confirms which same-title candidate is the same artist.
// Output: 曲库清单/4-补救清单.csv for download_library.py, plus new aliases in artist_aliases.json.
const planDir = resolve(process.env.PLAN_OUT || join(projectRoot, "..", "曲库清单"));
const downloadDir = resolve(process.env.DOWNLOAD_OUT || join(projectRoot, "..", "曲库下载"));
const aliasesPath = join(planDir, "artist_aliases.json");

const latest = new Map();
for (const line of readFileSync(join(downloadDir, "state.jsonl"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const record = JSON.parse(line);
  latest.set(record.key, record);
}
const misses = [...latest.values()].filter((record) => record.status === "not_found"
  || (record.status === "error" && record.error !== "network_down"));
console.log(`Misses to review: ${misses.length}`);

const system = `你在整理一个个人曲库的下载失败清单。每条记录来自 YouTube Music 的播放历史，title/artist 可能很脏：标题里混着"歌手 - 歌名"、"(Official Lyric Video)"、"【歌词】"、节目名，artist 可能只是上传者频道名。nearMisses 是音乐平台上"歌名相同但歌手名对不上"的搜索结果。
对每条判断：
1. isSong：是否是一首可以在正规音乐平台找到的正式发行歌曲。Type Beat、伴奏、翻唱 cover、粉丝混剪、综艺片段、播客、演出串烧都是 false。
2. title / artist：还原成官方歌名和真正的演唱者（用官方写法，中文歌手用中文名）。去掉歌词视频、MV、Lyric 等后缀。
3. sameArtistIndex：nearMisses 里如果有某条就是同一首歌、同一位演唱者（只是署名写法不同，例如 Firdhaus=菲道尔、YOUNG Captain=队长），给出它的序号；没有就填 -1。翻唱、同名不同歌一律 -1。
不确定时宁可 isSong=false 或 -1。只返回JSON：{"items":[{"i":0,"isSong":true,"title":"","artist":"","sameArtistIndex":-1}]}，每条都要返回。`;

const aliases = JSON.parse(readFileSync(aliasesPath, "utf8"));
const repaired = [];
let notSongs = 0; let aliasAdds = 0;
for (let index = 0; index < misses.length; index += 40) {
  const batch = misses.slice(index, index + 40);
  const result = await deepseekJson(system, {
    records: batch.map((record, i) => ({ i, title: record.title, artist: record.artist, nearMisses: record.near_misses || [] })),
  }, 4000);
  for (const item of Array.isArray(result.value?.items) ? result.value.items : []) {
    const record = batch[Number(item.i)];
    if (!record) continue;
    if (!item.isSong) { notSongs += 1; continue; }
    const title = String(item.title || record.title).trim();
    const artist = String(item.artist || record.artist).trim();
    const near = (record.near_misses || [])[Number(item.sameArtistIndex)];
    if (near) {
      // near-miss format: "song | singers | ext | size" — teach the downloader this artist's other name
      const singers = near.split(" | ")[1] || "";
      for (const name of [artist, ...String(record.artist).split(/、|&|,/)].map((value) => value.trim()).filter(Boolean)) {
        aliases[name] = [...new Set([...(aliases[name] || [name]), ...singers.split(/&|,|、/).map((value) => value.trim()).filter(Boolean)])];
        aliasAdds += 1;
      }
    }
    repaired.push({ layer: record.layer, priority: record.priority, title, artist, link: record.link, key: record.key, original: `${record.title} · ${record.artist}` });
  }
  console.log(`Reviewed ${Math.min(index + 40, misses.length)}/${misses.length}`);
}
writeFileSync(aliasesPath, JSON.stringify(aliases, null, 1));

const cell = (value) => (/[",\n]/.test(String(value ?? "")) ? `"${String(value).replaceAll("\"", "\"\"")}"` : String(value ?? ""));
const lines = [["层级", "层内优先级", "歌名", "歌手", "链接", "原始键", "原始条目"],
  ...repaired.map((row) => [row.layer, row.priority, row.title, row.artist, row.link, row.key, row.original])];
writeFileSync(join(planDir, "4-补救清单.csv"), `\ufeff${lines.map((line) => line.map(cell).join(",")).join("\n")}\n`);
console.log(JSON.stringify({ reviewed: misses.length, repairable: repaired.length, notSongs, aliasUpdates: aliasAdds }, null, 2));
