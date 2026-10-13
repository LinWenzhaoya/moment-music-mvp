import { useState } from "react";
import type { Mix, Track } from "../../lib/music";
import { Icon, MoodCover } from "./shared";

// One tap = one request: each card carries the sentence it sends. The pipeline still adds your
// long-term taste and recent listening, so the same card gives different people different lists.
export const moodCards = [
  { label: "开心", line: "想把好心情再放大一点", prompt: "我现在很开心，想把好心情再放大一点", bg: "#f2b33d", fg: "#2a1d02", shape: "#ffd36e" },
  { label: "难过", line: "不急着好起来，先陪你待一会儿", prompt: "有点难过，不急着好起来，想要能先陪我待一会儿的歌", bg: "#2f4a7a", fg: "#eef3ff", shape: "#4c6ea8" },
  { label: "亢奋", line: "心跳很快，需要更快的节拍接住", prompt: "现在很亢奋，心跳很快，需要节奏更快、能量更强的歌", bg: "#e8543d", fg: "#2b0b05", shape: "#ff866f" },
  { label: "放松", line: "把肩膀放下来，什么都不用想", prompt: "想彻底放松下来，什么都不用想", bg: "#5f9e86", fg: "#0e221a", shape: "#86c2aa" },
  { label: "专注", line: "没有歌词打扰，只留下推进感", prompt: "要专注做事，最好没有歌词打扰，有持续的推进感", bg: "#2c2f36", fg: "#f2f3ef", shape: "#4a4f5a" },
  { label: "深夜", line: "城市睡了，你还醒着", prompt: "深夜了，城市睡了我还醒着，来点适合这个时刻的歌", bg: "#241d45", fg: "#ece8ff", shape: "#4b3f8a" },
  { label: "想念", line: "想起一个很久没联系的人", prompt: "想起一个很久没联系的人，有点想念", bg: "#b86a8a", fg: "#2a0f1c", shape: "#d995b0" },
  { label: "燃起来", line: "上场前，给自己一点底气", prompt: "马上要上场了，给我一点底气，要燃一点", bg: "#d7ff61", fg: "#12160a", shape: "#b9e63d" },
];

const examples = ["下雨天窝在家里看书", "跑步用，160 BPM 左右", "像《年轮》那种感觉"];

function adjustMix(mix: Mix, key: keyof Mix, nextValue: number): Mix {
  const value = Math.max(0, Math.min(100, Math.round(nextValue / 5) * 5));
  const otherKeys = (["familiar", "forgotten", "discover"] as Array<keyof Mix>).filter((item) => item !== key);
  const remaining = 100 - value;
  const otherTotal = mix[otherKeys[0]] + mix[otherKeys[1]];
  const first = otherTotal ? Math.round((remaining * mix[otherKeys[0]] / otherTotal) / 5) * 5 : Math.round(remaining / 10) * 5;
  return { ...mix, [key]: value, [otherKeys[0]]: first, [otherKeys[1]]: remaining - first };
}

type Props = {
  greeting: string;
  prompt: string; setPrompt: (value: string) => void;
  generate: (override?: string) => void; isGenerating: boolean;
  trackCount: number; setTrackCount: (value: number) => void;
  mix: Mix; setMix: (mix: Mix) => void; mixMode: "auto" | "manual"; setMixMode: (mode: "auto" | "manual") => void;
  lastRequest?: string; topTrack?: Track;
};

export function HomeView(props: Props) {
  const [showSettings, setShowSettings] = useState(false);
  const { prompt, setPrompt, generate, isGenerating, trackCount, setTrackCount, mix, setMix, mixMode, setMixMode } = props;
  const forYou = [
    props.lastRequest && { kicker: "继续上次", title: props.lastRequest.length > 18 ? `${props.lastRequest.slice(0, 18)}…` : props.lastRequest, line: "按你上一次的需求再来一批", prompt: props.lastRequest, cover: { id: "last", valence: 0.35, arousal: 0.4 } },
    { kicker: "好久没听", title: "遗忘旧爱", line: "以前常听、但 90 天没听过的歌", prompt: "想听点我很久没听过、以前常听的歌", cover: { id: "old", valence: 0.6, arousal: 0.35 } },
    props.topTrack && { kicker: "新发现", title: `和《${props.topTrack.title}》一样的感觉`, line: "你还没听过、但听感接近的歌", prompt: `推荐几首我没听过、但和《${props.topTrack.title}》听感接近的歌`, cover: props.topTrack },
  ].filter(Boolean) as Array<{ kicker: string; title: string; line: string; prompt: string; cover: { id: string; valence?: number | null; arousal?: number | null } }>;

  return <div className="home">
    <section className="home-section">
      <h1 className="home-title">{props.greeting}，此刻是什么心情？</h1>
      <div className="mood-grid">
        {moodCards.map((card) => <button key={card.label} className="mood-card" style={{ background: card.bg, color: card.fg }} disabled={isGenerating}
          onClick={() => { setPrompt(card.prompt); generate(card.prompt); }}>
          <span className="mood-card-shape" style={{ background: card.shape }} />
          <span className="mood-card-label">{card.label}</span>
          <span className="mood-card-line">{card.line}</span>
        </button>)}
      </div>
    </section>

    <section className="prompt-panel">
      <div className="prompt-head"><h2>或者，用一句话告诉我此刻</h2><span>心情、场景、想听的感觉、参考歌、想要多少新歌，都可以写进去</span></div>
      <label htmlFor="prompt" className="visually-hidden">描述此刻的需求</label>
      <textarea id="prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3}
        onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) generate(); }}
        placeholder="刚加完班开车回家，想要不费脑子但别太丧的歌，八成要我听过的……" />
      <div className="prompt-actions">
        {examples.map((example) => <button key={example} className="pill" onClick={() => setPrompt(example)}>{example}</button>)}
        <button className={`pill ${showSettings ? "on" : ""}`} onClick={() => setShowSettings((open) => !open)}><Icon name="sliders" size={14} /> 歌单设置</button>
        <button className="primary-button big" onClick={() => generate()} disabled={!prompt.trim() || isGenerating}>
          <Icon name={isGenerating ? "spark" : "arrow"} size={18} />{isGenerating ? "正在挑选…" : "生成歌单"}
        </button>
      </div>
      {showSettings && <div className="prompt-settings">
        <div className="setting-row">
          <span>歌曲数量</span>
          <div className="stepper">
            <button onClick={() => setTrackCount(Math.max(1, trackCount - 1))} aria-label="减少一首">−</button>
            <input aria-label="歌单歌曲数量" type="number" min="1" max="30" value={trackCount} onChange={(event) => setTrackCount(Math.max(1, Math.min(30, Number(event.target.value) || 1)))} />
            <button onClick={() => setTrackCount(Math.min(30, trackCount + 1))} aria-label="增加一首">＋</button>
          </div>
          <small>约 {Math.round(trackCount * 4.2)} 分钟</small>
        </div>
        <label className="setting-row check"><input type="checkbox" checked={mixMode === "auto"} onChange={(event) => setMixMode(event.target.checked ? "auto" : "manual")} /> 按此刻的情境自动决定新旧比例（你在需求里说了比例时以你说的为准）</label>
        <div className={`mix-sliders ${mixMode === "auto" ? "disabled" : ""}`}>
          {([["familiar", "近期熟悉"], ["forgotten", "遗忘旧爱"], ["discover", "没听过"]] as Array<[keyof Mix, string]>).map(([key, label]) => <label key={key} className={`mix-slider ${key}`}>
            <span>{label}<b>{mix[key]}%</b></span>
            <input type="range" min="0" max="100" step="5" value={mix[key]} aria-label={`${label}比例`} onChange={(event) => { setMix(adjustMix(mix, key, Number(event.target.value))); setMixMode("manual"); }} />
          </label>)}
        </div>
      </div>}
    </section>

    {forYou.length > 0 && <section className="home-section">
      <div className="section-head"><h2>为你最近的状态</h2><span>根据你最近的需求和播放</span></div>
      <div className="for-you-grid">
        {forYou.map((item) => <button key={item.kicker} className="for-you-card" disabled={isGenerating} onClick={() => { setPrompt(item.prompt); generate(item.prompt); }}>
          <MoodCover track={item.cover} size={72} radius={6} />
          <span className="for-you-text"><span className="kicker">{item.kicker}</span><span className="for-you-title">{item.title}</span><span className="muted">{item.line}</span></span>
        </button>)}
      </div>
    </section>}
  </div>;
}
