import type { Track } from "../../lib/music";
import { formatDate, Icon, PageHeader } from "./shared";

export type MemoryCategory = "taste" | "context" | "boundary" | "anchor" | "reference";
export type MemoryRecord = { id: number; statement: string; scope: string; polarity: number; weight: number; confidence: number;
  evidence: Array<{ trackId?: string; title?: string }>; evidenceCount: number; reason: string; source: string; category: MemoryCategory;
  status: "pending" | "confirmed"; updatedAt: string };
export type RequestMemory = { id: number; request: string; requestedCount: number; status: "pending" | "succeeded" | "failed"; createdAt: string; title?: string };

const categoryLabel: Record<MemoryCategory, string> = { taste: "长期偏好", context: "场景设置", boundary: "明确边界", anchor: "歌手锚点", reference: "歌曲参照" };
const importanceLabel: Record<number, string> = { 1: "一般", 2: "常用", 3: "核心" };

export function mapMemories(rows: Array<Record<string, unknown>>): MemoryRecord[] {
  return rows.map((memory) => ({
    id: Number(memory.id), statement: String(memory.statement || memory.label || ""),
    scope: String(memory.scope || "general"), polarity: Number(memory.polarity || 1),
    weight: Number(memory.weight || 1), confidence: Number(memory.confidence || 0),
    evidence: (() => { try { return JSON.parse(String(memory.evidence_json || "[]")); } catch { return []; } })(),
    evidenceCount: Number(memory.evidence_count || 1), reason: String(memory.reason || "").replace(/^你明确告诉我喜欢歌手\s*/, "用户明确添加的歌手偏好："),
    source: String(memory.source || "unknown"), category: String(memory.category || "taste") as MemoryCategory,
    status: memory.status === "pending" ? "pending" : "confirmed", updatedAt: String(memory.updated_at || ""),
  }));
}

function Statement({ memory, onEdit, onDelete }: { memory: MemoryRecord; onEdit: (memory: MemoryRecord) => void; onDelete: (memory: MemoryRecord) => void }) {
  const source = memory.source === "explicit_manual" ? "你创建的" : memory.source === "explicit_feedback" ? "来自歌曲反馈" : memory.source === "explicit" ? "明确偏好" : "系统观察";
  const importance = importanceLabel[Math.min(3, Math.max(1, Math.abs(memory.weight)))] || "一般";
  return <article className="memory-card">
    <div className="memory-card-meta"><span>{categoryLabel[memory.category]} · {importance}{memory.scope !== "general" ? ` · ${memory.scope}` : ""}</span><span className="muted small">{source}</span></div>
    <h3>{memory.statement}</h3>
    {memory.reason && <p className="muted">{memory.reason}</p>}
    {memory.evidence.length > 0 && <div className="chips">{memory.evidence.map((item, index) => <span key={`${item.trackId || item.title}-${index}`}>{item.title || item.trackId}</span>)}</div>}
    <div className="memory-card-actions"><button className="text-button" onClick={() => onEdit(memory)}>修改</button><button className="text-button" onClick={() => onDelete(memory)}>删除</button></div>
  </article>;
}

export type SongBlock = { song_key: string; track_id: number | null; title: string; artist: string; created_at: string };

export function MemoryView({ memories, recentRequests, favoriteTracks, blocks, onUnblock, onNew, onEdit, onDelete, onPlay }: {
  memories: MemoryRecord[]; recentRequests: RequestMemory[]; favoriteTracks: Track[]; blocks: SongBlock[]; onUnblock: (block: SongBlock) => void;
  onNew: (category?: MemoryCategory) => void; onEdit: (memory: MemoryRecord) => void; onDelete: (memory: MemoryRecord) => void; onPlay: (track: Track) => void;
}) {
  const confirmed = memories.filter((item) => item.status === "confirmed");
  const pending = memories.filter((item) => item.status === "pending");
  const group = (category: MemoryCategory) => confirmed.filter((item) => item.category === category);
  const sections: Array<{ category: MemoryCategory; title: string; hint: string; empty: string }> = [
    { category: "taste", title: "长期偏好", hint: "一直有效", empty: "还没有手动确认的长期偏好。" },
    { category: "context", title: "场景设置", hint: "某个场景下才生效", empty: "还没有场景设置，本次需求默认只影响当前歌单。" },
    { category: "boundary", title: "明确边界", hint: "避免误推", empty: "还没有长期排除条件。" },
  ];
  return <div className="page">
    <PageHeader eyebrow="音乐记忆" title="我的音乐偏好" subtitle="会参与推荐的长期偏好、场景设置和边界。系统观察要你确认后才会生效。"
      actions={<button className="primary-button" onClick={() => onNew()}><Icon name="plus" size={16} />添加偏好</button>} />
    <div className="stat-row">
      <span><b>{group("taste").length}</b>长期偏好</span><span><b>{group("context").length}</b>场景设置</span><span><b>{group("boundary").length}</b>明确边界</span>
      <span><b>{group("anchor").length + group("reference").length + favoriteTracks.length}</b>音乐参照</span><span><b>{pending.length}</b>待确认</span>
    </div>
    {pending.length > 0 && <section className="panel-block"><div className="section-head"><h2>待确认的观察</h2><span>确认、修改或忽略后才会参与推荐</span></div>
      {pending.map((memory) => <div className="pending-item" key={memory.id}><span>{memory.statement}</span><button className="text-button" onClick={() => onEdit(memory)}>确认或修改</button><button className="text-button" onClick={() => onDelete(memory)}>不保存</button></div>)}</section>}
    <section className="panel-block"><div className="section-head"><h2>不喜欢的歌</h2><span>在播放条点过“不喜欢”的歌，永远不会出现在 AI 歌单里</span></div>
      {blocks.length ? <div className="block-list">{blocks.map((block) => <div className="block-item" key={block.song_key}>
        <span><b>{block.title}</b><span className="muted"> · {block.artist}</span></span><button className="text-button" onClick={() => onUnblock(block)}>撤销</button></div>)}</div>
        : <div className="empty">还没有。播放时觉得不对，点播放条上的 👎 即可。</div>}</section>
    {sections.map((section) => <section className="panel-block" key={section.category}>
      <div className="section-head"><h2>{section.title}</h2><span>{section.hint}</span><button className="text-button" onClick={() => onNew(section.category)}>＋ 新增</button></div>
      {group(section.category).length ? <div className="memory-grid">{group(section.category).map((memory) => <Statement key={memory.id} memory={memory} onEdit={onEdit} onDelete={onDelete} />)}</div>
        : <p className="muted">{section.empty}</p>}
    </section>)}
    <section className="panel-block"><div className="section-head"><h2>歌手、歌曲与收藏</h2><span>参照对象不等于喜欢它的全部特征</span></div>
      <div className="memory-grid">{[...group("anchor"), ...group("reference")].map((memory) => <Statement key={memory.id} memory={memory} onEdit={onEdit} onDelete={onDelete} />)}</div>
      <div className="chips clickable">{favoriteTracks.slice(0, 16).map((track) => <button key={track.id} onClick={() => onPlay(track)}>{track.title} · {track.artist}</button>)}</div>
    </section>
    <section className="panel-block"><div className="section-head"><h2>最近说过的需求</h2><span>原始记录，不会直接变成长期偏好</span></div>
      <div className="request-list">{recentRequests.slice(0, 8).map((item) => <div className="request-item" key={item.id}>
        <span className="muted small">{formatDate(item.createdAt)} · {item.status === "succeeded" ? "已生成" : item.status === "failed" ? "生成失败" : "生成中"}</span>
        <p>{item.request}</p>{item.title && <span className="muted small">{item.title} · {item.requestedCount} 首</span>}
      </div>)}</div>
    </section>
  </div>;
}
