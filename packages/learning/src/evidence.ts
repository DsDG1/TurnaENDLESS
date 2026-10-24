/**
 * 证据策略（第 5.3.3 节表格与 5.3.4 节对照）：
 * S-A 宽松（recognition-2 也写入 FSRS）、S-B 分级（默认）、S-C 合并（连续两次二选一都对记一次 Good）。
 */
import type { EvidenceType } from '@endless/esl';
import type { Facet } from './lexicon.js';
import type { Grade3 } from './fsrs.js';
import { GUESS_RATE } from './bkt.js';

export type Strategy = 'S-A' | 'S-B' | 'S-C';

export interface EvidenceEvent {
  item: string;
  facet: Facet;
  type: EvidenceType;
  correct: boolean;
  /** production：有拼写小错时为 true（→ Hard） */
  minorError?: boolean;
}

export interface EvidenceOutcome {
  /** 写入 FSRS 的评分；null = 该证据不推进 FSRS */
  fsrsGrade: Grade3 | null;
  /** BKT 更新（检索型证据都更新能力估计）；null = 只做弱更新 */
  bkt: { correct: boolean; guess: number } | null;
  /** 是否弱更新（曝光、comprehension、retry、practice） */
  weak: boolean;
}

/** 有状态的证据处理器（S-C 需要跨事件记连续答对）。 */
export class EvidenceProcessor {
  private r2Streak = new Map<string, number>();
  constructor(public strategy: Strategy) {}

  process(ev: EvidenceEvent): EvidenceOutcome {
    switch (ev.type) {
      case 'exposure':
      case 'comprehension':
      case 'retry':
      case 'practice':
        return { fsrsGrade: null, bkt: null, weak: true };
      case 'recognition-2': {
        const guess = GUESS_RATE['recognition-2']!;
        if (this.strategy === 'S-A') {
          return { fsrsGrade: ev.correct ? 'Good' : 'Again', bkt: { correct: ev.correct, guess }, weak: false };
        }
        if (this.strategy === 'S-C') {
          const key = `${ev.item}#${ev.facet}`;
          if (!ev.correct) {
            this.r2Streak.set(key, 0);
            return { fsrsGrade: 'Again', bkt: { correct: false, guess }, weak: false };
          }
          const streak = (this.r2Streak.get(key) ?? 0) + 1;
          this.r2Streak.set(key, streak);
          if (streak >= 2) {
            this.r2Streak.set(key, 0);
            return { fsrsGrade: 'Good', bkt: { correct: true, guess }, weak: false };
          }
          return { fsrsGrade: null, bkt: { correct: true, guess }, weak: false };
        }
        // S-B：recognition-2 不写入 FSRS
        return { fsrsGrade: null, bkt: { correct: ev.correct, guess }, weak: false };
      }
      case 'recognition-4':
      case 'listening-4': {
        const guess = GUESS_RATE[ev.type]!;
        return { fsrsGrade: ev.correct ? 'Good' : 'Again', bkt: { correct: ev.correct, guess }, weak: false };
      }
      case 'production': {
        const guess = GUESS_RATE['production']!;
        const grade: Grade3 = ev.correct ? 'Good' : ev.minorError ? 'Hard' : 'Again';
        return { fsrsGrade: grade, bkt: { correct: ev.correct || ev.minorError === true, guess }, weak: false };
      }
      default:
        return { fsrsGrade: null, bkt: null, weak: true };
    }
  }

  /** 重放用：恢复 S-C 连续计数。 */
  setStreak(key: string, n: number): void {
    this.r2Streak.set(key, n);
  }
  getStreak(key: string): number {
    return this.r2Streak.get(key) ?? 0;
  }

  /** 检查点导出：全部连续计数（S-B 不使用，返回空）。 */
  streaks(): [string, number][] {
    return [...this.r2Streak.entries()];
  }
}
