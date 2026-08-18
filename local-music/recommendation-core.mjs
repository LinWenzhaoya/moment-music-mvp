const groups = {
  style: {
    pop: ["流行", "pop"], rock: ["摇滚", "rock"], rnb: ["r&b", "rnb", "rhythmandblues"],
    hiphop: ["嘻哈", "说唱", "hiphop", "rap", "trap", "陷阱"], electronic: ["电子", "edm", "electronic", "house", "浩室", "synth", "合成器", "dance", "舞曲", "trance"],
    country: ["乡村", "country", "americana"], folk: ["民谣", "folk", "acoustic", "原声"],
    soul: ["灵魂", "soul"], jazz: ["爵士", "jazz"], metal: ["金属", "metal"],
    classical: ["古典", "classical", "管弦", "orchestral", "巴洛克", "baroque"],
    funk: ["放克", "funk"], blues: ["布鲁斯", "blues"], indie: ["独立", "indie", "alternative", "另类"],
  },
  felt: {
    bright: ["明亮", "愉快", "开心", "甜蜜", "轻快", "温暖", "希望", "浪漫", "治愈"],
    power: ["激昂", "昂扬", "振奋", "热血", "兴奋", "高能", "爆发", "狂热", "力量", "胜利", "张扬"],
    dark: ["暗黑", "阴暗", "危险", "神秘", "冷酷", "压迫", "幽暗"],
    heavySad: ["沉重", "痛苦", "绝望", "心碎", "崩溃", "苦闷", "无奈", "窒息"],
    softSad: ["忧伤", "惆怅", "怀旧", "柔软", "感伤", "微凉", "怀念"],
    cool: ["酷", "挑衅", "自信", "街头", "冷峻", "不羁", "霸气"],
    tender: ["温柔", "亲密", "安心", "克制", "细腻", "舒服", "松弛"],
  },
  energy: {
    build: ["积累", "增压", "推进", "抬升", "扩张", "上扬", "渐强", "蓄力"],
    release: ["爆发", "释放", "高潮", "高扬", "巅峰"],
    steady: ["平稳", "稳定", "持续", "循环", "舒展"],
    low: ["低位", "缓慢", "克制", "下沉", "无爆发", "悬置"],
    high: ["高能", "强烈", "快速", "高压", "紧迫", "加速"],
  },
  sound: {
    drums: ["鼓", "节拍", "鼓机", "重拍", "打击"], electronic: ["合成器", "电子", "鼓机", "低频"],
    guitar: ["吉他", "guitar"], strings: ["弦乐", "管弦", "大提琴"], piano: ["钢琴", "piano", "键盘"],
    rap: ["说唱", "快嘴", "咬字"], choir: ["合唱", "和声", "群体"], bass: ["贝斯", "低音", "低频"],
    vocalPower: ["高张力", "高位人声", "外放人声", "高音", "嘶吼"],
  },
};

export function normalizeMatch(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, "");
}

function levenshtein(left, right) {
  const a = [...left]; const b = [...right];
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return row[b.length];
}

export function fuzzyTitleDistance(prompt, title) {
  const source = normalizeMatch(prompt); const target = normalizeMatch(title);
  if (!target || target.length < 2) return Infinity;
  if (source.includes(target)) return 0;
  let best = Infinity;
  for (let size = Math.max(2, target.length - 1); size <= target.length + 1; size += 1) {
    for (let index = 0; index + size <= source.length; index += 1) best = Math.min(best, levenshtein(source.slice(index, index + size), target));
  }
  return best;
}

export function maximalTitleMatches(rows) {
  return rows.filter((row, index) => {
    const title = normalizeMatch(row.title);
    return !rows.some((other, otherIndex) => otherIndex !== index && normalizeMatch(other.title).length > title.length && normalizeMatch(other.title).includes(title));
  });
}

export function nearestTitleAfterArtist(prompt, artist, rows) {
  const source = normalizeMatch(prompt);
  const artistText = normalizeMatch(artist);
  const artistIndex = source.indexOf(artistText);
  if (artistIndex < 0) return null;
  const nearby = source.slice(artistIndex + artistText.length).replace(/^(?:的|这首|那首)/, "");
  if (!nearby || /^(?:比较|歌曲|歌单|音乐|风格|类似|想听|生成)/.test(nearby)) return null;
  const ranked = rows.map((row) => {
    const title = normalizeMatch(row.title);
    return { row, distance: title ? levenshtein(nearby.slice(0, title.length), title) : Infinity, length: title.length };
  }).filter((item) => item.length >= 2 && item.distance <= 1)
    .sort((left, right) => left.distance - right.distance || right.length - left.length);
  return ranked[0]?.row || null;
}

export function sanitizeHardStyles(prompt, values) {
  const normalizedPrompt = normalizeMatch(prompt);
  return (Array.isArray(values) ? values : []).map((value) => String(value).trim()).filter(Boolean)
    .filter((value) => {
      const style = normalizeMatch(value);
      const index = normalizedPrompt.indexOf(style);
      if (index < 0) return false;
      const context = normalizedPrompt.slice(Math.max(0, index - 8), index);
      return !/(?:不要|别放|别要|避开|排除|不想听|拒绝|去掉|不听)$/.test(context);
    });
}

function familySet(value, type) {
  const text = normalizeMatch(value); const result = new Set();
  for (const [name, words] of Object.entries(groups[type] || {})) if (words.some((word) => text.includes(normalizeMatch(word)))) result.add(name);
  return result;
}

function relationBetween(left, right, type) {
  const a = normalizeMatch(left); const b = normalizeMatch(right);
  if (!a || !b) return null;
  if (a === b) return "exact";
  if (Math.min(a.length, b.length) >= 2 && (a.includes(b) || b.includes(a))) return type === "style" ? "strong" : "related";
  const af = familySet(a, type); const bf = familySet(b, type);
  const overlap = [...af].filter((value) => bf.has(value)).length;
  if (overlap) return type === "style" && overlap >= 2 ? "strong" : "related";
  return null;
}

function compareDimension(reference, candidate, type, label) {
  if (!reference?.length || !candidate?.length) return null;
  let relatedPair = null;
  for (const left of reference) for (const right of candidate) {
    const relation = relationBetween(left, right, type);
    if (relation === "exact") return { relation, evidence: `${label}直接重合：${right}` };
    if (relation === "related" && !relatedPair) relatedPair = { left, right };
  }
  return relatedPair ? { relation: "related", evidence: `${label}有关联：${relatedPair.left} ↔ ${relatedPair.right}` } : null;
}

function containsTerm(text, term) {
  const source = normalizeMatch(text); const target = normalizeMatch(term);
  return target.length >= 2 && source.includes(target);
}

function compareWithSeed(profile, seed) {
  const comparisons = [
    compareDimension(seed.style, profile.style, "style", "曲风"),
    compareDimension(seed.feltExperience, profile.feltExperience, "felt", "听感"),
    compareDimension(seed.energyArc, profile.energyArc, "energy", "能量走向"),
    compareDimension(seed.sound, profile.sound, "sound", "声音表现"),
  ].filter(Boolean);
  const exactCount = comparisons.filter((item) => item.relation === "exact").length;
  const relatedCount = comparisons.length;
  const style = comparisons.find((item) => item.evidence.startsWith("曲风"));
  if (style && (style.relation === "exact" || exactCount >= 2)) return { tier: "direct", exactCount, relatedCount, evidence: comparisons.map((item) => item.evidence) };
  if (style?.relation === "strong" && relatedCount >= 2) return { tier: "related", exactCount, relatedCount, evidence: comparisons.map((item) => item.evidence) };
  if (style?.relation === "related" && exactCount >= 1 && relatedCount >= 3) return { tier: "related", exactCount, relatedCount, evidence: comparisons.map((item) => item.evidence) };
  return null;
}

function compareWithRequest(profile, plan) {
  const positiveText = [...profile.style, ...profile.feltExperience, ...profile.energyArc, ...profile.sound, profile.identity].join(" ");
  const requestTerms = [...(plan.hardStyles || []), ...(plan.softPreferences || []), ...(plan.mustKeep || [])].filter(Boolean);
  const literal = requestTerms.filter((term) => containsTerm(positiveText, term));
  if (literal.length) return { tier: "direct", exactCount: literal.length, relatedCount: literal.length, evidence: literal.slice(0, 4).map((term) => `本次需求直接命中档案：${term}`) };
  const dimensions = [
    { values: profile.style, type: "style", label: "曲风" },
    { values: profile.feltExperience, type: "felt", label: "听感" },
    { values: profile.energyArc, type: "energy", label: "能量走向" },
    { values: profile.sound, type: "sound", label: "声音表现" },
  ];
  const related = [];
  for (const term of requestTerms) for (const dimension of dimensions) {
    const hit = dimension.values.find((value) => Boolean(relationBetween(term, value, dimension.type)));
    if (hit && !related.some((item) => item.label === dimension.label)) related.push({ label: dimension.label, term, hit });
  }
  return related.length >= 2 ? { tier: "related", exactCount: 0, relatedCount: related.length, evidence: related.map((item) => `${item.label}有关联：${item.term} ↔ ${item.hit}`) } : null;
}

export function classifyProfileEvidence({ profile, seedProfiles = [], plan = {} }) {
  if (!profile) return null;
  const matches = seedProfiles.map((seed) => compareWithSeed(profile, seed)).filter(Boolean);
  if (matches.length) return matches.sort((left, right) => {
    const order = { direct: 2, related: 1 };
    return order[right.tier] - order[left.tier] || right.exactCount - left.exactCount || right.relatedCount - left.relatedCount;
  })[0];
  return compareWithRequest(profile, plan);
}
