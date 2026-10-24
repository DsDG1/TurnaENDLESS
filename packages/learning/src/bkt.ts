/**
 * 单技能 BKT 能力估计器（第 5.3.3 节）：输出用于决定「已知词集合」和新条目的引入时机，
 * 不影响 FSRS 的调度。四参数：p_init、p_learn、p_guess（取证据类型的猜对率 g）、p_slip=0.1。
 */
import type { Facet } from './lexicon.js';

export interface BktParams {
  pInit: number;
  pLearn: number;
  pSlip: number;
}

export const DEFAULT_BKT: BktParams = { pInit: 0.2, pLearn: 0.15, pSlip: 0.1 };

/** 各证据类型的猜对率 g（第 5.3.3 节表格）。 */
export const GUESS_RATE: Record<string, number> = {
  'recognition-2': 0.5,
  'recognition-4': 0.25,
  'listening-4': 0.25,
  production: 0.02,
};

/** 弱更新步长：曝光 / comprehension / retry 只小幅移动掌握概率（初始值）。 */
export const WEAK_STEP = 0.05;

export class AbilityEstimator {
  private mastery = new Map<string, number>();
  constructor(private params: BktParams = DEFAULT_BKT) {}

  get(item: string): number {
    return this.mastery.get(item) ?? this.params.pInit;
  }

  /** 一次检索证据后的贝叶斯更新。guess 取该证据类型的 g。 */
  update(item: string, correct: boolean, guess: number): number {
    const pL = this.get(item);
    const { pSlip, pLearn } = this.params;
    const pHits = correct ? pL * (1 - pSlip) : pL * pSlip;
    const pMisses = correct ? (1 - pL) * guess : (1 - pL) * (1 - guess);
    const posterior = pHits / (pHits + pMisses);
    const after = posterior + (1 - posterior) * pLearn;
    this.mastery.set(item, after);
    return after;
  }

  /** 弱更新：曝光、comprehension、retry、practice。 */
  weakUpdate(item: string): number {
    const pL = this.get(item);
    const after = pL + (1 - pL) * WEAK_STEP;
    this.mastery.set(item, after);
    return after;
  }

  /** 预置掌握度（模拟种子 / 冒烟运行用，不经证据）。 */
  force(item: string, value: number): void {
    this.mastery.set(item, value);
  }

  knownItems(threshold = 0.6, all?: Set<string>): Set<string> {
    const out = new Set<string>();
    for (const id of all ?? this.mastery.keys()) {
      if (this.get(id) >= threshold) out.add(id);
    }
    return out;
  }

  /** 检查点导出：全部掌握度条目（值已经过验证）。 */
  entries(): [string, number][] {
    return [...this.mastery.entries()];
  }
}

export type { Facet };
