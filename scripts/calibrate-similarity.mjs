const apiBase = process.env.MUSIC_API_BASE || "http://127.0.0.1:3001";
const dimensions = ["emotion", "dynamics", "vocal", "melody", "rhythm", "arrangement", "narrative", "culture"];
const sample = [
  [791, "Coldplay - Viva La Vida"],
  [647, "周杰伦 - 夜曲"], [634, "周杰伦 - 稻香"], [460, "周杰伦 - 龙拳"], [370, "周杰伦 - 晴天"],
  [177, "林俊杰 - 江南"], [432, "林俊杰 - 修炼爱情"],
  [377, "BEYOND - 海阔天空"], [25, "Beyond - 光辉岁月(Live)"],
  [70, "王菲 - 暗涌(Live)"], [433, "陈奕迅 - 孤勇者"], [53, "张国荣 - 风继续吹(Live)"], [69, "张学友 - 李香兰(Live)"],
  [1321, "Adele - Rolling in the Deep"], [1166, "Adele - Someone Like You"],
  [1092, "The Weeknd - Starboy"], [739, "The Weeknd - After Hours"],
  [840, "Kendrick Lamar - luther"], [1131, "Taylor Swift - Cruel Summer"],
  [1064, "Eagles - Hotel California"], [1163, "Imagine Dragons - Demons"],
];

const requestedIds = new Set(
  String(process.env.CALIBRATION_TRACK_IDS || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter(Number.isFinite),
);
const selectedSample = requestedIds.size ? sample.filter(([trackId]) => requestedIds.has(trackId)) : sample;

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `${response.status} ${path}`);
  return value;
}

function reviewAnnotation(raw = {}) {
  const issues = [];
  let observation = String(raw.observation || "").trim();
  let boundary = String(raw.boundary || "").trim();
  let evidence = String(raw.evidence || "").trim();
  const unsupportedAudioClaim = /(经过|通过|基于).{0,6}(音频分析|频谱分析)|检测到.{0,8}BPM|BPM\s*[为是:：]\s*\d+/i;
  if (!observation) { observation = "信息不足，待人工确认"; issues.push("missing_observation"); }
  if (!boundary) { boundary = "区分边界信息不足，待人工确认"; issues.push("missing_boundary"); }
  if (!evidence) { evidence = "信息不足，未进行音频或歌词分析"; issues.push("missing_evidence"); }
  if (unsupportedAudioClaim.test(`${observation} ${boundary} ${evidence}`)) {
    evidence = "模型已有知识（未核验）；未进行音频或歌词分析";
    issues.push("unsupported_audio_claim_removed");
  } else if (!/(歌曲元数据|模型已有知识|信息不足|未核验|未进行音频|未看到歌词)/.test(evidence)) {
    evidence = `模型已有知识（未核验）；${evidence}`;
    issues.push("evidence_source_added");
  }
  if (observation.length < 12 && !observation.includes("信息不足")) issues.push("short_observation");
  if (boundary.length < 10 && !boundary.includes("信息不足")) issues.push("short_boundary");
  return { annotation: { observation, boundary, evidence, source: "codex_reviewed" }, issues };
}

const report = [];
for (let index = 0; index < selectedSample.length; index += 1) {
  const [trackId, label] = selectedSample[index];
  try {
    await request(`/api/similarity/calibration/${trackId}`, { method: "POST" });
    const draft = await request(`/api/similarity/calibration/${trackId}/draft`, { method: "POST" });
    const trackIssues = [];
    for (const dimension of dimensions) {
      const reviewed = reviewAnnotation(draft.annotations?.[dimension]);
      trackIssues.push(...reviewed.issues.map((issue) => `${dimension}:${issue}`));
      await request(`/api/similarity/calibration/${trackId}/annotations/${dimension}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reviewed.annotation),
      });
    }
    report.push({ trackId, label, status: "saved", issues: trackIssues });
    process.stdout.write(`[${index + 1}/${selectedSample.length}] ${label} saved; QA issues: ${trackIssues.length}\n`);
  } catch (error) {
    report.push({ trackId, label, status: "failed", error: error instanceof Error ? error.message : String(error) });
    process.stdout.write(`[${index + 1}/${selectedSample.length}] ${label} failed: ${error instanceof Error ? error.message : error}\n`);
  }
}

const saved = report.filter((item) => item.status === "saved").length;
const failed = report.length - saved;
const qaIssues = report.reduce((total, item) => total + (item.issues?.length || 0), 0);
process.stdout.write(`SUMMARY saved=${saved} failed=${failed} qa_adjustments=${qaIssues}\n`);
if (failed) process.exitCode = 1;
