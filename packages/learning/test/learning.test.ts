/** learning 包测试：词库校验、FSRS 封装、BKT、证据策略、规划器 R1/R2/R4。 */
import { describe, expect, it } from 'vitest';
import { loadLexicon, knownWordSet, type Lexicon } from '../src/lexicon.js';
import { SrsStore } from '../src/fsrs.js';
import { AbilityEstimator } from '../src/bkt.js';
import { EvidenceProcessor } from '../src/evidence.js';
import { Planner, type PlannerInput } from '../src/planner.js';

const LEXICON_YAML = `
entries:
  - {id: lx:behind#prep.location, kind: sense, lemma: behind, pos: prep, forms: [behind], gloss_zh: 在…后面, cefr: A1, freq_band: 2, facets: [meaning, listening], confusables: [lx:under#prep.location]}
  - {id: lx:under#prep.location, kind: sense, lemma: under, pos: prep, forms: [under], gloss_zh: 在…下面, cefr: A1, freq_band: 2, facets: [meaning, listening], confusables: [lx:behind#prep.location]}
  - {id: ck:where-is, kind: chunk, forms: [where is, where's, where are, where was, where were], gloss_zh: 在哪里, cefr: A1, freq_band: 1, facets: [meaning, listening]}
  - {id: pt:there-is-are, kind: pattern, forms: [there is, there are], gloss_zh: 有（存在句）, cefr: A1, freq_band: 1, facets: [meaning], prereq: [lx:behind#prep.location]}
  - {id: lx:borrow#v.take-temporarily, kind: sense, lemma: borrow, pos: v, forms: [borrow, borrows, borrowed, borrowing], gloss_zh: 借入, cefr: A2, freq_band: 3, facets: [meaning, listening, form]}
function_words: [the, is, was, a, my, your, i, you, it]
`;

function lex(): Lexicon {
  const r = loadLexicon(LEXICON_YAML);
  if (!r.lexicon) throw new Error(`词库加载失败：${r.issues.map((i) => i.message).join(';')}`);
  return r.lexicon;
}

describe('词库', () => {
  it('加载与格式校验通过', () => {
    const r = loadLexicon(LEXICON_YAML);
    expect(r.issues).toEqual([]);
    expect(r.lexicon!.entries.size).toBe(5);
    expect(r.lexicon!.functionWords.has('the')).toBe(true);
  });

  it('格式校验抓出引用不存在的 confusables', () => {
    const bad = LEXICON_YAML.replace('confusables: [lx:under#prep.location]', 'confusables: [lx:ghost#n.none]');
    const r = loadLexicon(bad);
    expect(r.issues.some((i) => i.message.includes('lx:ghost#n.none'))).toBe(true);
  });

  it('knownWordSet：功能词 + 能力达标条目 + 专名', () => {
    const l = lex();
    const words = knownWordSet(l, { ability: (id) => (id === 'lx:under#prep.location' ? 0.9 : undefined), properNouns: ['Duck'] });
    expect(words.has('the')).toBe(true);
    expect(words.has('under')).toBe(true);
    expect(words.has('behind')).toBe(false); // 能力未知
    expect(words.has('duck')).toBe(true); // 专名小写
  });
});

describe('FSRS 封装', () => {
  /** 把一张新卡推进到 Review 态：两次 Good（学习步进 10 分钟 → Review）。 */
  function seedReview(srs: SrsStore, item: string, start: Date): void {
    srs.grade(item, 'meaning', 'Good', start);
    srs.grade(item, 'meaning', 'Good', new Date(start.getTime() + 60 * 60 * 1000));
  }

  it('评分推进卡片，预测回忆率随时间下降', () => {
    const srs = new SrsStore();
    const t0 = new Date('2026-01-01');
    seedReview(srs, 'ck:where-is', t0);
    const t1 = new Date('2026-01-02');
    const t30 = new Date('2026-01-31');
    const r1 = srs.predictedRecall('ck:where-is', 'meaning', t1);
    const r30 = srs.predictedRecall('ck:where-is', 'meaning', t30);
    expect(r1).not.toBeNull();
    expect(r30!).toBeLessThan(r1!);
  });

  it('到期队列按 逾期比例 × (1 − 预测回忆率) 排序，上限由调用方截取', () => {
    const srs = new SrsStore();
    const t0 = new Date('2026-01-01');
    const now = new Date('2026-02-15');
    seedReview(srs, 'ck:where-is', t0);
    seedReview(srs, 'lx:under#prep.location', t0);
    const due = srs.dueItems(now);
    expect(due.length).toBe(2);
    expect(due[0]!.overdueRatio).toBeGreaterThan(0);
  });
});

describe('BKT 能力估计', () => {
  it('猜对率打折：二选一答对提升小于四选一答对', () => {
    const bkt = new AbilityEstimator();
    const a = bkt.update('ck:where-is', true, 0.5);
    const bkt2 = new AbilityEstimator();
    const b = bkt2.update('lx:under#prep.location', true, 0.25);
    expect(b).toBeGreaterThan(a);
  });

  it('弱更新小幅移动', () => {
    const bkt = new AbilityEstimator();
    const before = bkt.get('lx:behind#prep.location');
    bkt.weakUpdate('lx:behind#prep.location');
    expect(bkt.get('lx:behind#prep.location')).toBeGreaterThan(before);
    expect(bkt.get('lx:behind#prep.location') - before).toBeLessThan(0.06);
  });
});

describe('证据策略（RQ6 / 5.3.4）', () => {
  const ev2 = { item: 'ck:where-is', facet: 'meaning' as const, type: 'recognition-2' as const, correct: true };
  const ev4 = { item: 'lx:under#prep.location', facet: 'meaning' as const, type: 'recognition-4' as const, correct: true };

  it('S-B 分级：recognition-2 不写 FSRS，recognition-4 写', () => {
    const p = new EvidenceProcessor('S-B');
    expect(p.process(ev2).fsrsGrade).toBeNull();
    expect(p.process(ev4).fsrsGrade).toBe('Good');
    expect(p.process({ ...ev4, correct: false }).fsrsGrade).toBe('Again');
  });

  it('S-A 宽松：recognition-2 也写 FSRS', () => {
    const p = new EvidenceProcessor('S-A');
    expect(p.process(ev2).fsrsGrade).toBe('Good');
    expect(p.process({ ...ev2, correct: false }).fsrsGrade).toBe('Again');
  });

  it('S-C 合并：连续两次二选一都对 → 一次 Good；答错 → Again', () => {
    const p = new EvidenceProcessor('S-C');
    expect(p.process(ev2).fsrsGrade).toBeNull(); // 第 1 次
    expect(p.process(ev2).fsrsGrade).toBe('Good'); // 第 2 次
    expect(p.getStreak('ck:where-is#meaning')).toBe(0);
    p.process(ev2);
    expect(p.process({ ...ev2, correct: false }).fsrsGrade).toBe('Again');
  });

  it('production：拼写小错 → Hard', () => {
    const p = new EvidenceProcessor('S-B');
    expect(
      p.process({ item: 'lx:borrow#v.take-temporarily', facet: 'meaning', type: 'production', correct: false, minorError: true }).fsrsGrade,
    ).toBe('Hard');
  });

  it('exposure / practice 只弱更新', () => {
    const p = new EvidenceProcessor('S-B');
    const o = p.process({ item: 'lx:behind#prep.location', facet: 'meaning', type: 'exposure', correct: true });
    expect(o.fsrsGrade).toBeNull();
    expect(o.weak).toBe(true);
  });
});

describe('规划器', () => {
  function makeInput(overrides: Partial<PlannerInput> = {}): PlannerInput {
    return {
      now: new Date('2026-02-15'),
      level: 'A1',
      srs: new SrsStore(),
      ability: new AbilityEstimator(),
      exposureCounts: new Map(),
      introduced: new Set(),
      allowedExtraPool: ['hat', 'sofa', 'table', 'moon', 'sleep', 'find', 'steal', 'door'],
      ...overrides,
    };
  }

  it('R1：无到期复习时最多引入 2 个；有复习时最多 1 个', () => {
    const planner = new Planner(lex());
    const b1 = planner.nextBrief(makeInput(), 1);
    expect(b1.introduce).toHaveLength(2);
    // 造一个真正的到期复习（推进到 Review 态并逾期）
    const srs = new SrsStore();
    srs.grade('ck:where-is', 'meaning', 'Good', new Date('2026-01-01'));
    srs.grade('ck:where-is', 'meaning', 'Good', new Date('2026-01-01T02:00:00Z'));
    const b2 = planner.nextBrief(makeInput({ srs }), 2);
    expect(b2.introduce).toHaveLength(1);
    expect(b2.review.some((r) => r.item === 'ck:where-is')).toBe(true);
  });

  it('R5：allowed_extra 默认取池前 8 个，可用 allowedExtraCount 放大（种子词库期）', () => {
    const planner = new Planner(lex());
    const pool = Array.from({ length: 20 }, (_, i) => `word${i}`);
    expect(planner.nextBrief(makeInput({ allowedExtraPool: pool }), 1).vocab.allowed_extra).toEqual(pool.slice(0, 8));
    expect(
      planner.nextBrief(makeInput({ allowedExtraPool: pool, allowedExtraCount: 15 }), 2).vocab.allowed_extra,
    ).toEqual(pool.slice(0, 15));
  });

  it('R2：复习上限 3，按优先级排序', () => {
    const planner = new Planner(lex());
    const srs = new SrsStore();
    const t0 = new Date('2026-01-01');
    for (const item of ['ck:where-is', 'lx:under#prep.location']) {
      srs.grade(item, 'meaning', 'Good', t0);
      srs.grade(item, 'meaning', 'Good', new Date(t0.getTime() + 2 * 3600_000));
    }
    const b = planner.nextBrief(makeInput({ srs }), 3);
    expect(b.review.length).toBeLessThanOrEqual(3);
  });

  it('R4：avoid_before_test 包含复习条目的全部形式', () => {
    const planner = new Planner(lex());
    const srs = new SrsStore();
    srs.grade('ck:where-is', 'meaning', 'Good', new Date('2026-01-01'));
    srs.grade('ck:where-is', 'meaning', 'Good', new Date('2026-01-01T02:00:00Z'));
    const b = planner.nextBrief(makeInput({ srs }), 4);
    expect(b.avoid_before_test).toContain('where is');
    expect(b.avoid_before_test).toContain("where's");
  });

  it('R1 前置：prereq 未达标不引入句型', () => {
    const planner = new Planner(lex());
    const b = planner.nextBrief(makeInput({ maxIntroduce: 10 }), 5);
    // pt:there-is-are 前置 lx:behind（能力未达标）→ 不应出现
    expect(b.introduce).not.toContain('pt:there-is-are');
  });

  it('expose：新条目曝光 0/2，已曝光 1 次的补 need', () => {
    const planner = new Planner(lex());
    const introduced = new Set(['lx:behind#prep.location']);
    const exposureCounts = new Map([['lx:behind#prep.location', 1]]);
    const b = planner.nextBrief(makeInput({ introduced, exposureCounts, maxIntroduce: 0 }), 6);
    const e = b.expose.find((x) => x.item === 'lx:behind#prep.location');
    expect(e).toMatchObject({ exposures_so_far: 1, need: 2 });
  });
});
