import type { Track } from "../../lib/music";
import { Chips, Icon, MoodCover } from "./shared";

// Cover (doubles as the play button) + title / artist / chips: the left half of every song row.
export function TrackCell({ track, active, playing, onPlay, showChips = true, note }: {
  track: Track; active: boolean; playing: boolean; onPlay: () => void; showChips?: boolean; note?: string;
}) {
  return <div className={`track-cell ${track.missing ? "missing" : ""}`}>
    <button className="cover-button" onClick={onPlay} aria-label={track.missing ? `${track.title}（文件已不在曲库）` : active && playing ? `暂停 ${track.title}` : `播放 ${track.title}`}>
      <MoodCover track={track} size={44}><span className={`cover-overlay ${active ? "show" : ""}`}><Icon name={active && playing ? "pause" : "play"} size={16} /></span></MoodCover>
    </button>
    <div className="track-text">
      <span className={`track-title ${active ? "active" : ""}`}>{track.title}</span>
      <span className="track-sub">{track.artist}{note ? ` · ${note}` : ""}{track.missing ? <span className="missing-note">文件已不在曲库</span> : showChips && <Chips items={track.chips} />}</span>
    </div>
  </div>;
}

export type RowHandlers = {
  isFavorite: (track: Track) => boolean;
  toggleFavorite: (track: Track) => void;
  addToPlaylist: (track: Track) => void;
  writeFeedback: (track: Track) => void;
  toggleTags: (track: Track) => void;
  openTagsId: string | null;
};

export function RowActions({ track, handlers, onRemove }: { track: Track; handlers: RowHandlers; onRemove?: () => void }) {
  const liked = handlers.isFavorite(track);
  const tagsOpen = handlers.openTagsId === track.id;
  return <div className="row-actions">
    <button className={`icon-button ${liked ? "liked" : ""}`} onClick={() => handlers.toggleFavorite(track)} aria-label={liked ? "取消收藏" : "收藏"} title={liked ? "取消收藏" : "收藏"}><Icon name="heart" size={18} filled={liked} /></button>
    <button className="icon-button" onClick={() => handlers.addToPlaylist(track)} aria-label="加入歌单" title="加入歌单"><Icon name="plus" size={18} /></button>
    <button className="icon-button" onClick={() => handlers.writeFeedback(track)} aria-label="写反馈" title="写反馈"><Icon name="edit" size={17} /></button>
    <button className={`icon-button ${tagsOpen ? "on" : ""}`} onClick={() => handlers.toggleTags(track)} aria-label={tagsOpen ? "收起标签" : "展开标签"} title="音频标签"><Icon name={tagsOpen ? "chevronUp" : "chevronDown"} size={18} /></button>
    {onRemove && <button className="icon-button" onClick={onRemove} aria-label="从歌单移除" title="从歌单移除"><Icon name="trash" size={17} /></button>}
  </div>;
}
