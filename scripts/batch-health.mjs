import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dashscopeApiKey, dashscopeBaseUrl, here } from "../local-music/config.mjs";
import { db } from "../local-music/db.mjs";

// Health check for the batch tagging run. Prints one SUMMARY line, plus an ALERT line for every
// threshold crossed. Run it on a timer; anything starting with ALERT needs a human look.
//   failure rate per batch > 25%     batch with no progress for 3 h     invalid results > 5%
//   projected spend > 120% of budget  quality of newly saved tags (enums filled, Chinese, length)
const BUDGET_YUAN = Number(process.env.BUDGET_YUAN || 270);
// Batch price per million tokens (50% of realtime): audio input 26.5, text input 3.5, text output 20.
const PRICE = { audio: 26.5, text: 3.5, output: 20 };
const jobs = existsSync(join(here, "batch-jobs.json")) ? JSON.parse(readFileSync(join(here, "batch-jobs.json"), "utf8")) : [];
const progressFile = join(here, "..", "logs", "batch", "progress.json");
const previous = existsSync(progressFile) ? JSON.parse(readFileSync(progressFile, "utf8")) : {};
const alerts = [];
let totals = { songs: 0, done: 0, failed: 0, inProgress: 0, collected: 0 };

for (const job of jobs) {
  const response = await fetch(`${dashscopeBaseUrl}/batches/${job.batchId}`, { headers: { Authorization: `Bearer ${dashscopeApiKey}` } });
  const batch = await response.json();
  const counts = batch.request_counts || {};
  totals.songs += counts.total || job.trackIds.length;
  totals.done += counts.completed || 0;
  totals.failed += counts.failed || 0;
  if (!["completed", "failed", "expired", "cancelled"].includes(batch.status)) totals.inProgress += 1;
  if (job.collected) totals.collected += 1;
  const finished = (counts.completed || 0) + (counts.failed || 0);
  // Baseline: ~20 requests fail at the start of every batch (server side, unbilled, resubmitted); alert only well above it.
  if (finished >= 20 && counts.failed / finished > 0.25) alerts.push(`ALERT 失败率 ${batch.id}: ${counts.failed}/${finished}`);
  const before = previous[job.batchId];
  const now = Date.now();
  if (before && before.finished === finished && batch.status === "in_progress" && now - before.since > 3 * 3600_000) alerts.push(`ALERT 卡住 ${batch.id}: 3 小时没有进展（${finished}/${counts.total}）`);
  previous[job.batchId] = before && before.finished === finished ? before : { finished, since: now };
  if (job.result && job.result.saved + job.result.invalid > 0 && job.result.invalid / (job.result.saved + job.result.invalid) > 0.05) alerts.push(`ALERT 不合格结果 ${job.batchId}: ${job.result.invalid}`);
}
mkdirSync(join(here, "..", "logs", "batch"), { recursive: true });

// Spend: from tokens of saved batch results (audio/text split from the raw usage is not kept, so use the
// measured average mix of a v2.3 song: ~1,700 audio, ~900 text in, ~650 out per 3,250 total).
const tokens = jobs.reduce((sum, job) => sum + (job.result?.tokens || 0), 0);
const yuanPerToken = (1700 * PRICE.audio + 900 * PRICE.text + 650 * PRICE.output) / 3250 / 1e6;
const spent = tokens * yuanPerToken;
const savedSongs = jobs.reduce((sum, job) => sum + (job.result?.saved || 0), 0);
const remaining = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT lower(trim(t.title)), lower(trim(t.artist)) FROM tracks t
  LEFT JOIN song_tags_v2 v ON v.track_id=t.id WHERE t.available=1 AND v.track_id IS NULL)`).get().n;
const projected = savedSongs ? spent + (remaining * spent) / savedSongs : 0;
if (projected > BUDGET_YUAN * 1.2) alerts.push(`ALERT 预计花费 ¥${projected.toFixed(0)} 超过预算 ¥${BUDGET_YUAN} 的 120%`);

// Quality of tags saved by the batch path in the last 2 hours.
const recent = db.prepare(`SELECT language, vocal_presence, tempo, description, mood_json FROM song_tags_v2
  WHERE prompt_version='v2.3' AND updated_at >= datetime('now','-2 hours')`).all();
if (recent.length >= 20) {
  const bad = recent.filter((row) => !row.language || !row.vocal_presence || !row.tempo
    || (row.description.match(/[一-鿿]/g) || []).length / row.description.length < 0.6
    || row.description.length < 80 || JSON.parse(row.mood_json).length < 2).length;
  if (bad / recent.length > 0.05) alerts.push(`ALERT 新标签质量: ${bad}/${recent.length} 条缺字段、非中文或过短`);
}

// Each alert is raised once; repeats of a known problem stay quiet (still visible in the SUMMARY counts).
const seen = new Set(previous.__alerted || []);
const fresh = alerts.filter((alert) => !seen.has(alert.replace(/\d+\/\d+|¥\d+/g, "#")));
previous.__alerted = [...seen, ...fresh.map((alert) => alert.replace(/\d+\/\d+|¥\d+/g, "#"))];
writeFileSync(progressFile, JSON.stringify(previous));
console.log(`SUMMARY [${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] 批次 ${jobs.length}（处理中 ${totals.inProgress}，已收取 ${totals.collected}）| 已完成 ${totals.done}/${totals.songs} 首，失败 ${totals.failed} | 已入库 ${savedSongs} 首，未打标 ${remaining} 首 | 已花约 ¥${spent.toFixed(1)}，预计总计 ¥${projected.toFixed(0)}`);
for (const alert of fresh) console.log(alert);
