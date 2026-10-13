import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(here, "..");
try { process.loadEnvFile(join(projectRoot, ".env.local")); } catch { /* optional local configuration */ }
export const libraryRoot = resolve(process.env.MUSIC_LIBRARY_PATH || join(projectRoot, "..", "music-repo"));
export const databasePath = resolve(process.env.MUSIC_DATABASE_PATH || join(here, "music-library.sqlite"));
export const port = Number(process.env.MUSIC_SERVER_PORT || 3001);
// Planner/ranker LLM. LLM_PROVIDER=modelproxy routes the same OpenAI-compatible calls through the
// company ModelProxy (budget pool) instead of the personal DeepSeek account; the DEEPSEEK_* values stay as they are.
const viaProxy = process.env.LLM_PROVIDER === "modelproxy";
export const deepseekBaseUrl = (viaProxy ? process.env.MODELPROXY_BASE_URL || "" : process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
export const deepseekModel = viaProxy ? process.env.MODELPROXY_LLM_MODEL || "deepseek-v4.1-flash" : process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
export const deepseekApiKey = (viaProxy ? process.env.MODELPROXY_API_KEY : process.env.DEEPSEEK_API_KEY) || "";
export const llmViaProxy = viaProxy;
// When the company proxy is unreachable (off the office network / VPN), fall back to the personal account.
export const deepseekFallback = viaProxy && process.env.DEEPSEEK_API_KEY
  ? { baseUrl: (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, ""), model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash", apiKey: process.env.DEEPSEEK_API_KEY }
  : null;
export const dashscopeBaseUrl = (process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
export const dashscopeApiKey = process.env.DASHSCOPE_API_KEY || "";
export const omniModel = process.env.OMNI_MODEL || "qwen3.5-omni-plus";
export const embeddingModel = process.env.EMBEDDING_MODEL || "text-embedding-v4";
export const embeddingDim = Number(process.env.EMBEDDING_DIM || 1024);
export const supportedExtensions = new Set([".mp3", ".flac", ".m4a", ".aac", ".wav", ".ogg"]);

export const isPlaceholderKey = (key) => !key || /在这里|填入|your/i.test(key);
