import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Lexicon } from '@endless/learning';
import { createContent } from '../src/index.js';
import { deriveFillerCard, extractPriorTexts, findPriorSentence } from '../src/deriver.js';

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

  it('提供 readScenes 时只从真实读过的场景取材；无已读场景则不出卡', () => {
    // behind 出现在 pilot-1 的 s1；只把 s1 标记为已读时可以取材
    const withS1 = deriveFillerCard(library, lexicon, {
      candidates: ['lx:behind#prep.location'],
      readScenes: new Set(['pilot-1.s1']),
    });
    expect(withS1).not.toBeNull();
    expect(withS1?.sourceText.toLowerCase()).toContain('behind');

    // s1 没读过（例如被跳过）时，绝不能拿它的句子出题
    const withoutS1 = deriveFillerCard(library, lexicon, {
      candidates: ['lx:behind#prep.location'],
      readScenes: new Set(['pilot-1.s2']),
    });
    expect(withoutS1).toBeNull();

    // 完全没有已读场景（新设备/直接跳到末集）时不出卡
    expect(deriveFillerCard(library, lexicon, {
      candidates: ['lx:behind#prep.location'],
      readScenes: new Set(),
    })).toBeNull();
  });

  it('干扰项不足 3 个时放弃该条目而不是凑数出题', () => {
    // 只有一个同词性干扰源的极小词库：凑不满 3 个干扰项，必须返回 null
    const tinyLexicon = {
      entries: new Map([
        ['lx:behind#prep.location', { kind: 'sense', lemma: 'behind', pos: 'prep', gloss_zh: '在…后面', confusables: ['lx:under#prep.location'] }],
        ['lx:under#prep.location', { kind: 'sense', lemma: 'under', pos: 'prep', gloss_zh: '在…下面', confusables: [] }],
      ]),
      forms: new Map([
        ['lx:behind#prep.location', ['behind']],
        ['lx:under#prep.location', ['under']],
      ]),
    } as unknown as Lexicon;
    expect(deriveFillerCard(library, tinyLexicon, {
      candidates: ['lx:behind#prep.location'],
    })).toBeNull();
  });

  it('候选条目在词库中没有形式时安静跳过', () => {
    expect(deriveFillerCard(library, lexicon, {
      candidates: ['lx:not-in-lexicon#x'],
    })).toBeNull();
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
