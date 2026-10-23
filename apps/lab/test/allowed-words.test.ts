/**
 * A5 允许词表改短：写手只取需要的列。
 *
 * 判据（计划文档）：L3 中位低于 9.7%、写手输入 token 低于 5.4k、V2 不下降。
 * 前两项要真实跑批才读得到，这里钉住能程序判定的那条前提：
 * **给模型看的表变短了，但校验器的判定集合没动** —— 否则「L3 下降」可能只是判定放宽了。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { knownWordSet, type LearningBrief } from '@endless/learning';
import { ALLOWED_WORDS_K, countWords, shortAllowedWords } from '../src/allowed-words.js';
import { buildValidationContext, loadLabData } from '../src/data.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data');

const BRIEF: LearningBrief = {
  brief: 'lb-a5',
  level: 'A1+',
  introduce: [],
  expose: [{ item: 'lx:behind#prep.location', exposures_so_far: 0, need: 2 }],
  review: [{ item: 'ck:where-is', facet: 'meaning', min_evidence: 'recognition-4' }],
  vocab: { allowed_extra: ['hat', 'table', 'sofa'], max_words_per_line: 12, oov_budget: 0.02 },
  avoid_before_test: ["where's"],
};

async function setup() {
  const data = await loadLabData(DATA_DIR);
  const properNouns = [...data.channels.values()].flatMap((b) => [...b.cast.map((c) => c.id), ...b.locations]);
  const knownForms = knownWordSet(data.lexicon, { ability: () => 0.9, properNouns });
  const ctx = buildValidationContext(data, {
    brief: {
      id: BRIEF.brief,
      review: BRIEF.review.map((r) => ({ item: r.item, facet: r.facet, minEvidence: r.min_evidence })),
      expose: BRIEF.expose.map((e) => ({ item: e.item })),
      introduce: BRIEF.introduce,
      avoidBeforeTest: BRIEF.avoid_before_test,
    },
    knownForms,
    allowedExtra: BRIEF.vocab.allowed_extra,
    entitiesExists: () => true,
    canonFacts: [],
    activeFacts: [],
    threads: new Map(),
  });
  const list = shortAllowedWords({
    data,
    brief: BRIEF,
    allowedForms: ctx.vocab.allowedForms,
    allowedExtra: BRIEF.vocab.allowed_extra,
  });
  return { data, ctx, list };
}

describe('A5 写手允许词表（短表）', () => {
  it('表长被压到 K 附近，远短于完整允许集合', async () => {
    const { ctx, list } = await setup();
    expect(ctx.vocab.allowedForms.size).toBeGreaterThan(300);
    expect(countWords(list)).toBeLessThanOrEqual(ALLOWED_WORDS_K + 20);
    expect(countWords(list)).toBeLessThan(ctx.vocab.allowedForms.size / 3);
  });

  it('功能词不进表（提示词里已声明「总是允许」）', async () => {
    const { data, list } = await setup();
    const words = new Set(list.split(',').map((w) => w.trim()));
    for (const fn of ['the', 'a', 'is', 'and', 'of']) {
      expect(data.lexicon.functionWords.has(fn)).toBe(true);
      expect(words.has(fn), `功能词 ${fn} 不该出现在短表里`).toBe(false);
    }
  });

  it('本批必须用的目标形式与 allowed_extra 一定在表里（不会因 K 被截掉）', async () => {
    const { list } = await setup();
    const words = new Set(list.split(',').map((w) => w.trim()));
    for (const w of ['where is', 'behind', 'hat', 'table', 'sofa']) {
      expect(words.has(w), `短表缺少 ${w}`).toBe(true);
    }
  });

  it('校验口径不变：完整允许集合里功能词与全部已知形式都还在', async () => {
    const { data, ctx } = await setup();
    expect(ctx.vocab.allowedForms.has('the')).toBe(true);
    expect(ctx.vocab.allowedForms.has('and')).toBe(true);
    for (const forms of data.lexicon.forms.values()) {
      for (const f of forms) expect(ctx.vocab.allowedForms.has(f.toLowerCase())).toBe(true);
    }
  });
});
