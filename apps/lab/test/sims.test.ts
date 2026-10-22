/** srs-sim / buffer-sim / metrics 的行为测试（小参数快速验证）。 */
import { describe, expect, it } from 'vitest';
import { runSrsSim } from '../src/srsim.js';
import { sweepBuffer } from '../src/buffersim.js';
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
        totals: { batchesOk: 0, batchFailed: 0, droppedScenes: 0, cards: 0, tokensIn: 0, tokensOut: 0, calls: 0, firstPass: 0, rawFirstPass: 0 },
      },
      {},
    );
    expect(m.batches).toBe(0);
    const md = metricsMarkdown(m);
    expect(md).toContain('运行报告');
    expect(md).toContain('阈值判定');
  });
});
