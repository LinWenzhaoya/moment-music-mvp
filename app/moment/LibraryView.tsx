import { useMemo, useState } from "react";
import type { Track } from "../../lib/music";
import { RowActions, type RowHandlers, TrackCell } from "./rows";
import { Icon, KindBadge, PageHeader, type SongTags, TagPanel } from "./shared";

const filters = [
  { key: "all", label: "全部", test: () => true },
  { key: "liked", label: "收藏", test: () => true },
  { key: "国语", label: "国语", test: (track: Track) => track.language === "国语" },
  { key: "粤语", label: "粤语", test: (track: Track) => track.language === "粤语" },
  { key: "英语", label: "英语", test: (track: Track) => track.language === "英语" },
  { key: "韩语", label: "韩语", test: (track: Track) => track.language === "韩语" },
  { key: "日语", label: "日语", test: (track: Track) => track.language === "日语" },
  { key: "纯音乐", label: "纯音乐", test: (track: Track) => Boolean(track.instrumental) },
  { key: "new", label: "没听过", test: (track: Track) => track.kind === "library" },
] as const;

const PAGE = 200;

type Props = {
  tracks: Track[]; playingId: string | null; isPlaying: boolean; onPlay: (track: Track) => void;
  handlers: RowHandlers; tagCache: Record<string, SongTags | null>;
  onRescan: () => void; scanning: boolean;
};

export function LibraryView({ tracks, playingId, isPlaying, onPlay, handlers, tagCache, onRescan, scanning }: Props) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"plays" | "favorites" | "artist">("plays");
  const [filter, setFilter] = useState<(typeof filters)[number]["key"]>("all");
  const [limit, setLimit] = useState(PAGE);
  const visible = useMemo(() => {
    const text = query.trim().toLowerCase();
    const rule = filters.find((item) => item.key === filter) || filters[0];
    let list = tracks.filter((track) => (filter === "liked" ? handlers.isFavorite(track) : rule.test(track))
      && (!text || `${track.title} ${track.artist} ${track.album || ""} ${(track.chips || []).join(" ")}`.toLowerCase().includes(text)));
    if (sort !== "artist") {
      const liked = (track: Track) => (handlers.isFavorite(track) ? 1 : 0);
      list = [...list].sort((left, right) => (sort === "favorites" ? liked(right) - liked(left) : 0) || (right.totalPlays || 0) - (left.totalPlays || 0));
    }
    return list;
  }, [tracks, query, sort, filter, handlers]);
  const likedCount = tracks.filter((track) => handlers.isFavorite(track)).length;

  return <div className="page">
    <PageHeader eyebrow="我的曲库" title={`${tracks.length.toLocaleString()} 首`}
      subtitle={`收藏 ${likedCount} 首 · 近期熟悉 ${tracks.filter((track) => track.kind === "familiar").length} 首 · 没听过 ${tracks.filter((track) => track.kind === "library").length} 首`}
      actions={<>
        <label className="search-field"><Icon name="search" size={16} /><span className="visually-hidden">搜索曲库</span>
          <input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(PAGE); }} placeholder="搜索歌名、歌手、情绪" /></label>
        <label className="select-field">排序
          <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="plays">播放次数</option><option value="favorites">收藏优先</option><option value="artist">按歌手</option></select></label>
        <button className="ghost-button" onClick={onRescan} disabled={scanning}><Icon name="refresh" size={16} />{scanning ? "扫描中…" : "重新扫描"}</button>
      </>} />
    <div className="filter-row">
      {filters.map((item) => <button key={item.key} className={`filter-chip ${filter === item.key ? "on" : ""}`} onClick={() => { setFilter(item.key); setLimit(PAGE); }}>{item.label}</button>)}
      <span className="muted filter-count">{visible.length.toLocaleString()} 首</span>
    </div>
    <div className="song-table library-table">
      <div className="song-table-head"><span>#</span><span>歌曲</span><span>播放</span><span>熟悉度</span><span /></div>
      {visible.slice(0, limit).map((track, index) => {
        const active = playingId === track.id;
        return <div className={`song-row-wrap ${active ? "active" : ""}`} key={track.id}>
          <div className="song-row">
            <span className={`row-index ${active ? "active" : ""}`}>{index + 1}</span>
            <TrackCell track={track} active={active} playing={isPlaying} onPlay={() => onPlay(track)} />
            <span className="muted tabular">{track.totalPlays ? `${track.totalPlays} 次` : "—"}</span>
            <KindBadge kind={track.kind} />
            <RowActions track={track} handlers={handlers} />
          </div>
          {handlers.openTagsId === track.id && <TagPanel tags={tagCache[track.id]} />}
        </div>;
      })}
      {visible.length > limit && <button className="ghost-button load-more" onClick={() => setLimit((value) => value + PAGE)}>再显示 {Math.min(PAGE, visible.length - limit)} 首</button>}
      {!visible.length && <div className="empty">没有符合条件的歌。</div>}
    </div>
  </div>;
}
