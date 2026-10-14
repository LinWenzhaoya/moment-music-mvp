import { useEffect, useState } from "react";
import type { Track } from "../../lib/music";
import { apiBase, Chips, formatDate, formatTime, Icon, MoodCover, PageHeader } from "./shared";

export type SongComment = { id: number; trackId: string | null; title: string; artist: string; body: string; mood: string | null;
  positionSeconds: number | null; context: string | null; createdAt: string };

export const commentMoods = ["有掌控感", "想哭", "被治愈", "很燃", "怀念", "平静"];

export function MoodTag({ mood }: { mood: string | null }) {
  if (!mood) return null;
  const index = commentMoods.indexOf(mood);
  return <span className={`mood-tag tone-${index >= 0 ? index : "x"}`}>{mood}</span>;
}

export function PlayerBar({ track, isPlaying, currentTime, duration, liked, disliked, commentCount, panelOpen, onToggle, onPrev, onNext, onSeek, onLike, onDislike, onOpenPanel }: {
  track: Track; isPlaying: boolean; currentTime: number; duration: number; liked: boolean; disliked: boolean; commentCount: number; panelOpen: boolean;
  onToggle: () => void; onPrev: () => void; onNext: () => void; onSeek: (seconds: number) => void; onLike: () => void; onDislike: () => void; onOpenPanel: () => void;
}) {
  const total = duration || track.duration || 0;
  return <footer className="player-bar">
    <div className="player-now">
      <MoodCover track={track} size={56} />
      <div className="player-text"><span className="player-title">{track.title}</span><span className="player-sub">{track.artist}<Chips items={track.chips} max={2} /></span></div>
      <button className={`icon-button ${liked ? "liked" : ""}`} onClick={onLike} aria-label={liked ? "取消收藏" : "收藏"} title={liked ? "取消收藏" : "收藏"}><Icon name="heart" size={20} filled={liked} /></button>
      <button className={`icon-button ${disliked ? "disliked" : ""}`} onClick={onDislike} aria-pressed={disliked}
        aria-label={disliked ? "撤销不喜欢" : "不喜欢，以后不再推荐"} title={disliked ? "撤销不喜欢" : "不喜欢：以后不再推荐，并跳到下一首"}><Icon name="dislike" size={19} /></button>
    </div>
    <div className="player-center">
      <div className="transport">
        <button className="icon-button" onClick={onPrev} aria-label="上一首"><Icon name="prev" /></button>
        <button className="play-circle" onClick={onToggle} aria-label={isPlaying ? "暂停" : "播放"}><Icon name={isPlaying ? "pause" : "play"} size={18} /></button>
        <button className="icon-button" onClick={onNext} aria-label="下一首"><Icon name="next" /></button>
      </div>
      <div className="progress">
        <span className="tabular">{formatTime(currentTime)}</span>
        <input type="range" min="0" max={total} step="0.1" value={Math.min(currentTime, total)} aria-label="播放进度"
          style={{ backgroundSize: `${total ? (Math.min(currentTime, total) / total) * 100 : 0}% 100%` }} onChange={(event) => onSeek(Number(event.target.value))} />
        <span className="tabular">{formatTime(total)}</span>
      </div>
    </div>
    <div className="player-side">
      <button className={`note-button ${panelOpen ? "on" : ""}`} onClick={onOpenPanel} aria-expanded={panelOpen}><Icon name="note" size={18} />记一笔{commentCount ? ` · ${commentCount}` : ""}</button>
    </div>
  </footer>;
}

// The right-hand "now playing" panel: the song, its tags, and what you wrote while listening to it.
// Mounted with key={track.id}, so the draft resets when the song changes.
export function NowPlayingPanel({ track, comments, context, currentTime, onClose, onSave, onDelete }: {
  track: Track; comments: SongComment[]; context: string; currentTime: number;
  onClose: () => void; onSave: (body: string, mood: string | null) => Promise<boolean>; onDelete: (comment: SongComment) => void;
}) {
  const [body, setBody] = useState("");
  const [mood, setMood] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  return <aside className="now-panel" aria-label="正在播放">
    <div className="now-panel-head"><span>正在播放</span><button className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" size={18} /></button></div>
    <MoodCover track={track} size="100%" radius={8} />
    <div className="now-title"><span className="now-name">{track.title}</span><span className="muted">{track.artist}{track.totalPlays ? ` · 播放 ${track.totalPlays} 次` : ""}</span></div>
    <Chips items={track.chips} max={4} />
    <form className="note-composer" onSubmit={async (event) => {
      event.preventDefault();
      if (!body.trim() || saving) return;
      setSaving(true);
      if (await onSave(body, mood)) { setBody(""); setMood(null); }
      setSaving(false);
    }}>
      <label htmlFor="note-body">此刻的感想</label>
      <textarea id="note-body" rows={3} value={body} onChange={(event) => setBody(event.target.value)} placeholder="今天听这首歌是什么心情？" />
      <div className="mood-picks">{commentMoods.map((item) => <button type="button" key={item} className={`mood-pick ${mood === item ? "on" : ""}`} onClick={() => setMood(mood === item ? null : item)}>{item}</button>)}</div>
      <div className="note-composer-foot"><span className="muted small">会记下时间、听到 {formatTime(currentTime)}{context ? `、「${context}」` : ""}</span>
        <button className="primary-button" type="submit" disabled={!body.trim() || saving}>{saving ? "保存中…" : "记下来"}</button></div>
    </form>
    <div className="note-list">
      <span className="note-list-head">这首歌下的 {comments.length} 条记录</span>
      {comments.map((comment) => <div className="note-item" key={comment.id}>
        <div className="note-item-meta"><MoodTag mood={comment.mood} /><span className="muted small">{formatDate(comment.createdAt)}{comment.positionSeconds != null ? ` · ${formatTime(comment.positionSeconds)}` : ""}</span>
          <button className="text-button" onClick={() => onDelete(comment)}>删除</button></div>
        <p>{comment.body}</p>
      </div>)}
    </div>
  </aside>;
}

export function JournalView({ tracksById, onPlay }: { tracksById: Map<string, Track>; onPlay: (track: Track) => void }) {
  const [comments, setComments] = useState<SongComment[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/api/comments?limit=500`).then((response) => response.json())
      .then((data) => { if (!cancelled) setComments(data.comments || []); })
      .catch(() => { if (!cancelled) setComments([]); });
    return () => { cancelled = true; };
  }, []);
  return <div className="page">
    <PageHeader eyebrow="听歌手记" title="你写下的每一刻" subtitle="在播放条点“记一笔”，写下听这首歌时的心情；这里按时间收着所有记录。" />
    {comments === null ? <div className="empty">正在读取…</div> : !comments.length ? <div className="empty">还没有记录。播放一首歌，点底部的“记一笔”试试。</div> :
      <div className="journal">{comments.map((comment) => {
        const track = comment.trackId ? tracksById.get(comment.trackId) : undefined;
        return <article className="journal-item" key={comment.id}>
          {track ? <button className="cover-button" onClick={() => onPlay(track)} aria-label={`播放 ${comment.title}`}><MoodCover track={track} size={52} /></button> : <MoodCover track={{ id: String(comment.id) }} size={52} />}
          <div className="journal-body">
            <div className="journal-meta"><b>{comment.title}</b><span className="muted">{comment.artist}</span><MoodTag mood={comment.mood} /><span className="muted small journal-when">{formatDate(comment.createdAt)}</span></div>
            <p>{comment.body}</p>
            <span className="muted small">{comment.context ? `在「${comment.context}」里` : "在曲库里播放"}{comment.positionSeconds != null ? ` · 听到 ${formatTime(comment.positionSeconds)}` : ""}</span>
          </div>
        </article>;
      })}</div>}
  </div>;
}
