"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { demoTracks } from "../data/tracks";
import { type Mix, type RecommendedTrack, type Track, type TrackKind } from "../lib/music";

type View = "create" | "ai_playlists" | "user_playlists" | "ai_detail" | "user_detail" | "library" | "memory" | "similarity";
type Feedback = { trackId: string; value: "like" | "dislike"; reason: string };
type LibraryStatus = "connecting" | "ready" | "scanning" | "offline";
type AiIntent = { summary: string; mustHave: string[]; avoid: string[]; softPreferences: string[] };
type FeedbackDraft = { trackId: string; value: "like" | "dislike"; explanation: string };
type MemoryCategory = "taste" | "context" | "boundary" | "anchor" | "reference";
type MemoryRecord = { id: number; statement: string; scope: string; polarity: number; weight: number; confidence: number; evidence: Array<{ trackId?: string; title?: string }>; evidenceCount: number; reason: string; source: string; category: MemoryCategory; status: "confirmed" | "pending"; updatedAt: string };
type MemoryDraft = { statement: string; category: MemoryCategory; scope: string; importance: number; evidence: Array<{ trackId?: string; title?: string }> };
type RequestMemory = { id: number; request: string; requestedCount: number; status: "pending" | "succeeded" | "failed"; recommendationId?: number; error?: string; createdAt: string; title?: string; summary?: string };
type RecommendationPlan = { intentSummary?: string; hardArtists?: string[]; excludedArtists?: string[]; candidateArtists?: string[]; mustKeep?: string[]; mustAvoid?: string[]; softPreferences?: string[]; seedRelations?: string[]; requiredEvidence?: string[]; mixExplanation?: string };
type SavedPlaylist = { id: number; title: string; summary: string; request: string; createdAt: string; intent: AiIntent | null; plan?: RecommendationPlan | null; seedTrackIds?: number[]; tracks: RecommendedTrack[] };
type UserPlaylist = { id: number; name: string; kind: "favorites" | "custom"; trackCount: number; createdAt: string; updatedAt: string; tracks: Track[] };
type SimilarityAnnotation = { observation: string; boundary: string; evidence: string; source?: string; updatedAt?: string };
type ExperienceProfile = { style: string[]; feltExperience: string[]; energyArc: string[]; sound: string[]; identity: string; avoid: string; source?: string; reviewStatus?: "needs_user_review" | "approved"; notes?: string; updatedAt?: string };
type CalibrationEntry = { track: Track; status: string; addedAt: string; annotations: Record<string, SimilarityAnnotation>; profile: ExperienceProfile | null };
type SimilarityComparison = { id: number; leftTrack: { id: string; title: string; artist: string }; rightTrack: { id: string; title: string; artist: string }; dimensions: string[]; similarity: string; difference: string; evidence: string; createdAt: string };

const apiBase = "http://localhost:3001";
const defaultPrompt = "";
const kindLabel: Record<TrackKind, string> = { familiar: "近期熟悉", forgotten: "遗忘旧爱", discover: "外部探索", library: "个人曲库 · 历史未知" };
const memoryCategoryLabel: Record<MemoryCategory, string> = { taste: "长期偏好", context: "场景设置", boundary: "明确边界", anchor: "歌手锚点", reference: "歌曲参照" };
const memoryImportanceLabel: Record<number, string> = { 1: "一般", 2: "常用", 3: "核心" };
const emptyExperienceProfile: ExperienceProfile = { style: [], feltExperience: [], energyArc: [], sound: [], identity: "", avoid: "", reviewStatus: "needs_user_review", notes: "" };
const similarityDimensions = [
  { key: "emotion", label: "情绪性质", question: "歌曲带来的究竟是哪一种快乐、悲伤或力量？", axes: ["情绪方向", "唤醒程度", "力量感", "释放感", "明暗质地"], contrast: "区分昂扬、甜美、松弛、悲壮等不同情绪质地。" },
  { key: "dynamics", label: "情绪动态", question: "情绪从开头到结尾怎样运动？", axes: ["积累方式", "副歌抬升", "段落对比", "峰值位置", "结尾落点"], contrast: "区分稳定维持、逐层积累、突然爆发和释放后回落。" },
  { key: "vocal", label: "演唱姿态", question: "演唱以什么姿态把情绪传递出来？", axes: ["克制／外放", "松弛／紧绷", "私语／号召", "个人／合唱", "音色质地"], contrast: "不只记录男女声，更关注张力、表达距离和集体感。" },
  { key: "melody", label: "旋律体验", question: "旋律为什么容易记住、跟唱或产生抬升感？", axes: ["鲜明度", "跟唱感", "音域开阔度", "旋律起伏", "副歌钩子"], contrast: "区分旋律相似和单纯风格、节奏相似。" },
  { key: "rhythm", label: "节奏推进", question: "节奏让身体和情绪如何向前？", axes: ["推进感", "律动方式", "稳定程度", "冲击方式", "速度感"], contrast: "BPM只是证据之一，推进感不等于速度快。" },
  { key: "arrangement", label: "编曲空间", question: "声音的密度、空间和层次如何变化？", axes: ["声音密度", "空间规模", "原声／电子", "层次变化", "副歌扩张"], contrast: "区分大空间舞台感、私密感、厚重和通透。" },
  { key: "narrative", label: "主题姿态", question: "歌曲面对主题时采取了什么态度？", axes: ["主动／被动", "勇敢／犹疑", "对抗／接受", "确认／安慰", "行动／沉浸"], contrast: "主题相同不代表表达姿态相同。" },
  { key: "culture", label: "文化体验", question: "歌曲属于怎样的语言、时代和共同记忆？", axes: ["语言地域", "时代质感", "共同记忆", "表演文化", "典型场景"], contrast: "这是一种相似来源，但不默认比旋律和情绪更重要。" },
] as const;

function Cover({ track, index, active, onPlay }: { track: Track; index: number; active?: boolean; onPlay?: () => void }) {
  return <div className={`cover ${track.color} ${active ? "playing" : ""}`}><span>{String(index + 1).padStart(2, "0")}</span><button onClick={onPlay} aria-label={`${active ? "暂停" : "播放"} ${track.title}`}>{active ? "Ⅱ" : "▶"}</button></div>;
}

function formatTime(value = 0) {
  if (!Number.isFinite(value)) return "0:00";
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
}

function formatPlaylistDate(value: string) {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function adjustMix(mix: Mix, key: keyof Mix, nextValue: number): Mix {
  const value = Math.max(0, Math.min(100, Math.round(nextValue / 5) * 5));
  const otherKeys = (["familiar", "forgotten", "discover"] as Array<keyof Mix>).filter((item) => item !== key);
  const remaining = 100 - value;
  const otherTotal = mix[otherKeys[0]] + mix[otherKeys[1]];
  const first = otherTotal ? Math.round((remaining * mix[otherKeys[0]] / otherTotal) / 5) * 5 : Math.round(remaining / 10) * 5;
  return { ...mix, [key]: value, [otherKeys[0]]: first, [otherKeys[1]]: remaining - first };
}

function MixControl({ mix, onChange }: { mix: Mix; onChange: (mix: Mix) => void }) {
  const controls: Array<{ key: keyof Mix; label: string; description: string }> = [
    { key: "familiar", label: "近期熟悉", description: "最近听过、当前常听" },
    { key: "forgotten", label: "遗忘旧爱", description: "曾经听过但很久没播放" },
    { key: "discover", label: "新鲜探索", description: "曲库内历史未知或新发现" },
  ];
  return <div className="mix-control">
    <div className="mix-bar" aria-label="熟悉度分布"><div className="familiar" style={{ width: `${mix.familiar}%` }} /><div className="forgotten" style={{ width: `${mix.forgotten}%` }} /><div className="discover" style={{ width: `${mix.discover}%` }} /></div>
    <div className="mix-controls">{controls.map((control) => <label className={`mix-card ${control.key}`} key={control.key}><span><i /> {control.label}<b>{mix[control.key]}%</b></span><small>{control.description}</small><input aria-label={`${control.label}比例`} type="range" min="0" max="100" step="5" value={mix[control.key]} onChange={(event) => onChange(adjustMix(mix, control.key, Number(event.target.value)))} /></label>)}</div>
    <p className="mix-total">三项始终合计 100%，调整任意一项时，另外两项会自动平衡。</p>
  </div>;
}

function mapMemories(rows: Array<Record<string, unknown>>): MemoryRecord[] {
  return rows.map((memory) => ({
    id: Number(memory.id), statement: String(memory.statement || memory.label || ""),
    scope: String(memory.scope || "general"), polarity: Number(memory.polarity || 1),
    weight: Number(memory.weight || 1), confidence: Number(memory.confidence || 0),
    evidence: (() => { try { return JSON.parse(String(memory.evidence_json || "[]")); } catch { return []; } })(),
    evidenceCount: Number(memory.evidence_count || 1), reason: String(memory.reason || "").replace(/^你明确告诉我喜欢歌手\s*/, "用户明确添加的歌手偏好："),
    source: String(memory.source || "unknown"),
    category: String(memory.category || "taste") as MemoryCategory,
    status: memory.status === "pending" ? "pending" : "confirmed",
    updatedAt: String(memory.updated_at || ""),
  }));
}

function normalizeSavedIntent(value: unknown): AiIntent | null {
  if (!value || typeof value !== "object") return null;
  const intent = value as Partial<AiIntent> & { inclusions?: string[]; exclusions?: string[] };
  return {
    summary: typeof intent.summary === "string" ? intent.summary : "历史版本保存的需求解析",
    mustHave: Array.isArray(intent.mustHave) ? intent.mustHave : Array.isArray(intent.inclusions) ? intent.inclusions : [],
    avoid: Array.isArray(intent.avoid) ? intent.avoid : Array.isArray(intent.exclusions) ? intent.exclusions : [],
    softPreferences: Array.isArray(intent.softPreferences) ? intent.softPreferences : [],
  };
}

function MemoryStatement({ memory, onEdit, onDelete }: { memory: MemoryRecord; onEdit: (memory: MemoryRecord) => void; onDelete: (memory: MemoryRecord) => void }) {
  const sourceLabel = memory.source === "explicit_manual" ? "用户创建" : memory.source === "explicit_feedback" ? "来自歌曲反馈" : memory.source === "explicit" ? "明确偏好" : "系统观察";
  const importance = memoryImportanceLabel[Math.min(3, Math.max(1, Math.abs(memory.weight)))] || "一般";
  return <article className="memory-statement"><div className="memory-statement-meta"><span>{memoryCategoryLabel[memory.category]} · {importance}{memory.scope !== "general" ? ` · ${memory.scope}` : ""}</span><small>{sourceLabel}</small></div><h3>{memory.statement}</h3><p>{memory.reason}</p>{memory.evidence.length > 0 && <div className="memory-evidence">{memory.evidence.map((item, index) => <b key={`${item.trackId || item.title}-${index}`}>参考：{item.title || item.trackId}</b>)}</div>}<div className="memory-statement-actions"><button onClick={() => onEdit(memory)}>修改</button><button onClick={() => onDelete(memory)}>删除</button></div></article>;
}

export default function MomentApp() {
  const [view, setView] = useState<View>("create");
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [mix, setMix] = useState<Mix>({ familiar: 50, forgotten: 20, discover: 30 });
  const [trackCount, setTrackCount] = useState(10);
  const [tracks, setTracks] = useState<Track[]>(demoTracks);
  const [playlist, setPlaylist] = useState<RecommendedTrack[]>([]);
  const [preferences, setPreferences] = useState<MemoryRecord[]>([]);
  const [recentRequests, setRecentRequests] = useState<RequestMemory[]>([]);
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [feedbackDraft, setFeedbackDraft] = useState<FeedbackDraft | null>(null);
  const [aiIntent, setAiIntent] = useState<AiIntent | null>(null);
  const [playlistTitle, setPlaylistTitle] = useState("此刻歌单");
  const [playlistSummary, setPlaylistSummary] = useState("根据你的表达和音乐记忆生成。");
  const [playlistSource, setPlaylistSource] = useState<"ai" | "user">("ai");
  const [currentPlaylistId, setCurrentPlaylistId] = useState<number | null>(null);
  const [currentPlan, setCurrentPlan] = useState<RecommendationPlan | null>(null);
  const [savedPlaylists, setSavedPlaylists] = useState<SavedPlaylist[]>([]);
  const [userPlaylists, setUserPlaylists] = useState<UserPlaylist[]>([]);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [playlistPickerTrack, setPlaylistPickerTrack] = useState<Track | null>(null);
  const [feedbackTrack, setFeedbackTrack] = useState<Track | null>(null);
  const [editingMemoryId, setEditingMemoryId] = useState<number | "new" | null>(null);
  const [memoryDraft, setMemoryDraft] = useState<MemoryDraft>({ statement: "", category: "taste", scope: "general", importance: 2, evidence: [] });
  const [memoryTrackQuery, setMemoryTrackQuery] = useState("");
  const [similarityQuery, setSimilarityQuery] = useState("");
  const [similarityTrack, setSimilarityTrack] = useState<Track | null>(null);
  const [experienceProfileDraft, setExperienceProfileDraft] = useState<ExperienceProfile>(emptyExperienceProfile);
  const [profileTagDrafts, setProfileTagDrafts] = useState({ style: "", feltExperience: "", energyArc: "", sound: "" });
  const [activeSimilarityDimension, setActiveSimilarityDimension] = useState<(typeof similarityDimensions)[number]["key"]>("emotion");
  const [annotationDrafts, setAnnotationDrafts] = useState<Record<string, SimilarityAnnotation>>({});
  const [calibrationEntries, setCalibrationEntries] = useState<CalibrationEntry[]>([]);
  const [similarityComparisons, setSimilarityComparisons] = useState<SimilarityComparison[]>([]);
  const [comparisonQuery, setComparisonQuery] = useState("");
  const [comparisonTrack, setComparisonTrack] = useState<Track | null>(null);
  const [comparisonDimensions, setComparisonDimensions] = useState<string[]>([]);
  const [comparisonDraft, setComparisonDraft] = useState({ similarity: "", difference: "", evidence: "" });
  const [isDraftingSimilarity, setIsDraftingSimilarity] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [libraryStatus, setLibraryStatus] = useState<LibraryStatus>("connecting");
  const [notice, setNotice] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);

  const loadLocalLibrary = async () => {
    try {
      const healthResponse = await fetch(`${apiBase}/api/health`);
      const health = await healthResponse.json();
      setLibraryStatus(health.scan?.running ? "scanning" : "ready");
      setAiConfigured(Boolean(health.ai?.configured));
      const tracksResponse = await fetch(`${apiBase}/api/tracks?limit=2000`);
      const library = await tracksResponse.json();
      if (Array.isArray(library.tracks) && library.tracks.length) setTracks(library.tracks);
    } catch { setLibraryStatus("offline"); }
  };

  const loadMemories = async () => {
    try {
      const response = await fetch(`${apiBase}/api/memories`);
      const value = await response.json();
      if (Array.isArray(value.memories)) setPreferences(mapMemories(value.memories));
      if (Array.isArray(value.recentRequests)) setRecentRequests(value.recentRequests);
    } catch { /* connection state is shown in the header */ }
  };

  const loadPlaylists = async () => {
    try {
      const response = await fetch(`${apiBase}/api/playlists?limit=50`);
      const value = await response.json();
      if (Array.isArray(value.playlists)) setSavedPlaylists(value.playlists);
    } catch { /* history remains empty while the local service is offline */ }
  };

  const loadUserPlaylists = async () => {
    try {
      const response = await fetch(`${apiBase}/api/user-playlists`);
      const value = await response.json();
      if (Array.isArray(value.playlists)) setUserPlaylists(value.playlists);
    } catch { /* local service status is shown globally */ }
  };

  const loadSimilarityLab = async () => {
    try {
      const response = await fetch(`${apiBase}/api/similarity/calibration`);
      const value = await response.json();
      if (Array.isArray(value.tracks)) setCalibrationEntries(value.tracks);
      if (Array.isArray(value.comparisons)) setSimilarityComparisons(value.comparisons);
    } catch { /* calibration remains available after the local service reconnects */ }
  };

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("lab") === "similarity") setView("similarity");
    loadLocalLibrary(); loadMemories(); loadPlaylists(); loadUserPlaylists(); loadSimilarityLab();
  }, []);

  const memoryEvidenceResults = useMemo(() => {
    const query = memoryTrackQuery.trim().toLowerCase();
    if (!query) return [];
    return tracks.filter((track) => !memoryDraft.evidence.some((item) => item.trackId === track.id) && `${track.title} ${track.artist}`.toLowerCase().includes(query)).slice(0, 5);
  }, [memoryTrackQuery, memoryDraft.evidence, tracks]);
  const similarityTrackResults = useMemo(() => {
    const query = similarityQuery.trim().toLowerCase();
    if (!query) return [];
    return tracks.filter((track) => `${track.title} ${track.artist} ${track.album || ""}`.toLowerCase().includes(query)).slice(0, 8);
  }, [similarityQuery, tracks]);
  const comparisonTrackResults = useMemo(() => {
    const query = comparisonQuery.trim().toLowerCase();
    if (!query) return [];
    return tracks.filter((track) => track.id !== similarityTrack?.id && `${track.title} ${track.artist} ${track.album || ""}`.toLowerCase().includes(query)).slice(0, 8);
  }, [comparisonQuery, similarityTrack, tracks]);
  const filteredLibraryTracks = useMemo(() => {
    const query = libraryQuery.trim().toLowerCase();
    if (!query) return tracks;
    return tracks.filter((track) => `${track.title} ${track.artist} ${track.album || ""} ${track.genre || ""}`.toLowerCase().includes(query));
  }, [libraryQuery, tracks]);
  const activeDimension = similarityDimensions.find((dimension) => dimension.key === activeSimilarityDimension) || similarityDimensions[0];
  const activeAnnotation = annotationDrafts[activeSimilarityDimension] || { observation: "", boundary: "", evidence: "" };
  const completedAnnotationCount = Object.values(annotationDrafts).filter((annotation) => annotation.observation.trim() && annotation.boundary.trim() && annotation.evidence.trim()).length;
  const currentTrack = tracks.find((track) => track.id === playingId) ?? playlist.find((track) => track.id === playingId);
  const favoriteIds = useMemo(() => new Set((userPlaylists.find((item) => item.kind === "favorites")?.tracks || []).map((track) => track.id)), [userPlaylists]);
  const favoriteTracks = userPlaylists.find((item) => item.kind === "favorites")?.tracks || [];
  const memoryGroups = useMemo(() => {
    const confirmed = preferences.filter((item) => item.status === "confirmed");
    return {
      tastes: confirmed.filter((item) => item.category === "taste"),
      contexts: confirmed.filter((item) => item.category === "context"),
      boundaries: confirmed.filter((item) => item.category === "boundary"),
      anchors: confirmed.filter((item) => item.category === "anchor"),
      references: confirmed.filter((item) => item.category === "reference"),
      pending: preferences.filter((item) => item.status === "pending"),
    };
  }, [preferences]);
  const confirmedMemoryCount = memoryGroups.tastes.length + memoryGroups.contexts.length + memoryGroups.boundaries.length + memoryGroups.anchors.length + memoryGroups.references.length;
  const actualMix = useMemo(() => (["familiar", "forgotten", "discover", "library"] as TrackKind[]).reduce((result, kind) => {
    result[kind] = playlist.filter((track) => track.kind === kind).length;
    return result;
  }, { familiar: 0, forgotten: 0, discover: 0, library: 0 } as Record<TrackKind, number>), [playlist]);
  const historyCapacity = useMemo(() => ({
    familiar: tracks.filter((track) => track.kind === "familiar").length,
    forgotten: tracks.filter((track) => track.kind === "forgotten").length,
    unknown: tracks.filter((track) => track.kind === "library").length,
  }), [tracks]);

  const showNotice = (message: string, duration = 3000) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), duration);
  };

  const generate = async () => {
    if (isGenerating || !prompt.trim()) return;
    setIsGenerating(true);
    setNotice("DeepSeek 正在理解此刻并挑选歌曲…");
    try {
      const response = await fetch(`${apiBase}/api/recommendations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, mix, count: trackCount }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "生成失败");
      setPlaylist(result.tracks);
      setAiIntent(result.intent);
      setPlaylistTitle(result.title || "此刻歌单");
      setPlaylistSummary(result.summary || "根据你的表达和音乐记忆生成。");
      setPlaylistSource("ai");
      setCurrentPlaylistId(Number(result.id));
      setCurrentPlan(result.plan || null);
      await loadPlaylists();
      await loadMemories();
      setView("ai_detail");
      showNotice(`DeepSeek 已从本地曲库选出 ${result.tracks.length} 首歌`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "生成失败，请稍后重试", 4200);
    } finally { setIsGenerating(false); }
  };

  const playTrack = async (track: Track) => {
    const audio = audioRef.current;
    if (!audio || !track.audioUrl) { showNotice(track.audioUrl ? "播放器正在准备" : "这是演示数据，没有本地音频"); return; }
    if (playingId === track.id && !audio.paused) { audio.pause(); return; }
    if (playingId !== track.id) {
      audio.src = track.audioUrl;
      setPlayingId(track.id);
      setCurrentTime(0);
      fetch(`${apiBase}/api/tracks/${track.id.replace("local-", "")}/play`, { method: "POST" }).catch(() => undefined);
    }
    try { await audio.play(); } catch { showNotice("浏览器阻止了播放，请再点一次"); }
  };

  const playNext = () => {
    if (!currentTrack) return;
    const queue = playlist.length ? playlist : tracks;
    const index = queue.findIndex((track) => track.id === currentTrack.id);
    const next = queue[(index + 1) % queue.length];
    if (next) playTrack(next);
  };

  const playPrevious = () => {
    if (!currentTrack) return;
    const queue = playlist.length ? playlist : tracks;
    const index = queue.findIndex((track) => track.id === currentTrack.id);
    const previous = queue[(index - 1 + queue.length) % queue.length];
    if (previous) playTrack(previous);
  };

  const updateFeedback = async (track: Track) => {
    if (!feedbackDraft || feedbackDraft.trackId !== track.id) return;
    const { value, explanation } = feedbackDraft;
    setFeedback((current) => [...current.filter((item) => item.trackId !== track.id), { trackId: track.id, value, reason: explanation }]);
    try {
      const response = await fetch(`${apiBase}/api/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trackId: track.id, value, explanation, scope: "long_term" }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "反馈保存失败");
      if (Array.isArray(result.memories)) setPreferences(mapMemories(result.memories));
      if (Array.isArray(result.playlists)) setUserPlaylists(result.playlists);
      setFeedbackDraft(null);
      setFeedbackTrack(null);
      showNotice(explanation.trim() ? "反馈和原因已保存，后续推荐会参考" : value === "like" ? "已收藏到我喜欢的音乐" : "已记录不喜欢");
    } catch (error) { showNotice(error instanceof Error ? error.message : "反馈保存失败"); }
  };

  const toggleFavorite = async (track: Track) => {
    const favorite = favoriteIds.has(track.id);
    const response = await fetch(`${apiBase}/api/favorites/${track.id.replace("local-", "")}`, { method: favorite ? "DELETE" : "PUT" });
    const result = await response.json();
    if (!response.ok) return showNotice(result.error || "收藏操作失败");
    if (Array.isArray(result.playlists)) setUserPlaylists(result.playlists);
    showNotice(favorite ? "已取消收藏" : "已收藏到“我喜欢的音乐”");
  };

  const addTrackToPlaylist = async (playlistId: number, track: Track) => {
    const response = await fetch(`${apiBase}/api/user-playlists/${playlistId}/tracks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trackId: track.id }) });
    const result = await response.json();
    if (!response.ok) return showNotice(result.error || "加入歌单失败");
    if (Array.isArray(result.playlists)) setUserPlaylists(result.playlists);
    setPlaylistPickerTrack(null);
    showNotice("已加入歌单");
  };

  const createUserPlaylist = async () => {
    if (!newPlaylistName.trim()) return;
    const response = await fetch(`${apiBase}/api/user-playlists`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newPlaylistName }) });
    const result = await response.json();
    if (!response.ok) return showNotice(result.error || "创建歌单失败");
    if (Array.isArray(result.playlists)) setUserPlaylists(result.playlists);
    setNewPlaylistName("");
    showNotice("新歌单已创建");
  };

  const deleteMemory = async (preference: MemoryRecord) => {
    if (!preference.id) return;
    const response = await fetch(`${apiBase}/api/memories/${preference.id}`, { method: "DELETE" });
    if (response.ok) setPreferences((current) => current.filter((item) => item.id !== preference.id));
  };

  const openNewMemory = (category: MemoryCategory = "taste") => {
    setMemoryDraft({ statement: "", category, scope: category === "context" ? "未命名场景" : "general", importance: 2, evidence: [] });
    setMemoryTrackQuery("");
    setEditingMemoryId("new");
  };

  const openMemoryEditor = (memory: MemoryRecord) => {
    setMemoryDraft({ statement: memory.statement, category: memory.category, scope: memory.scope, importance: Math.min(3, Math.max(1, Math.abs(memory.weight))), evidence: memory.evidence });
    setMemoryTrackQuery("");
    setEditingMemoryId(memory.id);
  };

  const saveMemory = async () => {
    if (!memoryDraft.statement.trim() || editingMemoryId === null) return;
    const response = await fetch(`${apiBase}/api/memories${editingMemoryId === "new" ? "" : `/${editingMemoryId}`}`, {
      method: editingMemoryId === "new" ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...memoryDraft, status: "confirmed" }),
    });
    const result = await response.json();
    if (!response.ok) return showNotice(result.error || "偏好保存失败");
    if (Array.isArray(result.memories)) setPreferences(mapMemories(result.memories));
    setEditingMemoryId(null);
    showNotice(editingMemoryId === "new" ? "偏好已保存" : "偏好已更新");
  };

  const selectCalibrationEntry = (entry: CalibrationEntry) => {
    setSimilarityTrack(entry.track);
    const profile = entry.profile || emptyExperienceProfile;
    setExperienceProfileDraft(profile);
    setProfileTagDrafts({ style: profile.style.join("、"), feltExperience: profile.feltExperience.join("、"), energyArc: profile.energyArc.join("、"), sound: profile.sound.join("、") });
    setAnnotationDrafts(entry.annotations || {});
    setComparisonTrack(null);
    setComparisonDimensions([]);
    setComparisonDraft({ similarity: "", difference: "", evidence: "" });
  };

  const saveExperienceProfile = async () => {
    if (!similarityTrack) return;
    const parseTags = (value: string) => value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean);
    const response = await fetch(`${apiBase}/api/similarity/calibration/${similarityTrack.id.replace("local-", "")}/profile`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...experienceProfileDraft, style: parseTags(profileTagDrafts.style), feltExperience: parseTags(profileTagDrafts.feltExperience), energyArc: parseTags(profileTagDrafts.energyArc), sound: parseTags(profileTagDrafts.sound), source: "user_calibrated", reviewStatus: "approved" }),
    });
    const result = await response.json();
    if (!response.ok) return showNotice(result.error || "听感档案保存失败");
    if (Array.isArray(result.tracks)) {
      setCalibrationEntries(result.tracks);
      const updated = result.tracks.find((item: CalibrationEntry) => item.track.id === similarityTrack.id);
      if (updated?.profile) {
        setExperienceProfileDraft(updated.profile);
        setProfileTagDrafts({ style: updated.profile.style.join("、"), feltExperience: updated.profile.feltExperience.join("、"), energyArc: updated.profile.energyArc.join("、"), sound: updated.profile.sound.join("、") });
      }
    }
    showNotice("听感档案已确认并参与推荐");
  };

  const addCalibrationTrack = async (track: Track) => {
    const response = await fetch(`${apiBase}/api/similarity/calibration/${track.id.replace("local-", "")}`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) return showNotice(result.error || "加入校准集合失败");
    if (Array.isArray(result.tracks)) {
      setCalibrationEntries(result.tracks);
      const entry = result.tracks.find((item: CalibrationEntry) => item.track.id === track.id);
      if (entry) selectCalibrationEntry(entry);
    }
    setSimilarityQuery("");
    showNotice("已加入校准集合");
  };

  const saveSimilarityAnnotation = async () => {
    if (!similarityTrack) return;
    const response = await fetch(`${apiBase}/api/similarity/calibration/${similarityTrack.id.replace("local-", "")}/annotations/${activeSimilarityDimension}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(activeAnnotation) });
    const result = await response.json();
    if (!response.ok) return showNotice(result.error || "标注保存失败");
    if (Array.isArray(result.tracks)) setCalibrationEntries(result.tracks);
    setAnnotationDrafts((current) => ({ ...current, [activeSimilarityDimension]: { ...activeAnnotation, source: "manual" } }));
    showNotice(`${activeDimension.label}标注已保存`);
  };

  const generateSimilarityDraft = async () => {
    if (!similarityTrack || isDraftingSimilarity) return;
    setIsDraftingSimilarity(true);
    showNotice("DeepSeek 正在生成待审核初稿…", 8000);
    try {
      const response = await fetch(`${apiBase}/api/similarity/calibration/${similarityTrack.id.replace("local-", "")}/draft`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "初稿生成失败");
      if (result.annotations && typeof result.annotations === "object") setAnnotationDrafts(result.annotations);
      showNotice("初稿已生成，尚未保存；请逐维审核");
    } catch (error) { showNotice(error instanceof Error ? error.message : "初稿生成失败", 4500); }
    finally { setIsDraftingSimilarity(false); }
  };

  const removeCalibrationTrack = async (entry: CalibrationEntry) => {
    const response = await fetch(`${apiBase}/api/similarity/calibration/${entry.track.id.replace("local-", "")}`, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok) return showNotice(result.error || "移出失败");
    if (Array.isArray(result.tracks)) setCalibrationEntries(result.tracks);
    if (similarityTrack?.id === entry.track.id) { setSimilarityTrack(null); setAnnotationDrafts({}); }
  };

  const saveSimilarityComparison = async () => {
    if (!similarityTrack || !comparisonTrack) return;
    const response = await fetch(`${apiBase}/api/similarity/comparisons`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leftTrackId: similarityTrack.id, rightTrackId: comparisonTrack.id, dimensions: comparisonDimensions, ...comparisonDraft }) });
    const result = await response.json();
    if (!response.ok) return showNotice(result.error || "对比测试保存失败");
    if (Array.isArray(result.comparisons)) setSimilarityComparisons(result.comparisons);
    setComparisonTrack(null); setComparisonDimensions([]); setComparisonDraft({ similarity: "", difference: "", evidence: "" });
    showNotice("对比测试已保存");
  };

  const deleteSimilarityComparison = async (id: number) => {
    const response = await fetch(`${apiBase}/api/similarity/comparisons/${id}`, { method: "DELETE" });
    const result = await response.json();
    if (response.ok && Array.isArray(result.comparisons)) setSimilarityComparisons(result.comparisons);
  };

  const rescanLibrary = async () => {
    setLibraryStatus("scanning");
    await fetch(`${apiBase}/api/library/scan`, { method: "POST" });
    window.setTimeout(loadLocalLibrary, 1200);
  };

  const openSavedPlaylist = (saved: SavedPlaylist) => {
    setPlaylist(saved.tracks);
    setPlaylistTitle(saved.title);
    setPlaylistSummary(saved.summary);
    setPlaylistSource("ai");
    setCurrentPlaylistId(saved.id);
    setCurrentPlan(saved.plan || null);
    setAiIntent(normalizeSavedIntent(saved.intent));
    setPrompt(saved.request);
    setView("ai_detail");
  };

  const openUserPlaylist = (saved: UserPlaylist) => {
    setPlaylist(saved.tracks.map((track) => ({ ...track, score: 0, reason: saved.kind === "favorites" ? "你主动收藏的歌曲。" : `你加入了“${saved.name}”。`, evidence: ["用户主动歌单"] })));
    setPlaylistTitle(saved.name);
    setPlaylistSummary(saved.kind === "favorites" ? "喜欢即收藏；这些歌曲会作为长期、明确的推荐信号。" : "由你主动创建和整理的歌单。");
    setPlaylistSource("user");
    setCurrentPlaylistId(saved.id);
    setCurrentPlan(null);
    setAiIntent(null);
    setView("user_detail");
  };

  const removeTrackFromCurrentPlaylist = async (track: Track) => {
    if (!currentPlaylistId) return;
    const response = playlistSource === "ai"
      ? await fetch(`${apiBase}/api/playlists/${currentPlaylistId}/tracks/${track.id.replace("local-", "")}`, { method: "DELETE" })
      : await fetch(`${apiBase}/api/user-playlists/${currentPlaylistId}/tracks`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trackId: track.id }) });
    const result = await response.json();
    if (!response.ok) return showNotice(result.error || "移除歌曲失败");
    setPlaylist((current) => current.filter((item) => item.id !== track.id));
    if (playlistSource === "ai") {
      if (Array.isArray(result.playlists)) setSavedPlaylists(result.playlists);
      else await loadPlaylists();
    } else if (Array.isArray(result.playlists)) setUserPlaylists(result.playlists);
    showNotice("已从歌单移除；曲库音频仍保留");
  };

  const deleteAiPlaylist = async (saved: SavedPlaylist) => {
    if (!window.confirm(`删除 AI 歌单“${saved.title}”？不会删除曲库歌曲。`)) return;
    const response = await fetch(`${apiBase}/api/playlists/${saved.id}`, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok) return showNotice(result.error || "删除歌单失败");
    if (Array.isArray(result.playlists)) setSavedPlaylists(result.playlists);
  };

  const deleteUserPlaylist = async (saved: UserPlaylist) => {
    if (saved.kind === "favorites" || !window.confirm(`删除用户歌单“${saved.name}”？不会删除曲库歌曲。`)) return;
    const response = await fetch(`${apiBase}/api/user-playlists/${saved.id}`, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok) return showNotice(result.error || "删除歌单失败");
    if (Array.isArray(result.playlists)) setUserPlaylists(result.playlists);
  };

  return <main className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => setView("create")}><span className="brand-dot" /> moment</button>
      <nav aria-label="主导航">
        <button className={`nav-item ${view === "create" ? "active" : ""}`} onClick={() => setView("create")}><span>◐</span> 此刻歌单</button>
        <button className={`nav-item ${view === "ai_playlists" || view === "ai_detail" ? "active" : ""}`} onClick={() => setView("ai_playlists")}><span>✦</span> AI 歌单</button>
        <button className={`nav-item ${view === "user_playlists" || view === "user_detail" ? "active" : ""}`} onClick={() => setView("user_playlists")}><span>▤</span> 用户歌单</button>
        <button className={`nav-item ${view === "library" ? "active" : ""}`} onClick={() => setView("library")}><span>♬</span> 我的曲库</button>
        <button className={`nav-item ${view === "memory" ? "active" : ""}`} onClick={() => setView("memory")}><span>✧</span> 音乐记忆</button>
      </nav>
      <div className="sidebar-foot"><p>已保存 <strong>{confirmedMemoryCount}</strong> 条明确记忆</p><div className="memory-line"><i style={{ width: `${Math.min(100, 12 + confirmedMemoryCount * 7)}%` }} /></div><span>{memoryGroups.pending.length ? `${memoryGroups.pending.length} 条线索等待确认` : feedback.length ? `有 ${feedback.length} 条歌曲反馈可追溯` : "收藏与具体反馈会形成证据"}</span></div>
    </aside>

    <section className="content">
      <header className="topbar"><div className={`status ${libraryStatus}`}><span /> {libraryStatus === "ready" ? `本地曲库已就绪 · ${tracks.length} 首` : libraryStatus === "scanning" ? "正在扫描本地曲库…" : libraryStatus === "offline" ? `本地音乐服务未启动 · 当前显示 ${tracks.length} 首演示歌曲` : "正在连接本地曲库…"}</div><div className={`ai-badge ${aiConfigured ? "ready" : ""}`}>✦ {aiConfigured ? "DeepSeek 已连接" : "DeepSeek 未配置"}</div><button className="avatar" aria-label="本地用户">L</button></header>

      {view === "create" && <>
        <div className="hero">
          <p className="eyebrow">此刻歌单</p><h1>你此刻想听什么？</h1>
          <p className="subtitle">说说现在的心情、场景，或你想保留的声音特征。</p>
          <div className="prompt-card">
            <textarea value={prompt} onChange={(event) => { setPrompt(event.target.value); setAiIntent(null); }} placeholder="例如：我现在心情很愉快，想听跟林子祥《敢爱敢做》类似的歌。生成10首，一半老歌、一半新歌。" aria-label="用自然语言描述此刻想听的音乐" />
            <div className="prompt-actions"><p>心情、场景、参考歌曲、数量和排除条件，都可以直接写在这段话里。</p><button className="generate-button" onClick={generate} disabled={!prompt.trim() || isGenerating}>{isGenerating ? "DeepSeek 正在选歌…" : "生成此刻歌单"} <span>{isGenerating ? "✦" : "→"}</span></button></div>
          </div>
          <div className="mix-section"><div className="section-heading"><div><h2>歌单结构</h2><p>分别调整三类歌曲的目标比例；实际历史不足时会如实标记。</p></div><div className="count-control"><span>歌曲数量</span><button onClick={() => setTrackCount((value) => Math.max(1, value - 1))}>−</button><input aria-label="歌单歌曲数量" type="number" min="1" max="30" value={trackCount} onChange={(event) => setTrackCount(Math.max(1, Math.min(30, Number(event.target.value) || 1)))} /><button onClick={() => setTrackCount((value) => Math.min(30, value + 1))}>＋</button><small>约 {Math.round(trackCount * 4.2)} 分钟</small></div></div><MixControl mix={mix} onChange={setMix} /><p className="history-capacity">当前可识别：近期熟悉 {historyCapacity.familiar} 首 · 遗忘旧爱 {historyCapacity.forgotten} 首 · 历史未知 {historyCapacity.unknown} 首。系统优先保证需求匹配，播放历史不足时会用曲库内历史未知歌曲补齐。</p></div>
        </div>
        <section className="recent"><div className="section-heading"><div><p className="eyebrow">本地的声音</p><h2>{libraryStatus === "ready" ? "已经可以播放你的真实歌曲" : "正在准备本地曲库"}</h2></div><button className="text-button" onClick={() => setView("library")}>查看完整曲库 →</button></div><div className="track-grid">{tracks.slice(0, 3).map((track, index) => <article className="track-card" key={track.id}><Cover track={track} index={index} active={playingId === track.id && isPlaying} onPlay={() => playTrack(track)} /><div><h3>{track.title}</h3><p>{track.artist}</p><span className="track-tag">{track.tags[0]}</span></div></article>)}</div></section>
      </>}

      {(view === "ai_detail" || view === "user_detail") && <section className="page playlist-page">
        <button className="back" onClick={() => setView(playlistSource === "ai" ? "ai_playlists" : "user_playlists")}>← 返回{playlistSource === "ai" ? "AI 歌单" : "用户歌单"}</button>
        <div className="playlist-head"><div><p className="eyebrow">{playlistSource === "ai" ? "AI 智能推荐" : "用户歌单"}</p><h1>{playlistTitle}</h1><p className="subtitle">{playlistSummary}{playlistSource === "ai" && confirmedMemoryCount ? ` · ${confirmedMemoryCount} 条已确认长期记忆仅作为次级参考。` : ""}</p></div><div className="playlist-actions">{playlistSource === "ai" && <button className="secondary" onClick={generate} disabled={isGenerating}>↻ {isGenerating ? "正在生成" : "换一批"}</button>}<button className="play-all" onClick={() => playlist[0] && playTrack(playlist[0])}>▶ 播放全部</button></div></div>
        {playlistSource === "ai" && <section className="recommendation-trace"><div className="trace-heading"><div><p className="eyebrow">本次推荐链路</p><h2>谁做了什么</h2></div><span>{currentPlan ? "已保存结构化检索计划" : "早期歌单未保存完整计划"}</span></div><div className="trace-grid"><article><b>1</b><h3>LLM 理解需求</h3><p>把自然语言拆成硬条件、参考关系、软偏好和排除项。</p><div className="trace-tags">{[...(currentPlan?.hardArtists || []).map((item) => `硬条件：${item}`), ...(currentPlan?.seedRelations || []).map((item) => `参考：${item}`), ...(currentPlan?.softPreferences || []), ...(currentPlan?.mustAvoid || []).map((item) => `排除：${item}`)].slice(0, 8).map((item) => <span key={item}>{item}</span>)}</div></article><article><b>2</b><h3>推荐系统筛选候选</h3><p>先执行歌手、曲风和排除条件，再按直接证据、关联证据和探索候选分层，去重后最多交给模型80首。</p><div className="trace-tags"><span>硬条件先过滤</span><span>证据分层</span><span>不计算虚假总分</span><span>去重与歌手分散</span></div></article><article className="llm-curation"><b>3</b><h3>LLM 语义选择</h3><p>DeepSeek 查看候选的完整听感档案和召回证据，选择真正承接本次需求的歌曲；服务端最后校验参考歌、数量、硬条件和真实ID。</p><div className="trace-warning">当前依据人工策展的语义听感档案，不声称已经计算音频旋律或音色相似度。</div></article></div></section>}
        <div className="playlist-summary"><div><strong>{playlist.length}</strong><span>真实可播放歌曲</span></div><div><strong>{actualMix.familiar} 首</strong><span>近期熟悉</span></div><div><strong>{actualMix.forgotten} 首</strong><span>遗忘旧爱</span></div><div><strong>{actualMix.library} 首</strong><span>曲库内历史未知</span></div><div><strong>{actualMix.discover} 首</strong><span>外部探索</span></div></div>
        <div className="queue">{playlist.map((track, index) => <article className={`queue-row ${playingId === track.id ? "is-playing" : ""}`} key={track.id}><Cover track={track} index={index} active={playingId === track.id && isPlaying} onPlay={() => playTrack(track)} /><div className="track-main"><div className="track-title-line"><h3>{track.title}</h3><span className={`kind ${track.kind}`}>{kindLabel[track.kind]}</span></div><p>{track.artist} · {track.album || track.genre}</p><div className="tags">{track.tags.slice(0,3).map((tag) => <span key={tag}>{tag}</span>)}</div></div><div className="reason-block"><p className="reason">{track.reason}</p>{track.evidence && track.evidence.length > 0 && <div className="evidence-list">{track.evidence.map((item) => <span key={item}>依据：{item}</span>)}</div>}</div><div className="track-actions"><button className={favoriteIds.has(track.id) ? "chosen" : ""} onClick={() => toggleFavorite(track)} title={favoriteIds.has(track.id) ? "取消收藏" : "喜欢并收藏"}>{favoriteIds.has(track.id) ? "♥" : "♡"}</button><button onClick={() => setPlaylistPickerTrack(track)} title="加入歌单">＋</button><button onClick={() => { setFeedbackTrack(track); setFeedbackDraft({ trackId: track.id, value: "like", explanation: "" }); }} title="写反馈">✎</button><button className="remove-button" onClick={() => removeTrackFromCurrentPlaylist(track)} title="从歌单移除">⌫</button></div></article>)}</div>
      </section>}

      {view === "ai_playlists" && <section className="page playlists-page"><div className="page-title"><div><p className="eyebrow">AI 歌单</p><h1>每次对话生成的音乐</h1><p className="subtitle">按日期保存 DeepSeek 对需求的概括、选歌结果和逐首理由。</p></div><button className="generate-button" onClick={() => { setPrompt(""); setAiIntent(null); setView("create"); }}>生成新歌单</button></div>{savedPlaylists.length === 0 ? <div className="empty-strip">还没有 AI 生成歌单</div> : <div className="playlist-history">{savedPlaylists.map((saved) => <article className="history-card" key={saved.id}><div className="history-date">{formatPlaylistDate(saved.createdAt)}</div><div className="history-copy"><h2>{saved.title}</h2><p>{saved.summary}</p><small>原始需求：{saved.request}</small></div><div className="history-tracks">{saved.tracks.slice(0, 5).map((track) => <span key={track.id}>{track.title}</span>)}{saved.tracks.length > 5 && <span>另 {saved.tracks.length - 5} 首</span>}</div><div className="history-actions"><b>{saved.tracks.length} 首</b><button className="secondary" onClick={() => openSavedPlaylist(saved)}>打开</button><button className="delete-button" onClick={() => deleteAiPlaylist(saved)}>删除</button></div></article>)}</div>}</section>}

      {view === "user_playlists" && <section className="page playlists-page"><div className="page-title"><div><p className="eyebrow">用户歌单</p><h1>你主动收藏与整理的音乐</h1><p className="subtitle">“我喜欢的音乐”是默认收藏；自定义歌单在下方独立创建和管理。</p></div></div>{userPlaylists.filter((saved) => saved.kind === "favorites").map((saved) => <section className="favorites-feature" key={saved.id}><div className="playlist-art"><span>♥</span></div><div><p className="eyebrow">默认收藏</p><h2>{saved.name}</h2><p>{saved.trackCount} 首歌曲 · 点击喜欢会自动加入这里</p><div className="playlist-preview">{saved.tracks.slice(0, 6).map((track) => <span key={track.id}>{track.title}</span>)}</div></div><button className="play-all" onClick={() => openUserPlaylist(saved)}>打开收藏</button></section>)}<section className="custom-playlists"><div className="module-heading"><div><span className="module-icon user">♬</span><div><h2>自定义歌单</h2><p>按场景、主题或你自己的方式整理。</p></div></div></div><div className="new-playlist-block"><label htmlFor="new-playlist-name">新建一个歌单</label><div><input id="new-playlist-name" value={newPlaylistName} onChange={(event) => setNewPlaylistName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") createUserPlaylist(); }} placeholder="例如：深夜开车" /><button onClick={createUserPlaylist}>＋ 创建歌单</button></div></div><div className="user-playlist-grid">{userPlaylists.filter((saved) => saved.kind === "custom").map((saved) => <article className="user-playlist-card" key={saved.id}><div className="playlist-art"><span>♬</span></div><div><small>自定义歌单</small><h3>{saved.name}</h3><p>{saved.trackCount} 首歌曲</p><div className="playlist-preview">{saved.tracks.slice(0, 3).map((track) => <span key={track.id}>{track.title}</span>)}</div></div><div className="card-actions"><button className="secondary" onClick={() => openUserPlaylist(saved)}>打开</button><button className="delete-button" onClick={() => deleteUserPlaylist(saved)}>删除</button></div></article>)}</div></section></section>}

      {view === "library" && <section className="page"><div className="page-title"><div><p className="eyebrow">我的曲库</p><h1>{libraryQuery.trim() ? `${filteredLibraryTracks.length} / ${tracks.length}` : tracks.length} 首真实歌曲</h1><p className="subtitle">播放、喜欢、加入歌单或写下反馈；喜欢会直接进入“我喜欢的音乐”。</p></div><button className="generate-button" onClick={rescanLibrary} disabled={libraryStatus === "scanning"}>{libraryStatus === "scanning" ? "正在扫描…" : "↻ 重新扫描曲库"}</button></div><div className="import-help"><strong>本地曲库已连接</strong><code>music-repo</code><span>支持 MP3 / FLAC / M4A / AAC / WAV / OGG，新增歌曲后点击重新扫描即可。</span></div><div className="library-search"><span>⌕</span><input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="搜索歌名、歌手、专辑或流派" aria-label="搜索曲库" />{libraryQuery && <button onClick={() => setLibraryQuery("")}>清除</button>}</div><div className="library-table"><div className="table-head"><span>歌曲</span><span>类型</span><span>专辑 / 分类</span><span>操作</span></div>{filteredLibraryTracks.map((track) => <div className={`table-row ${playingId === track.id ? "selected" : ""}`} key={track.id}><div className="song-cell"><button className={`mini-cover ${track.color}`} onClick={() => playTrack(track)} aria-label={`播放 ${track.title}`}>{playingId === track.id && isPlaying ? "Ⅱ" : "▶"}</button><button className="song-name" onClick={() => playTrack(track)}><strong>{track.title}</strong><small>{track.artist}</small></button></div><span className={`kind ${track.kind}`}>{kindLabel[track.kind]}</span><div className="tags"><span>{track.album || track.folder || track.genre}</span></div><div className="library-actions"><button className={favoriteIds.has(track.id) ? "chosen" : ""} onClick={() => toggleFavorite(track)} title={favoriteIds.has(track.id) ? "取消收藏" : "喜欢并收藏"}>{favoriteIds.has(track.id) ? "♥" : "♡"}</button><button onClick={() => setPlaylistPickerTrack(track)} title="加入歌单">＋</button><button onClick={() => { setFeedbackTrack(track); setFeedbackDraft({ trackId: track.id, value: "like", explanation: "" }); }} title="写反馈">✎</button></div></div>)}</div></section>}

      {view === "memory" && <section className="page memory-page">
        <div className="page-title"><div><p className="eyebrow">音乐记忆</p><h1>我的音乐偏好</h1><p className="subtitle">管理会参与推荐的长期偏好、场景设置和音乐参照。系统观察只有确认后才会生效。</p></div><button className="generate-button" onClick={() => openNewMemory()}>＋ 添加偏好</button></div>
        <section className="memory-overview"><div><p className="eyebrow">推荐设置</p><h2>长期记忆由用户与系统共同维护</h2><p>每次原始需求都会保留；其中的强信号先进入“待确认观察”，只有经过确认才会参与后续推荐。收藏表示保留歌曲，具体喜欢什么可以通过反馈补充。</p></div><div className="memory-stats"><span><b>{memoryGroups.tastes.length}</b>长期偏好</span><span><b>{memoryGroups.contexts.length}</b>场景设置</span><span><b>{memoryGroups.anchors.length + memoryGroups.references.length + favoriteTracks.length}</b>音乐参照</span><span><b>{memoryGroups.pending.length}</b>待确认观察</span></div></section>
        <section className="memory-section request-memory-section"><div className="memory-section-head"><div><p className="eyebrow">原始记录</p><h2>最近表达的听歌需求</h2></div><span>记录不等于长期偏好</span></div><p className="request-memory-help">用于继续上一次对话、追溯歌单为什么这样生成；不会因为一次临时心情直接改写长期记忆。</p><div className="request-memory-list">{recentRequests.slice(0, 8).map((item) => <article key={item.id}><div><span>{formatPlaylistDate(item.createdAt)}</span><b className={`request-status ${item.status}`}>{item.status === "succeeded" ? "已生成" : item.status === "failed" ? "生成失败" : "正在生成"}</b></div><p>{item.request}</p>{item.title && <small>{item.title} · {item.requestedCount} 首</small>}</article>)}</div></section>
        <section className="memory-section"><div className="memory-section-head"><div><p className="eyebrow">已确认</p><h2>长期偏好</h2></div><button className="memory-add" onClick={() => openNewMemory("taste")}>＋ 新增</button></div>{memoryGroups.tastes.length ? <div className="statement-list">{memoryGroups.tastes.map((memory) => <MemoryStatement key={memory.id} memory={memory} onEdit={openMemoryEditor} onDelete={deleteMemory} />)}</div> : <div className="memory-empty-state"><p>还没有手动确认的长期偏好。</p><button onClick={() => openNewMemory("taste")}>写下一条推荐偏好</button></div>}</section>
        <section className="memory-section"><div className="memory-section-head"><div><p className="eyebrow">按状态使用</p><h2>场景设置</h2></div><button className="memory-add" onClick={() => openNewMemory("context")}>＋ 新增场景</button></div>{memoryGroups.contexts.length ? <div className="statement-list">{memoryGroups.contexts.map((memory) => <MemoryStatement key={memory.id} memory={memory} onEdit={openMemoryEditor} onDelete={deleteMemory} />)}</div> : <div className="memory-empty-state"><p>还没有场景设置。本次需求默认只影响当前歌单。</p><button onClick={() => openNewMemory("context")}>创建场景设置</button></div>}</section>
        <section className="memory-section"><div className="memory-section-head"><div><p className="eyebrow">避免误推</p><h2>明确边界</h2></div><button className="memory-add" onClick={() => openNewMemory("boundary")}>＋ 新增边界</button></div>{memoryGroups.boundaries.length ? <div className="statement-list">{memoryGroups.boundaries.map((memory) => <MemoryStatement key={memory.id} memory={memory} onEdit={openMemoryEditor} onDelete={deleteMemory} />)}</div> : <div className="memory-empty-state"><p>尚未保存长期排除条件。</p><button onClick={() => openNewMemory("boundary")}>添加不希望出现的特征</button></div>}</section>
        <section className="memory-section"><div className="memory-section-head"><div><p className="eyebrow">音乐参照</p><h2>歌手、歌曲与具体反馈</h2></div><span>参照对象本身不等于喜欢它的全部特征</span></div><div className="anchor-layout"><article className="anchor-panel"><h3>歌手与歌曲反馈</h3>{memoryGroups.anchors.length + memoryGroups.references.length ? <div className="reference-memory-list">{[...memoryGroups.anchors, ...memoryGroups.references].map((memory) => <MemoryStatement key={memory.id} memory={memory} onEdit={openMemoryEditor} onDelete={deleteMemory} />)}</div> : <p className="memory-empty">暂无带具体说明的音乐参照。</p>}</article><article className="anchor-panel"><h3>收藏歌曲</h3>{favoriteTracks.length ? <div className="favorite-memory-list">{favoriteTracks.slice(0, 12).map((track) => <button key={track.id} onClick={() => playTrack(track)}><strong>{track.title}</strong><span>{track.artist}</span></button>)}</div> : <p className="memory-empty">点击歌曲的喜欢按钮后会出现在这里。</p>}</article></div></section>
        <section className="memory-learning"><div><p className="eyebrow">待确认观察</p><h2>{memoryGroups.pending.length ? `${memoryGroups.pending.length} 条观察等待处理` : "目前没有等待确认的观察"}</h2><p>行为只能形成建议，不能直接定义长期偏好。确认、修改或忽略后，结果才会参与推荐。</p></div>{memoryGroups.pending.length ? <div className="pending-memory-list">{memoryGroups.pending.map((memory) => <div key={memory.id}><span>{memory.statement}</span><button onClick={() => openMemoryEditor(memory)}>确认或修改</button><button onClick={() => deleteMemory(memory)}>不保存</button></div>)}</div> : <span>0 条待处理</span>}</section>
      </section>}

      {view === "similarity" && <section className="page similarity-page">
        <div className="page-title"><div><p className="eyebrow">内部听感档案 · 复检页</p><h1>检查一首歌真正带来的体验</h1><p className="subtitle">标注已经由 Codex 完成。这里不是让用户填写曲库，而是让你抽查、修改并确认；确认后的档案会直接参与推荐。</p></div><span className="internal-badge">INTERNAL</span></div>
        <section className="similarity-principle"><div><p className="eyebrow">推荐原则</p><h2>先匹配曲风和听感，再理解主题</h2><p>同歌手、同题材或都带“忧伤”不代表适合放在一起。系统优先判断声音风格、身体感受、能量如何运动，以及什么情况下不应该推荐。</p></div><div className="principle-steps"><span><b>1</b>曲风指纹</span><span><b>2</b>实际听感与能量</span><span><b>3</b>声音表现与排除边界</span></div></section>
        <section className="similarity-workbench">
          <div className="workbench-head"><div><p className="eyebrow">首批策展标注 · {calibrationEntries.filter((entry) => entry.profile).length}/{calibrationEntries.length}</p><h2>{similarityTrack ? `${similarityTrack.title} · ${similarityTrack.artist}` : "选择一首歌曲开始复检"}</h2></div><div className="profile-review-summary"><b>{calibrationEntries.filter((entry) => entry.profile?.reviewStatus === "approved").length}</b><span>已确认</span></div></div>
          {calibrationEntries.length > 0 && <div className="calibration-strip">{calibrationEntries.map((entry) => <div className={similarityTrack?.id === entry.track.id ? "active" : ""} key={entry.track.id}><button onClick={() => selectCalibrationEntry(entry)}><strong>{entry.track.title}</strong><span>{entry.profile?.reviewStatus === "approved" ? "已确认" : entry.profile ? "待复检" : "未标注"}</span></button></div>)}</div>}
          <article className="experience-profile-panel">
            {!similarityTrack ? <div className="profile-empty"><h2>21 首档案已准备好</h2><p>从上方选择歌曲查看。旧八维标注和自动两两比较已经停止参与推荐。</p></div> : <>
              <div className="dimension-title"><div><p className="eyebrow">策展式听感档案</p><h2>{experienceProfileDraft.identity || "等待填写核心辨识度"}</h2></div><div className="dimension-status"><span>{experienceProfileDraft.reviewStatus === "approved" ? "已确认" : "待你复检"}</span><b>{experienceProfileDraft.source === "user_calibrated" ? "依据你的听感校准" : "Codex 初标"}</b></div></div>
              <div className="profile-fields">
                <label><span>曲风指纹</span><input value={profileTagDrafts.style} onChange={(event) => setProfileTagDrafts((current) => ({ ...current, style: event.target.value }))} /><small>实际声音风格，不只写“流行”或“摇滚”</small></label>
                <label><span>实际听感</span><input value={profileTagDrafts.feltExperience} onChange={(event) => setProfileTagDrafts((current) => ({ ...current, feltExperience: event.target.value }))} /><small>听起来让人产生什么感受，允许矛盾共存</small></label>
                <label><span>能量与情绪走向</span><input value={profileTagDrafts.energyArc} onChange={(event) => setProfileTagDrafts((current) => ({ ...current, energyArc: event.target.value }))} /><small>从开头到结尾怎样积累、释放或悬置</small></label>
                <label><span>声音表现</span><input value={profileTagDrafts.sound} onChange={(event) => setProfileTagDrafts((current) => ({ ...current, sound: event.target.value }))} /><small>只保留真正影响听感的人声、节奏和音色</small></label>
                <label className="profile-wide"><span>核心辨识度</span><textarea value={experienceProfileDraft.identity} onChange={(event) => setExperienceProfileDraft((current) => ({ ...current, identity: event.target.value }))} /></label>
                <label className="profile-wide"><span>排除边界</span><textarea value={experienceProfileDraft.avoid} onChange={(event) => setExperienceProfileDraft((current) => ({ ...current, avoid: event.target.value }))} /></label>
              </div>
              <div className="profile-actions"><p>如果整体准确，直接确认；有偏差就修改后确认。确认后下一次生成歌单会读取这份档案。</p><button onClick={saveExperienceProfile}>保存并确认这首歌</button></div>
            </>}
          </article>
        </section>
      </section>}
    </section>

    <audio ref={audioRef} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onDurationChange={(event) => setAudioDuration(event.currentTarget.duration)} onEnded={playNext} />
    {currentTrack?.audioUrl && <div className="player"><div className={`player-cover ${currentTrack.color}`}><span>♪</span></div><div className="player-track"><strong>{currentTrack.title}</strong><span>{currentTrack.artist}</span></div><div className="player-actions"><button className={favoriteIds.has(currentTrack.id) ? "chosen" : ""} onClick={() => toggleFavorite(currentTrack)} aria-label={favoriteIds.has(currentTrack.id) ? "取消收藏" : "喜欢并收藏"}>{favoriteIds.has(currentTrack.id) ? "♥" : "♡"}</button><button onClick={() => setPlaylistPickerTrack(currentTrack)} aria-label="加入歌单">＋</button><button onClick={() => { setFeedbackTrack(currentTrack); setFeedbackDraft({ trackId: currentTrack.id, value: "like", explanation: "" }); }} aria-label="写反馈">✎</button></div><div className="transport"><button onClick={playPrevious} aria-label="上一首">⏮</button><button className="player-button" onClick={() => playTrack(currentTrack)} aria-label={isPlaying ? "暂停" : "继续播放"}>{isPlaying ? "Ⅱ" : "▶"}</button><button onClick={playNext} aria-label="下一首">⏭</button></div><span className="player-time">{formatTime(currentTime)}</span><input aria-label="播放进度" type="range" min="0" max={audioDuration || currentTrack.duration || 0} step="0.1" value={Math.min(currentTime, audioDuration || currentTrack.duration || 0)} onChange={(event) => { if (audioRef.current) audioRef.current.currentTime = Number(event.target.value); }} /><span className="player-time">{formatTime(audioDuration || currentTrack.duration)}</span></div>}
    {playlistPickerTrack && <div className="modal-backdrop" onMouseDown={() => setPlaylistPickerTrack(null)}><section className="action-modal compact" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setPlaylistPickerTrack(null)}>×</button><p className="eyebrow">加入歌单</p><h2>{playlistPickerTrack.title}</h2><div className="playlist-picker-list">{userPlaylists.map((saved) => <button key={saved.id} onClick={() => addTrackToPlaylist(saved.id, playlistPickerTrack)}><span>{saved.kind === "favorites" ? "♥" : "♬"}</span><div><strong>{saved.name}</strong><small>{saved.trackCount} 首</small></div><b>＋</b></button>)}</div></section></div>}
    {editingMemoryId !== null && <div className="modal-backdrop" onMouseDown={() => setEditingMemoryId(null)}><section className="action-modal memory-editor" onMouseDown={(event) => event.stopPropagation()}>
      <button className="modal-close" onClick={() => setEditingMemoryId(null)}>×</button><p className="eyebrow">{editingMemoryId === "new" ? "添加推荐设置" : "修改推荐设置"}</p><h2>{editingMemoryId === "new" ? "保存一条音乐偏好" : "调整这条音乐偏好"}</h2><p className="modal-subtitle">建议描述推荐条件，例如“偏好副歌具有明显释放感”，不需要描述个人性格。</p>
      <div className="memory-form"><label><span>类型</span><select value={memoryDraft.category} onChange={(event) => { const category = event.target.value as MemoryCategory; setMemoryDraft((current) => ({ ...current, category, scope: category === "context" && current.scope === "general" ? "未命名场景" : category !== "context" ? "general" : current.scope })); }}><option value="taste">长期偏好</option><option value="context">场景设置</option><option value="boundary">明确边界</option><option value="reference">音乐参照</option></select></label>{memoryDraft.category === "context" && <label><span>场景名称</span><input value={memoryDraft.scope} onChange={(event) => setMemoryDraft((current) => ({ ...current, scope: event.target.value }))} placeholder="例如：开车、深夜、想振作时" /></label>}<label className="memory-form-statement"><span>偏好内容</span><textarea autoFocus value={memoryDraft.statement} onChange={(event) => setMemoryDraft((current) => ({ ...current, statement: event.target.value }))} placeholder={memoryDraft.category === "boundary" ? "例如：避免仅靠高响度制造冲击的歌曲" : memoryDraft.category === "context" ? "例如：偏好有推进感，避免节奏过于松散" : "例如：偏好旋律鲜明、副歌具有释放感的歌曲"} /></label>
        <div className="memory-reference-field"><span>代表歌曲（可选）</span>{memoryDraft.evidence.length > 0 && <div className="seed-chips">{memoryDraft.evidence.map((item, index) => <button key={`${item.trackId}-${index}`} onClick={() => setMemoryDraft((current) => ({ ...current, evidence: current.evidence.filter((_, evidenceIndex) => evidenceIndex !== index) }))}>{item.title}<span>×</span></button>)}</div>}<div className="seed-search"><input value={memoryTrackQuery} onChange={(event) => setMemoryTrackQuery(event.target.value)} placeholder="搜索曲库中的歌名或歌手" />{memoryEvidenceResults.length > 0 && <div className="seed-results">{memoryEvidenceResults.map((track) => <button key={track.id} onClick={() => { setMemoryDraft((current) => ({ ...current, evidence: [...current.evidence, { trackId: track.id, title: `${track.title} · ${track.artist}` }].slice(0, 10) })); setMemoryTrackQuery(""); }}><strong>{track.title}</strong><span>{track.artist}</span></button>)}</div>}</div></div>
        <label><span>参与推荐的重要程度</span><select value={memoryDraft.importance} onChange={(event) => setMemoryDraft((current) => ({ ...current, importance: Number(event.target.value) }))}><option value="1">一般</option><option value="2">常用</option><option value="3">核心</option></select></label>
      </div><button className="save-feedback modal-save" onClick={saveMemory} disabled={!memoryDraft.statement.trim()}>保存偏好</button>
    </section></div>}
    {feedbackTrack && feedbackDraft && <div className="modal-backdrop" onMouseDown={() => { setFeedbackTrack(null); setFeedbackDraft(null); }}><section className="action-modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => { setFeedbackTrack(null); setFeedbackDraft(null); }}>×</button><p className="eyebrow">歌曲反馈</p><h2>{feedbackTrack.title}</h2><p className="modal-subtitle">{feedbackTrack.artist} · 原因可以不写；写下的具体原因会成为长期推荐记忆。</p><div className="verdict-switch"><button className={feedbackDraft.value === "like" ? "active" : ""} onClick={() => setFeedbackDraft({ ...feedbackDraft, value: "like" })}>♥ 喜欢</button><button className={feedbackDraft.value === "dislike" ? "active dislike" : ""} onClick={() => setFeedbackDraft({ ...feedbackDraft, value: "dislike" })}>× 不喜欢</button></div><textarea autoFocus value={feedbackDraft.explanation} onChange={(event) => setFeedbackDraft({ ...feedbackDraft, explanation: event.target.value })} placeholder={feedbackDraft.value === "like" ? "可选：具体喜欢什么？例如前奏克制、鼓点逐渐进入。" : "可选：具体哪里不喜欢？例如副歌人声太满。"} /><button className="save-feedback modal-save" onClick={() => updateFeedback(feedbackTrack)}>保存反馈</button></section></div>}
    {notice && <div className="toast">{isGenerating ? "✦" : "✓"} {notice}</div>}
  </main>;
}
