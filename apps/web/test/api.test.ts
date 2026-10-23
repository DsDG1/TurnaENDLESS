import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateEpisode } from '../src/api.js';
import { complete, generated } from '../../api/test/fixtures.js';

afterEach(() => vi.unstubAllGlobals());

const status = {
  configured: false, acceptsUserKey: true, model: 'test-model', token: 'test-token',
  quota: { dailyLimit: 10, used: 0, remaining: 10 },
};
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

describe('浏览器临时 Key 传输', () => {
  it('只在提交时使用独立请求头，存档正文和轮询都不携带 Key', async () => {
    const key = 'synthetic-page-only-key';
    const input = { requestId: crypto.randomUUID(), save: complete() };
    const result = generated(input.save, `ai-${input.requestId}`);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(status))
      .mockResolvedValueOnce(response({ id: input.requestId, status: 'running', phase: '生成中' }))
      .mockResolvedValueOnce(response({ id: input.requestId, status: 'succeeded', phase: '已完成', result }));
    vi.stubGlobal('fetch', fetcher);
    expect(await generateEpisode(input, () => {}, new AbortController().signal, key)).toMatchObject({ failed: false });
    const submitted = fetcher.mock.calls[1]![1]!;
    expect(new Headers(submitted.headers).get('X-Endless-Provider-Key')).toBe(key);
    expect(submitted.body).not.toContain(key);
    expect(new Headers(fetcher.mock.calls[2]![1]!.headers).has('X-Endless-Provider-Key')).toBe(false);
    expect(new Headers(fetcher.mock.calls[0]![1]!.headers).has('X-Endless-Provider-Key')).toBe(false);
  });

  it('刷新丢失 Key 后仍可提交相同任务 ID 进行恢复查询', async () => {
    const input = { requestId: crypto.randomUUID(), save: complete() };
    const result = generated(input.save, `ai-${input.requestId}`);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(status))
      .mockResolvedValueOnce(response({ id: input.requestId, status: 'succeeded', phase: '已完成', result }));
    vi.stubGlobal('fetch', fetcher);
    expect(await generateEpisode(input, () => {}, new AbortController().signal, '', true)).toMatchObject({ failed: false });
    expect(new Headers(fetcher.mock.calls[1]![1]!.headers).has('X-Endless-Provider-Key')).toBe(false);
  });

  it('无 Key 的新任务、旧服务端、格式错误均不会发起生成调用', async () => {
    const input = { requestId: crypto.randomUUID(), save: complete() };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(status));
    vi.stubGlobal('fetch', fetcher);
    await expect(generateEpisode(input, () => {}, new AbortController().signal)).rejects.toThrow(/输入自己的 API Key/);
    await expect(generateEpisode(input, () => {}, new AbortController().signal, 'synthetic key with spaces')).rejects.toThrow(/格式/);
    fetcher.mockResolvedValue(response({ ...status, acceptsUserKey: false }));
    await expect(generateEpisode(input, () => {}, new AbortController().signal, 'synthetic-key')).rejects.toThrow(/更新并重启/);
    expect(fetcher.mock.calls.every(([path]) => path === '/api/status')).toBe(true);
  });
});
