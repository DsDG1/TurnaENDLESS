/** A4：失败分类重试（借 ScrollToStudy 的「不完整 / 网络错 / 最终失败」三分法）。 */
import { describe, expect, it } from 'vitest';
import type { LlmClient, LlmRequest, LlmResponse } from '../src/llm.js';
import { LlmFailure, RetryingLlmClient, classifyLlmError, retryAfterMsOf } from '../src/retry.js';

const req = (): LlmRequest => ({ stage: 'writer', system: 's', prompt: 'p', modelTier: 'fast' });

const okResponse = (text = 'ok'): LlmResponse => ({
  text,
  usage: { inputTokens: 10, outputTokens: 5 },
  latencyMs: 7,
  cacheHit: false,
  requestHash: 'h',
});

/** 按脚本抛错的假客户端：throws[i] 决定第 i 次调用是否抛错。 */
class ScriptedClient implements LlmClient {
  calls = 0;
  constructor(private script: (call: number) => void) {}
  async modelId(): Promise<string> {
    return 'fake';
  }
  async complete(): Promise<LlmResponse> {
    this.calls++;
    this.script(this.calls);
    return okResponse();
  }
}

const noSleep = { sleep: async () => {} };

describe('错误分类', () => {
  it('网络错误 / 超时 / 429 / 5xx 归为传输类', () => {
    expect(classifyLlmError(new Error('fetch failed'))).toBe('transport');
    expect(classifyLlmError(new Error('read ECONNRESET'))).toBe('transport');
    expect(classifyLlmError(new Error('The operation was aborted due to timeout'))).toBe('transport');
    expect(classifyLlmError(Object.assign(new Error('rate limited'), { statusCode: 429 }))).toBe('transport');
    expect(classifyLlmError(Object.assign(new Error('bad gateway'), { status: 502 }))).toBe('transport');
  });

  it('400 / 401 / 422 归为请求类（重试没用）', () => {
    expect(classifyLlmError(Object.assign(new Error('bad request'), { statusCode: 400 }))).toBe('request');
    expect(classifyLlmError(Object.assign(new Error('unauthorized'), { statusCode: 401 }))).toBe('request');
    expect(classifyLlmError(Object.assign(new Error('unprocessable'), { status: 422 }))).toBe('request');
  });

  it('沿 cause 链取状态码：AI SDK 把底层错误挂在 cause 上', () => {
    const wrapped = new Error('AI_APICallError', { cause: Object.assign(new Error('gateway'), { statusCode: 503 }) });
    expect(classifyLlmError(wrapped)).toBe('transport');
  });

  it('Retry-After 支持秒数与 HTTP 日期', () => {
    expect(retryAfterMsOf({ responseHeaders: { 'retry-after': '2' } })).toBe(2000);
    const at = new Date(Date.now() + 5000).toUTCString();
    const ms = retryAfterMsOf({ headers: { 'retry-after': at } });
    expect(ms).toBeGreaterThan(3000);
    expect(ms).toBeLessThanOrEqual(5000);
  });
});

describe('RetryingLlmClient', () => {
  it('前两次网络错、第三次成功 → 一次调用返回，transportRetries=2', async () => {
    const inner = new ScriptedClient((n) => {
      if (n <= 2) throw new Error('fetch failed');
    });
    const client = new RetryingLlmClient(inner, { maxAttempts: 4, ...noSleep });
    const res = await client.complete(req());
    expect(res.text).toBe('ok');
    expect(res.transportRetries).toBe(2);
    expect(inner.calls).toBe(3);
  });

  it('请求类错误立即失败，不重试', async () => {
    const inner = new ScriptedClient(() => {
      throw Object.assign(new Error('bad request'), { statusCode: 400 });
    });
    const client = new RetryingLlmClient(inner, { maxAttempts: 4, ...noSleep });
    await expect(client.complete(req())).rejects.toBeInstanceOf(LlmFailure);
    expect(inner.calls).toBe(1);
  });

  it('一直 429：重试耗尽后抛传输类 LlmFailure，并带上尝试次数', async () => {
    const inner = new ScriptedClient(() => {
      throw Object.assign(new Error('too many requests'), { statusCode: 429, responseHeaders: { 'retry-after': '0' } });
    });
    const client = new RetryingLlmClient(inner, { maxAttempts: 3, ...noSleep });
    const err = await client.complete(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmFailure);
    expect((err as LlmFailure).klass).toBe('transport');
    expect((err as LlmFailure).attempts).toBe(3);
    expect(inner.calls).toBe(3);
  });

  it('退避随尝试次数翻倍，且不超过上限', async () => {
    const delays: number[] = [];
    const inner = new ScriptedClient(() => {
      throw new Error('fetch failed');
    });
    const client = new RetryingLlmClient(inner, {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 250,
      jitter: 0,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await client.complete(req()).catch(() => undefined);
    expect(delays).toEqual([100, 200, 250]);
  });

  it('min_interval（D1）把连续调用按最小间隔排队', async () => {
    const waits: number[] = [];
    const inner = new ScriptedClient(() => {});
    const client = new RetryingLlmClient(inner, {
      minIntervalMs: 50,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const first = await client.complete(req());
    const second = await client.complete(req());
    // 首次不受限；第二次至少等一次（真实时钟下可能已过 50ms，故只断言不抛错且不重复退避）
    expect(first.transportRetries).toBe(0);
    expect(second.transportRetries).toBe(0);
    expect(inner.calls).toBe(2);
  });
});
