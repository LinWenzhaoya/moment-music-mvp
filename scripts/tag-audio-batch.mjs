import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dashscopeApiKey, dashscopeBaseUrl, here, omniModel } from "../local-music/config.mjs";
import { db } from "../local-music/db.mjs";
import { parseModelJson } from "../local-music/llm.mjs";
import { loadAudio, PROMPT_VERSION, saveTags, systemPrompt, trackPath, userPrompt, validate } from "../local-music/omni-tagging.mjs";
import { logicalTrackKey } from "../local-music/recommendation-core.mjs";

// Half-price tagging through DashScope Batch File: requests are packed into JSONL files (≤500 MB,
// ≤6 MB per line), uploaded, and processed within 24 h on idle capacity at 50% of the realtime price.
//
//   node scripts/tag-audio-batch.mjs submit [--limit N] [--ids 1,2] [--per-file 150]
//   node scripts/tag-audio-batch.mjs status
//   node scripts/tag-audio-batch.mjs collect      (saves finished results; failed songs become untagged again)
const [command = "status", ...args] = process.argv.slice(2);
// `status | grep -q` closes the pipe early; that is not an error.
process.stdout.on("error", (error) => { if (error.code !== "EPIPE") throw error; });
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : fallback; };
const jobsFile = join(here, "batch-jobs.json");
const workDir = join(here, "..", "logs", "batch");
mkdirSync(workDir, { recursive: true });
const loadJobs = () => (existsSync(jobsFile) ? JSON.parse(readFileSync(jobsFile, "utf8")) : []);
const saveJobs = (jobs) => writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
const auth = { Authorization: `Bearer ${dashscopeApiKey}` };
const safeParse = (text) => { try { return parseModelJson(text); } catch { return null; } };

// The file endpoint is rate limited (429 after a few 250 MB uploads in a row): wait and retry.
async function api(path, init = {}, attempt = 1) {
  const response = await fetch(`${dashscopeBaseUrl}${path}`, { ...init, headers: { ...auth, ...(init.headers || {}) } });
  const text = await response.text();
  if (response.status === 429 && attempt <= 10) {
    console.warn(`${path}: rate limited, retry ${attempt} in ${attempt} min`);
    await new Promise((done) => setTimeout(done, attempt * 60_000));
    return api(path, init, attempt + 1);
  }
  if (!response.ok) throw new Error(`${path} ${response.status}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { return text; }
}

function pendingSongs() {
  const rows = db.prepare(`SELECT t.id, t.title, t.artist, t.relative_path, v.prompt_version
    FROM tracks t LEFT JOIN song_tags_v2 v ON v.track_id=t.id
    WHERE t.available=1 ORDER BY COALESCE(t.bitrate, 0) DESC, t.id`).all();
  const inFlight = new Set(loadJobs().filter((job) => !job.collected).flatMap((job) => job.trackIds));
  const ids = new Set(String(option("ids", "")).split(",").map(Number).filter(Boolean));
  const logical = [...new Map(rows.map((row) => [logicalTrackKey(row), row])).values()];
  const pool = ids.size ? logical.filter((row) => ids.has(Number(row.id))) : logical.filter((row) => !row.prompt_version);
  return pool.filter((row) => !inFlight.has(Number(row.id)));
}

async function submit() {
  let songs = pendingSongs();
  const limit = Number(option("limit", 0));
  if (limit) songs = songs.slice(0, limit);
  const perFile = Number(option("per-file", 150));
  const system = systemPrompt(true);
  console.log(`Songs to submit: ${songs.length}, files: ${Math.ceil(songs.length / perFile)}`);
  const jobs = loadJobs();
  for (let start = 0; start < songs.length; start += perFile) {
    const chunk = songs.slice(start, start + perFile);
    const lines = []; const trackIds = []; let skipped = 0;
    for (const song of chunk) {
      const audio = await loadAudio(trackPath(song.relative_path), "transcode", "48k");
      const line = JSON.stringify({
        custom_id: String(song.id), method: "POST", url: "/v1/chat/completions",
        body: {
          model: omniModel, modalities: ["text"], max_tokens: 2400,
          messages: [
            { role: "system", content: system },
            { role: "user", content: [
              { type: "input_audio", input_audio: { data: `data:;base64,${audio.base64}`, format: audio.format } },
              { type: "text", text: userPrompt(song) },
            ] },
          ],
        },
      });
      if (Buffer.byteLength(line) > 6 * 1024 * 1024) { skipped += 1; console.warn(`Too long for batch, use the realtime script: ${song.title}`); continue; }
      lines.push(line); trackIds.push(Number(song.id));
    }
    const name = `tags-${PROMPT_VERSION}-${Date.now()}.jsonl`;
    writeFileSync(join(workDir, name), `${lines.join("\n")}\n`);
    const form = new FormData();
    form.append("file", new Blob([readFileSync(join(workDir, name))], { type: "application/jsonl" }), name);
    form.append("purpose", "batch");
    const file = await api("/files", { method: "POST", body: form });
    const batch = await api("/batches", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input_file_id: file.id, endpoint: "/v1/chat/completions", completion_window: "24h", metadata: { purpose: `moment ${PROMPT_VERSION}` } }),
    });
    jobs.push({ batchId: batch.id, inputFileId: file.id, file: name, trackIds, submittedAt: new Date().toISOString(), collected: false });
    saveJobs(jobs);
    console.log(`Submitted ${batch.id}: ${trackIds.length} songs (${(Buffer.byteLength(lines.join("\n")) / 1048576).toFixed(1)} MB${skipped ? `, ${skipped} skipped` : ""})`);
  }
}

async function status() {
  for (const job of loadJobs()) {
    const batch = await api(`/batches/${job.batchId}`);
    console.log(`${job.batchId} | ${batch.status} | ${JSON.stringify(batch.request_counts)} | 提交 ${job.submittedAt}${job.collected ? " | 已收取" : ""}`);
  }
}

async function collect() {
  const jobs = loadJobs();
  const tracks = new Map(db.prepare("SELECT id, title, artist FROM tracks").all().map((row) => [Number(row.id), row]));
  for (const job of jobs.filter((item) => !item.collected)) {
    const batch = await api(`/batches/${job.batchId}`);
    if (!["completed", "expired", "failed", "cancelled"].includes(batch.status)) { console.log(`${job.batchId}: ${batch.status}, not finished`); continue; }
    let saved = 0; let invalid = 0; let tokens = 0;
    if (batch.output_file_id) {
      const output = await api(`/files/${batch.output_file_id}/content`);
      for (const line of String(output).split("\n").filter(Boolean)) {
        const item = JSON.parse(line);
        const track = tracks.get(Number(item.custom_id));
        const body = item.response?.body;
        tokens += Number(body?.usage?.total_tokens || 0);
        const raw = safeParse(body?.choices?.[0]?.message?.content || "");
        const tags = raw && validate(raw);
        if (!track || !tags) { invalid += 1; continue; }
        saveTags(track, tags, raw);
        saved += 1;
      }
    }
    if (batch.error_file_id) {
      const errors = await api(`/files/${batch.error_file_id}/content`);
      appendFileSync(join(workDir, "errors.jsonl"), String(errors));
    }
    job.collected = true; job.result = { status: batch.status, saved, invalid, tokens, counts: batch.request_counts };
    saveJobs(jobs);
    // Songs not saved here stay untagged and are picked up by the next submit.
    console.log(`${job.batchId}: saved ${saved}, invalid ${invalid}, tokens ${tokens}, counts ${JSON.stringify(batch.request_counts)}`);
  }
}

await ({ submit, status, collect }[command] || (() => { throw new Error(`unknown command ${command}`); }))();
