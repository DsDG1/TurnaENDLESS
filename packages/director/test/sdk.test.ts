import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText } from 'ai';
import { AiSdkLlmClient } from '../src/llm.js';

vi.mock('ai', () => ({ generateText: vi.fn() }));
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: () => ({ chatModel: () => ({ modelId: 'test-model' }) }),
}));

beforeEach(() => {
  vi.mocked(generateText).mockResolvedValue({
    text: '{}', usage: { inputTokens: 10, outputTokens: 5 }, finishReason: 'stop',
  } as Awaited<ReturnType<typeof generateText>>);
});

describe('应用模式的 SDK 传输重试', () => {
  it('调用方可关闭隐式重试，单次调用预算不被 SDK 放大', async () => {
    const client = new AiSdkLlmClient({
      providerName: 'test', baseURL: 'https://provider.example/v1', apiKey: 'not-a-secret',
      models: { fast: 'test-model', premium: 'test-model' }, maxRetries: 0,
    });
    await client.complete({ stage: 'single', system: 'test', prompt: 'test', modelTier: 'fast' });
    expect(generateText).toHaveBeenLastCalledWith(expect.objectContaining({ maxRetries: 0 }));
  });

  it('未指定时保持实验原有的 SDK 默认行为', async () => {
    const client = new AiSdkLlmClient({
      providerName: 'test', baseURL: 'https://provider.example/v1', apiKey: 'not-a-secret',
      models: { fast: 'test-model', premium: 'test-model' },
    });
    await client.complete({ stage: 'single', system: 'test', prompt: 'test', modelTier: 'fast' });
    expect(generateText).toHaveBeenLastCalledWith(expect.objectContaining({ maxRetries: undefined }));
  });
});
