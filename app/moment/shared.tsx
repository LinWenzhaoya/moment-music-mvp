import type { ReactNode } from "react";
import type { Track, TrackKind } from "../../lib/music";

// Local development talks to the API on :3001; a deployed build is served from the same origin as the API.
export const apiBase = typeof window !== "undefined" && !["localhost", "127.0.0.1"].includes(window.location.hostname) ? "" : "http://localhost:3001";

export const kindLabel: Record<TrackKind, string> = { familiar: "近期熟悉", forgotten: "遗忘旧爱", discover: "新发现", library: "没听过" };

export type SongTags = { missing?: boolean; language?: string; vocalPresence?: string; vocalType?: string; vocalTimbre?: string; tempo?: string; bpm?: number | null;
  genre?: { primary: string; sub: string[]; era: string; region: string }; instruments?: string[]; texture?: string; arcShape?: string; arc?: string;
  mood?: string[]; valence?: number; arousal?: number; lyricTheme?: string[]; lyricContrast?: string; scene?: string[]; description?: string };

export function formatTime(value = 0) {
  if (!Number.isFinite(value)) return "0:00";
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
}

export function formatDate(value: string, withTime = true) {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}) }).format(date);
}

const paths: Record<string, string> = {
  home: "M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  disc: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 3",
  note: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  scale: "M12 3v18M5 7h14M5 7l-3 7a4 4 0 0 0 6 0zM19 7l-3 7a4 4 0 0 0 6 0z",
  brain: "M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a3 3 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1",
  prev: "M19 20L9 12l10-8v16zM5 19V5", next: "M5 4l10 8-10 8V4zM19 5v14",
  plus: "M12 5v14M5 12h14", edit: "M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4", tags: "M4 6h16M4 12h16M4 18h10",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13", close: "M6 6l12 12M18 6L6 18", back: "M15 18l-6-6 6-6",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7", search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3", arrow: "M5 12h14M13 6l6 6-6 6",
  dislike: "M10 15v4a3 3 0 0 0 3 3l4-9V2H5.7a2 2 0 0 0-2 1.7l-1.4 9A2 2 0 0 0 4.3 15zM17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3", shuffle: "M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5",
  chevronDown: "M6 9l6 6 6-6", chevronUp: "M6 15l6-6 6 6", sliders: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
};

export function Icon({ name, size = 20, filled = false }: { name: string; size?: number; filled?: boolean }) {
  if (name === "play") return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4l13 8-13 8z" /></svg>;
  if (name === "pause") return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>;
  if (name === "heart") return <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 21s-7-4.4-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6c-2.5 4.6-9.5 9-9.5 9z" /></svg>;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] || ""} /></svg>;
}

// Mood cover: no album art, the song's own audio tags paint it. The hue walks the emotional range
// blue → violet → rose → coral → amber as songs get more positive (skipping green, which reads as
// "status" next to the mint accent); intensity sets saturation and depth; the seed jitters each song.
export function moodColors(valence?: number | null, arousal?: number | null, seed = 0) {
  if (valence == null || arousal == null) return { base: "hsl(210 6% 34%)", dot: "hsl(210 6% 48%)", spot: "hsl(210 6% 42%)", x: 60, y: 60 };
  const hue = (232 + valence * 166 + ((seed % 21) - 10)) % 360;
  const sat = 30 + arousal * 42;
  const light = 30 + valence * 10 - arousal * 4;
  return {
    base: `hsl(${hue.toFixed(0)} ${sat.toFixed(0)}% ${light.toFixed(0)}%)`,
    dot: `hsl(${((hue + 24) % 360).toFixed(0)} ${(sat * 0.82).toFixed(0)}% ${(light + 22).toFixed(0)}%)`,
    spot: `hsl(${((hue + 340) % 360).toFixed(0)} ${sat.toFixed(0)}% ${(light + 12).toFixed(0)}%)`,
    x: 45 + (seed % 5) * 9, y: 40 + (seed % 7) * 7,
  };
}

const seedOf = (id: string) => [...id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 9973, 7);

export function MoodCover({ track, size = 44, radius = 4, children }: { track: Pick<Track, "id" | "valence" | "arousal">; size?: number | string; radius?: number; children?: ReactNode }) {
  const colors = moodColors(track.valence, track.arousal, seedOf(track.id));
  // A numeric size is a fixed square; a CSS length ("100%") fills the width and stays square via aspect-ratio.
  return <span className="mood-cover" style={{ width: size, height: typeof size === "number" ? size : "auto", borderRadius: radius, background: colors.base }}>
    <span className="mood-cover-dot" style={{ background: colors.dot, left: `${colors.x}%`, top: `${colors.y}%` }} />
    <span className="mood-cover-spot" style={{ background: colors.spot }} />
    {children}
  </span>;
}

export function KindBadge({ kind }: { kind: TrackKind }) {
  return <span className={`kind-badge ${kind}`}>{kindLabel[kind]}</span>;
}

export function Chips({ items, max = 3 }: { items?: string[]; max?: number }) {
  if (!items?.length) return null;
  return <span className="chips">{items.slice(0, max).map((item) => <span key={item}>{item}</span>)}</span>;
}

// The audio model's tags for one song, as small cards (loaded when the row is opened).
export function TagPanel({ tags }: { tags: SongTags | null | undefined }) {
  if (tags === undefined) return <div className="tag-panel muted">正在读取标签…</div>;
  if (!tags || tags.missing) return <div className="tag-panel muted">这首歌还没有音频标签。</div>;
  const cards: Array<[string, string]> = [
    ["语言 · 人声 · 节奏", `${tags.language || "?"} · ${tags.vocalType && tags.vocalType !== "无" ? tags.vocalType : tags.vocalPresence || "?"} · ${tags.tempo || "?"}速${tags.bpm ? `（约 ${Math.round(tags.bpm)} BPM）` : ""}${tags.vocalTimbre ? `；${tags.vocalTimbre}` : ""}`],
    ["曲风", `${tags.genre?.primary || ""}${tags.genre?.sub?.length ? ` / ${tags.genre.sub.join("、")}` : ""} · ${tags.genre?.era || ""} ${tags.genre?.region || ""}`],
    ["听感情绪", `${(tags.mood || []).join("、")}（正负 ${tags.valence ?? "?"} · 激烈 ${tags.arousal ?? "?"}）`],
    ["声音与能量", `${(tags.instruments || []).join("、")}${tags.texture ? `；${tags.texture}` : ""}${tags.arc ? `；${tags.arcShape || ""}：${tags.arc}` : ""}`],
    ["歌词主题", `${tags.lyricTheme?.length ? tags.lyricTheme.join("、") : "无歌词 / 未识别"}${tags.lyricContrast ? `；${tags.lyricContrast}` : ""}`],
    ["适合的处境", (tags.scene || []).join(" / ")],
  ];
  return <div className="tag-panel">
    {cards.map(([label, value]) => <div className="tag-card" key={label}><b>{label}</b><span>{value}</span></div>)}
    {tags.description && <div className="tag-card wide"><b>综合描述</b><span>{tags.description}</span></div>}
  </div>;
}

export function PageHeader({ eyebrow, title, subtitle, actions }: { eyebrow: string; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return <div className="page-header">
    <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{subtitle && <p className="subtitle">{subtitle}</p>}</div>
    {actions && <div className="page-actions">{actions}</div>}
  </div>;
}
