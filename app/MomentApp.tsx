"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { demoTracks } from "../data/tracks";
import { type Mix, type RecommendedTrack, type Track } from "../lib/music";
import { EvalView, type EvalStatus } from "./moment/EvalView";
import { HistoryView, type PlayHistory } from "./moment/HistoryView";
import { HomeView } from "./moment/HomeView";
import { LibraryView } from "./moment/LibraryView";
import { mapMemories, type MemoryCategory, type MemoryRecord, MemoryView, type RequestMemory, type SongBlock } from "./moment/MemoryView";
import { type FeedbackDraft, FeedbackModal, type MemoryDraft, MemoryEditor, PlaylistPicker } from "./moment/Modals";
import { JournalView, NowPlayingPanel, PlayerBar, type SongComment } from "./moment/Player";
import { AiPlaylistsView, type SavedPlaylist, type UserPlaylist, UserPlaylistsView } from "./moment/PlaylistsViews";
import { type RecommendationPlan, PlaylistView } from "./moment/PlaylistView";
import type { RowHandlers } from "./moment/rows";
import { apiBase, Icon, type SongTags } from "./moment/shared";

type View = "home" | "ai_playlists" | "user_playlists" | "ai_detail" | "user_detail" | "library" | "history" | "journal" | "eval" | "memory";
type LibraryStatus = "connecting" | "ready" | "scanning" | "offline";

const nav: Array<{ view: View; label: string; icon: string; also?: View[] }> = [
  { view: "home", label: "首页", icon: "home" },
  { view: "ai_playlists", label: "AI 歌单", icon: "spark", also: ["ai_detail"] },
  { view: "user_playlists", label: "我的歌单", icon: "list", also: ["user_detail"] },
  { view: "library", label: "我的曲库", icon: "disc" },
  { view: "history", label: "播放历史", icon: "clock" },
  { view: "journal", label: "听歌手记", icon: "note" },
  { view: "memory", label: "音乐记忆", icon: "brain" },
  { view: "eval", label: "推荐评测", icon: "scale" },
];

const songKey = (track: Pick<Track, "title" | "artist">) => `${track.title}|${track.artist}`.toLowerCase().trim();
const greetingFor = (hour: number) => (hour < 5 ? "夜深了" : hour < 11 ? "早上好" : hour < 13 ? "中午好" : hour < 18 ? "下午好" : "晚上好");

export default function MomentApp() {
  const [view, setView] = useState<View>("home");
  const [prompt, setPrompt] = useState("");
  const [mix, setMix] = useState<Mix>({ familiar: 50, forgotten: 20, discover: 30 });
  const [mixMode, setMixMode] = useState<"auto" | "manual">("auto");
  const [trackCount, setTrackCount] = useState(10);
  const [tracks, setTracks] = useState<Track[]>(demoTracks);
  const [playlist, setPlaylist] = useState<RecommendedTrack[]>([]);
  const [playlistMeta, setPlaylistMeta] = useState<{ source: "ai" | "user"; id: number | null; title: string; summary: string; request?: string; plan: RecommendationPlan | null }>({ source: "ai", id: null, title: "此刻歌单", summary: "", plan: null });
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [recentRequests, setRecentRequests] = useState<RequestMemory[]>([]);
  const [savedPlaylists, setSavedPlaylists] = useState<SavedPlaylist[]>([]);
  const [userPlaylists, setUserPlaylists] = useState<UserPlaylist[]>([]);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [history, setHistory] = useState<PlayHistory | null>(null);
  const [evalStatus, setEvalStatus] = useState<EvalStatus | null>(null);
  const [evalFrameKey, setEvalFrameKey] = useState(0);
  const [openTagsId, setOpenTagsId] = useState<string | null>(null);
  const [tagCache, setTagCache] = useState<Record<string, SongTags | null>>({});
  const [pickerTrack, setPickerTrack] = useState<Track | null>(null);
  const [feedbackTrack, setFeedbackTrack] = useState<Track | null>(null);
  const [feedbackDraft, setFeedbackDraft] = useState<FeedbackDraft | null>(null);
  const [editingMemoryId, setEditingMemoryId] = useState<number | "new" | null>(null);
  const [memoryDraft, setMemoryDraft] = useState<MemoryDraft>({ statement: "", category: "taste", scope: "general", importance: 2, evidence: [] });
  const [isGenerating, setIsGenerating] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [libraryStatus, setLibraryStatus] = useState<LibraryStatus>("connecting");
  const [notice, setNotice] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [comments, setComments] = useState<SongComment[]>([]);
  const [greeting, setGreeting] = useState("你好");
  const audioRef = useRef<HTMLAudioElement>(null);

  const showNotice = useCallback((message: string, duration = 3000) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), duration);
  }, []);

  const loadLibrary = useCallback(async () => {
    try {
      const health = await (await fetch(`${apiBase}/api/health`)).json();
      setLibraryStatus(health.scan?.running ? "scanning" : "ready");
      const library = await (await fetch(`${apiBase}/api/tracks?limit=20000`)).json();
      if (Array.isArray(library.tracks) && library.tracks.length) setTracks(library.tracks);
    } catch { setLibraryStatus("offline"); }
  }, []);
  const loadMemories = useCallback(async () => {
    try {
      const value = await (await fetch(`${apiBase}/api/memories`)).json();
      if (Array.isArray(value.memories)) setMemories(mapMemories(value.memories));
      if (Array.isArray(value.recentRequests)) setRecentRequests(value.recentRequests);
    } catch { /* offline state is shown in the sidebar */ }
  }, []);
  const loadPlaylists = useCallback(async () => {
    try {
      const value = await (await fetch(`${apiBase}/api/playlists?limit=50`)).json();
      if (Array.isArray(value.playlists)) setSavedPlaylists(value.playlists);
    } catch { /* stays empty while offline */ }
  }, []);
  const loadUserPlaylists = useCallback(async () => {
    try {
      const value = await (await fetch(`${apiBase}/api/user-playlists`)).json();
      if (Array.isArray(value.playlists)) setUserPlaylists(value.playlists);
    } catch { /* stays empty while offline */ }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setGreeting(greetingFor(new Date().getHours()));
      loadLibrary(); loadMemories(); loadPlaylists(); loadUserPlaylists();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadLibrary, loadMemories, loadPlaylists, loadUserPlaylists]);

  // Each top-level page has an address (#library, #history…): links, reloads and the back button work.
  const routed = useRef(false);
  const [pendingPlaylistId, setPendingPlaylistId] = useState<number | null>(null);
  useEffect(() => {
    const fromHash = () => {
      const target = window.location.hash.slice(1);
      const playlistMatch = target.match(/^playlist-(\d+)$/);
      if (playlistMatch) setPendingPlaylistId(Number(playlistMatch[1]));
      else if (nav.some((item) => item.view === target)) setView(target as View);
      routed.current = true;
    };
    const timer = window.setTimeout(fromHash, 0);
    window.addEventListener("hashchange", fromHash);
    return () => { window.clearTimeout(timer); window.removeEventListener("hashchange", fromHash); };
  }, []);
  useEffect(() => {
    if (!routed.current) return; // read the address first, then start writing it
    const top = nav.find((item) => item.view === view || item.also?.includes(view));
    const hash = view === "ai_detail" && playlistMeta.source === "ai" && playlistMeta.id ? `#playlist-${playlistMeta.id}` : top ? `#${top.view}` : "";
    if (hash && window.location.hash !== hash) window.history.pushState(null, "", hash);
  }, [view, playlistMeta.source, playlistMeta.id]);

  useEffect(() => {
    if (pendingPlaylistId === null) return;
    const saved = savedPlaylists.find((item) => item.id === pendingPlaylistId);
    if (!saved) return;
    const timer = window.setTimeout(() => {
      setPendingPlaylistId(null);
      setPlaylist(saved.tracks);
      setPlaylistMeta({ source: "ai", id: saved.id, title: saved.title, summary: saved.summary, request: saved.request, plan: (saved.plan as RecommendationPlan) || null });
      setView("ai_detail");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pendingPlaylistId, savedPlaylists]);

  const tracksById = useMemo(() => new Map(tracks.map((track) => [track.id, track])), [tracks]);
  const currentTrack = (playingId && (tracksById.get(playingId) ?? playlist.find((track) => track.id === playingId))) || undefined;
  const favorites = useMemo(() => userPlaylists.find((item) => item.kind === "favorites")?.tracks || [], [userPlaylists]);
  const favoriteKeys = useMemo(() => new Set(favorites.map(songKey)), [favorites]);
  const isFavorite = useCallback((track: Track) => favoriteKeys.has(songKey(track)), [favoriteKeys]);
  const [blocks, setBlocks] = useState<SongBlock[]>([]);
  // Same key as the server's logicalTrackKey: artist \0 title, lowercased.
  const blockedKeys = useMemo(() => new Set(blocks.map((block) => block.song_key)), [blocks]);
  const isBlocked = useCallback((track: Pick<Track, "title" | "artist">) => blockedKeys.has(`${track.artist.trim().toLowerCase()}\u0000${track.title.trim().toLowerCase()}`), [blockedKeys]);
  useEffect(() => {
    fetch(`${apiBase}/api/blocks`).then((response) => response.json()).then((value) => { if (Array.isArray(value.blocks)) setBlocks(value.blocks); }).catch(() => undefined);
  }, []);
  const topTrack = useMemo(() => tracks.reduce<Track | undefined>((best, track) => ((track.totalPlays || 0) > (best?.totalPlays || 0) ? track : best), undefined), [tracks]);

  // Comments of the song that is playing (count on the player bar, list in the panel).
  useEffect(() => {
    if (!playingId?.startsWith("local-")) return;
    let cancelled = false;
    fetch(`${apiBase}/api/tracks/${playingId.replace("local-", "")}/comments`).then((response) => response.json())
      .then((data) => { if (!cancelled) setComments(data.comments || []); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [playingId]);

  useEffect(() => {
    if (view !== "eval") return;
    const refresh = async () => {
      try {
        const status = await (await fetch(`${apiBase}/api/eval/run`)).json() as EvalStatus;
        setEvalStatus((previous) => { if (previous?.running && !status.running) setEvalFrameKey((key) => key + 1); return status; });
      } catch { /* service offline */ }
    };
    const first = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, 10000);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [view]);

  const generate = async (override?: string, variation?: "refresh" | "shift") => {
    const text = (override ?? prompt).trim();
    if (isGenerating || !text) return;
    setIsGenerating(true);
    setNotice("正在理解此刻并挑选歌曲…");
    try {
      const response = await fetch(`${apiBase}/api/recommendations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: text, mix, mixMode, count: trackCount, ...(variation && playlistMeta.source === "ai" ? { variation, previousId: playlistMeta.id } : {}) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "生成失败");
      setPlaylist(result.tracks);
      setPlaylistMeta({ source: "ai", id: Number(result.id), title: result.title || "此刻歌单", summary: result.summary || "", request: text, plan: result.plan || null });
      setView("ai_detail");
      showNotice(`已从曲库选出 ${result.tracks.length} 首歌`);
      loadPlaylists(); loadMemories();
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "生成失败，请稍后重试", 4200);
    } finally { setIsGenerating(false); }
  };

  const reportListenEvent = (trackId: string, type: "complete" | "skip" | "partial", playedSeconds: number) => {
    fetch(`${apiBase}/api/tracks/${trackId.replace("local-", "")}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, playedSeconds }) }).catch(() => undefined);
  };

  const playTrack = async (track: Track) => {
    const audio = audioRef.current;
    if (!audio || !track.audioUrl) { showNotice(track.missing ? "这首歌的文件已不在曲库里" : track.audioUrl ? "播放器正在准备" : "这是演示数据，没有本地音频"); return; }
    if (playingId === track.id) { if (audio.paused) await audio.play().catch(() => undefined); else audio.pause(); return; }
    // Leaving a track before it ended: <30s counts as a skip, otherwise a partial listen.
    if (playingId && !audio.ended) reportListenEvent(playingId, audio.currentTime < 30 ? "skip" : "partial", audio.currentTime);
    audio.src = track.audioUrl;
    setPlayingId(track.id);
    setCurrentTime(0);
    fetch(`${apiBase}/api/tracks/${track.id.replace("local-", "")}/play`, { method: "POST" }).catch(() => undefined);
    try { await audio.play(); } catch (error) {
      // AbortError = this play() was superseded by a newer click: not a failure.
      const name = error instanceof DOMException ? error.name : "";
      if (name === "AbortError") return;
      showNotice(name === "NotAllowedError" ? "浏览器阻止了自动播放，请再点一次" : name === "NotSupportedError" ? "这首歌的音频读取失败（文件不存在或格式不支持）" : `播放失败：${name || "未知原因"}`, 4200);
    }
  };
  const step = (offset: number) => {
    if (!currentTrack) return;
    const queue = playlist.length ? playlist : tracks;
    const index = queue.findIndex((track) => track.id === currentTrack.id);
    // Skip songs marked 不喜欢 when moving through a queue.
    for (let hop = 1; hop <= queue.length; hop += 1) {
      const target = queue[(index + offset * hop + queue.length * hop) % queue.length];
      if (target && (target.id === currentTrack.id || !isBlocked(target))) { playTrack(target); return; }
    }
  };

  const toggleTags = async (track: Track) => {
    if (openTagsId === track.id) { setOpenTagsId(null); return; }
    setOpenTagsId(track.id);
    if (track.id in tagCache) return;
    try {
      const tags = await (await fetch(`${apiBase}/api/tracks/${track.id.replace("local-", "")}/tags`)).json() as SongTags;
      setTagCache((cache) => ({ ...cache, [track.id]: tags }));
    } catch { setTagCache((cache) => ({ ...cache, [track.id]: null })); }
  };
  const toggleBlock = async (track: Track) => {
    const blocked = isBlocked(track);
    try {
      const response = await fetch(`${apiBase}/api/tracks/${track.id.replace("local-", "")}/block`, { method: blocked ? "DELETE" : "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "操作失败");
      setBlocks(result.blocks);
      showNotice(blocked ? "已撤销不喜欢" : `以后不会再推荐《${track.title}》`);
      if (!blocked && currentTrack?.id === track.id) step(1);
    } catch (error) { showNotice(error instanceof Error ? error.message : "操作失败"); }
  };
  const unblock = async (block: SongBlock) => {
    const response = await fetch(`${apiBase}/api/blocks?key=${encodeURIComponent(block.song_key)}`, { method: "DELETE" });
    const result = await response.json();
    if (response.ok) { setBlocks(result.blocks); showNotice(`已撤销对《${block.title}》的不喜欢`); }
  };
  const toggleFavorite = async (track: Track) => {
    const liked = isFavorite(track);
    const response = await fetch(`${apiBase}/api/favorites/${track.id.replace("local-", "")}`, { method: liked ? "DELETE" : "PUT" });
    const result = await response.json();
    if (!response.ok) return showNotice(result.error || "收藏操作失败");
    if (Array.isArray(result.playlists)) setUserPlaylists(result.playlists);
    showNotice(liked ? "已取消收藏" : "已收藏到“我喜欢的音乐”");
  };
  const handlers: RowHandlers = {
    isFavorite, toggleFavorite, toggleTags, openTagsId,
    addToPlaylist: (track) => setPickerTrack(track),
    writeFeedback: (track) => { setFeedbackTrack(track); setFeedbackDraft({ trackId: track.id, value: "like", explanation: "" }); },
  };

  const saveFeedback = async () => {
    if (!feedbackTrack || !feedbackDraft) return;
    try {
      const response = await fetch(`${apiBase}/api/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trackId: feedbackTrack.id, value: feedbackDraft.value, explanation: feedbackDraft.explanation, scope: "long_term" }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "反馈保存失败");
      if (Array.isArray(result.memories)) setMemories(mapMemories(result.memories));
      if (Array.isArray(result.playlists)) setUserPlaylists(result.playlists);
      showNotice(feedbackDraft.explanation.trim() ? "反馈和原因已保存，后续推荐会参考" : feedbackDraft.value === "like" ? "已收藏到我喜欢的音乐" : "已记录不喜欢");
      setFeedbackTrack(null); setFeedbackDraft(null);
    } catch (error) { showNotice(error instanceof Error ? error.message : "反馈保存失败"); }
  };
  const addToPlaylist = async (playlistId: number) => {
    if (!pickerTrack) return;
    const response = await fetch(`${apiBase}/api/user-playlists/${playlistId}/tracks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trackId: pickerTrack.id }) });
    const result = await response.json();
    if (!response.ok) return showNotice(result.error || "加入歌单失败");
    if (Array.isArray(result.playlists)) setUserPlaylists(result.playlists);
    setPickerTrack(null);
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
  const openMemoryEditor = (memory?: MemoryRecord, category: MemoryCategory = "taste") => {
    setMemoryDraft(memory
      ? { statement: memory.statement, category: memory.category, scope: memory.scope, importance: Math.min(3, Math.max(1, Math.abs(memory.weight))), evidence: memory.evidence }
      : { statement: "", category, scope: category === "context" ? "未命名场景" : "general", importance: 2, evidence: [] });
    setEditingMemoryId(memory ? memory.id : "new");
  };
  const saveMemory = async () => {
    if (!memoryDraft.statement.trim() || editingMemoryId === null) return;
    const response = await fetch(`${apiBase}/api/memories${editingMemoryId === "new" ? "" : `/${editingMemoryId}`}`, {
      method: editingMemoryId === "new" ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...memoryDraft, status: "confirmed" }),
    });
    const result = await response.json();
    if (!response.ok) return showNotice(result.error || "偏好保存失败");
    if (Array.isArray(result.memories)) setMemories(mapMemories(result.memories));
    setEditingMemoryId(null);
    showNotice("偏好已保存");
  };
  const deleteMemory = async (memory: MemoryRecord) => {
    const response = await fetch(`${apiBase}/api/memories/${memory.id}`, { method: "DELETE" });
    if (response.ok) setMemories((current) => current.filter((item) => item.id !== memory.id));
  };

  const openSavedPlaylist = (saved: SavedPlaylist) => {
    setPlaylist(saved.tracks);
    setPlaylistMeta({ source: "ai", id: saved.id, title: saved.title, summary: saved.summary, request: saved.request, plan: (saved.plan as RecommendationPlan) || null });
    setView("ai_detail");
  };
  const openUserPlaylist = (saved: UserPlaylist) => {
    setPlaylist(saved.tracks.map((track) => ({ ...track, score: 0, reason: saved.kind === "favorites" ? "你收藏的歌。" : `你加入了“${saved.name}”。`, evidence: [] })));
    setPlaylistMeta({ source: "user", id: saved.id, title: saved.name, summary: saved.kind === "favorites" ? "点 ♥ 的歌都在这里，也是推荐时最明确的口味信号。" : "你自己整理的歌单。", plan: null });
    setView("user_detail");
  };
  const removeFromPlaylist = async (track: Track) => {
    if (!playlistMeta.id) return;
    const response = playlistMeta.source === "ai"
      ? await fetch(`${apiBase}/api/playlists/${playlistMeta.id}/tracks/${track.id.replace("local-", "")}`, { method: "DELETE" })
      : await fetch(`${apiBase}/api/user-playlists/${playlistMeta.id}/tracks`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trackId: track.id }) });
    const result = await response.json();
    if (!response.ok) return showNotice(result.error || "移除失败");
    setPlaylist((current) => current.filter((item) => item.id !== track.id));
    if (playlistMeta.source === "ai") { if (Array.isArray(result.playlists)) setSavedPlaylists(result.playlists); else loadPlaylists(); }
    else if (Array.isArray(result.playlists)) setUserPlaylists(result.playlists);
    showNotice("已从歌单移除");
  };
  const deleteAiPlaylist = async (saved: SavedPlaylist) => {
    if (!window.confirm(`删除 AI 歌单“${saved.title}”？不会删除曲库歌曲。`)) return;
    const result = await (await fetch(`${apiBase}/api/playlists/${saved.id}`, { method: "DELETE" })).json();
    if (Array.isArray(result.playlists)) setSavedPlaylists(result.playlists);
  };
  const deleteUserPlaylist = async (saved: UserPlaylist) => {
    if (saved.kind === "favorites" || !window.confirm(`删除歌单“${saved.name}”？不会删除曲库歌曲。`)) return;
    const result = await (await fetch(`${apiBase}/api/user-playlists/${saved.id}`, { method: "DELETE" })).json();
    if (Array.isArray(result.playlists)) setUserPlaylists(result.playlists);
  };
  // History is (re)loaded whenever the page is shown or refreshed.
  const [historyNonce, setHistoryNonce] = useState(0);
  useEffect(() => {
    if (view !== "history") return;
    let cancelled = false;
    fetch(`${apiBase}/api/history`).then((response) => response.json())
      .then((data) => { if (!cancelled) setHistory(data as PlayHistory); }).catch(() => { if (!cancelled) showNotice("读取播放历史失败"); });
    return () => { cancelled = true; };
  }, [view, historyNonce, showNotice]);
  const rescanLibrary = async () => {
    setLibraryStatus("scanning");
    await fetch(`${apiBase}/api/library/scan`, { method: "POST" });
    window.setTimeout(loadLibrary, 1200);
  };
  const startEvalRound = async () => {
    if (!window.confirm("用 20 条测试需求重新跑一轮盲测？约 10–15 分钟，会调用推荐模型。")) return;
    await fetch(`${apiBase}/api/eval/run`, { method: "POST" });
    setEvalStatus({ running: true, done: 0 });
    showNotice("新一轮评测已开始，完成后会自动刷新");
  };
  const saveComment = async (body: string, mood: string | null) => {
    if (!currentTrack) return false;
    const context = playlist.some((track) => track.id === currentTrack.id) ? playlistMeta.title : "";
    const response = await fetch(`${apiBase}/api/tracks/${currentTrack.id.replace("local-", "")}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body, mood, positionSeconds: audioRef.current?.currentTime ?? currentTime, context, recommendationId: playlistMeta.source === "ai" ? playlistMeta.id : null }),
    });
    const result = await response.json();
    if (!response.ok) { showNotice(result.error || "保存失败"); return false; }
    setComments((current) => [result.comment, ...current]);
    showNotice("已记下");
    return true;
  };
  const deleteComment = async (comment: SongComment) => {
    if (!window.confirm("删除这条记录？")) return;
    const response = await fetch(`${apiBase}/api/comments/${comment.id}`, { method: "DELETE" });
    if (response.ok) setComments((current) => current.filter((item) => item.id !== comment.id));
  };

  const goTo = (target: View) => setView(target);
  const statusText = libraryStatus === "ready" ? `曲库就绪 · ${tracks.length.toLocaleString()} 首` : libraryStatus === "scanning" ? "正在扫描曲库…" : libraryStatus === "offline" ? "本地音乐服务未启动" : "正在连接曲库…";

  return <div className={`app ${currentTrack ? "has-player" : ""} ${panelOpen && currentTrack ? "with-panel" : ""}`}>
    <aside className="sidebar">
      <button className="brand" onClick={() => setView("home")}><span className="brand-dot" />Moment</button>
      <nav aria-label="主导航">
        {nav.map((item) => <button key={item.view} className={`nav-item ${view === item.view || item.also?.includes(view) ? "active" : ""}`} onClick={() => goTo(item.view)}>
          <Icon name={item.icon} size={20} />{item.label}</button>)}
      </nav>
      <div className={`sidebar-status ${libraryStatus}`}><span className="status-dot" />{statusText}</div>
    </aside>

    <main className={`main ${view === "ai_detail" || view === "user_detail" ? "flush" : ""}`}>
      {view === "home" && <HomeView greeting={greeting} prompt={prompt} setPrompt={setPrompt} generate={generate} isGenerating={isGenerating}
        trackCount={trackCount} setTrackCount={setTrackCount} mix={mix} setMix={setMix} mixMode={mixMode} setMixMode={setMixMode}
        lastRequest={recentRequests.find((item) => item.status === "succeeded")?.request} topTrack={topTrack} />}
      {(view === "ai_detail" || view === "user_detail") && <PlaylistView source={playlistMeta.source} title={playlistMeta.title} summary={playlistMeta.summary} request={playlistMeta.request}
        plan={playlistMeta.plan} tracks={playlist} playingId={playingId} isPlaying={isPlaying} isGenerating={isGenerating}
        onPlay={playTrack} onBack={() => setView(playlistMeta.source === "ai" ? "ai_playlists" : "user_playlists")}
        onRegenerate={(variation) => generate(playlistMeta.request, variation)} onRemove={removeFromPlaylist} handlers={handlers} tagCache={tagCache} />}
      {view === "ai_playlists" && <AiPlaylistsView playlists={savedPlaylists} onOpen={openSavedPlaylist} onDelete={deleteAiPlaylist} onNew={() => { setPrompt(""); setView("home"); }} />}
      {view === "user_playlists" && <UserPlaylistsView playlists={userPlaylists} onOpen={openUserPlaylist} onDelete={deleteUserPlaylist} newName={newPlaylistName} setNewName={setNewPlaylistName} onCreate={createUserPlaylist} />}
      {view === "library" && <LibraryView tracks={tracks} playingId={playingId} isPlaying={isPlaying} onPlay={playTrack} handlers={handlers} tagCache={tagCache} onRescan={rescanLibrary} scanning={libraryStatus === "scanning"} />}
      {view === "history" && <HistoryView history={history} onRefresh={() => setHistoryNonce((value) => value + 1)} tracksById={tracksById} playingId={playingId} isPlaying={isPlaying} onPlay={playTrack} handlers={handlers} tagCache={tagCache} />}
      {view === "journal" && <JournalView tracksById={tracksById} onPlay={playTrack} />}
      {view === "memory" && <MemoryView memories={memories} recentRequests={recentRequests} favoriteTracks={favorites} blocks={blocks} onUnblock={unblock} onNew={(category) => openMemoryEditor(undefined, category)} onEdit={(memory) => openMemoryEditor(memory)} onDelete={deleteMemory} onPlay={playTrack} />}
      {view === "eval" && <EvalView status={evalStatus} onStart={startEvalRound} reloadKey={evalFrameKey} tracksById={tracksById}
        playingId={playingId} isPlaying={isPlaying} onPlay={playTrack} handlers={handlers} />}
    </main>

    {panelOpen && currentTrack && <NowPlayingPanel key={currentTrack.id} track={currentTrack} comments={comments} currentTime={currentTime}
      context={playlist.some((track) => track.id === currentTrack.id) ? playlistMeta.title : ""} onClose={() => setPanelOpen(false)} onSave={saveComment} onDelete={deleteComment} />}

    {/* Music has no captions to offer. */}
    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
    <audio ref={audioRef} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
      onDurationChange={(event) => setAudioDuration(event.currentTarget.duration)} onEnded={(event) => { if (playingId) reportListenEvent(playingId, "complete", event.currentTarget.duration); step(1); }} />
    {currentTrack && <PlayerBar track={currentTrack} isPlaying={isPlaying} currentTime={currentTime} duration={audioDuration} liked={isFavorite(currentTrack)} disliked={isBlocked(currentTrack)} onDislike={() => toggleBlock(currentTrack)}
      commentCount={comments.length} panelOpen={panelOpen} onToggle={() => playTrack(currentTrack)} onPrev={() => step(-1)} onNext={() => step(1)}
      onSeek={(seconds) => { if (audioRef.current) audioRef.current.currentTime = seconds; }} onLike={() => toggleFavorite(currentTrack)} onOpenPanel={() => setPanelOpen((open) => !open)} />}

    {pickerTrack && <PlaylistPicker track={pickerTrack} playlists={userPlaylists} onPick={addToPlaylist} onClose={() => setPickerTrack(null)} />}
    {feedbackTrack && feedbackDraft && <FeedbackModal track={feedbackTrack} draft={feedbackDraft} setDraft={setFeedbackDraft} onSave={saveFeedback} onClose={() => { setFeedbackTrack(null); setFeedbackDraft(null); }} />}
    {editingMemoryId !== null && <MemoryEditor isNew={editingMemoryId === "new"} draft={memoryDraft} setDraft={(update) => setMemoryDraft(update)} tracks={tracks} onSave={saveMemory} onClose={() => setEditingMemoryId(null)} />}
    {notice && <div className="toast" role="status">{notice}</div>}
  </div>;
}
