/**
 * 证据策略对照（第 5.3.4 节 RQ6 / 第 7.2 节）：合成事件流，不调用 LLM。
 * 300 条目 × 60 模拟日 × 3 画像 × 3 策略 × N 种子；
 * 输出 L6（SRS 校准：Brier / ECE）与 L7（保持率与效率），并对比 H6。
 */
import { EvidenceProcessor, SrsStore, type Strategy } from '@endless/learning';
import { LearnerSimulator, type PersonaId } from './sim/learner.js';
import { mulberry32 } from './sim/rng.js';

export interface SrsSimOptions {
  items: number;
  days: number;
  personas: PersonaId[];
  strategies: Strategy[];
  seeds: number;
  introducePerDay: number;
  reviewsPerDay: number;
}

export const DEFAULT_SRS_SIM: SrsSimOptions = {
  items: 300,
  days: 60,
  personas: ['P1', 'P2', 'P3'],
  strategies: ['S-A', 'S-B', 'S-C'],
  // 方案 7.2 要求 5 个种子：校准误差结论要在种子之间稳定，2 个种子的均值容易被单次抽样左右
  seeds: 5,
  introducePerDay: 5,
  reviewsPerDay: 25,
};

export interface CalibPoint {
  predicted: number;
  trueRecall: number;
  correct: boolean;
}

export interface StrategyRunResult {
  strategy: Strategy;
  persona: PersonaId;
  seed: number;
  /** Brier（对二元结果） */
  brier: number;
  /** Brier（对真实回忆率 R_true，连续结局） */
  brierTrue: number;
  /** ECE（10 档分箱，对二元结果） */
  ece: number;
  bins: { lo: number; hi: number; n: number; predMean: number; obsRate: number }[];
  /** 第 60 模拟日的平均真实回忆率（L7） */
  retention: number;
  /** 每条目平均复习次数（L7） */
  reviewsPerItem: number;
  /** 写入 FSRS 的复习次数 */
  fsrsReviews: number;
  calibPoints: CalibPoint[];
}

const BASE = new Date('2026-01-01T09:00:00Z');
const dayAt = (d: number) => new Date(BASE.getTime() + d * 86_400_000);

function runOne(strategy: Strategy, persona: PersonaId, seed: number, opts: SrsSimOptions): StrategyRunResult {
  const items = Array.from({ length: opts.items }, (_, i) => `sim-${String(i).padStart(3, '0')}`);
  const sim = new LearnerSimulator(persona, seed);
  sim.seedKnowledge(items);
  const srs = new SrsStore();
  const processor = new EvidenceProcessor(strategy);
  const rng = mulberry32(seed * 7919 + 13);

  const introduced: string[] = [];
  const calib: CalibPoint[] = [];
  let totalReviews = 0;
  let fsrsReviews = 0;

  for (let day = 1; day <= opts.days; day++) {
    const now = dayAt(day);
    // 新条目（按序引入；当天完成首次检测——视作已满足 2 次曝光门槛后的第一次检索）
    while (introduced.length < opts.items && introduced.length < day * opts.introducePerDay) {
      const item = items[introduced.length]!;
      introduced.push(item);
      const guess = 0.25;
      const correct = sim.answer(item, guess, day);
      const outcome = processor.process({ item, facet: 'meaning', type: 'recognition-4', correct });
      totalReviews++;
      if (outcome.fsrsGrade) {
        fsrsReviews++;
        // 首次复习没有预测基线，跳过校准点；只推进卡片
        srs.grade(item, 'meaning', outcome.fsrsGrade, now);
      }
      if (correct) sim.settleCorrect(item);
      else sim.settleWrong(item);
    }
    // 到期复习（R2 优先序，含学习步进内的到期卡），上限 reviewsPerDay
    const due = srs.dueItems(now, 'meaning', true).filter((d) => introduced.includes(d.item)).slice(0, opts.reviewsPerDay);
    for (const d of due) {
      const r = rng();
      const type = r < 0.5 ? 'recognition-4' : r < 0.8 ? 'recognition-2' : 'listening-4';
      const guess = type === 'recognition-4' ? 0.25 : type === 'recognition-2' ? 0.5 : 0.25;
      const trueRecall = sim.recall(d.item, 'meaning', day);
      const correct = sim.answer(d.item, guess, day, { listening: type === 'listening-4' });
      const outcome = processor.process({ item: d.item, facet: 'meaning', type: type as never, correct });
      totalReviews++;
      if (outcome.fsrsGrade) {
        fsrsReviews++;
        const predicted = srs.predictedRecall(d.item, 'meaning', now) ?? 0.9;
        calib.push({ predicted, trueRecall, correct });
        srs.grade(d.item, 'meaning', outcome.fsrsGrade, now);
      } else {
        // 不写 FSRS 的证据也弱更新能力侧（此处无能力估计器，只更新真值）
      }
      if (correct) sim.settleCorrect(d.item);
      else sim.settleWrong(d.item);
    }
  }

  const brier = calib.length ? calib.reduce((s, p) => s + (p.predicted - (p.correct ? 1 : 0)) ** 2, 0) / calib.length : 0;
  const brierTrue = calib.length ? calib.reduce((s, p) => s + (p.predicted - p.trueRecall) ** 2, 0) / calib.length : 0;
  const { bins, ece } = calibrationBins(calib);
  return {
    strategy,
    persona,
    seed,
    brier,
    brierTrue,
    ece,
    bins,
    retention: sim.meanRecallAt(introduced, opts.days),
    reviewsPerItem: introduced.length ? totalReviews / introduced.length : 0,
    fsrsReviews,
    calibPoints: calib,
  };
}

/**
 * 10 档 ECE（第 6.3 节 L6）。抽出来单独导出：合成流（srs-sim）与真实产出回放（srs-replay）
 * 必须用同一套分箱口径，否则两条腿的数字不能放在一张表里比。
 */
export function calibrationBins(points: { predicted: number; correct: boolean }[]): {
  bins: StrategyRunResult['bins'];
  ece: number;
} {
  const bins: StrategyRunResult['bins'] = [];
  for (let b = 0; b < 10; b++) {
    const lo = b / 10;
    const hi = (b + 1) / 10;
    const inBin = points.filter((p) => p.predicted >= lo && p.predicted < hi + (b === 9 ? 0.01 : 0));
    if (inBin.length === 0) continue;
    bins.push({
      lo,
      hi,
      n: inBin.length,
      predMean: inBin.reduce((s, p) => s + p.predicted, 0) / inBin.length,
      obsRate: inBin.filter((p) => p.correct).length / inBin.length,
    });
  }
  const ece = bins.reduce((s, b) => s + (b.n / Math.max(1, points.length)) * Math.abs(b.predMean - b.obsRate), 0);
  return { bins, ece };
}

export interface SrsSimReport {
  options: SrsSimOptions;
  runs: StrategyRunResult[];
  byStrategy: {
    strategy: Strategy;
    brier: number;
    brierTrue: number;
    ece: number;
    retention: number;
    reviewsPerItem: number;
    fsrsReviews: number;
  }[];
  markdown: string;
}

export function runSrsSim(opts: Partial<SrsSimOptions> = {}): SrsSimReport {
  const options = { ...DEFAULT_SRS_SIM, ...opts };
  const runs: StrategyRunResult[] = [];
  for (const strategy of options.strategies) {
    for (const persona of options.personas) {
      for (let seed = 1; seed <= options.seeds; seed++) {
        runs.push(runOne(strategy, persona, seed, options));
      }
    }
  }
  const byStrategy = options.strategies.map((strategy) => {
    const rs = runs.filter((r) => r.strategy === strategy);
    const mean = (f: (r: StrategyRunResult) => number) => rs.reduce((s, r) => s + f(r), 0) / Math.max(1, rs.length);
    return {
      strategy,
      brier: mean((r) => r.brier),
      brierTrue: mean((r) => r.brierTrue),
      ece: mean((r) => r.ece),
      retention: mean((r) => r.retention),
      reviewsPerItem: mean((r) => r.reviewsPerItem),
      fsrsReviews: mean((r) => r.fsrsReviews),
    };
  });
  const md = renderSrsReport(options, byStrategy, runs);
  return { options, runs, byStrategy, markdown: md };
}

function renderSrsReport(
  options: SrsSimOptions,
  byStrategy: SrsSimReport['byStrategy'],
  runs: StrategyRunResult[],
): string {
  const lines: string[] = [];
  lines.push('# 证据策略对照报告（RQ6 / S-A · S-B · S-C）');
  lines.push('');
  lines.push(`设置：${options.items} 条目 × ${options.days} 模拟日 × ${options.personas.join('/')} × ${options.seeds} 种子，每日引入 ≤ ${options.introducePerDay}、复习 ≤ ${options.reviewsPerDay}。不调用 LLM。`);
  lines.push('');
  lines.push('| 策略 | Brier(二元) | Brier(对 R_true) | ECE | 保持率(第60日) | 平均复习/条目 | 写入 FSRS 次数 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const s of byStrategy) {
    lines.push(
      `| ${s.strategy} | ${s.brier.toFixed(4)} | ${s.brierTrue.toFixed(4)} | ${s.ece.toFixed(4)} | ${(s.retention * 100).toFixed(1)}% | ${s.reviewsPerItem.toFixed(1)} | ${s.fsrsReviews.toFixed(0)} |`,
    );
  }
  lines.push('');
  const best = [...byStrategy].sort((a, b) => a.ece - b.ece)[0] ?? byStrategy[0];
  if (!best) return lines.join('\n');
  lines.push(`## H6 判读`);
  lines.push('');
  lines.push(`- 校准误差（ECE）最小的策略：**${best.strategy}**（ECE ${best.ece.toFixed(4)}）。`);
  const sa = byStrategy.find((s) => s.strategy === 'S-A');
  const sb = byStrategy.find((s) => s.strategy === 'S-B');
  if (sa && sb) {
    lines.push(
      sa.ece > sb.ece
        ? `- 与 H6 一致的迹象：S-A（二选一也计入复习）的 ECE 高于 S-B（按证据分级），说明弱证据推高 FSRS 的预测、造成系统性高估。`
        : `- 与 H6 不一致：S-A 的 ECE 不高于 S-B，需要检查合成流的证据类型比例假设。`,
    );
  }
  lines.push('');
  lines.push(`## 分策略 × 画像明细`);
  lines.push('');
  lines.push('| 策略 | 画像 | 种子 | Brier | ECE | 保持率 | 复习/条目 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of runs) {
    lines.push(`| ${r.strategy} | ${r.persona} | ${r.seed} | ${r.brier.toFixed(4)} | ${r.ece.toFixed(4)} | ${(r.retention * 100).toFixed(1)}% | ${r.reviewsPerItem.toFixed(1)} |`);
  }
  lines.push('');
  lines.push('> 注意（第 10 节风险表）：模拟学习者与真人差距大，本结论只作为调度逻辑的自洽检查；真人效果留给实验 2。');
  return lines.join('\n');
}
