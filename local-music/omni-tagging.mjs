import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { libraryRoot, omniModel } from "./config.mjs";
import { db } from "./db.mjs";

// Shared by the realtime tagger (scripts/tag-audio-omni.mjs) and the half-price batch tagger
// (scripts/tag-audio-batch.mjs), so both produce identical v2.3 tags.
const execFileAsync = promisify(execFile);
export const PROMPT_VERSION = "v2.3";

// Fields with fixed vocabularies are for hard filtering ("只要粤语""纯音乐""节奏快一点"); free text feeds
// explanations and the description feeds the embedding. Objective numbers (BPM, loudness) are computed
// locally from the audio instead of asked of the model.
export const ENUMS = {
  language: ["国语", "粤语", "英语", "韩语", "日语", "闽南语", "其他", "无人声"],
  vocalPresence: ["有人声", "人声很少", "纯音乐"],
  vocalType: ["男声", "女声", "男女合唱", "多人组合", "无"],
  tempo: ["慢", "中", "快"],
  acousticElectronic: ["原声为主", "电子为主", "混合"],
  arcShape: ["平稳", "渐进", "起伏", "开头即高潮", "渐弱"],
};

// v2.3: mood, valence/arousal and scene describe how the song SOUNDS, not what the lyrics say. Listeners
// relate to songs mostly through sound ("After Hours" is a confident protagonist-entrance BGM, not a
// regret song), so lyrics get their own fields. Title and artist are given: a 17-song test against
// listener notes showed it helps rather than biases (Hawái); a "common use" field was dropped as noise.
export const systemPrompt = (withTitle = true) => `你是专业的音乐分析师。你会听到一首完整的歌曲音频${withTitle ? "，同时知道它的歌名和歌手" : "，不知道歌名和歌手，只依据听到的内容判断"}。所有内容用简体中文书写，曲风、乐器等专有名词可写成"中文（英文）"。听不出来、不知道的就写"不确定"或留空，不要编造。
核心原则：人和一首歌的关系主要来自声音——旋律、节奏、律动、音色、编曲、人声的状态——而不是歌词字面意思。歌词悲伤但节奏轻快、听起来自信酷炫的歌，听感就是轻快、自信。所以情绪、正负、激烈程度、适合的场景一律按"听起来怎样"判断，不看歌词。
各字段要求：
1. language 演唱的主要语言，只能是：${ENUMS.language.join("/")}。
2. vocal 人声：presence 只能是 ${ENUMS.vocalPresence.join("/")}；type 只能是 ${ENUMS.vocalType.join("/")}；timbre 一句话描述音色与唱法（如"沙哑低沉的男声，气声较多"）。
3. genre 曲风：primary 主风格；sub 1-3 个子风格或融合风格；era 年代质感；region 地域。回答"它在风格谱系上属于哪里"，不是情绪。
4. sound 声音：instruments 听得出的核心乐器（3-6 个）；acousticElectronic 只能是 ${ENUMS.acousticElectronic.join("/")}；tempo 体感节奏只能是 ${ENUMS.tempo.join("/")}；texture 一句话写音色冷暖明暗、律动、密度、空间感中最有特点的部分。
5. arc 能量弧线：shape 只能是 ${ENUMS.arcShape.join("/")}；summary 一句话写实际听到的走向（例如"前两分钟只有吉他，最后一段全编制爆发后戛然而止"），不要写"主歌-副歌"这类通用结构。
6. mood 听感情绪 3-6 个词：只根据声音给人的感受（如 自信、酷、松弛、迷幻、压抑、幽怨、宏大、甜），不要因为歌词讲失恋就写"伤感"。valence 听感正负（0=消极 1=积极），arousal 听感激烈程度（0=平静 1=激烈），同样只看声音。
7. lyricTheme 歌词主题 1-3 个（如 失恋、思念、励志、告别）；纯音乐或听不清歌词返回空数组。lyricContrast：歌词情绪和听感明显不一致时用一句话说明（如"歌词讲心碎，但律动轻快、听起来潇洒"），一致就留空字符串。
8. scene 2-4 条最适合的处境或画面，从听感推导（如"需要自信和掌控感的时刻""深夜独自夜驾""上场前蓄力"），不要从歌词字面推导；"KTV""背景音乐"这类放之四海皆准的场景不要写。
9. description 综合描述 100-250 字，用于和用户的自然语言需求做向量匹配。先写听起来最有特点的地方（声音、律动、编曲、听感情绪），再写适合的时刻；歌词只作补充一句。直接从那个特点写起，不要以"这首歌""这首曲子""这是一首"开头，也不要用套话；不要写歌名和歌手名。
只返回JSON：{"language":"","vocal":{"presence":"","type":"","timbre":""},"genre":{"primary":"","sub":[""],"era":"","region":""},"sound":{"instruments":[""],"acousticElectronic":"","tempo":"","texture":""},"arc":{"shape":"","summary":""},"mood":[""],"valence":0.5,"arousal":0.5,"lyricTheme":[""],"lyricContrast":"","scene":[""],"description":""}`;

export function validate(value) {
  const list = (items, min, max) => (Array.isArray(items) ? [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, max) : []).filter((_, index, all) => all.length >= min);
  const pick = (input, allowed) => (allowed.includes(String(input || "").trim()) ? String(input).trim() : null);
  const description = String(value?.description || "").trim();
  const mood = list(value?.mood, 2, 6);
  const scene = list(value?.scene, 1, 5);
  const clamp = (number) => (Number.isFinite(Number(number)) ? Math.max(0, Math.min(1, Number(number))) : null);
  if (!value?.genre?.primary || description.length < 80 || description.length > 400 || !mood.length || !scene.length) return null;
  const vocalPresence = pick(value.vocal?.presence, ENUMS.vocalPresence);
  return {
    language: vocalPresence === "纯音乐" ? "无人声" : pick(value.language, ENUMS.language),
    vocalPresence, vocalType: pick(value.vocal?.type, ENUMS.vocalType),
    tempo: pick(value.sound?.tempo, ENUMS.tempo), acousticElectronic: pick(value.sound?.acousticElectronic, ENUMS.acousticElectronic),
    arcShape: pick(value.arc?.shape, ENUMS.arcShape),
    genre: value.genre, sound: { ...(value.sound || {}), vocalTimbre: value.vocal?.timbre || "" }, arc: value.arc || {},
    mood, scene, lyricTheme: list(value.lyricTheme, 0, 3), description, valence: clamp(value.valence), arousal: clamp(value.arousal),
    lyricContrast: String(value.lyricContrast || "").trim(), commonUse: [],
  };
}

export function trackPath(relativePath) {
  const path = resolve(libraryRoot, relativePath);
  if (!path.startsWith(`${libraryRoot}${sep}`)) throw new Error(`Invalid track path: ${relativePath}`);
  return path;
}

// Mono 16 kHz MP3: speech/music encoders of this model family downmix and resample internally,
// so this mainly cuts upload size. COMPARE mode exists to verify that assumption on real songs.
// bitrate: batch requests are capped at 6 MB per line, so the batch path uses 48k (an 8-minute song stays ~4 MB of base64).
export async function loadAudio(path, mode = "transcode", bitrate = "64k") {
  if (mode === "original") return { base64: (await readFile(path)).toString("base64"), format: extname(path).slice(1).toLowerCase() };
  const { stdout } = await execFileAsync("ffmpeg", ["-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-b:a", bitrate, "-f", "mp3", "pipe:1"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return { base64: stdout.toString("base64"), format: "mp3" };
}

export const userPrompt = (track, withTitle = true) => (withTitle ? `歌名：${track.title}\n歌手：${track.artist}\n请分析这首歌。` : "请分析这首歌。");

// Same logical song, every physical copy gets the tags.
const copies = db.prepare(`SELECT id FROM tracks WHERE available=1 AND lower(trim(title))=lower(trim(?)) AND lower(trim(artist))=lower(trim(?))`);
const upsert = db.prepare(`INSERT INTO song_tags_v2 (track_id, genre_json, sound_json, arc_json, mood_json, scene_json, description, valence, arousal,
  language, vocal_presence, vocal_type, tempo, acoustic_electronic, arc_shape, lyric_theme_json, lyric_contrast, common_use_json, model, prompt_version, status, raw_json, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, CURRENT_TIMESTAMP) ON CONFLICT(track_id) DO UPDATE SET
  genre_json=excluded.genre_json, sound_json=excluded.sound_json, arc_json=excluded.arc_json, mood_json=excluded.mood_json,
  scene_json=excluded.scene_json, description=excluded.description, valence=excluded.valence, arousal=excluded.arousal,
  language=excluded.language, vocal_presence=excluded.vocal_presence, vocal_type=excluded.vocal_type, tempo=excluded.tempo,
  acoustic_electronic=excluded.acoustic_electronic, arc_shape=excluded.arc_shape, lyric_theme_json=excluded.lyric_theme_json,
  lyric_contrast=excluded.lyric_contrast, common_use_json=excluded.common_use_json,
  model=excluded.model, prompt_version=excluded.prompt_version, status='draft', raw_json=excluded.raw_json, updated_at=CURRENT_TIMESTAMP`);

export function saveTags(track, tags, raw, model = omniModel) {
  for (const copy of copies.all(track.title, track.artist)) upsert.run(copy.id, JSON.stringify(tags.genre), JSON.stringify(tags.sound), JSON.stringify(tags.arc),
    JSON.stringify(tags.mood), JSON.stringify(tags.scene), tags.description, tags.valence, tags.arousal,
    tags.language, tags.vocalPresence, tags.vocalType, tags.tempo, tags.acousticElectronic, tags.arcShape, JSON.stringify(tags.lyricTheme),
    tags.lyricContrast, JSON.stringify(tags.commonUse), model, PROMPT_VERSION, JSON.stringify(raw));
}
