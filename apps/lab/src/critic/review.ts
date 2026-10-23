/**
 * 人工评分表聚合（方案 7.4 规程 / 9.1 的人工阈值）。
 *
 * 5 项人工阈值（「想看下一张」、N5 疲劳差、L5 习题感、以及 C1/C3 的人工确认部分）
 * 之前一件工具都没有：评过分也只能手算。这里把「回收 → 校验 → 算 α 与 ρ → 判阈值」串成一条命令。
 *
 * 输入是**长表 CSV**（一人一行一批评分）：
 * ```
 * rater,batch,want_next,fun,drill_feel,consistency
 * alice,0001,4,3,2,4
 * bob,0001,5,4,2,4
 * ```
 * - `rater` / `batch` 必需，其余数值列自动当成评分维度；
 * - `batch` 取渲染稿的序号（0001 → 1），与 `judge/judge.jsonl` 的 `0001.md` 对齐；
 * - 缺的维度留空即可（Krippendorff 按「该评审没参与这个单元」处理）。
 *
 * 阈值口径（9.1）：主评分项 `want_next` 在第 41–60 批的均分 ≥ 3.5；N5 = 第 41–60 批均分 − 第 1–20 批均分 ≥ −0.5；
 * L5 习题感（`drill_feel`）≤ 2.5；评审间 Krippendorff α ≥ 0.6；与评审模型的 Spearman ρ ≥ 0.5 才允许评审参与判定。
 */
import { krippendorffAlphaInterval, mean, meanCI, spearman } from './agreement.js';
import type { JudgeVerdict } from './judge.js';

export interface RatingRow {
  rater: string;
  batch: number;
  scores: Record<string, number>;
}

export interface ParsedRatings {
  rows: RatingRow[];
  dimensions: string[];
  errors: string[];
}

/** 主评分项（校准与「想看下一张」阈值都看它）。 */
export const MAIN_DIMENSION = 'want_next';
/** 习题感维度（越低越好）。 */
export const DRILL_DIMENSION = 'drill_feel';

const isNumeric = (s: string) => s.trim() !== '' && Number.isFinite(Number(s.trim()));

export function parseRatingsCsv(text: string): ParsedRatings {
  const errors: string[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { rows: [], dimensions: [], errors: ['评分表是空的'] };
  const split = (line: string) => line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
  const header = split(lines[0]!).map((h) => h.toLowerCase());
  const raterIdx = header.indexOf('rater');
  const batchIdx = header.indexOf('batch');
  if (raterIdx === -1 || batchIdx === -1) {
    return { rows: [], dimensions: [], errors: ['表头必须有 rater 与 batch 两列'] };
  }
  const dimensions = header.filter((h, i) => i !== raterIdx && i !== batchIdx && h !== '');
  const rows: RatingRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = split(lines[i]!);
    const rater = cells[raterIdx] ?? '';
    const batchRaw = cells[batchIdx] ?? '';
    if (rater === '' || batchRaw === '') {
      errors.push(`第 ${i + 1} 行缺 rater 或 batch`);
      continue;
    }
    const batch = Number(batchRaw.replace(/[^0-9]/g, ''));
    if (!Number.isFinite(batch) || batch === 0) {
      errors.push(`第 ${i + 1} 行的 batch「${batchRaw}」不是序号`);
      continue;
    }
    const scores: Record<string, number> = {};
    dimensions.forEach((dim) => {
      const raw = cells[header.indexOf(dim)] ?? '';
      if (!isNumeric(raw)) return;
      const v = Number(raw);
      if (v < 1 || v > 5) {
        errors.push(`第 ${i + 1} 行 ${dim}=${v} 超出 1–5`);
        return;
      }
      scores[dim] = v;
    });
    rows.push({ rater, batch, scores });
  }
  return { rows, dimensions, errors };
}

export interface DimensionStats {
  dimension: string;
  /** 全体均分 */
  mean: number;
  /** 参与打分的行数 */
  n: number;
  /** 分批次先按人取均值、再跨批取均值（阈值判定用这一列，避免打分多的人权重更大） */
  batchMean: number;
  /** 评审间一致性（Krippendorff α，interval）；唯一评审时为 null */
  alpha: number | null;
  /** 与评审模型的 Spearman ρ（给了 --judge 才算） */
  rhoJudge: number | null;
  /** ρ 的样本量（对齐上的批次数） */
  judgePairs: number;
}

export interface WindowStats {
  dimension: string;
  /** 第 1–20 批均分（按批） */
  low: number | null;
  /** 第 21–40 批均分 */
  mid: number | null;
  /** 第 41–60 批均分 */
  high: number | null;
  /** 疲劳差 = high − low */
  fatigue: number | null;
}

export interface ReviewCheck {
  name: string;
  value: string;
  threshold: string;
  pass: boolean | null;
}

export interface ReviewReport {
  raters: string[];
  batches: number[];
  dimensions: DimensionStats[];
  windows: WindowStats[];
  checks: ReviewCheck[];
  warnings: string[];
  markdown: string;
}

export interface ReviewOptions {
  /** 评审模型逐批判定（`lab judge` 的产出）；给了才算 ρ */
  judge?: JudgeVerdict[];
}

/** judge 的文件名（0001.md）→ 批次序号。 */
function judgeSeq(file: string): number {
  const m = /(\d+)/.exec(file);
  return m ? Number(m[1]) : NaN;
}

const inWindow = (batch: number, lo: number, hi: number) => batch >= lo && batch <= hi;

export function buildReviewReport(parsed: ParsedRatings, opts: ReviewOptions = {}): ReviewReport {
  const { rows, dimensions } = parsed;
  const raters = [...new Set(rows.map((r) => r.rater))].sort();
  const batches = [...new Set(rows.map((r) => r.batch))].sort((a, b) => a - b);
  const warnings = [...parsed.errors];
  if (raters.length < 2) {
    warnings.push('只有 1 位评审：Krippendorff α 无从计算，方案 7.4 要求 2–3 位评审。');
  }

  // 评审模型分数按批次索引（同一批取均值，重复评审时更稳）
  const judgeScores = new Map<number, Record<string, number>>();
  for (const v of opts.judge ?? []) {
    if (v.parseError || !v.scores) continue;
    const seq = judgeSeq(v.batchFile);
    if (!Number.isFinite(seq)) continue;
    judgeScores.set(seq, v.scores);
  }

  const dimensionStats: DimensionStats[] = dimensions.map((dimension) => {
    const values = rows.map((r) => r.scores[dimension]).filter((v): v is number => v !== undefined);
    // 每个批次的跨评审均分：阈值按「批」平均，不按「打分次数」平均
    const perBatch = batches
      .map((b) => rows.filter((r) => r.batch === b && r.scores[dimension] !== undefined).map((r) => r.scores[dimension]!))
      .filter((v) => v.length > 0);
    const units = perBatch.filter((v) => v.length >= 2);
    // ρ 的配对用「批次均分 vs 评审模型分」
    const pairXs: number[] = [];
    const pairYs: number[] = [];
    for (const b of batches) {
      const human = rows.filter((r) => r.batch === b && r.scores[dimension] !== undefined).map((r) => r.scores[dimension]!);
      const j = judgeScores.get(b)?.[dimension];
      if (human.length > 0 && typeof j === 'number') {
        pairXs.push(mean(human));
        pairYs.push(j);
      }
    }
    return {
      dimension,
      mean: mean(values),
      n: values.length,
      batchMean: mean(perBatch.map((v) => mean(v))),
      alpha: units.length >= 2 ? krippendorffAlphaInterval(units) : null,
      rhoJudge: judgeScores.size > 0 ? spearman(pairXs, pairYs) : null,
      judgePairs: pairYs.length,
    };
  });

  const windows: WindowStats[] = dimensions.map((dimension) => {
    const band = (lo: number, hi: number) => {
      const perBatch = batches
        .filter((b) => inWindow(b, lo, hi))
        .map((b) => {
          const v = rows.filter((r) => r.batch === b && r.scores[dimension] !== undefined).map((r) => r.scores[dimension]!);
          return v.length > 0 ? mean(v) : null;
        })
        .filter((v): v is number => v !== null);
      return perBatch.length > 0 ? mean(perBatch) : null;
    };
    const low = band(1, 20);
    const mid = band(21, 40);
    const high = band(41, 60);
    return { dimension, low, mid, high, fatigue: high !== null && low !== null ? high - low : null };
  });

  const checks: ReviewCheck[] = [];
  const main = dimensionStats.find((d) => d.dimension === MAIN_DIMENSION);
  const mainWindow = windows.find((w) => w.dimension === MAIN_DIMENSION);
  const drill = dimensionStats.find((d) => d.dimension === DRILL_DIMENSION);

  if (mainWindow?.high !== undefined && mainWindow.high !== null) {
    checks.push({
      name: '人工「想看下一张」第 41–60 批均分',
      value: mainWindow.high.toFixed(2),
      threshold: '≥ 3.5',
      pass: mainWindow.high >= 3.5,
    });
  } else {
    warnings.push('没有第 41–60 批的评分：该阈值要跑满 60 批后才有读数（当前批次范围 ' + (batches.length ? `${batches[0]}–${batches[batches.length - 1]}` : '空') + '）');
  }
  if (mainWindow?.fatigue !== undefined && mainWindow.fatigue !== null) {
    checks.push({
      name: 'N5 疲劳差（41–60 减 1–20）',
      value: mainWindow.fatigue.toFixed(2),
      threshold: '≥ −0.5',
      pass: mainWindow.fatigue >= -0.5,
    });
  }
  if (drill) {
    checks.push({ name: 'L5 习题感均分', value: drill.batchMean.toFixed(2), threshold: '≤ 2.5（越低越好）', pass: drill.batchMean <= 2.5 });
  }
  // 一致性：主评分项的 α 决定「这份评分能不能用」
  if (main) {
    checks.push({
      name: `评审间一致性 α（${MAIN_DIMENSION}，interval）`,
      value: main.alpha === null ? '不可判定（单一评审或批次数不足）' : main.alpha.toFixed(3),
      threshold: '≥ 0.6',
      pass: main.alpha === null ? null : main.alpha >= 0.6,
    });
    if (main.alpha !== null && main.alpha < 0.6) {
      warnings.push('α 未达标：先修订评分说明再重评一轮（方案 7.4），不要用这份评分下判定。');
    }
  }
  // 校准：主评分项的 ρ 决定「评审模型能不能参与判定」
  if (main?.rhoJudge !== null && main?.rhoJudge !== undefined) {
    checks.push({
      name: `评审模型校准 ρ（${MAIN_DIMENSION} vs LLM）`,
      value: `${main.rhoJudge.toFixed(3)}（${main.judgePairs} 批配对）`,
      threshold: '≥ 0.5',
      pass: main.rhoJudge >= 0.5,
    });
    if (main.rhoJudge < 0.5) warnings.push('ρ < 0.5：评审模型的打分只作参考，不参与判定（方案 5.12）。');
  } else if (judgeScores.size > 0) {
    warnings.push('给了评审模型结果，但同一批次上没有配对的人工评分：ρ 无法计算。');
  }

  const summary = { raters, batches, dimensions: dimensionStats, windows, checks, warnings };
  return { ...summary, markdown: renderReviewReport(summary) };
}

function renderReviewReport(r: Omit<ReviewReport, 'markdown'>): string {
  const lines: string[] = [];
  const pct = (x: number | null) => (x === null ? '—' : x.toFixed(2));
  lines.push('# 人工评分汇总（方案 7.4）');
  lines.push('');
  lines.push(`评审人 ${r.raters.length} 位（${r.raters.join(' / ')}），覆盖 ${r.batches.length} 批（${r.batches[0] ?? '-'}–${r.batches[r.batches.length - 1] ?? '-'}）。`);
  lines.push('');
  if (r.raters.length < 2) {
    lines.push('> ⚠ 只有 1 位评审：Krippendorff α 无法计算。方案 7.4 要求 2–3 位评审。');
    lines.push('');
  }
  lines.push('## 阈值判定');
  lines.push('');
  lines.push('| 项 | 值 | 阈值 | 判定 |');
  lines.push('|---|---|---|---|');
  for (const c of r.checks) {
    lines.push(`| ${c.name} | ${c.value} | ${c.threshold} | ${c.pass === null ? '—' : c.pass ? '✅' : '❌'} |`);
  }
  lines.push('');
  lines.push('## 各维度明细');
  lines.push('');
  lines.push('| 维度 | 批均分 | 打分次数 | α | ρ(vs 评审模型) |');
  lines.push('|---|---|---|---|---|');
  for (const d of r.dimensions) {
    lines.push(`| ${d.dimension} | ${d.batchMean.toFixed(2)} | ${d.n} | ${d.alpha === null ? '—' : d.alpha.toFixed(3)} | ${d.rhoJudge === null ? '—' : d.rhoJudge.toFixed(3)} |`);
  }
  lines.push('');
  lines.push('## 分段均分（看疲劳）');
  lines.push('');
  lines.push('| 维度 | 1–20 | 21–40 | 41–60 | 疲劳差 |');
  lines.push('|---|---|---|---|---|');
  for (const w of r.windows) {
    lines.push(`| ${w.dimension} | ${pct(w.low)} | ${pct(w.mid)} | ${pct(w.high)} | ${pct(w.fatigue)} |`);
  }
  if (r.warnings.length > 0) {
    lines.push('');
    lines.push('## 注意事项');
    lines.push('');
    for (const w of r.warnings) lines.push(`- ${w}`);
  }
  lines.push('');
  lines.push('> 口径：阈值按「批次均分」判定（先按人平均、再按批平均），不是按打分次数平均——否则打分多的人权重更大。');
  lines.push('> 连续阅读测试的总体「想继续」分与「最先觉得腻的批次号」不进这张表，须单独记录（方案 7.4）。');
  return lines.join('\n');
}

/** 评分表模板（每个评审一行，维度留空待填）。 */
export function ratingsTemplate(opts: { batches: number; raters: string[]; dimensions: string[] }): string {
  const head = ['rater', 'batch', ...opts.dimensions].join(',');
  const lines = [head];
  for (const rater of opts.raters) {
    for (let b = 1; b <= opts.batches; b++) {
      lines.push([rater, String(b).padStart(4, '0'), ...opts.dimensions.map(() => '')].join(','));
    }
  }
  return lines.join('\n') + '\n';
}

/** 均值 + 95% 区间（报告里给「这个均分的稳定性」一个交代）。 */
export function meanWithCI(values: number[]): { mean: number; lo: number; hi: number } {
  const ci = meanCI(values);
  return { mean: mean(values), lo: ci.lo, hi: ci.hi };
}
