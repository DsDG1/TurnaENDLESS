/**
 * 评审统计（方案 5.12 校准 / 7.4 信度）：Spearman ρ 与 Krippendorff α。
 *
 * 之前这两条只有文字规定、没有代码：评审模型「先校准再参与判定」无从执行，
 * 人工评分表回收后也没法算 α。这里把两个系数固化成可测的纯函数，
 * 让 `lab review` 能直接给出「这次评审能不能参与判定」。
 *
 * 口径：
 * - Spearman ρ 用**平均秩**处理并列（评分是 1–5 的整数，并列极多，不处理会把 ρ 算高）。
 * - Krippendorff α 用 **interval** 度量（1–5 分当等距量表）。
 *   区间度量的标准定义：Do 为单元内有序对差值平方的加权均值，De 为全体值两两差值的平方均值。
 *   本实现按「每个单元只取到场的评审」处理缺失值（Krippendorff 对缺失的原生处理方式）。
 */

/** 平均秩（并列取平均）：`[1,2,2,4] → [1,2.5,2.5,4]`。 */
export function averageRanks(xs: number[]): number[] {
  const order = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(xs.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.v === order[i]!.v) j++;
    const avg = (i + j) / 2 + 1; // 秩从 1 起
    for (let k = i; k <= j; k++) ranks[order[k]!.i] = avg;
    i = j + 1;
  }
  return ranks;
}

/**
 * Spearman 秩相关。样本量 < 3 或任一序列无变异时返回 null（相关系数无定义，不是 0）。
 */
export function spearman(x: number[], y: number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  const rx = averageRanks(x.slice(0, n));
  const ry = averageRanks(y.slice(0, n));
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i]! - mx;
    const b = ry[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

/**
 * Krippendorff α（interval 度量）。
 * `units`：每个评分单元（一个批次 × 一个维度）上各评审给出的分数；缺失用长度差表达。
 * 返回 null 表示无法计算（有效单元 < 2 或全体值无变异）。
 */
export function krippendorffAlphaInterval(units: number[][]): number | null {
  const usable = units.filter((u) => u.length >= 2);
  if (usable.length < 2) return null;
  const n = usable.reduce((s, u) => s + u.length, 0);
  if (n < 3) return null;

  // 观测不一致：每个单元内所有有序对的差值平方，除以 (m_u − 1)
  let doSum = 0;
  for (const u of usable) {
    let inner = 0;
    for (let i = 0; i < u.length; i++) {
      for (let j = 0; j < u.length; j++) {
        if (i === j) continue;
        inner += (u[i]! - u[j]!) ** 2;
      }
    }
    doSum += inner / (u.length - 1);
  }
  const Do = doSum / n;

  // 期望不一致：把全部值摊平，两两差值的平方均值（按 n(n−1) 归一）
  const all = usable.flat();
  let pairSum = 0;
  for (let i = 0; i < all.length; i++) {
    for (let j = 0; j < all.length; j++) {
      if (i === j) continue;
      pairSum += (all[i]! - all[j]!) ** 2;
    }
  }
  const De = pairSum / (all.length * (all.length - 1));
  if (De === 0) return null; // 所有评审给出同一个分：一致性无从定义
  return 1 - Do / De;
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, v) => s + v, 0) / xs.length;
}

/** 均值的 95% 置信区间（正态近似）：样本少时区间会很宽，报告里要一并给出。 */
export function meanCI(xs: number[]): { lo: number; hi: number } {
  if (xs.length < 2) return { lo: NaN, hi: NaN };
  const m = mean(xs);
  const variance = xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1);
  const se = Math.sqrt(variance / xs.length);
  return { lo: m - 1.96 * se, hi: m + 1.96 * se };
}
