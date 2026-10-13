import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { here, libraryRoot, omniModel } from "../local-music/config.mjs";
import { db } from "../local-music/db.mjs";
import { omniAudioJson } from "../local-music/llm.mjs";
import { loadAudio, PROMPT_VERSION, saveTags, systemPrompt, trackPath, userPrompt, validate } from "../local-music/omni-tagging.mjs";
import { logicalTrackKey } from "../local-music/recommendation-core.mjs";

// Audio tagging v2: Qwen-Omni listens to the whole song and returns the 6 dimensions from the
// project notes plus filterable fields and a description (the text that gets embedded); prompt and
// validation live in local-music/omni-tagging.mjs. For half price, see scripts/tag-audio-batch.mjs.
//
//   LIMIT=20 node scripts/tag-audio-omni.mjs            pilot on 20 untagged songs
//   COMPARE=5 node scripts/tag-audio-omni.mjs           tag 5 songs from the original file AND the
//                                                       transcoded file, write both side by side (no DB write)
//   AUDIO_MODE=original|transcode (default transcode)   CONCURRENCY=2   FORCE=1 (re-tag current prompt version)
const limit = Number(process.env.LIMIT || 0);
const compare = Number(process.env.COMPARE || 0);
const audioMode = process.env.AUDIO_MODE === "original" ? "original" : "transcode";
const concurrency = Math.max(1, Math.min(16, Number(process.env.CONCURRENCY || 2)));
const force = process.env.FORCE === "1";
// IDS=1,2,3 tags exactly these tracks; DRY=1 writes results to eval-results/ instead of the database.
const onlyIds = new Set(String(process.env.IDS || "").split(",").map(Number).filter(Boolean));
const dry = process.env.DRY === "1";
// NO_TITLE=1: the model only hears the audio (tests whether knowing the song biases its judgement).
const withTitle = process.env.NO_TITLE !== "1";

const system = systemPrompt(withTitle);

let fatal = null;

async function tagTrack(track, mode, attempt = 1) {
  try {
    const transcodeStart = performance.now();
    const audio = await loadAudio(trackPath(track.relative_path), mode);
    const transcodeMs = Math.round(performance.now() - transcodeStart);
    const result = await omniAudioJson({ system, prompt: userPrompt(track, withTitle), audioBase64: audio.base64, audioFormat: audio.format });
    const tags = validate(result.value);
    if (!tags) throw new Error("模型输出未通过校验（缺字段或描述长度不符）");
    return { tags, raw: result.value, usage: result.usage, audioBytes: Math.round(audio.base64.length * 0.75), timing: { transcodeMs, ...result.timing } };
  } catch (error) {
    // Billing / auth errors fail every song the same way: stop the run instead of burning through the list.
    if (/Access denied|overdue|Arrearage|account is in good standing|Invalid API-key/i.test(error.message)) {
      fatal = error.message; return { error: error.message };
    }
    if (attempt >= 3) return { error: error.message };
    await new Promise((done) => setTimeout(done, 2000 * attempt));
    return tagTrack(track, mode, attempt + 1);
  }
}

// One physical file per logical song; skip songs already tagged with this prompt version.
const rows = db.prepare(`SELECT t.id, t.title, t.artist, t.relative_path, t.duration, v.prompt_version
  FROM tracks t LEFT JOIN song_tags_v2 v ON v.track_id=t.id
  WHERE t.available=1 ORDER BY COALESCE(t.bitrate, 0) DESC, t.id`).all();
const logical = [...new Map(rows.map((row) => [logicalTrackKey(row), row])).values()];
let pending = onlyIds.size ? [...new Map(rows.filter((row) => onlyIds.has(Number(row.id))).map((row) => [logicalTrackKey(row), row])).values()]
  // Untagged songs only: songs already tagged with an earlier version are kept (re-tag them with FORCE=1).
  : compare ? logical.slice(0, compare) : logical.filter((row) => force || !row.prompt_version);
if (limit && !compare) pending = pending.slice(0, limit);
console.log(`Library: ${libraryRoot}\nSongs: ${logical.length}, to tag: ${pending.length}, mode: ${compare ? "compare" : audioMode}, model: ${omniModel}`);

if (compare) {
  const comparisons = [];
  for (const track of pending) {
    const [original, transcoded] = await Promise.all([tagTrack(track, "original"), tagTrack(track, "transcode")]);
    comparisons.push({ title: track.title, artist: track.artist, original, transcoded });
    console.log(`Compared: ${track.title} · ${track.artist} (${original.audioBytes || "-"} vs ${transcoded.audioBytes || "-"} bytes)`);
  }
  const outDir = join(here, "eval-results");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `omni-compare-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(comparisons, null, 2));
  console.log(`Side-by-side results: ${file}`);
  process.exit(0);
}

let done = 0; let failed = 0; let tokens = 0; let audioBytes = 0;
const runStarted = Date.now(); const timings = [];
const avg = (key) => Math.round(timings.reduce((sum, t) => sum + t[key], 0) / Math.max(1, timings.length) / 100) / 10;
const dryResults = [];

function save(track, result) {
  if (result.error) { failed += 1; console.error(`Failed: ${track.title} · ${track.artist}: ${result.error}`); return; }
  tokens += Number(result.usage?.total_tokens || 0); audioBytes += result.audioBytes;
  if (result.timing) timings.push(result.timing);
  const { tags } = result;
  if (dry) { dryResults.push({ id: track.id, title: track.title, artist: track.artist, tags }); done += 1; return; }
  saveTags(track, tags, result.raw);
  done += 1;
}

function report() {
  const minutes = (Date.now() - runStarted) / 60000; const perMinute = (done + failed) / Math.max(minutes, 0.01);
  const eta = Math.round((pending.length - done - failed) / Math.max(perMinute, 0.01));
  console.log(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] Tagged ${done}/${pending.length} (failed ${failed}), tokens ${tokens}, audio ${(audioBytes / 1048576).toFixed(1)} MB | `
    + `${perMinute.toFixed(1)} 首/分钟, ETA ${Math.floor(eta / 60)}h${eta % 60}m | 每首平均: 压缩 ${avg("transcodeMs")}s, 上传+听歌 ${avg("firstTokenMs")}s, 生成 ${avg("generateMs")}s`);
}

// Sliding window: each worker takes the next song as soon as its current one finishes,
// so one slow song never holds the others back.
let next = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < pending.length && !fatal) {
    const track = pending[next++];
    save(track, await tagTrack(track, audioMode));
    if ((done + failed) % 10 === 0) report();
  }
}));
report();
if (dry) {
  const file = join(here, "eval-results", `tags-${PROMPT_VERSION}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(join(here, "eval-results"), { recursive: true });
  writeFileSync(file, JSON.stringify(dryResults, null, 2));
  console.log(`Dry run, nothing written to the database: ${file}`);
}
if (fatal) { console.error(`Stopped early (account/key problem): ${fatal}`); process.exitCode = 3; }
console.log(JSON.stringify({ tagged: done, failed, totalTokens: tokens, avgTokensPerSong: done ? Math.round(tokens / done) : null }, null, 2));
if (failed) process.exitCode = 2;
