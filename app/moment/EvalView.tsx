import { useCallback, useEffect, useRef, useState } from "react";
import type { Track } from "../../lib/music";
import type { RowHandlers } from "./rows";
import { apiBase, Icon, KindBadge, MoodCover, PageHeader, type SongTags } from "./shared";

type RunTrack = { id: number; title: string; artist: string; kind: Track["kind"]; reason: string };
type RunQuery = { id: string; type: string; text: string; error?: string; sides?: Record<"A" | "B", { mix?: { familiar: number; forgotten: number; discover: number; reason?: string }; tracks: RunTrack[] }> };
type Run = { runId?: string; queries: RunQuery[]; ratings: Array<{ query_id: string; side: string; track_id: number; score: number }>; preferences: Array<{ query_id: string; preferred: string; note: string | null }> };
type TagSample = { fields: string[]; reviews: Array<{ track_id: number; field: string; verdict: string; note: string | null }>; songs: Array<{ id: number; title: string; artist: string; plays: number; tags: SongTags }> };
export type EvalStatus = { running: boolean; startedAt?: string; finishedAt?: string | null; exitCode?: number | null; done?: number; progress?: string };

const post = (path: string, body: unknown) => fetch(`${apiBase}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// A note saves itself while you type (debounced) and when the field loses focus.
function NoteField({ initial, placeholder, onSave }: { initial: string; placeholder: string; onSave: (note: string) => Promise<unknown> }) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(false);
  const timer = useRef<number | null>(null);
  const flush = (next: string) => { if (timer.current) window.clearTimeout(timer.current); timer.current = null; onSave(next).then(() => { setSaved(true); window.setTimeout(() => setSaved(false), 1500); }); };
  return <span className="note-field">
    <input value={value} placeholder={placeholder} aria-label={placeholder}
      onChange={(event) => { const next = event.target.value; setValue(next); if (timer.current) window.clearTimeout(timer.current); timer.current = window.setTimeout(() => flush(next), 700); }}
      onBlur={() => { if (timer.current) flush(value); }} />
    {saved && <span className="muted small">已保存</span>}
  </span>;
}

const fieldLabel: Record<string, string> = { language_vocal: "语言 · 人声 · 节奏", genre: "曲风", mood: "听感情绪", lyricTheme: "歌词主题", scene: "适合的处境", description: "综合描述" };
function fieldValue(field: string, tags: SongTags) {
  if (field === "language_vocal") return `${tags.language || "?"} · ${tags.vocalPresence || "?"} · ${tags.vocalType || "?"} · ${tags.tempo || "?"}速${tags.bpm ? `（约 ${Math.round(tags.bpm)} BPM）` : ""}`;
  if (field === "genre") return `${tags.genre?.primary || ""}${tags.genre?.sub?.length ? ` / ${tags.genre.sub.join("、")}` : ""} · ${tags.genre?.era || ""} ${tags.genre?.region || ""}`;
  if (field === "mood") return `${(tags.mood || []).join("、")}（正负 ${tags.valence ?? "?"} · 激烈 ${tags.arousal ?? "?"}）`;
  if (field === "lyricTheme") return tags.lyricTheme?.length ? tags.lyricTheme.join("、") : "无歌词 / 未识别";
  if (field === "scene") return (tags.scene || []).join(" / ");
  return tags.description || "";
}

export function EvalView({ status, onStart, reloadKey, tracksById, playingId, isPlaying, onPlay, handlers }: {
  status: EvalStatus | null; onStart: () => void; reloadKey: number; tracksById: Map<string, Track>;
  playingId: string | null; isPlaying: boolean; onPlay: (track: Track) => void; handlers: RowHandlers;
}) {
  const [tab, setTab] = useState<"blind" | "tags">("blind");
  const [run, setRun] = useState<Run | null>(null);
  const [sample, setSample] = useState<TagSample | null>(null);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [prefs, setPrefs] = useState<Record<string, string>>({});
  const [verdicts, setVerdicts] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/api/eval/latest`).then((response) => response.json()).then((data: Run) => {
      if (cancelled) return;
      setRun(data);
      setScores(Object.fromEntries((data.ratings || []).map((r) => [`${r.query_id}|${r.side}|${r.track_id}`, r.score])));
      setPrefs(Object.fromEntries((data.preferences || []).filter((p) => p.preferred).map((p) => [p.query_id, p.preferred])));
    }).catch(() => undefined);
    fetch(`${apiBase}/api/eval/tag-sample`).then((response) => response.json()).then((data: TagSample) => {
      if (cancelled) return;
      setSample(data);
      setVerdicts(Object.fromEntries(data.reviews.filter((r) => r.verdict).map((r) => [`${r.track_id}|${r.field}`, r.verdict])));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [reloadKey]);

  const score = useCallback((queryId: string, side: string, trackId: number, value: number) => {
    setScores((current) => ({ ...current, [`${queryId}|${side}|${trackId}`]: value }));
    post("/api/eval/ratings", { runId: run?.runId, queryId, side, trackId, score: value });
  }, [run?.runId]);
  const prefer = (queryId: string, preferred: string) => { setPrefs((current) => ({ ...current, [queryId]: preferred })); post("/api/eval/preference", { runId: run?.runId, queryId, preferred }); };
  const verdict = (trackId: number, field: string, value: string) => { setVerdicts((current) => ({ ...current, [`${trackId}|${field}`]: value })); post("/api/eval/tag-review", { trackId, field, verdict: value }); };

  const queries = run?.queries || [];
  const totalSongs = queries.reduce((sum, q) => sum + (q.sides ? q.sides.A.tracks.length + q.sides.B.tracks.length : 0), 0);
  const notes = Object.fromEntries((run?.preferences || []).map((p) => [p.query_id, p.note || ""]));
  const tagNotes = Object.fromEntries((sample?.reviews || []).map((r) => [`${r.track_id}|${r.field}`, r.note || ""]));

  return <div className="page">
    <PageHeader eyebrow="推荐评测" title="盲测与标签抽查"
      subtitle="同一批真实需求生成 A/B 两份歌单（检索方式隐藏），逐首打分、选边、写备注；结果长期保存，用来判断每次改动是变好还是变差。"
      actions={<button className="primary-button" onClick={onStart} disabled={Boolean(status?.running)}><Icon name="play" size={14} />{status?.running ? `评测进行中 · ${status.done || 0}/20` : "跑一轮新评测"}</button>} />
    {status?.running && <p className="muted note">正在生成：{status.progress || "准备中…"}</p>}
    <div className="filter-row eval-tabs">
      <button className={`filter-chip ${tab === "blind" ? "on" : ""}`} onClick={() => setTab("blind")}>推荐盲测</button>
      <button className={`filter-chip ${tab === "tags" ? "on" : ""}`} onClick={() => setTab("tags")}>标签抽查</button>
      <span className="muted filter-count">{tab === "blind" ? `已打分 ${Object.keys(scores).length}/${totalSongs} 首 · 已选边 ${Object.keys(prefs).length}/${queries.length} 条` : `已标 ${Object.keys(verdicts).length}/${(sample?.songs.length || 0) * (sample?.fields.length || 0)} 项`}</span>
    </div>

    {tab === "blind" && <>
      <p className="muted note">每首打分：2 很合适 · 1 还行 · 0 不合适；再选整体哪份更好。点封面用底部播放条试听。</p>
      {!queries.length && <div className="empty">还没有评测结果，点右上角“跑一轮新评测”。</div>}
      {queries.map((query) => query.error || !query.sides ? <div className="panel-block" key={query.id}><h3>{query.text}</h3><p className="muted">运行失败：{query.error}</p></div> :
        <section className="panel-block eval-query" key={query.id}>
          <div className="section-head"><h2>{query.text}</h2><span className="chips"><span>{query.type}</span></span></div>
          {query.sides.A.mix && <p className="muted small">比例：熟悉 {query.sides.A.mix.familiar}% · 旧爱 {query.sides.A.mix.forgotten}% · 新歌 {query.sides.A.mix.discover}%{query.sides.A.mix.reason ? `（${query.sides.A.mix.reason}）` : ""}</p>}
          <div className="eval-sides">
            {(["A", "B"] as const).map((side) => <div key={side} className="eval-side">
              <h3>歌单 {side}</h3>
              {query.sides![side].tracks.map((item) => {
                const track = tracksById.get(`local-${item.id}`);
                const key = `${query.id}|${side}|${item.id}`;
                const active = Boolean(track && playingId === track.id);
                return <div className={`eval-song ${active ? "active" : ""}`} key={item.id}>
                  <button className="cover-button" onClick={() => track && onPlay(track)} aria-label={`播放 ${item.title}`}>
                    <MoodCover track={track || { id: String(item.id) }} size={40}><span className={`cover-overlay ${active ? "show" : ""}`}><Icon name={active && isPlaying ? "pause" : "play"} size={14} /></span></MoodCover>
                  </button>
                  <div className="eval-song-text">
                    <span className="track-title">{item.title}</span>
                    <span className="track-sub">{item.artist} <KindBadge kind={item.kind} /></span>
                    <span className="reason" title={item.reason}>{item.reason}</span>
                  </div>
                  <div className="eval-song-actions">
                    {track && <button className={`icon-button ${handlers.isFavorite(track) ? "liked" : ""}`} onClick={() => handlers.toggleFavorite(track)} aria-label="收藏"><Icon name="heart" size={16} filled={handlers.isFavorite(track)} /></button>}
                    <span className="score-group" role="group" aria-label={`给 ${item.title} 打分`}>
                      {[2, 1, 0].map((value) => <button key={value} className={`score s${value} ${scores[key] === value ? "on" : ""}`} onClick={() => score(query.id, side, item.id, value)}>{value}</button>)}
                    </span>
                  </div>
                </div>;
              })}
            </div>)}
          </div>
          <div className="eval-pref">
            <span>整体哪份更好？</span>
            <div className="segmented">{[["A", "A 更好"], ["same", "差不多"], ["B", "B 更好"]].map(([value, label]) => <button key={value} className={prefs[query.id] === value ? "on" : ""} onClick={() => prefer(query.id, value)}>{label}</button>)}</div>
            <NoteField key={`${run?.runId}-${query.id}`} initial={notes[query.id] || ""} placeholder="备注（可选）：哪首明显不对、缺了什么" onSave={(note) => post("/api/eval/preference", { runId: run?.runId, queryId: query.id, note })} />
          </div>
        </section>)}
    </>}

    {tab === "tags" && sample && <>
      <p className="muted note">这些是你播放最多、已打标签的歌。每一项选：✓ 对 · ✗ 不对 · ⚠ 胡编（明显不是这首歌的内容）。</p>
      {sample.songs.map((song) => {
        const track = tracksById.get(`local-${song.id}`);
        return <section className="panel-block" key={song.id}>
          <div className="section-head">
            <button className="cover-button" onClick={() => track && onPlay(track)} aria-label={`播放 ${song.title}`}><MoodCover track={track || { id: String(song.id) }} size={44} /></button>
            <h2>{song.title}</h2><span>{song.artist} · 播放 {song.plays} 次</span>
          </div>
          {sample.fields.map((field) => {
            const key = `${song.id}|${field}`;
            return <div className="tag-review-row" key={field}>
              <b>{fieldLabel[field] || field}</b>
              <div><p>{fieldValue(field, song.tags)}</p>
                <NoteField key={`${key}-note`} initial={tagNotes[key] || ""} placeholder="备注（可选）" onSave={(note) => post("/api/eval/tag-review", { trackId: song.id, field, note })} /></div>
              <span className="score-group">{[["ok", "✓"], ["wrong", "✗"], ["made_up", "⚠"]].map(([value, label]) => <button key={value} className={`score v-${value} ${verdicts[key] === value ? "on" : ""}`} onClick={() => verdict(song.id, field, value)} aria-label={value === "ok" ? "对" : value === "wrong" ? "不对" : "胡编"}>{label}</button>)}</span>
            </div>;
          })}
        </section>;
      })}
    </>}
  </div>;
}
