import { useState } from "react";
import type { Track } from "../../lib/music";
import { RowActions, type RowHandlers, TrackCell } from "./rows";
import { Icon, MoodCover, PageHeader, type SongTags, TagPanel } from "./shared";

export type HistorySong = { trackId: number | null; title: string; artist: string; plays: number; lastPlayedAt: string; sources: string[] };
export type HistorySectionKey = "recent" | "week" | "today" | "month" | "year" | "allTime";
export type PlayHistory = { totalPlays: number; latestBySource: Record<string, string | null>; counts: { allSongs: number }; sections: Record<HistorySectionKey, HistorySong[]> };

const sections: Array<{ key: HistorySectionKey; label: string; note: string }> = [
  { key: "recent", label: "最近播放", note: "最近听过的歌，按最后一次播放时间倒序（最多 500 首）" },
  { key: "week", label: "近一周", note: "最近 7 天听过的歌，按最后一次播放时间倒序（最多 500 首）" },
  { key: "today", label: "今天", note: "今天听过的歌，按播放次数倒序（最多 500 首）" },
  { key: "month", label: "本月", note: "这个月听过的歌，按播放次数倒序（最多 500 首）" },
  { key: "year", label: "今年", note: "今年听过的歌，按播放次数倒序（最多 500 首）" },
  { key: "allTime", label: "全部", note: "所有历史播放，按总播放次数倒序（最多 500 首）" },
];
const formatPlayedAt = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

export function HistoryView({ history, onRefresh, tracksById, playingId, isPlaying, onPlay, handlers, tagCache }: {
  history: PlayHistory | null; onRefresh: () => void; tracksById: Map<string, Track>;
  playingId: string | null; isPlaying: boolean; onPlay: (track: Track) => void; handlers: RowHandlers; tagCache: Record<string, SongTags | null>;
}) {
  const [section, setSection] = useState<HistorySectionKey>("recent");
  const current = sections.find((item) => item.key === section) || sections[0];
  const songs = history?.sections[section] || [];
  return <div className="page">
    <PageHeader eyebrow="播放历史" title={history ? `${history.totalPlays.toLocaleString()} 次播放` : "正在读取…"}
      subtitle={history ? `共 ${history.counts.allSongs.toLocaleString()} 首歌 · YouTube 记录截至 ${history.latestBySource.youtube ? formatPlayedAt(history.latestBySource.youtube) : "无"}，之后的播放来自本应用` : undefined}
      actions={<button className="ghost-button" onClick={onRefresh}><Icon name="refresh" size={16} />刷新</button>} />
    <div className="filter-row">
      {sections.map((item) => <button key={item.key} className={`filter-chip ${section === item.key ? "on" : ""}`} onClick={() => setSection(item.key)}>{item.label}<small>{history?.sections[item.key]?.length ?? ""}</small></button>)}
    </div>
    <p className="muted note">{current.note}</p>
    <div className="song-table history-table">
      <div className="song-table-head"><span>#</span><span>歌曲</span><span>次数</span><span>最后播放</span><span /></div>
      {!songs.length && <div className="empty">{history ? "这段时间没有播放记录" : "正在读取…"}</div>}
      {songs.map((song, index) => {
        const track = song.trackId ? tracksById.get(`local-${song.trackId}`) : undefined;
        const active = Boolean(track && playingId === track.id);
        return <div className={`song-row-wrap ${active ? "active" : ""}`} key={`${song.trackId ?? song.title}-${index}`}>
          <div className="song-row">
            <span className="row-index">{index + 1}</span>
            {track ? <TrackCell track={track} active={active} playing={isPlaying} onPlay={() => onPlay(track)} />
              : <div className="track-cell"><MoodCover track={{ id: song.title }} size={44} /><div className="track-text"><span className="track-title">{song.title}</span><span className="track-sub">{song.artist} · 曲库中没有</span></div></div>}
            <span className="tabular">{song.plays} 次</span>
            <span className="muted tabular">{formatPlayedAt(song.lastPlayedAt)}</span>
            {track ? <RowActions track={track} handlers={handlers} /> : <span />}
          </div>
          {track && handlers.openTagsId === track.id && <TagPanel tags={tagCache[track.id]} />}
        </div>;
      })}
    </div>
  </div>;
}
