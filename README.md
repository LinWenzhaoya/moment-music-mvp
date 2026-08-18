# Moment · 此刻歌单

Moment 是一个本地优先的个性化音乐推荐 MVP。用户可以直接用自然语言描述此刻的心情、参考歌曲、曲风与排除条件，系统结合本地真实曲库、可编辑的音乐记忆和 DeepSeek，生成可以播放和保存的歌单。

> 当前项目用于个人产品实验和推荐策略验证。仓库不包含音乐文件、运行数据库或任何 API Key。

## 核心能力

- 用一段自然语言生成 1～30 首歌曲；
- 识别参考歌曲、限定歌手、明确曲风、软偏好和排除条件；
- 扫描本地音频并建立 SQLite 曲库；
- 播放本地真实音频，支持上一首、下一首和播放进度；
- 分别管理 AI 歌单、默认收藏和自定义歌单；
- 对歌曲进行喜欢、不喜欢及原因反馈；
- 查看、创建、修改和删除音乐偏好记忆；
- 保存每次生成请求、检索计划与历史歌单；
- 使用歌曲听感档案辅助候选召回，并由 DeepSeek 完成语义选择。

## 推荐链路

```text
用户自然语言
  → DeepSeek 解析本次需求
  → 程序识别参考歌并读取歌曲档案
  → 全曲库执行硬条件、排除、去重与候选召回
  → DeepSeek 在有限候选中进行语义选择
  → 服务端校验真实歌曲、参考歌、数量和重复项
  → 保存并播放歌单
```

大模型负责理解用户难以结构化表达的需求；程序负责约束真实曲库和执行确定性规则。当前版本不展示缺少可靠依据的相似度总分。

## 技术栈

- React 19 + Vinext
- Node.js 本地音乐服务
- SQLite（Node 内置 `node:sqlite`）
- `music-metadata` 音频元数据解析
- DeepSeek Chat Completions API
- Node Test Runner

## 本地运行

### 环境要求

- Node.js `>= 22.13.0`
- 一个包含支持格式音频的本地目录
- DeepSeek API Key

### 安装

```bash
npm install
cp .env.example .env.local
```

编辑 `.env.local`：

```dotenv
MUSIC_LIBRARY_PATH=/absolute/path/to/your/music-library
MUSIC_SERVER_PORT=3001
DEEPSEEK_API_KEY=your_key_here
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
```

启动前端和本地音乐服务：

```bash
npm run dev
```

默认地址：

- Web：`http://localhost:3000`
- 本地 API：`http://localhost:3001`

首次启动后，可在页面中触发曲库扫描。SQLite 数据库会在 `local-music/` 下生成，并已被 Git 忽略。

## 验证

```bash
node --test tests/recommendation-core.test.mjs
npm run build
```

## 主要目录

```text
app/                          前端界面与交互
local-music/server.mjs        本地曲库、播放与推荐 API
local-music/recommendation-core.mjs
                              参考歌识别与候选召回规则
scripts/                      曲库扫描、歌曲档案生成与校准脚本
tests/                        核心规则与页面回归测试
data/                         前端演示数据与类型样例
```

## 数据与安全

- `.env.local`、SQLite 数据库和音频文件不会进入 Git；
- DeepSeek Key 仅由本地后端读取，不应写进前端或提交记录；
- 请只使用你有权存储和播放的音乐文件；
- 公网版本需要把本地数据库、音频与服务端 API 迁移到云端环境。

## 当前限制

- 当前是单机、单用户、本地运行的桌面 Web MVP；
- 歌曲语义档案仍需要持续复检；
- “相似歌曲”质量仍在通过代表歌曲对照集与真实 Badcase 校准；
- 完整推荐和播放依赖本地音乐服务与用户自己的曲库。
