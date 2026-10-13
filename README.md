# Moment · 此刻歌单

Moment 是一个本地优先的个性化音乐推荐系统。用一句话描述此刻的心情、场景、参考歌曲或限制条件，系统结合本地曲库的音频标签、你的听歌历史和大模型，生成可以直接播放、保存的歌单。

核心思路：**长期口味 × 此刻意图 × 可控的探索比例**。粗召回只管"相不相关"，精排负责"此刻适不适合你"。

> 仓库不包含音乐文件、运行数据库、听歌记录或任何 API Key。

## 核心能力

- 一句话生成 1～30 首歌单；识别参考歌曲、限定/排除歌手、语言、人声、曲风、节奏等硬条件；
- 熟悉 / 遗忘旧爱 / 没听过 三类比例：原话里说的 > 手动滑块 > 系统按情境判断（并说明理由）；
- 每首歌有音频模型听完整首后打的标签：语言、人声、曲风、声音与能量、听感情绪、歌词主题、适合的处境、综合描述，以及本地测量的 BPM / 响度；
- 曲库浏览（按播放次数 / 收藏排序，可展开标签）、播放历史（最近、本周、今天、本月、今年、全部）；
- 收藏、自定义歌单、反馈与长期偏好记忆；
- 推荐评测页：同一批真实需求的 A/B 盲测、逐首打分、标签抽查，用来判断每次改动是变好还是变差。

## 推荐链路

```text
离线  歌曲音频 → Qwen-Omni 打标（prompt v2.3，听感优先）→ text-embedding-v4 向量
      音频 → 本地测 BPM / 响度（librosa、ffmpeg）
      听歌历史（YouTube Music 导出 + 应用内播放/完播/跳过/收藏）→ 歌曲偏好分 + 兴趣中心（K-means）
在线  用户原句
  → 需求理解（DeepSeek）：硬条件、软偏好、参考歌、熟悉度比例
  → 硬过滤：按标签字段严格执行（区间类条件不够时自动放宽并记录）
  → 粗召回：原句向量 × 歌曲向量，按熟悉度分层取候选（每类先取自己最相关的歌）
  → 精排：0.7 × 需求匹配 + 0.3 × 口味匹配 排序 → 大模型分 3 批初筛（知道配额）→ 终选
  → 按比例配额，缺口用该类里最相关的歌补位 → 服务端校验并保存
```

各阶段中间结果写入 `recommendation_events.plan_json.pipeline`。参数在 `local-music/ranking-config.json`。

## 本地运行

需要 Node.js `>= 22.13`、ffmpeg；音频特征脚本需要 Python 3.12 + librosa。

```bash
npm install
cp .env.example .env.local   # 填写曲库路径和各个 Key
npm run dev                  # Web http://localhost:3000，本地 API http://localhost:3001
```

`.env.local` 主要配置：

```dotenv
MUSIC_LIBRARY_PATH=/absolute/path/to/your/music-library
DASHSCOPE_API_KEY=...        # 阿里云百炼：Qwen-Omni 打标、text-embedding-v4 向量
DEEPSEEK_API_KEY=...         # 需求理解与精排；或者用下面的 ModelProxy
LLM_PROVIDER=modelproxy      # 可选：需求理解与精排改走公司 ModelProxy
MODELPROXY_API_KEY=...
```

## 数据准备

都可以重复运行，只处理新增或变化的部分：

```bash
npm run history:import                         # 导入 Google Takeout 的 YouTube Music 历史
node scripts/tag-audio-batch.mjs submit        # 音频打标（Batch 半价，24 小时内出结果）
node scripts/tag-audio-batch.mjs collect       #   收取结果；status 查看进度；batch-health.mjs 健康检查
npm run tags:omni                              # 或实时打标（IDS=… 指定歌曲，DRY=1 只输出不入库）
npm run embeddings:build                       # 生成歌曲向量（desc / rich 两种文本）
python scripts/audio-features.py               # BPM / 响度，并用听感快慢纠正 BPM 翻倍
npm run eval                                   # 跑一轮 A/B 盲测，到"推荐评测"页打分
```

曲库清单与下载（`build-library-plan`、`build-artist-aliases`、`repair-not-found`、`pick-platform-titles`）配合同级目录的 `music-downloader` 使用。

## 验证

```bash
npm run test:unit
npm run build
```

## 主要目录

```text
app/                              前端（生成、曲库、播放历史、歌单、评测、偏好记忆）
local-music/server.mjs            曲库扫描、播放、推荐 API
local-music/retrieval.mjs         向量文本、向量库、粗召回
local-music/song-tags.mjs         标签读取与硬过滤
local-music/ranking.mjs           打分、分批、分层召回、比例配额
local-music/personalization.mjs   行为分、兴趣中心、熟悉度分桶
local-music/omni-tagging.mjs      打标提示词与校验（实时与 Batch 共用）
local-music/history.mjs           播放历史统计
local-music/eval-routes.mjs       评测与抽查接口；review.html 为评测页
scripts/                          导入、打标、向量、音频特征、评测、曲库下载辅助
tests/                            单元测试
```

## 数据与安全

- `.env.local`、SQLite 数据库、音频、听歌记录和评测结果都不进 Git；
- Key 只在本地后端读取；
- 只使用你有权存储和播放的音乐；上云时存储需私有并加登录。

## 当前限制

- 单机、单用户、本地运行；
- 标签由模型生成：歌词与听感反差明显的歌已能区分，较微妙的听感仍可能偏向歌词；
- 早期 1,094 首用 v2.2 提示词打标，其余为 v2.3。
