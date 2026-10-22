/**
 * promptfoo 自定义 provider：直连 MiniMax 的 OpenAI 兼容端点。
 *
 * 为什么不直接用 `openai:chat:<model>`：该系列是推理模型，思考 token 也计入 max_tokens。
 * promptfoo 0.124 的 openai chat provider 不会把 config.reasoning_effort 透传进请求体
 * （只有 abliteration / openrouter 等少数 provider 会，见 dist/src/chat-*.js），结果 8192
 * 全被思考吃掉、finish_reason=length、输出以「Thinking:」开头——10 条用例全部解析失败。
 * 这里用 30 行自定义 provider 按 lab 的方式发请求（reasoning_effort: low），把适配层的
 * 差异挡在矩阵之外；规则判定仍由 esl-assert.js 调真正的校验器完成。
 *
 * 用法（promptfooconfig.yaml）：
 *   providers:
 *     - id: file://provider.js
 *       label: fast/MiniMax-M3.1-Flash
 *       config: { model: MiniMax-M3.1-Flash, api_key_env: ENDLESS_API_KEY }
 */
const DEFAULT_BASE_URL = 'https://api.minimax.cn/v1';

class EndlessChatProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
    this.label = options.label ?? this.config.model ?? 'unknown';
  }

  id() {
    return `endless:${this.config.model ?? 'unknown'}`;
  }

  async callApi(prompt) {
    const envName = this.config.api_key_env ?? 'ENDLESS_API_KEY';
    const apiKey = process.env[envName];
    if (!apiKey) return { error: `环境变量 ${envName} 未设置（key 只从环境变量读）` };

    const baseUrl = this.config.base_url ?? DEFAULT_BASE_URL;
    const body = {
      model: this.config.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: this.config.temperature ?? 0.8,
      max_tokens: this.config.max_tokens ?? 8192,
      // 不压推理强度，长批次会被思考挤成 finish=length
      reasoning_effort: this.config.reasoning_effort ?? 'low',
      // M3（非 Flash）把思考内联进 content（`Thinking:…` 前缀、无 reasoning_content）。
      // `thinking: {type: disabled}` 能关掉 M3 的思考，但 **Flash 会直接 400**（requires adaptive thinking），
      // 所以这个开关只给 M3 档用；流水线与 `lab assert` 已经靠 stripThinking() 容忍内联思考，
      // 不设它也能解析（实测 2026-10）。
      ...(this.config.thinking ? { thinking: { type: this.config.thinking } } : {}),
    };

    const startedAt = Date.now();
    let res;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return { error: `请求失败：${err.message}`, latencyMs: Date.now() - startedAt };
    }

    const raw = await res.text();
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      return { error: `HTTP ${res.status}：${raw.slice(0, 300)}`, latencyMs };
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { error: `响应不是 JSON：${raw.slice(0, 300)}`, latencyMs };
    }

    const choice = data.choices?.[0] ?? {};
    const usage = data.usage ?? {};
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
    return {
      output: choice.message?.content ?? '',
      latencyMs,
      tokenUsage: {
        prompt: usage.prompt_tokens,
        completion: usage.completion_tokens,
        total: usage.total_tokens,
        ...(reasoningTokens === undefined ? {} : { completionDetails: { reasoningTokens } }),
      },
      metadata: { finishReason: choice.finish_reason, model: data.model },
    };
  }
}

module.exports = EndlessChatProvider;
