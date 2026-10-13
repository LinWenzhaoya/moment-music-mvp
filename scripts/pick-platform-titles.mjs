import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectRoot } from "../local-music/config.mjs";
import { deepseekJson } from "../local-music/llm.mjs";

// Third pass over misses. YouTube Music often shows an English title for a Chinese song
// ("Hostage · 张惠妹") while the platforms list it as 人质. The downloader now records the
// same-artist titles it saw in search results (artist_hits); the model only picks among those
// real titles, so it cannot invent a song. Output: 曲库清单/5-译名清单.csv for download_library.py.
const planDir = resolve(process.env.PLAN_OUT || join(projectRoot, "..", "曲库清单"));
const downloadDir = resolve(process.env.DOWNLOAD_OUT || join(projectRoot, "..", "曲库下载"));

const latest = new Map();
for (const line of readFileSync(join(downloadDir, "state.jsonl"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const record = JSON.parse(line);
  latest.set(record.key, record);
}
// The model ignored "Live/Remix don't count" often enough (太美丽 (Live), 全部都是你 (RemixDJ…)) that
// version-tagged candidates are dropped in code unless the wanted title carries the same tag.
const versionTag = /live|remix|\bdj|伴奏|instrumental|karaoke|acoustic|demo|现场|演唱会|翻唱|cover|sped ?up|slowed|piano session/i;
const misses = [...latest.values()]
  .filter((record) => record.status === "not_found" && record.artist_hits?.length)
  .map((record) => ({ ...record, artist_hits: record.artist_hits.filter((hit) => versionTag.test(record.title) || !versionTag.test(hit)) }))
  .filter((record) => record.artist_hits.length);
console.log(`Misses with same-artist results: ${misses.length}`);

const system = `你在帮个人曲库找歌。每条记录有一首要找的歌（title/artist，来自 YouTube Music，歌名可能是英文译名、罗马音或别名），以及音乐平台上同一歌手的搜索结果歌名列表 candidates。
判断 candidates 里是否有一个就是这首歌本身（只是歌名写法不同：中英文译名、繁简、罗马音、别名）。翻唱、Live、Remix、伴奏、同歌手的另一首歌都不算。
只有确定时才给出序号，不确定填 -1。只返回JSON：{"items":[{"i":0,"pick":-1}]}，每条都要返回。`;

const picked = [];
for (let index = 0; index < misses.length; index += 40) {
  const batch = misses.slice(index, index + 40);
  const result = await deepseekJson(system, {
    records: batch.map((record, i) => ({ i, title: record.title, artist: record.artist, candidates: record.artist_hits })),
  }, 3000);
  for (const item of Array.isArray(result.value?.items) ? result.value.items : []) {
    const record = batch[Number(item.i)];
    const title = record?.artist_hits?.[Number(item.pick)];
    if (title) picked.push({ ...record, platformTitle: title });
  }
  console.log(`Reviewed ${Math.min(index + 40, misses.length)}/${misses.length}`);
}

const cell = (value) => (/[",\n]/.test(String(value ?? "")) ? `"${String(value).replaceAll("\"", "\"\"")}"` : String(value ?? ""));
const lines = [["层级", "层内优先级", "歌名", "歌手", "链接", "原始键", "原始条目"],
  ...picked.map((row) => [row.layer, row.priority, row.platformTitle, row.artist, row.link, row.key, `${row.title} · ${row.artist}`])];
writeFileSync(join(planDir, "5-译名清单.csv"), `\ufeff${lines.map((line) => line.map(cell).join(",")).join("\n")}\n`);
for (const row of picked.slice(0, 15)) console.log(`  ${row.title} → ${row.platformTitle} · ${row.artist}`);
console.log(JSON.stringify({ reviewed: misses.length, picked: picked.length }, null, 2));
