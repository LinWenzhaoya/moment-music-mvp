export type TrackKind = "familiar" | "forgotten" | "discover";

export type Track = {
  id: string;
  title: string;
  artist: string;
  genre: string;
  kind: TrackKind;
  energy: number;
  vocal: number;
  tags: string[];
  instruments: string[];
  color: string;
  lastPlayed?: string;
};

export type Intent = {
  energy: number;
  vocal: number;
  tags: string[];
  exclusions: string[];
};

export type Mix = {
  familiar: number;
  forgotten: number;
  discover: number;
};

export type Preference = {
  tag: string;
  weight: number;
  reason: string;
};

export type RecommendedTrack = Track & {
  score: number;
  reason: string;
};

const KEYWORDS: Array<[string[], string]> = [
  [["鼓点", "节奏", "律动"], "鼓点"],
  [["电子", "合成器", "electronic"], "电子"],
  [["弦乐", "交响", "古典"], "弦乐"],
  [["钢琴", "piano"], "钢琴"],
  [["空灵", "空间感", "氛围"], "空灵"],
  [["渐进", "推进", "层次"], "渐进"],
  [["工作", "专注", "focus"], "专注"],
  [["运动", "跑步", "健身"], "运动"],
  [["夜晚", "深夜"], "夜晚"],
  [["愉快", "开心", "明亮"], "愉快"],
];

export function parseIntent(text: string): Intent {
  const normalized = text.toLowerCase();
  const tags = KEYWORDS.filter(([words]) => words.some((word) => normalized.includes(word))).map(([, tag]) => tag);
  const highEnergy = ["激昂", "高能", "强烈", "运动", "开心"].some((word) => normalized.includes(word));
  const lowEnergy = ["安静", "舒缓", "放松", "不太吵", "平静"].some((word) => normalized.includes(word));
  const lessVocal = ["少一点人声", "不要人声", "无人声", "纯音乐", "少人声"].some((word) => normalized.includes(word));
  const moreVocal = ["人声", "歌词", "演唱"].some((word) => normalized.includes(word)) && !lessVocal;
  const exclusions: string[] = [];
  if (normalized.includes("不要女声")) exclusions.push("女声");
  if (normalized.includes("不要男声")) exclusions.push("男声");
  if (normalized.includes("不要电子")) exclusions.push("电子");
  return { energy: highEnergy ? 82 : lowEnergy ? 42 : 62, vocal: lessVocal ? 18 : moreVocal ? 75 : 45, tags: [...new Set(tags)], exclusions };
}

function makeReason(track: Track, intent: Intent, preferences: Preference[]) {
  const matchedIntent = track.tags.find((tag) => intent.tags.includes(tag));
  const matchedPreference = preferences.filter((preference) => preference.weight > 0).sort((a, b) => b.weight - a.weight).find((preference) => track.tags.includes(preference.tag) || track.instruments.includes(preference.tag));
  if (track.kind === "forgotten") return `你曾经很喜欢它，但已经 ${track.lastPlayed ?? "很久"} 没播放；${matchedIntent ? `它的${matchedIntent}也符合此刻。` : "现在重听刚好。"}`;
  if (track.kind === "discover") return `新鲜探索：${matchedIntent ? `保留了你想要的${matchedIntent}` : `能量和你此刻的状态接近`}${matchedPreference ? `，同时命中你喜欢的${matchedPreference.tag}` : ""}。`;
  return `熟悉的安心感：${matchedIntent ? `${matchedIntent}符合此刻需求` : "整体能量正合适"}${matchedPreference ? `，也延续了你对${matchedPreference.tag}的偏好` : ""}。`;
}

export function recommend(tracks: Track[], text: string, mix: Mix, count: number, preferences: Preference[] = []): { intent: Intent; tracks: RecommendedTrack[] } {
  const intent = parseIntent(text);
  const positivePreferences = preferences.filter((item) => item.weight > 0);
  const negativePreferences = preferences.filter((item) => item.weight < 0);

  const scored = tracks.map((track) => {
    const tagMatches = track.tags.filter((tag) => intent.tags.includes(tag)).length;
    const preferenceBoost = positivePreferences.reduce((sum, item) => sum + (track.tags.includes(item.tag) || track.instruments.includes(item.tag) ? item.weight * 7 : 0), 0);
    const preferencePenalty = negativePreferences.reduce((sum, item) => sum + (track.tags.includes(item.tag) || track.instruments.includes(item.tag) ? Math.abs(item.weight) * 10 : 0), 0);
    const exclusionPenalty = intent.exclusions.some((item) => track.tags.includes(item)) ? 100 : 0;
    const energyScore = 30 - Math.abs(track.energy - intent.energy) * 0.35;
    const vocalScore = 18 - Math.abs(track.vocal - intent.vocal) * 0.22;
    const score = energyScore + vocalScore + tagMatches * 16 + preferenceBoost - preferencePenalty - exclusionPenalty;
    return { ...track, score, reason: makeReason(track, intent, preferences) };
  });

  const desired = {
    familiar: Math.round((count * mix.familiar) / 100),
    forgotten: Math.round((count * mix.forgotten) / 100),
    discover: 0,
  };
  desired.discover = Math.max(0, count - desired.familiar - desired.forgotten);

  const selected = (["familiar", "forgotten", "discover"] as TrackKind[]).flatMap((kind) =>
    scored.filter((track) => track.kind === kind).sort((a, b) => b.score - a.score).slice(0, desired[kind]),
  );

  return { intent, tracks: selected.sort((a, b) => b.score - a.score) };
}

export function normalizeMix(familiar: number, forgotten: number): Mix {
  const safeFamiliar = Math.min(80, Math.max(10, familiar));
  const safeForgotten = Math.min(100 - safeFamiliar, Math.max(10, forgotten));
  return { familiar: safeFamiliar, forgotten: safeForgotten, discover: 100 - safeFamiliar - safeForgotten };
}
