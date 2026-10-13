import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Track } from "../../lib/music";
import type { MemoryCategory } from "./MemoryView";
import type { UserPlaylist } from "./PlaylistsViews";
import { Icon } from "./shared";

// Native <dialog>: Escape and the close button dismiss it, focus stays inside while open.
function Modal({ title, eyebrow, onClose, children, wide }: { title: string; eyebrow: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; if (dialog && !dialog.open) dialog.showModal(); }, []);
  return <dialog ref={ref} className={`modal ${wide ? "wide" : ""}`} onClose={onClose} aria-label={title}>
    <div className="modal-head"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" size={18} /></button></div>
    {children}
  </dialog>;
}

export function PlaylistPicker({ track, playlists, onPick, onClose }: { track: Track; playlists: UserPlaylist[]; onPick: (playlistId: number) => void; onClose: () => void }) {
  return <Modal eyebrow="加入歌单" title={track.title} onClose={onClose}>
    <div className="picker-list">{playlists.map((playlist) => <button key={playlist.id} onClick={() => onPick(playlist.id)}>
      <Icon name={playlist.kind === "favorites" ? "heart" : "list"} size={18} filled={playlist.kind === "favorites"} />
      <span><b>{playlist.name}</b><span className="muted small">{playlist.trackCount} 首</span></span><Icon name="plus" size={18} />
    </button>)}</div>
  </Modal>;
}

export type FeedbackDraft = { trackId: string; value: "like" | "dislike"; explanation: string };

export function FeedbackModal({ track, draft, setDraft, onSave, onClose }: { track: Track; draft: FeedbackDraft; setDraft: (draft: FeedbackDraft) => void; onSave: () => void; onClose: () => void }) {
  return <Modal eyebrow="歌曲反馈" title={track.title} onClose={onClose}>
    <p className="muted">{track.artist} · 原因可以不写；写下的具体原因会成为长期推荐记忆。</p>
    <div className="segmented">
      <button className={draft.value === "like" ? "on" : ""} onClick={() => setDraft({ ...draft, value: "like" })}>喜欢</button>
      <button className={draft.value === "dislike" ? "on" : ""} onClick={() => setDraft({ ...draft, value: "dislike" })}>不喜欢</button>
    </div>
    <label className="field"><span>具体原因（可选）</span>
      <textarea value={draft.explanation} onChange={(event) => setDraft({ ...draft, explanation: event.target.value })} rows={4}
        placeholder={draft.value === "like" ? "例如：前奏克制，鼓点逐渐进入。" : "例如：副歌人声太满。"} /></label>
    <div className="modal-foot"><button className="primary-button" onClick={onSave}>保存反馈</button></div>
  </Modal>;
}

export type MemoryDraft = { statement: string; category: MemoryCategory; scope: string; importance: number; evidence: Array<{ trackId?: string; title?: string }> };

export function MemoryEditor({ isNew, draft, setDraft, tracks, onSave, onClose }: {
  isNew: boolean; draft: MemoryDraft; setDraft: (update: (draft: MemoryDraft) => MemoryDraft) => void; tracks: Track[]; onSave: () => void; onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const text = query.trim().toLowerCase();
  const results = text ? tracks.filter((track) => !draft.evidence.some((item) => item.trackId === track.id) && `${track.title} ${track.artist}`.toLowerCase().includes(text)).slice(0, 5) : [];
  return <Modal eyebrow={isNew ? "添加偏好" : "修改偏好"} title={isNew ? "保存一条音乐偏好" : "调整这条音乐偏好"} onClose={onClose} wide>
    <p className="muted">建议描述推荐条件，例如“偏好副歌有明显释放感”。</p>
    <div className="form-grid">
      <label className="field"><span>类型</span>
        <select value={draft.category} onChange={(event) => { const category = event.target.value as MemoryCategory; setDraft((current) => ({ ...current, category, scope: category === "context" && current.scope === "general" ? "未命名场景" : category !== "context" ? "general" : current.scope })); }}>
          <option value="taste">长期偏好</option><option value="context">场景设置</option><option value="boundary">明确边界</option><option value="reference">音乐参照</option>
        </select></label>
      <label className="field"><span>重要程度</span>
        <select value={draft.importance} onChange={(event) => setDraft((current) => ({ ...current, importance: Number(event.target.value) }))}><option value="1">一般</option><option value="2">常用</option><option value="3">核心</option></select></label>
      {draft.category === "context" && <label className="field wide"><span>场景名称</span><input value={draft.scope} onChange={(event) => setDraft((current) => ({ ...current, scope: event.target.value }))} placeholder="例如：开车、深夜、想振作时" /></label>}
      <label className="field wide"><span>偏好内容</span><textarea rows={3} value={draft.statement} onChange={(event) => setDraft((current) => ({ ...current, statement: event.target.value }))}
        placeholder={draft.category === "boundary" ? "例如：避免仅靠高响度制造冲击的歌曲" : "例如：偏好旋律鲜明、副歌具有释放感的歌曲"} /></label>
      <div className="field wide"><span>代表歌曲（可选）</span>
        {draft.evidence.length > 0 && <div className="chips clickable">{draft.evidence.map((item, index) => <button key={`${item.trackId}-${index}`} onClick={() => setDraft((current) => ({ ...current, evidence: current.evidence.filter((_, i) => i !== index) }))}>{item.title} ×</button>)}</div>}
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索曲库中的歌名或歌手" aria-label="搜索代表歌曲" />
        {results.length > 0 && <div className="picker-list compact">{results.map((track) => <button key={track.id} onClick={() => { setDraft((current) => ({ ...current, evidence: [...current.evidence, { trackId: track.id, title: `${track.title} · ${track.artist}` }].slice(0, 10) })); setQuery(""); }}>
          <span><b>{track.title}</b><span className="muted small">{track.artist}</span></span><Icon name="plus" size={16} /></button>)}</div>}
      </div>
    </div>
    <div className="modal-foot"><button className="primary-button" onClick={onSave} disabled={!draft.statement.trim()}>保存偏好</button></div>
  </Modal>;
}
