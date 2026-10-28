/**
 * 生成执行端口对模型客户端的最小要求。
 *
 * 这里故意不 import `@endless/director`：本包只负责「已验证上下文 + 冻结计划时间 → 一个可验收的生成文档」，
 * 不能把供应商 SDK、本机 provider 配置或任何 HTTP 语义带进调用方。供应商客户端只要结构相符即可注入
 * （`apps/api/src/provider.ts` 的 director 客户端就是结构兼容的）。
 */
export interface GenerationLlmRequest {
  stage: string;
  system: string;
  prompt: string;
  modelTier: 'fast' | 'premium';
  temperature?: number;
  maxTokens?: number;
}

export interface GenerationLlmUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface GenerationLlmResponse {
  text: string;
  usage: GenerationLlmUsage;
}

/**
 * 端口只要求 text 与 token 用量；额外的供应商字段（延迟、缓存命中、请求哈希）由调用方客户端透传，
 * 计量层不裁剪它们，因此本机 director 客户端仍可原样注入。
 */
export interface GenerationLlm<Response extends GenerationLlmResponse = GenerationLlmResponse> {
  complete(request: GenerationLlmRequest): Promise<Response>;
  modelId(tier: 'fast' | 'premium'): Promise<string>;
}

export interface GenerationUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

/** 只累计本次生成的调用与 token；不做限额、不重试、不缓存、不裁剪供应商响应字段。 */
export class MeteredLlmClient<Response extends GenerationLlmResponse = GenerationLlmResponse> implements GenerationLlm<Response> {
  private calls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  constructor(private inner: GenerationLlm<Response>, private phase: (value: string) => void) {}
  modelId(tier: 'fast' | 'premium') { return this.inner.modelId(tier); }
  async complete(request: GenerationLlmRequest): Promise<Response> {
    this.calls++;
    this.phase(this.calls === 1 ? '正在生成剧情与互动' : '正在校验并修复内容');
    const response = await this.inner.complete(request);
    this.inputTokens += response.usage.inputTokens;
    this.outputTokens += response.usage.outputTokens;
    return response;
  }
  usage(): GenerationUsage { return { calls: this.calls, inputTokens: this.inputTokens, outputTokens: this.outputTokens }; }
}
