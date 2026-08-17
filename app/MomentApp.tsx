"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { demoTracks } from "../data/tracks";
import { normalizeMix, parseIntent, recommend, type Mix, type Preference, type RecommendedTrack, type Track, type TrackKind } from "../lib/music";

type View = "create" | "playlist" | "library" | "memory";
type Feedback = { trackId: string; value: "like" | "dislike"; reason: string };

const defaultPrompt = "今天心情不错，想听有明显鼓点但不太吵的音乐，少一点人声。";
const initialPreferences: Preference[] = [
  { tag: "鼓点", weight: 2, reason: "你在不同流派中都经常完整播放强鼓点歌曲" },
  { tag: "渐进", weight: 1, reason: "你更容易收藏层次逐渐增加的编曲" },
  { tag: "专注", weight: 1, reason: "工作时你倾向于选择少人声的音乐" },
];

const kindLabel: Record<TrackKind, string> = { familiar: "近期熟悉", forgotten: "遗忘旧爱", discover: "新鲜探索" };
const quickPrompts = [
  ["☕", "工作", "今天要专注工作，想听节奏稳定、少人声、不太吵的音乐。"],
  ["☀", "愉快", "今天心情很好，想听明亮愉快、有推进感的电子音乐。"],
  ["♩", "强鼓点", "我想听鼓点明显、律动强的音乐，但不要太多人声。"],
  ["☾", "深夜", "深夜了，想听空灵、层次缓慢增加的音乐。"],
];

function Cover({ track, index, active, onPlay }: { track: Track; index: number; active?: boolean; onPlay?: () => void }) {
  return <div className={`cover ${track.color} ${active ? "playing" : ""}`}><span>{String(index + 1).padStart(2, "0")}</span><button onClick={onPlay} aria-label={`${active ? "暂停" : "播放"} ${track.title}`}>{active ? "Ⅱ" : "▶"}</button></div>;
}

function MixControl({ mix, onChange }: { mix: Mix; onChange: (mix: Mix) => void }) {
  return <div className="mix-control">
    <div className="mix-bar" aria-label="熟悉度分布"><div className="familiar" style={{ width: `${mix.familiar}%` }} /><div className="forgotten" style={{ width: `${mix.forgotten}%` }} /><div className="discover" style={{ width: `${mix.discover}%` }} /></div>
    <div className="legend">
      <label><span><i className="familiar-dot" /> 近期熟悉 <b>{mix.familiar}%</b></span><input aria-label="近期熟悉比例" type="range" min="10" max="80" step="10" value={mix.familiar} onChange={(event) => onChange(normalizeMix(Number(event.target.value), mix.forgotten))} /></label>
      <label><span><i className="forgotten-dot" /> 遗忘旧爱 <b>{mix.forgotten}%</b></span><input aria-label="遗忘旧爱比例" type="range" min="10" max="50" step="10" value={mix.forgotten} onChange={(event) => onChange(normalizeMix(mix.familiar, Number(event.target.value)))} /></label>
      <span className="discover-label"><i className="discover-dot" /> 新鲜探索 <b>{mix.discover}%</b></span>
    </div>
  </div>;
}

export default function MomentApp() {
  const [view, setView] = useState<View>("create");
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [mix, setMix] = useState<Mix>({ familiar: 50, forgotten: 20, discover: 30 });
  const [tracks, setTracks] = useState<Track[]>(demoTracks);
  const [playlist, setPlaylist] = useState<RecommendedTrack[]>([]);
  const [preferences, setPreferences] = useState<Preference[]>(initialPreferences);
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("moment-state");
      if (stored) {
        const value = JSON.parse(stored);
        if (Array.isArray(value.preferences)) setPreferences(value.preferences);
        if (Array.isArray(value.feedback)) setFeedback(value.feedback);
        if (Array.isArray(value.importedTracks)) setTracks([...demoTracks, ...value.importedTracks]);
      }
    } catch { /* ignore invalid local state */ }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    localStorage.setItem("moment-state", JSON.stringify({ preferences, feedback, importedTracks: tracks.filter((track) => track.id.startsWith("imported-")) }));
  }, [preferences, feedback, tracks, ready]);

  const intent = useMemo(() => parseIntent(prompt), [prompt]);
  const importedCount = tracks.filter((track) => track.id.startsWith("imported-")).length;
  const generate = () => {
    const result = recommend(tracks, prompt, mix, 10, preferences);
    setPlaylist(result.tracks);
    setView("playlist");
    setNotice(`已按 ${mix.familiar}% / ${mix.forgotten}% / ${mix.discover}% 生成 10 首歌`);
    window.setTimeout(() => setNotice(""), 2600);
  };

  const updateFeedback = (track: RecommendedTrack, value: "like" | "dislike", reason: string) => {
    setFeedback((current) => [...current.filter((item) => item.trackId !== track.id), { trackId: track.id, value, reason }]);
    const learnedTag = reason || track.tags[0];
    setPreferences((current) => {
      const found = current.find((item) => item.tag === learnedTag);
      const delta = value === "like" ? 1 : -1;
      if (found) return current.map((item) => item.tag === learnedTag ? { ...item, weight: Math.max(-3, Math.min(3, item.weight + delta)), reason: `来自你对《${track.title}》的反馈` } : item);
      return [...current, { tag: learnedTag, weight: delta, reason: `来自你对《${track.title}》的反馈` }];
    });
    setNotice("已记住这次反馈，下次生成会调整");
    window.setTimeout(() => setNotice(""), 2400);
  };

  const importCsv = async (file?: File) => {
    if (!file) return;
    const text = await file.text();
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const firstIsHeader = lines[0]?.toLowerCase().includes("title");
    const imported: Track[] = lines.slice(firstIsHeader ? 1 : 0).map((line, index) => {
      const [title, artist = "未知艺人", genre = "Imported", tags = ""] = line.split(",").map((item) => item.trim());
      return { id: `imported-${Date.now()}-${index}`, title, artist, genre, kind: "familiar", energy: 60, vocal: 45, tags: tags.split(/[|;/]/).filter(Boolean), instruments: [], color: ["green", "orange", "violet", "blue"][index % 4] };
    }).filter((track) => track.title);
    setTracks((current) => [...current, ...imported]);
    setNotice(`已导入 ${imported.length} 首歌`);
    window.setTimeout(() => setNotice(""), 2400);
  };

  return <main className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => setView("create")}><span className="brand-dot" /> moment</button>
      <nav aria-label="主导航">
        <button className={`nav-item ${view === "create" || view === "playlist" ? "active" : ""}`} onClick={() => setView("create")}><span>◐</span> 此刻歌单</button>
        <button className={`nav-item ${view === "library" ? "active" : ""}`} onClick={() => setView("library")}><span>♬</span> 我的曲库</button>
        <button className={`nav-item ${view === "memory" ? "active" : ""}`} onClick={() => setView("memory")}><span>✧</span> 音乐记忆</button>
      </nav>
      <div className="sidebar-foot"><p>已理解你的 <strong>{preferences.filter((item) => item.weight !== 0).length}</strong> 个偏好</p><div className="memory-line"><i style={{ width: `${Math.min(100, 38 + feedback.length * 9)}%` }} /></div><span>{feedback.length ? `已学习 ${feedback.length} 次主动反馈` : "给歌曲反馈，让我更懂你"}</span></div>
    </aside>

    <section className="content">
      <header className="topbar"><div className="status"><span /> 演示曲库已就绪 · {tracks.length} 首{importedCount ? ` · 导入 ${importedCount} 首` : ""}</div><button className="avatar" aria-label="本地用户">L</button></header>

      {view === "create" && <>
        <div className="hero">
          <p className="eyebrow">此刻歌单</p><h1>你此刻想听什么？</h1>
          <p className="subtitle">说说现在的心情、场景，或你想保留的声音特征。</p>
          <div className="prompt-card">
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} aria-label="描述此刻的听歌需求" />
            <div className="parsed-intent"><span>已理解</span><b>能量 {intent.energy}</b><b>人声 {intent.vocal}</b>{intent.tags.map((tag) => <b key={tag}>{tag}</b>)}</div>
            <div className="prompt-actions"><div className="quick-tags">{quickPrompts.map(([icon, label, value]) => <button key={label} onClick={() => setPrompt(value)}>{icon} {label}</button>)}</div><button className="generate-button" onClick={generate} disabled={!prompt.trim()}>生成此刻歌单 <span>→</span></button></div>
          </div>
          <div className="mix-section"><div className="section-heading"><div><h2>这次想要多熟悉？</h2><p>拖动比例，控制安心感和探索成本。</p></div><span className="track-count">10 首 · 约 42 分钟</span></div><MixControl mix={mix} onChange={setMix} /></div>
        </div>
        <section className="recent"><div className="section-heading"><div><p className="eyebrow">最近的声音</p><h2>我记得你喜欢这些</h2></div><button className="text-button" onClick={() => setView("memory")}>查看音乐记忆 →</button></div><div className="track-grid">{tracks.filter((track) => track.kind === "familiar").slice(0, 3).map((track, index) => <article className="track-card" key={track.id}><Cover track={track} index={index} active={playingId === track.id} onPlay={() => setPlayingId(playingId === track.id ? null : track.id)} /><div><h3>{track.title}</h3><p>{track.artist}</p><span className="track-tag">{track.tags[0]}</span></div></article>)}</div></section>
      </>}

      {view === "playlist" && <section className="page playlist-page">
        <button className="back" onClick={() => setView("create")}>← 调整需求</button>
        <div className="playlist-head"><div><p className="eyebrow">为此刻生成</p><h1>鼓点开始工作</h1><p className="subtitle">根据你的表达和 {preferences.length} 条音乐记忆，在熟悉和新鲜之间找到平衡。</p></div><div className="playlist-actions"><button className="secondary" onClick={generate}>↻ 换一批</button><button className="play-all" onClick={() => setPlayingId(playlist[0]?.id ?? null)}>▶ 播放全部</button></div></div>
        <div className="playlist-summary"><div><strong>{playlist.length}</strong><span>首歌</span></div><div><strong>{mix.familiar}%</strong><span>近期熟悉</span></div><div><strong>{mix.forgotten}%</strong><span>遗忘旧爱</span></div><div><strong>{mix.discover}%</strong><span>新鲜探索</span></div></div>
        <div className="queue">{playlist.map((track, index) => { const currentFeedback = feedback.find((item) => item.trackId === track.id); return <article className={`queue-row ${playingId === track.id ? "is-playing" : ""}`} key={track.id}><Cover track={track} index={index} active={playingId === track.id} onPlay={() => setPlayingId(playingId === track.id ? null : track.id)} /><div className="track-main"><div className="track-title-line"><h3>{track.title}</h3><span className={`kind ${track.kind}`}>{kindLabel[track.kind]}</span></div><p>{track.artist} · {track.genre}</p><div className="tags">{track.tags.slice(0,3).map((tag) => <span key={tag}>{tag}</span>)}</div></div><p className="reason">{track.reason}</p><div className="feedback"><button className={currentFeedback?.value === "like" ? "chosen" : ""} onClick={() => updateFeedback(track, "like", track.tags[0])} title="喜欢这首">♡</button><button className={currentFeedback?.value === "dislike" ? "chosen dislike" : ""} onClick={() => updateFeedback(track, "dislike", track.tags[0])} title="不符合此刻">×</button></div></article>})}</div>
      </section>}

      {view === "library" && <section className="page"><div className="page-title"><div><p className="eyebrow">我的曲库</p><h1>你的音乐世界</h1><p className="subtitle">导入收藏后，Moment 会从其中召回遗忘的旧爱。</p></div><button className="generate-button" onClick={() => fileRef.current?.click()}>＋ 导入 CSV</button><input ref={fileRef} hidden type="file" accept=".csv,text/csv" onChange={(event) => importCsv(event.target.files?.[0])} /></div><div className="import-help"><strong>CSV 格式</strong><code>title,artist,genre,tags</code><span>标签可用 | 分隔，例如：鼓点|电子|专注</span></div><div className="library-table"><div className="table-head"><span>歌曲</span><span>类型</span><span>声音特征</span><span>能量</span></div>{tracks.map((track, index) => <div className="table-row" key={track.id}><div className="song-cell"><span className={`mini-cover ${track.color}`}>{index + 1}</span><div><strong>{track.title}</strong><small>{track.artist}</small></div></div><span className={`kind ${track.kind}`}>{kindLabel[track.kind]}</span><div className="tags">{track.tags.slice(0,2).map((tag) => <span key={tag}>{tag}</span>)}</div><div className="energy"><i style={{ width: `${track.energy}%` }} /><b>{track.energy}</b></div></div>)}</div></section>}

      {view === "memory" && <section className="page"><div className="page-title"><div><p className="eyebrow">音乐记忆</p><h1>我是这样理解你的</h1><p className="subtitle">这些偏好会影响下一次选曲；你可以随时修正或删除。</p></div></div><div className="memory-grid">{preferences.filter((item) => item.weight !== 0).sort((a,b) => b.weight - a.weight).map((preference) => <article className={`memory-card ${preference.weight < 0 ? "negative" : ""}`} key={preference.tag}><div className="memory-card-top"><span className="memory-icon">{preference.weight > 0 ? "✦" : "−"}</span><button aria-label={`删除 ${preference.tag} 偏好`} onClick={() => setPreferences((current) => current.filter((item) => item.tag !== preference.tag))}>×</button></div><h3>{preference.weight > 0 ? "你喜欢" : "你倾向跳过"}「{preference.tag}」</h3><p>{preference.reason}</p><div className="weight">{Array.from({length:3}).map((_, index) => <i className={index < Math.abs(preference.weight) ? "filled" : ""} key={index} />)}<span>{Math.abs(preference.weight) >= 2 ? "强偏好" : "正在学习"}</span></div></article>)}</div>{feedback.length > 0 && <div className="learning-log"><div><h2>最近学到的</h2><p>来自你对歌曲的主动反馈</p></div><strong>{feedback.length} 次</strong></div>}</section>}
    </section>
    {notice && <div className="toast">✓ {notice}</div>}
  </main>;
}
