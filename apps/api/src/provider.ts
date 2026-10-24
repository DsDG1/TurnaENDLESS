import { AiSdkLlmClient, type AiSdkClientOptions, type LlmClient } from '@endless/director';
import type { Content } from '@endless/content';
import { ApiError } from './jobs.js';
import { createGenerator } from './generate.js';

export interface ProviderConfig {
  provider: { name: string; base_url: string; reasoning_effort?: string; timeout_ms?: number };
  models: { fast: string; premium: string };
}

export function createProviderRunner(
  content: Content,
  config: ProviderConfig,
  serverKey = '',
  createClient: (options: AiSdkClientOptions) => LlmClient = (options) => new AiSdkLlmClient(options),
) {
  return async (save: unknown, id: string, phase: (value: string) => void, userKey?: string, archives?: import('@endless/content').ArchiveContextEntryWire[]) => {
    const apiKey = userKey || serverKey;
    if (!apiKey) throw new ApiError(401, '本次生成缺少 API Key，请在网页重新输入；密钥不会保存到任务中');
    const client = createClient({
      baseURL: config.provider.base_url, providerName: config.provider.name, apiKey,
      models: config.models, reasoningEffort: config.provider.reasoning_effort,
      timeoutMs: config.provider.timeout_ms, maxRetries: 0,
    });
    return createGenerator(content, client)(save, id, phase, undefined, archives);
  };
}
