/**
 * 学习规划器（第 5.3 节）：读取 FSRS 状态、能力估计与曝光计数，产出本批的 LearningBrief。
 * 规划规则 R1–R7 见 5.3.2 节；R7（学习任务优先）是导演侧的裁决原则，不在此编码。
 */
import type { EvidenceType } from '@endless/esl';
import type { Lexicon, Facet } from './lexicon.js';
import type { SrsStore } from './fsrs.js';
import type { AbilityEstimator } from './bkt.js';

export interface LearningBrief {
  brief: string;
  level: string;
  /** 本批引入的新条目（R1：每批最多 1 个；到期复习为空时最多 2 个） */
  introduce: string[];
  /** 只需出现、不检测（新条目首次检测前须累计曝光 ≥ 2 次，可跨批） */
  expose: { item: string; exposures_so_far: number; need: number }[];
  /** 到期复习，必须有合格检索证据（R2：每批最多 3 个） */
  review: { item: string; facet: Facet; min_evidence: EvidenceType }[];
  vocab: {
    allowed_extra: string[];
    max_words_per_line: number;
    oov_budget: number;
  };
  /** 防启动（R4）：检测之前本批不得出现这些形式 */
  avoid_before_test: string[];
}

export interface PlannerInput {
  now: Date;
  level: 'A1' | 'A2';
  srs: SrsStore;
  ability: AbilityEstimator;
  /** 每个条目的累计曝光次数（含被动曝光） */
  exposureCounts: Map<string, number>;
  /** 已引入过的条目（≥ 1 次曝光） */
  introduced: Set<string>;
  /** 允许词表候选池（程序生成，实验用固定池） */
  allowedExtraPool: string[];
  /** 复习条目数上限（默认 3） */
  maxReviews?: number;
  /** 新条目数上限（默认 1；到期复习为空时 2） */
  maxIntroduce?: number;
}

export class Planner {
  constructor(private lexicon: Lexicon) {}

  /** 按频率档排序的候选新条目：级别内、前置满足、未引入、forms 非空（句型的形式枚举留给 v1）。 */
  nextCandidates(input: PlannerInput, n: number): string[] {
    const { level, ability, introduced } = input;
    return [...this.lexicon.entries.values()]
      .filter((e) => e.cefr <= level)
      .filter((e) => !introduced.has(e.id))
      .filter((e) => (this.lexicon.forms.get(e.id)?.length ?? 0) > 0)
      .filter((e) => (e.prereq ?? []).every((p) => ability.get(p) >= 0.6))
      .sort((a, b) => a.freq_band - b.freq_band || a.id.localeCompare(b.id))
      .slice(0, n)
      .map((e) => e.id);
  }

  nextBrief(input: PlannerInput, seq: number): LearningBrief {
    const maxReviews = input.maxReviews ?? 3;
    const review: LearningBrief['review'] = [];
    for (const due of input.srs.dueItems(input.now, 'meaning')) {
      if (review.length >= maxReviews) break;
      if (review.some((r) => r.item === due.item)) continue;
      review.push({ item: due.item, facet: 'meaning', min_evidence: 'recognition-4' });
    }

    // R1：新条目节奏
    const introduceCap = input.maxIntroduce ?? (review.length === 0 ? 2 : 1);
    const introduce = this.nextCandidates(input, introduceCap);

    // expose：新条目的首次曝光 + 已有 1 次曝光、还差 1 次达到可检测门槛的条目
    const expose: LearningBrief['expose'] = [];
    for (const item of introduce) {
      expose.push({ item, exposures_so_far: input.exposureCounts.get(item) ?? 0, need: 2 });
    }
    const pending = [...input.introduced]
      .filter((id) => (input.exposureCounts.get(id) ?? 0) < 2)
      .filter((id) => !introduce.includes(id))
      .filter((id) => (this.lexicon.forms.get(id)?.length ?? 0) > 0)
      .sort((a, b) => (this.lexicon.entries.get(a)?.freq_band ?? 9) - (this.lexicon.entries.get(b)?.freq_band ?? 9))
      .slice(0, 2);
    for (const item of pending) {
      expose.push({ item, exposures_so_far: input.exposureCounts.get(item) ?? 0, need: 2 });
    }

    // R4：防启动形式表 = 全部到期复习条目的形式
    const avoid = new Set<string>();
    for (const r of review) for (const f of this.lexicon.forms.get(r.item) ?? []) avoid.add(f);

    // R5：词汇预算（allowed_extra 按序取池的前几个，实际运行由程序生成并注入）
    const pool = input.allowedExtraPool.slice(0, 8);

    return {
      brief: `lb-${String(seq).padStart(4, '0')}`,
      level: input.level === 'A2' ? 'A2' : 'A1+',
      introduce,
      expose,
      review,
      vocab: {
        allowed_extra: pool,
        max_words_per_line: input.level === 'A2' ? 16 : 12,
        oov_budget: 0.02,
      },
      avoid_before_test: [...avoid],
    };
  }
}
