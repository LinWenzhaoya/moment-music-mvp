import { dashscopeApiKey, dashscopeBaseUrl, deepseekApiKey, deepseekBaseUrl, deepseekFallback, deepseekModel, embeddingDim, embeddingModel, isPlaceholderKey, llmViaProxy, omniModel } from "./config.mjs";

export function parseModelJson(content) {
  if (!content) throw new Error("模型没有返回正文，请重试");
  const cleaned = content.trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

let proxyDownUntil = 0;

// Planner/ranker JSON call. With LLM_PROVIDER=modelproxy a network failure (off the office network)
// switches to the personal DeepSeek account for 10 minutes, and the error says which network is missing.
export async function deepseekJson(system, value, maxTokens = 1400) {
  const primary = { baseUrl: deepseekBaseUrl, model: deepseekModel, apiKey: deepseekApiKey, label: llmViaProxy ? "公司 ModelProxy" : "DeepSeek" };
  const fallback = deepseekFallback && !isPlaceholderKey(deepseekFallback.apiKey) ? { ...deepseekFallback, label: "个人 DeepSeek" } : null;
  if (fallback && Date.now() < proxyDownUntil) return deepseekJsonWith(fallback, system, value, maxTokens);
  try {
    return await deepseekJsonWith(primary, system, value, maxTokens);
  } catch (error) {
    if (!(error instanceof NetworkError) || !llmViaProxy) throw error;
    if (!fallback) throw new Error("连不上公司 ModelProxy（需要公司网络或 VPN），也没有配置个人 DeepSeek Key");
    proxyDownUntil = Date.now() + 10 * 60_000;
    try { return await deepseekJsonWith(fallback, system, value, maxTokens); }
    catch (fallbackError) { throw new Error(`连不上公司 ModelProxy（需要公司网络或 VPN）；改用个人 DeepSeek 也失败：${fallbackError.message}`); }
  }
}

class NetworkError extends Error {}

async function deepseekJsonWith({ baseUrl, model, apiKey, label }, system, value, maxTokens) {
  if (isPlaceholderKey(apiKey)) throw new Error(`${label} 的 API Key 尚未配置`);
  if (!baseUrl) throw new Error(`${label} 的地址尚未配置（.env.local 里的 MODELPROXY_BASE_URL）`);
  let lastError;
  let totalTokens = 0;
  let gatewayRetries = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const retryRule = attempt ? "\n上一次结构化输出无法解析。这次必须返回一个完整、简洁、无 Markdown 的 JSON 对象；缩短文字，不得在字符串中换行。" : "";
    let apiResponse;
    try {
      apiResponse = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: "system", content: `${system}${retryRule}` }, { role: "user", content: JSON.stringify(value) }], thinking: { type: "disabled" }, response_format: { type: "json_object" }, temperature: attempt ? 0.1 : 0.35, max_tokens: attempt ? Math.ceil(maxTokens * 1.5) : maxTokens }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (error) {
      lastError = error;
      if (attempt === 0) continue;
      throw new NetworkError(`${label} 请求超时或网络异常：${error?.message || "未知错误"}`);
    }
    const result = await apiResponse.json().catch(() => ({}));
    // Gateways (ModelProxy) return occasional 502/503/429: back off and retry instead of failing the request.
    if ([429, 500, 502, 503, 504].includes(apiResponse.status) && gatewayRetries < 4) {
      gatewayRetries += 1; attempt -= 1;
      await new Promise((done) => setTimeout(done, 1500 * 2 ** gatewayRetries));
      continue;
    }
    if (!apiResponse.ok) throw new Error(`${label}：${result.error?.message || `请求失败 (${apiResponse.status})`}`);
    totalTokens += Number(result.usage?.total_tokens || 0);
    try {
      return { value: parseModelJson(result.choices?.[0]?.message?.content), usage: { ...(result.usage || {}), total_tokens: totalTokens }, model: result.model || model };
    } catch (error) { lastError = error; }
  }
  throw new Error(`DeepSeek 连续返回了无法解析的 JSON：${lastError?.message || "未知错误"}`);
}

function requireDashscopeKey() {
  if (isPlaceholderKey(dashscopeApiKey)) throw new Error("DASHSCOPE_API_KEY 尚未配置");
}

// OpenAI-compatible DashScope embeddings; returns Float32Array per input, in order.
export async function embedTexts(texts, { dimensions = embeddingDim } = {}) {
  requireDashscopeKey();
  const vectors = [];
  for (let index = 0; index < texts.length; index += 10) {
    const batch = texts.slice(index, index + 10);
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(`${dashscopeBaseUrl}/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${dashscopeApiKey}` },
          body: JSON.stringify({ model: embeddingModel, input: batch, dimensions, encoding_format: "float" }),
          signal: AbortSignal.timeout(60_000),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error?.message || `Embedding 请求失败 (${response.status})`);
        const data = [...(body.data || [])].sort((left, right) => left.index - right.index);
        if (data.length !== batch.length) throw new Error("Embedding 返回数量与输入不一致");
        vectors.push(...data.map((item) => Float32Array.from(item.embedding)));
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((done) => setTimeout(done, 1000 * attempt));
      }
    }
    if (lastError) throw lastError;
  }
  return vectors;
}

// Qwen-Omni only supports streaming output; collect the streamed text and parse it as JSON.
export async function omniAudioJson({ system, prompt, audioBase64, audioFormat = "mp3", maxTokens = 2400 }) {
  requireDashscopeKey();
  // Timings split one call into: upload + model listening (until the first token) vs. writing the answer.
  const started = performance.now(); let firstToken = null;
  const response = await fetch(`${dashscopeBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${dashscopeApiKey}` },
    body: JSON.stringify({
      model: omniModel, stream: true, stream_options: { include_usage: true }, modalities: ["text"], max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: [
          { type: "input_audio", input_audio: { data: `data:;base64,${audioBase64}`, format: audioFormat } },
          { type: "text", text: prompt },
        ] },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error?.message || `Omni 请求失败 (${response.status})`);
  }
  let text = ""; let usage = null; let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const data = line.replace(/^data:\s*/, "").trim();
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data);
      const delta = event.choices?.[0]?.delta?.content || "";
      if (delta && firstToken === null) firstToken = performance.now();
      text += delta;
      if (event.usage) usage = event.usage;
    }
  }
  const ended = performance.now();
  const timing = { firstTokenMs: Math.round((firstToken ?? ended) - started), generateMs: Math.round(ended - (firstToken ?? ended)) };
  return { value: parseModelJson(text), usage, model: omniModel, timing };
}
