/**
 * A4 端到端：传输失败不进 V2 分母，连续失败熔断。
 * 判据来自计划 A4：「前两次抛网络错、第三次成功 → 批次通过、transportRetries=2、V2 不变」；
 * 「一直返回 429 → 熔断生效」。
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { InMemoryWorldStore } from '@endless/world';
import { StubLlmClient, type LlmClient, type LlmRequest, type LlmResponse } from '@endless/director';
import { loadLabData } from '../src/data.js';
import { runExperiment, RunAbortedError } from '../src/pipeline.js';
import { makeStubScript } from '../src/stub.js';
import { smokeBrief } from '../src/smokebrief.js';
import { computeMetrics } from '../src/critic/metrics.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data');

/** 前 N 次调用抛网络错，之后透传到 Stub。按「每个请求」计，不按全局计。 */
class FlakyClient implements LlmClient {
  private seen = new Map<string, number>();
  constructor(
    private inner: LlmClient,
    private failuresPerRequest: number,
    private makeError: () => Error = () => new Error('fetch failed'),
  ) {}
  async modelId(tier: 'fast' | 'premium'): Promise<string> {
    return this.inner.modelId(tier);
  }
  hashSalt(): string {
    return this.inner.hashSalt?.() ?? '';
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const key = `${req.stage}:${req.prompt.slice(0, 80)}`;
    const n = this.seen.get(key) ?? 0;
    if (n < this.failuresPerRequest) {
      this.seen.set(key, n + 1);
      throw this.makeError();
    }
    this.seen.set(key, n + 1);
    return this.inner.complete(req);
  }
}

const baseRun = (llm: LlmClient, batches: number, extra: Record<string, unknown> = {}) => ({
  llm,
  batches,
  outDir: null,
  runId: 'resilience-test',
  persona: 'P1' as const,
  seed: 42,
  director: 'two-stage' as const,
  encoding: 'yaml' as const,
  derive: true,
  worldState: true,
  tropeLedgerOn: true,
  strategy: 'S-B' as const,
  feedbackLag: 2,
  channelOverride: 'duck_detective',
  briefOverrides: Array.from({ length: batches }, () => smokeBrief()),
  smokeSeed: true,
  retry: { maxAttempts: 4, baseDelayMs: 1, jitter: 0, sleep: async () => {} },
  ...extra,
});

describe('A4 传输层韧性', () => {
  it('每请求前两次网络错、第三次成功：批次全过、重试被计数、V2 不变', async () => {
    const data = await loadLabData(DATA_DIR);
    const flaky = new FlakyClient(new StubLlmClient(makeStubScript()), 2);
    const result = await runExperiment({
      data,
      store: new InMemoryWorldStore(),
      ...baseRun(flaky, 3),
    });
    expect(result.totals.batchesOk).toBe(3);
    expect(result.totals.transportFailed).toBe(0);
    // 每批 2 次调用（showrunner + writer），每次 2 次重试 → 每批 4 次
    expect(result.totals.transportRetries).toBeGreaterThanOrEqual(12);
    const metrics = computeMetrics(result);
    expect(metrics.executability.v2AfterRepairRate).toBe(1);
    expect(metrics.executability.transport.retries).toBeGreaterThanOrEqual(12);
  }, 60_000);

  it('传输重试耗尽：批次记 E-TRANSPORT 并从 V2 分母剔除', async () => {
    const data = await loadLabData(DATA_DIR);
    const dead = new FlakyClient(new StubLlmClient(makeStubScript()), 99, () =>
      Object.assign(new Error('too many requests'), { statusCode: 429 }),
    );
    const result = await runExperiment({
      data,
      store: new InMemoryWorldStore(),
      // 阈值放大，先只看「不熔断时怎么记」
      ...baseRun(dead, 2, { maxConsecutiveTransportFailures: 99 }),
    });
    expect(result.totals.transportFailed).toBe(2);
    expect(result.records.every((r) => r.issues.some((i) => i.code === 'E-TRANSPORT'))).toBe(true);
    const metrics = computeMetrics(result);
    // 分母被剔除后没有可判定批次：V2 记 0，但传输失败率 100% 会独立标红
    expect(metrics.executability.transport.evaluableBatches).toBe(0);
    expect(metrics.executability.transport.rate).toBe(1);
    expect(metrics.thresholds.some((t) => t.name.includes('传输失败率') && t.pass === false)).toBe(true);
  }, 60_000);

  it('连续 3 批传输失败触发熔断，并带出续跑命令', async () => {
    const data = await loadLabData(DATA_DIR);
    const dead = new FlakyClient(new StubLlmClient(makeStubScript()), 99, () =>
      Object.assign(new Error('too many requests'), { statusCode: 429 }),
    );
    const err = await runExperiment({
      data,
      store: new InMemoryWorldStore(),
      ...baseRun(dead, 6, { maxConsecutiveTransportFailures: 3, resumeHint: 'pnpm lab run --config x.yaml' }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunAbortedError);
    expect((err as RunAbortedError).consecutiveFailures).toBe(3);
    expect((err as RunAbortedError).resumeHint).toContain('pnpm lab run');
  }, 60_000);

  it('零星抖动不会误熔断：失败一批、成功一批后连续计数归零', async () => {
    const data = await loadLabData(DATA_DIR);
    const ok = new StubLlmClient(makeStubScript());
    // 前 4 次编剧室调用（正好耗尽 1 次调用链的 4 次尝试）永远 429，之后正常
    let showrunnerAttempts = 0;
    const llm: LlmClient = {
      modelId: (t) => ok.modelId(t),
      complete: async (req) => {
        if (req.stage === 'showrunner' && ++showrunnerAttempts <= 4) {
          throw Object.assign(new Error('too many requests'), { statusCode: 429 });
        }
        return ok.complete(req);
      },
    };
    const result = await runExperiment({
      data,
      store: new InMemoryWorldStore(),
      // 阈值 2：若计数不清零，第二、三批再失败就会熔断；这里只有首批失败，应当跑完
      ...baseRun(llm, 3, { maxConsecutiveTransportFailures: 2 }),
    });
    expect(result.totals.transportFailed).toBe(1);
    expect(result.totals.batchesOk).toBe(2);
  }, 60_000);
});
