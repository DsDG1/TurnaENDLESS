/** srs-sim / buffer-sim / metrics 的行为测试（小参数快速验证）。 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSrsSim } from '../src/srsim.js';
import { sweepBuffer } from '../src/buffersim.js';
import { readLatencySummary } from '../src/latency.js';
import { readReplayEvents, replayStrategies } from '../src/srsreplay.js';
import { computeMetrics, metricsMarkdown } from '../src/critic/metrics.js';

describe('srs-sim（RQ6）', () => {
  it('三种策略产出有限的校准指标且策略间有差异', () => {
    const report = runSrsSim({ items: 60, days: 30, seeds: 1, introducePerDay: 4, reviewsPerDay: 15 });
    expect(report.byStrategy).toHaveLength(3);
    for (const s of report.byStrategy) {
      expect(Number.isFinite(s.brier)).toBe(true);
      expect(Number.isFinite(s.ece)).toBe(true);
      expect(s.retention).toBeGreaterThan(0);
      expect(s.reviewsPerItem).toBeGreaterThan(1);
    }
    const strategies = report.byStrategy.map((s) => s.strategy).sort();
    expect(strategies).toEqual(['S-A', 'S-B', 'S-C']);
    expect(report.markdown).toContain('H6');
    expect(report.runs.length).toBe(9); // 3 策略 × 3 画像 × 1 种子
  });
});

describe('buffer-sim（K4）', () => {
  it('生成远快于消费时几乎不卡顿；生成远慢时卡顿', () => {
    const fast = sweepBuffer({
      persona: 'P2',
      buffers: [2],
      prefetched: [3],
      batches: 60,
      genMedianMs: 500,
      genSigma: 0.3,
      seed: 1,
    });
    expect(fast.results[0]!.stallProbability).toBeLessThan(0.1);
    const slow = sweepBuffer({
      persona: 'P1',
      buffers: [1],
      prefetched: [0],
      batches: 60,
      genMedianMs: 60_000,
      genSigma: 0.3,
      seed: 1,
    });
    expect(slow.results[0]!.stallProbability).toBeGreaterThan(0.5);
  });

  it('矩阵报告包含判定格', () => {
    const { markdown } = sweepBuffer({ batches: 30 });
    expect(markdown).toContain('判定格');
    expect(markdown).toContain('缓冲 B');
  });

  it('实测时延样本取代对数正态：慢样本必然卡，快样本几乎不卡', () => {
    const slow = sweepBuffer({
      persona: 'P1',
      buffers: [2],
      prefetched: [3],
      batches: 60,
      seed: 1,
      genSamples: [55_000, 58_000, 60_000, 62_000, 120_000],
      latencySource: 'calls.jsonl',
    });
    expect(slow.results[0]!.stallProbability).toBeGreaterThan(0.5);
    expect(slow.markdown).toContain('实测经验分布');
    expect(slow.markdown).toContain('生成/消费');

    const fast = sweepBuffer({
      persona: 'P2',
      buffers: [2],
      prefetched: [3],
      batches: 60,
      seed: 1,
      genSamples: [2000, 2500, 3000, 3500, 4000],
    });
    expect(fast.results[0]!.stallProbability).toBeLessThan(0.1);
  });

  it('不传样本时报告明确标注「假设值，不是实测」', () => {
    const { markdown } = sweepBuffer({ batches: 10 });
    expect(markdown).toContain('假设值');
  });
});

describe('实测时延读取（calls.jsonl）', () => {
  it('按 seq 汇总每批时延，跳过 failed 行，给出 P50/P95', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'endless-latency-'));
    const lines = [
      { seq: 1, latencyMs: 1000 },
      { seq: 1, latencyMs: 3000 },
      { seq: 2, latencyMs: 6000 },
      { seq: 3, latencyMs: 1, failed: true },
      { seq: 3, latencyMs: 12000 },
      { seq: 4, latencyMs: 2000, transportWaitMs: 500 },
    ];
    await writeFile(join(dir, 'calls.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    const summary = await readLatencySummary(dir);
    expect(summary.batches).toEqual([2000, 4000, 6000, 12000]);
    expect(summary.calls).toHaveLength(5); // failed 行不计
    expect(summary.p50BatchMs).toBeGreaterThan(0);
    expect(summary.meanCallsPerBatch).toBeCloseTo(5 / 4, 5);
  });

  it('没有调用记录时明确报错，不静默返回 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'endless-latency-empty-'));
    await writeFile(join(dir, 'calls.jsonl'), '', 'utf8');
    await expect(readLatencySummary(dir)).rejects.toThrow(/没有可用的调用记录/);
  });
});

describe('S-R 回放（真实产出）', () => {
  const feedbackLines = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      const seq = i + 1;
      return JSON.stringify({
        batch: `b-${String(seq).padStart(4, '0')}`,
        seq,
        cards: [0, 1, 2, 3],
        scenes: [
          { sceneId: 's1', dwellMs: 4000, completed: true, skipped: false },
          {
            sceneId: 's2',
            dwellMs: 4000,
            completed: true,
            skipped: false,
            // 交替出 recognition-2 / recognition-4，让三种策略的写入次数不同
            evidence: {
              item: `lx:item${i % 3}#prep.location`,
              type: i % 2 === 0 ? 'recognition-2' : 'recognition-4',
              correct: i % 3 !== 0,
              attempts: 1,
              qualified: true,
              primed: false,
            },
          },
        ],
      });
    }).join('\n') + '\n';

  it('从 feedback.jsonl 提取检索事件：跳过无证据场景，按累计卡数换算学习日', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'endless-replay-'));
    await writeFile(join(dir, 'feedback.jsonl'), feedbackLines(6), 'utf8');
    const { events, batches } = await readReplayEvents(dir);
    expect(batches).toBe(6);
    expect(events).toHaveLength(6); // 每批 1 个检测场景
    expect(events[0]!.day).toBe(0); // 前 60 张卡仍在第 0 天
    expect(new Set(events.map((e) => e.item)).size).toBe(3);
  });

  it('三种策略吃同一条事件流：S-A 写入 FSRS 的次数最多', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'endless-replay2-'));
    await writeFile(join(dir, 'feedback.jsonl'), feedbackLines(20), 'utf8');
    const { events, batches } = await readReplayEvents(dir);
    const report = replayStrategies(events, ['S-A', 'S-B', 'S-C'], batches);
    expect(report.events).toBe(20);
    const by = Object.fromEntries(report.byStrategy.map((s) => [s.strategy, s]));
    expect(by['S-A']!.fsrsReviews).toBeGreaterThanOrEqual(by['S-B']!.fsrsReviews);
    expect(by['S-C']!.fsrsReviews).toBeLessThanOrEqual(by['S-A']!.fsrsReviews);
    expect(report.markdown).toContain('H6 判读');
    // 确定性：同样输入两次结果一致
    const again = replayStrategies(events, ['S-A', 'S-B', 'S-C'], batches);
    expect(again.byStrategy.map((s) => s.fsrsReviews)).toEqual(report.byStrategy.map((s) => s.fsrsReviews));
  });

  it('没有任何检索事件时报告明确说明无法回放', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'endless-replay3-'));
    await writeFile(
      join(dir, 'feedback.jsonl'),
      JSON.stringify({ batch: 'b-1', seq: 1, cards: [0, 1], scenes: [{ sceneId: 's1', dwellMs: 1, completed: true, skipped: false }] }) + '\n',
      'utf8',
    );
    const { events } = await readReplayEvents(dir);
    const report = replayStrategies(events);
    expect(report.events).toBe(0);
    expect(report.markdown).toContain('没有任何检索型证据事件');
  });
});

describe('metrics', () => {
  it('空运行不崩溃并产出报告骨架', () => {
    const m = computeMetrics(
      {
        runId: 'empty',
        records: [],
        played: [],
        briefs: new Map(),
        feedbacks: [],
        ledgerEntries: [],
        sim: undefined as never,
        srs: undefined as never,
        ability: undefined as never,
        exposureCounts: new Map(),
        introduced: new Set(),
        totals: { batchesOk: 0, batchFailed: 0, transportFailed: 0, transportRetries: 0, incompleteCalls: 0, aliasHits: 0, aliasNeeds: 0, droppedScenes: 0, cards: 0, tokensIn: 0, tokensOut: 0, calls: 0, firstPass: 0, rawFirstPass: 0 },
      },
      {},
    );
    expect(m.batches).toBe(0);
    const md = metricsMarkdown(m);
    expect(md).toContain('运行报告');
    expect(md).toContain('阈值判定');
    // 分母为 0 时必须是「不可判定」，不能报 100%
    expect(m.learning.l1Coverage).toBeNull();
    expect(m.learning.l2QualifiedRatio).toBeNull();
    expect(m.learning.l4.rate).toBeNull();
  });

  it('重写净效果：首版带错的批次分别记为救回/丢掉，首版干净却失败的单独计数', () => {
    const err = [{ code: 'E-SCHEMA', level: 'error' as const, message: 'x' }];
    const rec = (seq: number, ok: boolean, firstDraftIssues: { code: string; level: 'error' | 'warn'; message: string }[]) => ({
      seq,
      batchId: `b-${seq}`,
      channel: 'duck_detective',
      briefId: 'lb-1',
      cards: 4,
      ok,
      firstPass: ok && firstDraftIssues.length === 0,
      rawFirstPass: firstDraftIssues.length === 0,
      firstDraftIssues,
      repairRounds: 0,
      droppedScenes: [],
      batchFailed: !ok,
      issues: [],
      factRefs: 0,
      oovRatio: null,
      tropes: [],
      logline: '',
      calls: [],
      v5Revalidated: false,
      v5Regenerated: false,
      tokensIn: 0,
      tokensOut: 0,
    });
    const m = computeMetrics(
      {
        runId: 'rewrite-effect',
        records: [rec(1, true, err), rec(2, false, err), rec(3, false, []), rec(4, true, [])] as never,
        played: [],
        briefs: new Map(),
        feedbacks: [],
        ledgerEntries: [],
        sim: undefined as never,
        srs: undefined as never,
        ability: undefined as never,
        exposureCounts: new Map(),
        introduced: new Set(),
        totals: { batchesOk: 2, batchFailed: 2, transportFailed: 0, transportRetries: 0, incompleteCalls: 0, aliasHits: 0, aliasNeeds: 0, droppedScenes: 0, cards: 16, tokensIn: 0, tokensOut: 0, calls: 0, firstPass: 2, rawFirstPass: 2 },
      },
      {},
    );
    expect(m.executability.rewriteEffect).toEqual({ firstDraftDirty: 2, recovered: 1, lost: 1, cleanButFailed: 1 });
    expect(metricsMarkdown(m)).toContain('重写净效果：首版带阻塞错误 2 批 → 救回 1 批、丢掉 1 批');
    expect(metricsMarkdown(m)).toContain('另有 1 批首版干净却最终失败');
  });
});
