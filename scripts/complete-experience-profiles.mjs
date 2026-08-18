import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

try { process.loadEnvFile(resolve(".env.local")); } catch { /* configured by environment */ }

const apiKey = process.env.DEEPSEEK_API_KEY || "";
const baseUrl = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const model = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const db = new DatabaseSync(resolve("local-music/music-library.sqlite"));
const repairMode = process.env.PROFILE_REPAIR === "1";
const batchSize = Math.max(4, Math.min(14, Number(process.env.PROFILE_BATCH_SIZE || 10)));
const concurrency = Math.max(1, Math.min(6, Number(process.env.PROFILE_CONCURRENCY || 4)));

if (!apiKey || /在这里|填入|your/i.test(apiKey)) throw new Error("DEEPSEEK_API_KEY 未配置");

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const songKey = (row) => `${String(row.artist || "").trim().toLowerCase()}\u0000${String(row.title || "").trim().toLowerCase()}`;

function pendingSongs() {
  const rows = db.prepare(`SELECT t.id, t.title, t.artist, t.album, t.genre, t.folder,
    CASE WHEN p.track_id IS NULL THEN 0 ELSE 1 END AS profiled, p.source,
    p.style_json, p.felt_json, p.energy_json, p.sound_json, p.identity_text, p.avoid_text
    FROM tracks t LEFT JOIN song_experience_profiles p ON p.track_id=t.id
    WHERE t.available=1 ORDER BY lower(t.artist), lower(t.title), t.id`).all();
  const groups = new Map();
  for (const row of rows) {
    const key = songKey(row);
    const asciiIdentity = row.identity_text && Buffer.byteLength(row.identity_text) === row.identity_text.length;
    const identityLength = String(row.identity_text || "").length;
    const weakIdentity = /\u6b4c\u8bcd\u8868\u8fbe|\u6b4c\u8bcd\u4f20\u8fbe/.test(row.identity_text || "")
      || (/\u4e3a\u4e3b\u9898/.test(row.identity_text || "") && identityLength < 34)
      || identityLength < 14;
    const needsRepair = row.source === "llm_bulk_draft" && (asciiIdentity || weakIdentity);
    const group = groups.get(key) || { rows: [], hasProfile: false, needsRepair: false };
    group.rows.push(row);
    group.hasProfile ||= Boolean(row.profiled);
    group.needsRepair ||= needsRepair;
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => repairMode ? group.needsRepair : !group.hasProfile)
    .map((group) => group.rows.find((row) => repairMode ? row.source === "llm_bulk_draft" : true) || group.rows[0]);
}

const system = `你在为本地个性化音乐推荐系统批量生成“歌曲听感档案”初稿。你没有实时收听音频：知名作品可依据可靠的已有知识；不熟悉的作品必须保守，不要捏造具体乐器、歌词情节或音色事实。
标注优先级：
1. style 最重要：2至4个能真正限定候选范围的曲风指纹，不要只写“流行”。
2. feltExperience：3至5个真正听到的主观体验，区分沉重、苦闷、舒服的忧伤、暗黑酷感、爆裂力量等，不要把歌词主题直接当成听感。
3. energyArc：2至4个能量和情绪如何运动，例如克制积累、副歌释放、持续推进、悬置不爆发。
4. sound：2至4个决定曲风的声音特征；只写有把握的特征。
5. identity：一句话说清它与其他歌的核心区别，不要重复标签。
6. avoid：一句话写清哪些需求下不应推荐。
同一歌手的不同歌不得复制同一档案；Remix、翻唱、现场版要尊重标题和专辑所表明的版本差异。
所有标签和句子必须使用中文（通用曲风名如R&B、EDM可保留）。identity必须描述听感和曲风辨识度，不得只复述歌名或写“以XX为主题”。
只返回JSON：{"profiles":[{"id":1,"style":[""],"feltExperience":[""],"energyArc":[""],"sound":[""],"identity":"","avoid":""}]}。必须为输入中的每个id返回且只返回一条。`;

function cleanList(value, min = 2, max = 6) {
  if (!Array.isArray(value)) return null;
  const result = [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, max);
  return result.length >= min ? result : null;
}

function validateProfile(value, allowedIds) {
  const id = Number(value?.id);
  const style = cleanList(value?.style, 2, 4);
  const felt = cleanList(value?.feltExperience, 3, 5);
  const energy = cleanList(value?.energyArc, 2, 4);
  const sound = cleanList(value?.sound, 2, 4);
  const identity = String(value?.identity || "").trim();
  const avoid = String(value?.avoid || "").trim();
  if (!allowedIds.has(id) || !style || !felt || !energy || !sound || identity.length < 8 || avoid.length < 8) return null;
  return { id, style, felt, energy, sound, identity: identity.slice(0, 500), avoid: avoid.slice(0, 500) };
}

async function requestBatch(tracks, attempt = 1) {
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, thinking: { type: "disabled" }, response_format: { type: "json_object" },
        temperature: 0.25, max_tokens: 6200,
        messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify({ tracks }) }],
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || `HTTP ${response.status}`);
    const content = String(body.choices?.[0]?.message?.content || "").trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(content);
    const allowedIds = new Set(tracks.map((track) => Number(track.id)));
    const profiles = (Array.isArray(parsed.profiles) ? parsed.profiles : []).map((item) => validateProfile(item, allowedIds)).filter(Boolean);
    return { profiles, tokens: Number(body.usage?.total_tokens || 0), requested: tracks.length };
  } catch (error) {
    if (attempt >= 3) return { profiles: [], tokens: 0, requested: tracks.length, error: error.message };
    await sleep(1500 * attempt);
    return requestBatch(tracks, attempt + 1);
  }
}

const copies = db.prepare(`SELECT id FROM tracks WHERE available=1
  AND lower(trim(title))=lower(trim(?)) AND lower(trim(artist))=lower(trim(?))`);
const trackById = db.prepare("SELECT id,title,artist FROM tracks WHERE id=? AND available=1");
const insert = db.prepare(`INSERT INTO song_experience_profiles
  (track_id,style_json,felt_json,energy_json,sound_json,identity_text,avoid_text,source,review_status,notes)
  VALUES (?,?,?,?,?,?,?,'llm_bulk_draft','needs_user_review',?) ON CONFLICT(track_id) ${repairMode ? `DO UPDATE SET
    style_json=excluded.style_json, felt_json=excluded.felt_json, energy_json=excluded.energy_json,
    sound_json=excluded.sound_json, identity_text=excluded.identity_text, avoid_text=excluded.avoid_text,
    notes=excluded.notes, updated_at=CURRENT_TIMESTAMP WHERE song_experience_profiles.source='llm_bulk_draft'` : "DO NOTHING"}`);

function saveProfiles(profiles) {
  let logical = 0; let physical = 0;
  db.exec("BEGIN");
  try {
    for (const profile of profiles) {
      const track = trackById.get(profile.id);
      if (!track) continue;
      let changed = 0;
      for (const copy of copies.all(track.title, track.artist)) {
        changed += Number(insert.run(copy.id, JSON.stringify(profile.style), JSON.stringify(profile.felt), JSON.stringify(profile.energy), JSON.stringify(profile.sound), profile.identity, profile.avoid, repairMode ? "bulk-all-v1-qa" : "bulk-all-v1").changes || 0);
      }
      if (changed) { logical += 1; physical += changed; }
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { logical, physical };
}

let totalTokens = 0; let totalLogical = 0; let totalPhysical = 0; let pass = 0;
while (pass < 5) {
  const pending = pendingSongs();
  if (!pending.length) break;
  pass += 1;
  const size = pass >= 3 ? Math.max(2, Math.floor(batchSize / 2)) : batchSize;
  const batches = [];
  for (let index = 0; index < pending.length; index += size) batches.push(pending.slice(index, index + size));
  let passLogical = 0;
  for (let index = 0; index < batches.length; index += concurrency) {
    const group = batches.slice(index, index + concurrency);
    const results = await Promise.all(group.map((batch) => requestBatch(batch.map(({ id, title, artist, album, genre, folder, style_json, felt_json, energy_json, sound_json, identity_text, avoid_text }) => ({
      id, title, artist, album, genre, folder,
      ...(repairMode ? { existingDraft: { style: JSON.parse(style_json), feltExperience: JSON.parse(felt_json), energyArc: JSON.parse(energy_json), sound: JSON.parse(sound_json), identity: identity_text, avoid: avoid_text } } : {}),
    })))));
    for (const result of results) {
      totalTokens += result.tokens;
      const saved = saveProfiles(result.profiles);
      passLogical += saved.logical; totalLogical += saved.logical; totalPhysical += saved.physical;
      if (result.error) console.error(`Batch failed after retries: ${result.error}`);
    }
    const completed = Math.min(index + group.length, batches.length);
    console.log(`Pass ${pass}: ${completed}/${batches.length} batches, ${passLogical}/${pending.length} songs saved, ${totalTokens} tokens`);
  }
  if (!passLogical) break;
}

db.exec("PRAGMA optimize");
const remaining = pendingSongs().length;
const incomplete = db.prepare(`SELECT COUNT(*) AS count FROM song_experience_profiles p JOIN tracks t ON t.id=p.track_id
  WHERE t.available=1 AND (json_array_length(p.style_json)<2 OR json_array_length(p.felt_json)<3
  OR json_array_length(p.energy_json)<2 OR json_array_length(p.sound_json)<2
  OR length(trim(p.identity_text))<8 OR length(trim(p.avoid_text))<8)`).get().count;
console.log(JSON.stringify({ logicalSaved: totalLogical, physicalSaved: totalPhysical, remaining, incomplete, totalTokens }, null, 2));
if (remaining || incomplete) process.exitCode = 2;
