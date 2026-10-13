import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectRoot } from "../local-music/config.mjs";
import { db } from "../local-music/db.mjs";
import { deepseekJson } from "../local-music/llm.mjs";
import { normalizeArtist, splitArtists } from "../local-music/song-matching.mjs";

// Chinese platforms credit artists differently from YouTube Music (JJ Lin ↔ 林俊杰, THE 8 ↔ 徐明浩).
// Build one alias list per artist on the download list; the downloader uses it to verify matches,
// and the same aliases go into artist_aliases so history ↔ library matching improves too.
const planDir = resolve(process.env.PLAN_OUT || join(projectRoot, "..", "曲库清单"));
const outPath = join(planDir, "artist_aliases.json");
const text = readFileSync(join(planDir, "1-下载清单.csv"), "utf8").replace(/^\ufeff/, "");
const artistColumn = text.split("\n")[0].split(",").indexOf("歌手");

function csvRows(input) {
  const rows = []; let row = []; let field = ""; let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === "\"" && input[index + 1] === "\"") { field += "\""; index += 1; } else if (char === "\"") quoted = false; else field += char;
    } else if (char === "\"") quoted = true;
    else if (char === ",") { row.push(field); field = ""; } else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; } else field += char;
  }
  return rows.slice(1);
}

const artists = new Map();
for (const row of csvRows(text)) {
  for (const name of String(row[artistColumn] || "").split(/\s*(?:、|&|,|，|\/| x | feat\.? )\s*/i)) {
    const clean = name.trim();
    if (clean && !artists.has(normalizeArtist(clean))) artists.set(normalizeArtist(clean), clean);
  }
}
const aliases = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : {};
const pending = [...artists.values()].filter((name) => !aliases[name]);
console.log(`Artists: ${artists.size}, need aliases: ${pending.length}`);

const system = `你是音乐资料库编辑。为每位歌手或组合列出在中国大陆音乐平台（酷我、网易云、QQ音乐）和国际平台上常见的署名写法：简体中文名、繁体中文名、英文名、韩文或日文原名、常见别称。
只写你确定的写法；不认识的歌手只返回原名。组合不要拆成成员。只返回JSON：{"artists":[{"i":0,"names":["原名","别名"]}]}，每位都要返回。`;
for (let index = 0; index < pending.length; index += 60) {
  const batch = pending.slice(index, index + 60);
  const result = await deepseekJson(system, { artists: batch.map((name, i) => ({ i, name })) }, 3600);
  for (const item of Array.isArray(result.value?.artists) ? result.value.artists : []) {
    const name = batch[Number(item.i)];
    if (!name) continue;
    aliases[name] = [...new Set([name, ...(Array.isArray(item.names) ? item.names : []).map((value) => String(value).trim()).filter(Boolean)])];
  }
  for (const name of batch) aliases[name] ??= [name];
  writeFileSync(outPath, JSON.stringify(aliases, null, 1));
  console.log(`Aliases: ${Math.min(index + 60, pending.length)}/${pending.length}`);
}

// Feed confirmed alternate names back into the history matcher.
const insert = db.prepare("INSERT OR IGNORE INTO artist_aliases (alias_key, canonical_artist, same, source) VALUES (?, ?, 1, 'llm_catalog')");
let added = 0;
for (const names of Object.values(aliases)) {
  const keys = [...new Set(names.flatMap((name) => [normalizeArtist(name), ...splitArtists(name)]).filter(Boolean))];
  for (const left of keys) for (const right of keys) if (left !== right) added += Number(insert.run(left, right).changes || 0);
}
console.log(`Wrote ${outPath}; ${added} alias pairs added to artist_aliases`);
