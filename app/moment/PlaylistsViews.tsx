import type { RecommendedTrack, Track } from "../../lib/music";
import { formatDate, Icon, MoodCover, PageHeader } from "./shared";

export type SavedPlaylist = { id: number; title: string; summary: string; request: string; createdAt: string; tracks: RecommendedTrack[]; plan?: unknown };
export type UserPlaylist = { id: number; name: string; kind: "favorites" | "custom"; trackCount: number; createdAt: string; updatedAt: string; tracks: Track[] };

function Collage({ tracks }: { tracks: Track[] }) {
  return <span className="collage small">
    {[0, 1, 2, 3].map((index) => tracks[index] ? <MoodCover key={index} track={tracks[index]} size="100%" radius={0} /> : <span key={index} className="collage-empty" />)}
  </span>;
}

export function AiPlaylistsView({ playlists, onOpen, onDelete, onNew }: {
  playlists: SavedPlaylist[]; onOpen: (playlist: SavedPlaylist) => void; onDelete: (playlist: SavedPlaylist) => void; onNew: () => void;
}) {
  return <div className="page">
    <PageHeader eyebrow="AI 歌单" title="每一次此刻" subtitle="每次生成的歌单都保存在这里，连同当时的那句话和逐首理由。"
      actions={<button className="primary-button" onClick={onNew}><Icon name="plus" size={16} />生成新歌单</button>} />
    {playlists.length === 0 ? <div className="empty">还没有 AI 生成的歌单，去首页点一张心情卡片试试。</div> :
      <div className="card-grid">
        {playlists.map((playlist) => <article className="playlist-row-card" key={playlist.id}>
          <button className="playlist-row-main" onClick={() => onOpen(playlist)}>
            <Collage tracks={playlist.tracks} />
            <span className="playlist-row-text">
              <span className="playlist-card-title">{playlist.title}</span>
              <span className="playlist-card-sub">{formatDate(playlist.createdAt)} · {playlist.tracks.length} 首</span>
              <span className="playlist-card-request">「{playlist.request}」</span>
              <span className="playlist-card-songs">{playlist.tracks.slice(0, 4).map((track) => track.title).join(" · ")}</span>
            </span>
          </button>
          <button className="icon-button card-delete" onClick={() => onDelete(playlist)} aria-label={`删除 ${playlist.title}`} title="删除"><Icon name="trash" size={16} /></button>
        </article>)}
      </div>}
  </div>;
}

export function UserPlaylistsView({ playlists, onOpen, onDelete, newName, setNewName, onCreate }: {
  playlists: UserPlaylist[]; onOpen: (playlist: UserPlaylist) => void; onDelete: (playlist: UserPlaylist) => void;
  newName: string; setNewName: (value: string) => void; onCreate: () => void;
}) {
  const favorites = playlists.find((playlist) => playlist.kind === "favorites");
  const custom = playlists.filter((playlist) => playlist.kind === "custom");
  return <div className="page">
    <PageHeader eyebrow="我的歌单" title="你收藏和整理的音乐" subtitle="“我喜欢的音乐”是默认收藏，点 ♥ 的歌都会进来；自定义歌单按你的方式整理。" />
    {favorites && <button className="favorites-banner" onClick={() => onOpen(favorites)}>
      <span className="favorites-art"><Icon name="heart" size={40} filled /></span>
      <span className="favorites-text"><span className="eyebrow">默认收藏</span><span className="favorites-title">{favorites.name}</span><span className="muted">{favorites.trackCount} 首 · {favorites.tracks.slice(0, 4).map((track) => track.title).join("、")}</span></span>
      <span className="play-fab small" aria-hidden="true"><Icon name="play" size={18} /></span>
    </button>}
    <div className="section-head"><h2>自定义歌单</h2></div>
    <form className="new-playlist" onSubmit={(event) => { event.preventDefault(); onCreate(); }}>
      <label htmlFor="new-playlist-name" className="visually-hidden">新歌单名称</label>
      <input id="new-playlist-name" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="新歌单名称，例如：深夜开车" />
      <button className="primary-button" type="submit" disabled={!newName.trim()}><Icon name="plus" size={16} />创建</button>
    </form>
    <div className="card-grid">
      {custom.map((playlist) => <article className="playlist-row-card" key={playlist.id}>
        <button className="playlist-row-main" onClick={() => onOpen(playlist)}>
          <Collage tracks={playlist.tracks} />
          <span className="playlist-row-text">
            <span className="playlist-card-title">{playlist.name}</span>
            <span className="playlist-card-sub">{playlist.trackCount} 首</span>
            <span className="playlist-card-songs">{playlist.tracks.slice(0, 4).map((track) => track.title).join(" · ")}</span>
          </span>
        </button>
        <button className="icon-button card-delete" onClick={() => onDelete(playlist)} aria-label={`删除 ${playlist.name}`} title="删除"><Icon name="trash" size={16} /></button>
      </article>)}
      {!custom.length && <div className="empty">还没有自定义歌单。</div>}
    </div>
  </div>;
}
