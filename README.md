# Moment · 此刻歌单

Moment 是一个个性化音乐推荐产品：用一句话描述此刻的心情、场景、参考歌曲或限制条件，系统结合曲库里每首歌"听起来是什么样"、你的听歌历史和大模型，生成可以直接播放、保存的歌单。

核心思路：**长期口味 × 此刻意图 × 可控的探索比例**。召回只管"相不相关"，精排负责"此刻适不适合你"。大模型负责理解需求和从候选里挑歌，不凭空推荐，也不打分；程序保证只推荐曲库里真实存在、满足条件的歌。

> 仓库不包含音乐文件、数据库、听歌记录、服务器地址或任何 API Key。

## 核心能力

- **一句话生成歌单**：1～30 首；识别参考歌曲、限定/排除歌手、语言、人声、曲风、节奏等硬条件；首页 8 张心情卡片一键生成；
- **熟悉 / 遗忘旧爱 / 没听过 三类比例**：原话里说的 > 手动滑块 > 系统按情境判断（并说明理由）；
- **不重复**：近期推荐过的歌自动降权；「换一批」保持同样需求、排除上一版的歌；「换个口味」保持心情、换掉上一版的歌手和整体曲风方向；
- **不喜欢**：播放条上点 👎 的歌永远不进 AI 歌单，可在「音乐记忆」里撤销；
- **懂歌**：音频模型听完整首后打的标签——语言、人声、曲风、声音与能量走向、听感情绪（效价 / 唤醒度）、歌词主题、适合的处境、综合描述，以及本地测量的 BPM / 响度；
- **曲库与历史**：按播放次数 / 收藏排序，可展开每首歌的标签；播放历史（最近、本周、今天、本月、今年、全部）；
- **收藏、自定义歌单、听歌手记**（边听边记一笔）和可查看、可修改的偏好记忆；
- **推荐评测页**：同一批真实需求的 A/B 盲测、逐首打分、标签抽查，用来判断每次改动是变好还是变差。

## 推荐链路

```text
离线  歌曲音频 → Qwen-Omni 打标（prompt v2.3，先听声音再看歌名）→ text-embedding-v4 向量
      音频 → 本地测 BPM / 响度（librosa、ffmpeg）
      听歌历史（YouTube Music 导出 + 应用内播放/完播/跳过/收藏）→ 歌曲偏好分 + 兴趣中心（K-means）
在线  用户原句
  → 需求理解（DeepSeek）：硬条件、软偏好、参考歌、熟悉度比例
  → 硬过滤：按标签字段严格执行（区间类条件不够时自动放宽并记录）；去掉"不喜欢"的歌
  → 召回：原句向量 × 歌曲向量，近期推荐过的歌按时间衰减降权；按熟悉度分层取候选
          （换一批：排除上一版；换个口味：再排除上一版歌手，并让查询向量偏离上一版的整体听感）
  → 精排：0.7 × 需求匹配 + 0.3 × 口味匹配 排序 → 大模型分 3 批初筛（知道配额）→ 终选
  → 按比例配额，缺口用该类里最相关的歌补位 → 服务端校验并保存
```

各阶段中间结果写入 `recommendation_events.plan_json.pipeline`，参数在 `local-music/ranking-config.json`。评测时关闭"不重复"相关的随机项，保证结果可比。

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
DEEPSEEK_API_KEY=...         # 需求理解与精排
LLM_PROVIDER=modelproxy      # 可选：改走 OpenAI 兼容的代理网关（MODELPROXY_*）
```

## 部署到云端

目前跑在一台阿里云香港轻量服务器上，手机和电脑都能用：

```text
浏览器 ──HTTPS + 登录──▶ Caddy ─┬─ 静态前端（构建时预渲染的单页）
                                └─ /api ▶ Node 服务 ── SQLite（云端为准，每天备份到 OSS）
                                                    └─ 音乐文件：OSS 私有存储桶，挂载为本地目录
```

```bash
./deploy/deploy.sh                    # 构建并发布代码（不动云端数据库和配置）
./deploy/upload-library.sh            # 把曲库同步到 OSS（可断点续传，已上传的跳过）
node deploy/db-sync.mjs pull | push   # 加新歌：拉云端数据库到本地打标，再推回
```

服务器地址、OSS 存储桶和密钥都只写在 `.env.local`。详细步骤见 [deploy/README.md](deploy/README.md)。

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
node scripts/purge-missing-tracks.mjs          # 清理已不在曲库且无引用的旧记录（默认只预览，--apply 执行并先备份）
```

曲库清单与下载（`build-library-plan`、`build-artist-aliases`、`repair-not-found`、`pick-platform-titles`）配合同级目录的 `music-downloader` 使用。

## 验证

```bash
npm run test:unit
npm run lint
npm run build
```

## 主要目录

```text
app/MomentApp.tsx                 前端入口：视图切换、播放、状态
app/moment/                       各页面与组件（首页、歌单、曲库、历史、手记、记忆、评测、播放条）
local-music/server.mjs            曲库扫描、播放、推荐 API
local-music/retrieval.mjs         向量文本、向量库、召回
local-music/freshness.mjs         近期降权、换一批 / 换个口味、不喜欢名单
local-music/song-tags.mjs         标签读取与硬过滤
local-music/ranking.mjs           打分、分批、分层召回、比例配额
local-music/personalization.mjs   行为分、兴趣中心、熟悉度分桶
local-music/omni-tagging.mjs      打标提示词与校验（实时与 Batch 共用）
local-music/history.mjs           播放历史统计
local-music/comments.mjs          听歌手记
local-music/remap.mjs             换曲库后把旧记录指向同一首歌的新文件
local-music/eval-routes.mjs       评测与抽查接口
deploy/                           云端部署、曲库上传、数据库同步
scripts/                          导入、打标、向量、音频特征、评测、清理、备份
tests/                            单元测试
```

## 数据与安全

- `.env.local`、SQLite 数据库、音频、听歌记录和评测结果都不进 Git；
- Key 只在后端读取；云端整站需要登录，音乐存储桶为私有；
- 只使用你有权存储和播放的音乐。

## 当前限制

- 单用户；
- 标签由模型生成：歌词与听感反差明显的歌已能区分，较微妙的听感仍可能偏向歌词；早期 1,094 首用 v2.2 提示词打标，其余为 v2.3；
- 新歌打标在本地完成，再通过 `db-sync` 推回云端，推送期间云端暂停约 1 分钟。
