/**
 * 评审统计（Spearman ρ / Krippendorff α）与评分表聚合。
 *
 * α 的期望值用一份独立实现（Python，逐行按同一公式算）核对过，
 * 免得「公式看起来对、系数差一个常数」这种错悄悄进到判定里。
 */
import { describe, expect, it } from 'vitest';
import { averageRanks, krippendorffAlphaInterval, meanCI, spearman } from '../src/critic/agreement.js';
import { buildReviewReport, parseRatingsCsv, ratingsTemplate } from '../src/critic/review.js';

describe('Spearman ρ', () => {
  it('平均秩处理并列：1,2,2,4 → 1,2.5,2.5,4', () => {
    expect(averageRanks([1, 2, 2, 4])).toEqual([1, 2.5, 2.5, 4]);
    expect(averageRanks([3, 1, 1, 1])).toEqual([4, 2, 2, 2]);
  });

  it('完全单调递增 ρ = 1，完全反向 ρ = −1', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 10);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 10);
  });

  it('单调但非线性（对数关系）仍是 ρ = 1：ρ 只看秩序', () => {
    expect(spearman([1, 2, 3, 4, 5], [1, 4, 9, 16, 25])).toBeCloseTo(1, 10);
  });

  it('样本量不足或无变异时返回 null（不可判定，不是 0）', () => {
    expect(spearman([1, 2], [1, 2])).toBeNull();
    expect(spearman([3, 3, 3], [1, 2, 3])).toBeNull();
  });
});

describe('Krippendorff α（interval）', () => {
  it('两位评审完全一致 → α = 1', () => {
    expect(krippendorffAlphaInterval([[1, 1], [2, 2], [3, 3], [4, 4]])).toBeCloseTo(1, 10);
  });

  it('对照独立实现：[[1,2],[2,1],[3,4],[4,3]] → 0.65', () => {
    expect(krippendorffAlphaInterval([[1, 2], [2, 1], [3, 4], [4, 3]])).toBeCloseTo(0.65, 6);
  });

  it('对照独立实现：三评审混杂 → 0.111111', () => {
    expect(krippendorffAlphaInterval([[1, 2, 3], [2, 3, 4], [3, 3, 3]])).toBeCloseTo(1 / 9, 6);
  });

  it('对照独立实现：四位评审 → 0.342857', () => {
    const units = [
      [4, 5, 5, 4],
      [4, 4, 3, 2],
      [5, 5, 4, 4],
      [3, 4, 4, 3],
    ];
    expect(krippendorffAlphaInterval(units)).toBeCloseTo(0.342857, 5);
  });

  it('单一评审 / 有效单元不足 → null', () => {
    expect(krippendorffAlphaInterval([[1], [2], [3]])).toBeNull();
    expect(krippendorffAlphaInterval([[3, 3], [3, 3]])).toBeNull(); // 全体无变异
  });
});

describe('meanCI', () => {
  it('样本太少时返回 NaN（提示不要当结论用）', () => {
    expect(Number.isNaN(meanCI([3]).lo)).toBe(true);
  });

  it('区间包住均值', () => {
    const ci = meanCI([3, 4, 5, 4, 3]);
    expect(ci.lo).toBeLessThan(3.8);
    expect(ci.hi).toBeGreaterThan(3.8);
  });
});

describe('评分表聚合（lab review）', () => {
  const csv = (rows: string[]) => ['rater,batch,want_next,fun,drill_feel,consistency', ...rows].join('\n');

  const build60 = (rater: string, base: number, low = 0.4) =>
    Array.from({ length: 60 }, (_, i) => {
      const v = i < 20 ? base + low : i < 40 ? base : base - low;
      const w = Math.max(1, Math.min(5, Math.round(v)));
      return `${rater},${String(i + 1).padStart(4, '0')},${w},${w},2,4`;
    });

  it('解析：表头大小写、带前缀的批次号、越界分都要处理', () => {
    const parsed = parseRatingsCsv(
      ['Rater,Batch,want_next', 'alice,0001,4', 'bob,b-0002,5', 'carol,0003,9', 'dave,,4'].join('\n'),
    );
    // 越界分的那一行保留（人确实打了分），但该维度不采信
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[0]).toEqual({ rater: 'alice', batch: 1, scores: { want_next: 4 } });
    expect(parsed.rows[2]).toEqual({ rater: 'carol', batch: 3, scores: {} });
    expect(parsed.errors.some((e) => e.includes('超出 1–5'))).toBe(true);
    expect(parsed.errors.some((e) => e.includes('缺 rater 或 batch'))).toBe(true);
  });

  it('阈值按批次均分算：41–60 批均分 ≥ 3.5、N5 疲劳差、L5 习题感', () => {
    const parsed = parseRatingsCsv(csv([...build60('alice', 4, 0.3), ...build60('bob', 4, 0.3)]));
    const report = buildReviewReport(parsed);
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(byName['人工「想看下一张」第 41–60 批均分']?.pass).toBe(true);
    expect(Number(byName['N5 疲劳差（41–60 减 1–20）']?.value)).toBe(0);
    expect(byName['N5 疲劳差（41–60 减 1–20）']?.pass).toBe(true);
    expect(byName['L5 习题感均分']?.value).toBe('2.00');
    expect(byName['L5 习题感均分']?.pass).toBe(true);
  });

  it('只有 1–20 批时明确报「没有 41–60 批评分」，不假装达标', () => {
    const rows = Array.from({ length: 10 }, (_, i) => `alice,${String(i + 1).padStart(4, '0')},4,4,2,4`);
    const report = buildReviewReport(parseRatingsCsv(csv(rows)));
    expect(report.checks.some((c) => c.name.includes('41–60'))).toBe(false);
    expect(report.warnings.some((w) => w.includes('没有第 41–60 批'))).toBe(true);
  });

  it('单一评审：α 不可判定且有提示', () => {
    const report = buildReviewReport(parseRatingsCsv(csv(build60('alice', 4))));
    const alphaCheck = report.checks.find((c) => c.name.includes('一致性'));
    expect(alphaCheck?.pass).toBeNull();
    expect(report.warnings.some((w) => w.includes('只有 1 位评审'))).toBe(true);
  });

  it('给了评审模型结果：算 ρ，且 ρ < 0.5 时明确说「不参与判定」', () => {
    // 人工分在 1–5 之间交替，评审模型给反向分：ρ 应该显著为负
    const rows: string[] = [];
    for (let b = 1; b <= 12; b++) {
      const w = 1 + (b % 5); // 1..5 循环，保证有变异
      rows.push(`alice,${String(b).padStart(4, '0')},${w},4,2,4`);
      rows.push(`bob,${String(b).padStart(4, '0')},${w},4,2,4`);
    }
    const parsed = parseRatingsCsv(csv(rows));
    const judge = Array.from({ length: 12 }, (_, i) => {
      const b = i + 1;
      const human = 1 + (b % 5);
      return { batchFile: `${String(b).padStart(4, '0')}.md`, scores: { want_next: 6 - human } };
    });
    const report = buildReviewReport(parsed, { judge });
    const calib = report.checks.find((c) => c.name.includes('校准'));
    expect(calib).toBeDefined();
    expect(calib!.pass).toBe(false);
    expect(report.warnings.some((w) => w.includes('ρ < 0.5'))).toBe(true);
  });

  it('人工分毫无变异时 ρ 不可判定（null），不报「ρ = 0」', () => {
    const rows = Array.from({ length: 12 }, (_, i) => `alice,${String(i + 1).padStart(4, '0')},4,4,2,4`);
    const parsed = parseRatingsCsv(csv(rows));
    const judge = Array.from({ length: 12 }, (_, i) => ({
      batchFile: `${String(i + 1).padStart(4, '0')}.md`,
      scores: { want_next: 1 + (i % 5) },
    }));
    const report = buildReviewReport(parsed, { judge });
    const main = report.dimensions.find((d) => d.dimension === 'want_next');
    expect(main?.rhoJudge).toBeNull();
    expect(main?.judgePairs).toBe(12);
  });

  it('模板：每个评审 × 每批一行，维度留空', () => {
    const text = ratingsTemplate({ batches: 3, raters: ['a', 'b'], dimensions: ['want_next'] });
    const lines = text.trim().split('\n');
    expect(lines[0]).toBe('rater,batch,want_next');
    expect(lines).toHaveLength(7);
    expect(lines[1]).toBe('a,0001,');
  });
});
