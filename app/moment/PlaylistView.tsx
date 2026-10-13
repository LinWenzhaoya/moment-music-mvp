import { useState } from "react";
import type { RecommendedTrack, Track } from "../../lib/music";
import { RowActions, type RowHandlers, TrackCell } from "./rows";
import { formatTime, Icon, KindBadge, MoodCover, moodColors, type SongTags, TagPanel } from "./shared";

export type RecommendationPlan = { intentSummary?: string; hardArtists?: string[]; excludedArtists?: string[]; softPreferences?: string[]; mustAvoid?: string[];
  hardFilters?: Record<string, string[] | number[] | null>; mix?: { familiar: number; forgotten: number; discover: number; source: string; reason: string } };

type Props = {
  source: "ai" | "user"; title: string; summary: string; request?: string; plan: RecommendationPlan | null;
  tracks: RecommendedTrack[]; playingId: string | null; isPlaying: boolean; isGenerating: boolean;
  onPlay: (track: Track) => void; onBack: () => void; onRegenerate: () => void; onRemove: (track: Track) => void;
  handlers: RowHandlers; tagCache: Record<string, SongTags | null>;
};

export function PlaylistView(props: Props) {
  const [showTrace, setShowTrace] = useState(false);
  const { tracks, plan } = props;
  const counts = { familiar: 0, forgotten: 0, library: 0 } as Record<string, number>;
  for (const track of tracks) counts[track.kind === "discover" ? "library" : track.kind] = (counts[track.kind === "discover" ? "library" : track.kind] || 0) + 1;
  const total = Math.max(1, tracks.length);
  const scored = tracks.filter((track) => track.valence != null && track.arousal != null);
  const average = (key: "valence" | "arousal") => (scored.length ? scored.reduce((sum, track) => sum + Number(track[key]), 0) / scored.length : null);
  const band = moodColors(average("valence"), average("arousal"));
  const minutes = Math.round(tracks.reduce((sum, track) => sum + (track.duration || 0), 0) / 60);
  const hardFilters = Object.entries(plan?.hardFilters || {}).filter(([, value]) => Array.isArray(value) && value.length)
    .map(([key, value]) => `${key}：${(value as Array<string | number>).join(" / ")}`);

  return <div className="playlist-page">
    <header className="playlist-hero" style={{ background: `linear-gradient(180deg, ${band.base} 0%, ${band.base} 55%, var(--panel) 100%)` }}>
      <button className="back-link" onClick={props.onBack}><Icon name="back" size={16} />{props.source === "ai" ? "AI 歌单" : "我的歌单"}</button>
      <div className="playlist-hero-body">
        <div className="collage">{[0, 1, 2, 3].map((index) => tracks[index] ? <MoodCover key={index} track={tracks[index]} size="100%" radius={0} /> : <span key={index} className="collage-empty" />)}</div>
        <div className="playlist-hero-text">
          <span className="eyebrow light">{props.source === "ai" ? "AI 歌单" : "我的歌单"}{props.request ? ` · 「${props.request.length > 24 ? `${props.request.slice(0, 24)}…` : props.request}」` : ""}</span>
          <h1>{props.title}</h1>
          <p>{props.summary}</p>
          {props.source === "ai" && <div className="mix-summary">
            <div className="mix-bar-track">
              <span className="familiar" style={{ width: `${(counts.familiar / total) * 100}%` }} />
              <span className="forgotten" style={{ width: `${(counts.forgotten / total) * 100}%` }} />
              <span className="library" style={{ width: `${(counts.library / total) * 100}%` }} />
            </div>
            <div className="mix-legend"><span className="familiar">熟悉 {counts.familiar} 首</span><span className="forgotten">遗忘旧爱 {counts.forgotten} 首</span><span className="library">没听过 {counts.library} 首</span>
              {plan?.mix?.reason && <span className="mix-reason">{plan.mix.reason}</span>}</div>
          </div>}
        </div>
      </div>
    </header>

    <div className="playlist-toolbar">
      <button className="play-fab" onClick={() => tracks[0] && props.onPlay(tracks[0])} aria-label="播放全部"><Icon name="play" size={24} /></button>
      {props.source === "ai" && <button className="ghost-button" onClick={props.onRegenerate} disabled={props.isGenerating}><Icon name="refresh" size={16} />{props.isGenerating ? "正在生成" : "换一批"}</button>}
      {props.source === "ai" && <button className={`ghost-button ${showTrace ? "on" : ""}`} onClick={() => setShowTrace((open) => !open)}>推荐链路</button>}
      <span className="muted toolbar-meta">{tracks.length} 首 · 约 {minutes} 分钟</span>
    </div>

    {showTrace && <div className="trace">
      <div className="trace-step"><b>1 · 理解需求</b><p>{plan?.intentSummary || "把这句话拆成硬条件、软偏好和新旧比例。"}</p>
        <div className="chips">{[...hardFilters.map((item) => `硬条件 ${item}`), ...(plan?.softPreferences || []), ...(plan?.mustAvoid || []).map((item) => `排除 ${item}`)].slice(0, 10).map((item) => <span key={item}>{item}</span>)}</div></div>
      <div className="trace-step"><b>2 · 召回与打分</b><p>按标签严格过滤，用原话做向量检索并按熟悉度分层取候选，再按 0.7 × 需求匹配 + 0.3 × 你的口味 排序。</p></div>
      <div className="trace-step"><b>3 · 精选与配额</b><p>大模型分批查看每首歌的完整音频标签，选出真正合适的，最后按新旧比例配齐。</p></div>
    </div>}

    <div className="song-table playlist-table">
      <div className="song-table-head"><span>#</span><span>歌曲</span><span>为什么推荐</span><span>熟悉度</span><span className="right">时长</span><span /></div>
      {tracks.map((track, index) => {
        const active = props.playingId === track.id;
        return <div className={`song-row-wrap ${active ? "active" : ""}`} key={track.id}>
          <div className="song-row">
            <span className={`row-index ${active ? "active" : ""}`}>{index + 1}</span>
            <TrackCell track={track} active={active} playing={props.isPlaying} onPlay={() => props.onPlay(track)} />
            <span className="reason" title={track.reason}>{track.reason}</span>
            <KindBadge kind={track.kind} />
            <span className="right muted tabular">{formatTime(track.duration)}</span>
            <RowActions track={track} handlers={props.handlers} onRemove={() => props.onRemove(track)} />
          </div>
          {props.handlers.openTagsId === track.id && <TagPanel tags={props.tagCache[track.id]} />}
        </div>;
      })}
    </div>
  </div>;
}
