/**
 * LLM 接入（第 11 节）：Vercel AI SDK + OpenAI 兼容端点，供应商与模型写在 config/models.yaml。
 * API key 只由调用方从环境变量读取后注入，本包不碰任何凭据存储。
 * 每次调用按请求哈希缓存原始响应（第 10 节：LLM 输出不可复现 → 缓存以支持回放）。
 */
import { generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { fnv1a64, stableStringify } from '@endless/esl';
import { estimateTokens } from './context.js';

export interface LlmRequest {
  stage: string;
  system: string;
  prompt: string;
  modelTier: 'fast' | 'premium';
  temperature?: number;
  maxTokens?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  text: string;
  usage: LlmUsage;
  latencyMs: number;
  cacheHit: boolean;
  requestHash: string;
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

export const requestHash = (req: LlmRequest, modelId: string): string =>
  fnv1a64(stableStringify({ s: req.system, p: req.prompt, m: modelId, t: req.temperature ?? 0 }));

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
  /** 该档位的模型 ID（写入 calls.jsonl 与配置留档） */
  modelId(tier: 'fast' | 'premium'): Promise<string>;
}

/** 带缓存的装饰器：命中缓存不调用供应商（回放读缓存）。 */
export class CachingLlmClient implements LlmClient {
  constructor(private inner: LlmClient, private cache: LlmCache = new MemoryLlmCache()) {}
  async modelId(tier: 'fast' | 'premium'): Promise<string> {
    return this.inner.modelId(tier);
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const hash = requestHash(req, await this.inner.modelId(req.modelTier));
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
}

/** Vercel AI SDK 实现。 */
export class AiSdkLlmClient implements LlmClient {
  private models: { fast: string; premium: string };
  private provider: ReturnType<typeof createOpenAICompatible>;
  constructor(opts: AiSdkClientOptions) {
    this.provider = createOpenAICompatible({ name: opts.providerName, baseURL: opts.baseURL, apiKey: opts.apiKey });
    this.models = opts.models;
  }
  async modelId(tier: 'fast' | 'premium'): Promise<string> {
    return this.models[tier];
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const modelId = this.models[req.modelTier];
    const started = Date.now();
    const res = await generateText({
      model: this.provider.chatModel(modelId),
      system: req.system,
      prompt: req.prompt,
      temperature: req.temperature ?? 0.8,
      maxOutputTokens: req.maxTokens ?? 4096,
    });
    return {
      text: res.text,
      usage: {
        inputTokens: res.usage.inputTokens ?? 0,
        outputTokens: res.usage.outputTokens ?? 0,
      },
      latencyMs: Date.now() - started,
      cacheHit: false,
      requestHash: fnv1a64(stableStringify({ s: req.system, p: req.prompt, m: modelId, t: req.temperature ?? 0 })),
    };
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
    return {
      text,
      usage: { inputTokens: estimateTokens(req.prompt), outputTokens: estimateTokens(text) },
      latencyMs: 5,
      cacheHit: false,
      requestHash: fnv1a64(stableStringify({ s: req.system, p: req.prompt, m: 'stub', t: 0 })),
    };
  }
}
