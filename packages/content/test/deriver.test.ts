import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createContent } from '../src/index.js';
import {
  deriveFillerCard,
  extractPriorTexts,
  findPriorSentence,
  planDerivedScene,
} from '../src/deriver.js';

describe('B3 派生与填缝引擎 (packages/content/src/deriver.ts)', () => {
  const text = readFileSync(new URL('../../../apps/lab/data/lexicon/a1_a2.yaml', import.meta.url), 'utf8');
  const content = createContent(text);
  const library = content.pilot;
  const lexicon = content.lexicon;

  it('从 Library 提取已读历史叙述文本单元 (extractPriorTexts)', () => {
    const prior = extractPriorTexts(library);
    expect(prior.size).toBeGreaterThanOrEqual(3);
    const ep1 = prior.get('pilot-1');
    expect(ep1).toBeDefined();
    expect(ep1!.length).toBeGreaterThan(0);
    expect(ep1![0]!.role).toBe('narrative');
    expect(ep1![0]!.text.length).toBeGreaterThan(0);
  });

  it('按词库形式检索唯一出现的句子 (findPriorSentence)', () => {
    const prior = extractPriorTexts(library);
    // pilot-1 的 s1 对白包含 "I was behind the door. I saw nothing!"
    const found = findPriorSentence(prior, ['behind']);
    expect(found).not.toBeNull();
    expect(found?.text.toLowerCase()).toContain('behind');
    expect(found?.hit.start).toBeGreaterThanOrEqual(0);
    expect(found?.hit.end).toBeGreaterThan(found!.hit.start);
    expect(found?.matchedForm.toLowerCase()).toBe('behind');
  });

  it('生成符合 ESL 契约的 derive 场景计划 (planDerivedScene)', () => {
    const prior = extractPriorTexts(library);
    const plan = planDerivedScene({
      brief: { review: [{ item: 'lx:behind#prep.location' }] },
      priorTexts: prior,
      lexicon: {
        formsOf: (item) => lexicon.forms.get(item),
      },
      recentlyWrong: ['lx:behind#prep.location'],
      baseCards: 3,
      usedSceneIds: ['s1', 's2', 's3'],
    });

    expect(plan).not.toBeNull();
    expect(plan?.scene.type).toBe('derive');
    expect(plan?.scene.kind).toBe('cloze_pick');
    expect(plan?.scene.id).toBe('s4');
    expect(plan?.errorReplay).toBe(true);
    expect(plan?.item).toBe('lx:behind#prep.location');
    expect(plan?.sourceText).toContain('behind');
  });

  it('0 毫秒即时生成前端可用的填缝卡 (deriveFillerCard)', () => {
    const filler = deriveFillerCard(library, lexicon, {
      candidates: ['lx:behind#prep.location'],
    });

    expect(filler).not.toBeNull();
    expect(filler?.clozePrompt).toContain('____');
    expect(filler?.options).toHaveLength(4);
    expect(filler?.options.filter((o) => o.correct)).toHaveLength(1);
    expect(filler?.sourceEpisodeTitle).toBeTruthy();
    expect(filler?.feedback.on_correct).toBeTruthy();
    expect(filler?.feedback.on_wrong).toBeTruthy();
  });
});
