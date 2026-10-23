/**
 * LLM 接入（第 11 节）：Vercel AI SDK + OpenAI 兼容端点，供应商与模型写在 config/models.yaml。
 * API key 只由调用方从环境变量读取后注入，本包不碰任何凭据存储。
 * 每次调用按请求哈希缓存原始响应（第 10 节：LLM 输出不可复现 → 缓存以支持回放）。
 */
import { generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { fnv1a64, stableStringify } from '@endless/esl';
import { estimateTokens } from './context.js';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  stage: string;
  system: string;
  prompt: string;
  /**
   * 多轮会话消息列表（含前序轮次与当前 user 消息）。
   * 提供时按多轮对话发送以复用上下文与供应商前缀缓存；未提供或仅单条时与单轮 prompt 等价。
   */
  messages?: LlmMessage[];
  modelTier: 'fast' | 'premium';
  temperature?: number;
  maxTokens?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** 供应商报告的命中缓存输入 token 数（若有） */
  cachedInputTokens?: number;
}

export interface LlmResponse {
  text: string;
  usage: LlmUsage;
  latencyMs: number;
  cacheHit: boolean;
  requestHash: string;
  /** 供应商的结束原因（stop / length / content-filter …）。缓存命中时未知。 */
  finishReason?: string;
  /** 推理模型花在思考上的 token；供应商标注时才有 */
  reasoningTokens?: number;
  /** 传输类失败的重试次数（A4；由 RetryingLlmClient 填，缓存命中为 0） */
  transportRetries?: number;
  /** 重试累计等待（毫秒），用于把 K3 拆成「含重试 / 不含重试」两列 */
  transportWaitMs?: number;
}

export interface LlmCache {
  get(hash: string): Promise<string | null>;
  put(hash: string, value: string): Promise<void>;
}

export class MemoryLlmCache implements LlmCache {
  private map = new Map<string, string>();
  async get(hash: string): Promise<string | null> {
    return this.map.get(hash) ?? null;
  }
  async put(hash: string, value: string): Promise<void> {
    this.map.set(hash, value);
  }
  get size(): number {
    return this.map.size;
  }
}

/** 请求哈希：影响输出的参数都必须进哈希，否则改了输出上限会误命中旧缓存。 */
export const requestHash = (req: LlmRequest, modelId: string, salt = ''): string =>
  fnv1a64(
    stableStringify({
      s: req.system,
      p: req.prompt,
      ...(req.messages && req.messages.length > 1 ? { msgs: req.messages } : {}),
      m: modelId,
      t: req.temperature ?? 0,
      n: req.maxTokens ?? 0,
      r: salt,
    }),
  );

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
  /** 该档位的模型 ID（写入 calls.jsonl 与配置留档） */
  modelId(tier: 'fast' | 'premium'): Promise<string>;
  /** 影响生成的客户端级参数（如推理强度），进入请求哈希 */
  hashSalt?(): string;
}

/** 带缓存的装饰器：命中缓存不调用供应商（回放读缓存）。 */
export class CachingLlmClient implements LlmClient {
  constructor(private inner: LlmClient, private cache: LlmCache = new MemoryLlmCache()) {}
  async modelId(tier: 'fast' | 'premium'): Promise<string> {
    return this.inner.modelId(tier);
  }
  hashSalt(): string {
    return this.inner.hashSalt?.() ?? '';
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const hash = requestHash(req, await this.inner.modelId(req.modelTier), this.hashSalt());
    const hit = await this.cache.get(hash);
    if (hit !== null) {
      return { text: hit, usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 0, cacheHit: true, requestHash: hash };
    }
    const res = await this.inner.complete(req);
    await this.cache.put(hash, res.text);
    return { ...res, requestHash: hash };
  }
}

export interface AiSdkClientOptions {
  /** OpenAI 兼容 base URL，如 https://api.example.com/v1 */
  baseURL: string;
  /** API key：调用方从环境变量读取后传入；绝不写入运行文件或日志 */
  apiKey: string;
  providerName: string;
  models: { fast: string; premium: string };
  /** 推理强度（low / medium / high …）。部分供应商支持；不填用供应商默认值。
   * 推理模型的思考 token 也计入 maxOutputTokens，思考过长会把正文挤空。 */
  reasoningEffort?: string;
  /** 单次调用超时（毫秒），默认 5 分钟；超时按调用失败处理。 */
  timeoutMs?: number;
}

/** Vercel AI SDK 实现。 */
export class AiSdkLlmClient implements LlmClient {
  private models: { fast: string; premium: string };
  private provider: ReturnType<typeof createOpenAICompatible>;
  private readonly providerName: string;
  private readonly reasoningEffort: string | undefined;
  private readonly timeoutMs: number;
  constructor(opts: AiSdkClientOptions) {
    this.provider = createOpenAICompatible({ name: opts.providerName, baseURL: opts.baseURL, apiKey: opts.apiKey });
    this.models = opts.models;
    this.providerName = opts.providerName;
    this.reasoningEffort = opts.reasoningEffort;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
  }
  async modelId(tier: 'fast' | 'premium'): Promise<string> {
    return this.models[tier];
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const modelId = this.models[req.modelTier];
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await generateText({
        model: this.provider.chatModel(modelId),
        system: req.system,
        ...(req.messages && req.messages.length > 0 ? { messages: req.messages } : { prompt: req.prompt }),
        temperature: req.temperature ?? 0.8,
        maxOutputTokens: req.maxTokens ?? 4096,
        abortSignal: controller.signal,
        ...(this.reasoningEffort
          ? { providerOptions: { [this.providerName]: { reasoningEffort: this.reasoningEffort } } }
          : {}),
      });
      return {
        text: res.text,
        usage: {
          inputTokens: res.usage.inputTokens ?? 0,
          outputTokens: res.usage.outputTokens ?? 0,
          ...(res.usage.cachedInputTokens !== undefined ? { cachedInputTokens: res.usage.cachedInputTokens } : {}),
        },
        latencyMs: Date.now() - started,
        cacheHit: false,
        requestHash: requestHash(req, modelId, this.reasoningEffort ?? ''),
        finishReason: res.finishReason,
        reasoningTokens: res.usage.reasoningTokens,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  hashSalt(): string {
    return this.reasoningEffort ?? '';
  }
}

/** 脚本化 Stub：无 API key 时驱动端到端冒烟测试。 */
export class StubLlmClient implements LlmClient {
  public calls: LlmRequest[] = [];
  constructor(private script: (req: LlmRequest, index: number) => string | undefined) {}
  async modelId(tier: 'fast' | 'premium'): Promise<string> {
    return `stub-${tier}`;
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const text = this.script(req, this.calls.length - 1);
    if (text === undefined) throw new Error(`Stub LLM：没有为第 ${this.calls.length} 次调用（stage=${req.stage}）准备脚本`);
    const inTokens =
      req.messages && req.messages.length > 0
        ? req.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
        : estimateTokens(req.prompt);
    return {
      text,
      usage: { inputTokens: inTokens, outputTokens: estimateTokens(text) },
      latencyMs: 5,
      cacheHit: false,
      requestHash: requestHash(req, 'stub', ''),
    };
  }
}
