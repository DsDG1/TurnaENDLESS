import { describe, expect, it, vi } from 'vitest';
import type { AiSdkClientOptions } from '@endless/director';
import { createProviderRunner } from '../src/provider.js';
import { complete, content } from './fixtures.js';

const config = {
  provider: { name: 'test', base_url: 'https://provider.example/v1' },
  models: { fast: 'test-model', premium: 'test-model' },
};
const factory = () => vi.fn((_options: AiSdkClientOptions) => ({
  modelId: async () => 'test-model',
  complete: async () => { throw new Error('simulated transport failure'); },
}));

describe('每任务临时模型凭据', () => {
  it('网页 Key 优先，下一次未提供时不沿用上一次的网页 Key', async () => {
    const createClient = factory();
    const run = createProviderRunner(content, config, 'synthetic-server-key', createClient);
    await expect(run(complete(), crypto.randomUUID(), () => {}, 'synthetic-page-key')).rejects.toThrow('simulated');
    await expect(run(complete(), crypto.randomUUID(), () => {})).rejects.toThrow('simulated');
    expect(createClient.mock.calls[0]?.[0]).toMatchObject({ apiKey: 'synthetic-page-key', maxRetries: 0 });
    expect(createClient.mock.calls[1]?.[0]).toMatchObject({ apiKey: 'synthetic-server-key', maxRetries: 0 });
  });

  it('没有任何 Key 时不创建模型客户端', async () => {
    const createClient = factory();
    const run = createProviderRunner(content, config, '', createClient);
    await expect(run(complete(), crypto.randomUUID(), () => {})).rejects.toThrow(/缺少 API Key/);
    expect(createClient).not.toHaveBeenCalled();
  });
});
