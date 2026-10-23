/** B3：程序派生的跨批检测（不调 LLM）。 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { TextUnit } from '@endless/esl';
import { InMemoryWorldStore } from '@endless/world';
import { StubLlmClient } from '@endless/director';
import type { LearningBrief } from '@endless/learning';
import { loadLabData } from '../src/data.js';
import { planDerivedScene } from '../src/deriver.js';
import { runExperiment } from '../src/pipeline.js';
import { makeStubScript } from '../src/stub.js';
import { smokeBrief } from '../src/smokebrief.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data');

const units = (texts: { sceneId: string; path: string; text: string }[]): TextUnit[] =>
  texts.map((t, i) => ({ sceneId: t.sceneId, path: t.path, text: t.text, role: 'narrative', sceneIndex: i }));

const lexicon = {
  formsOf: (item: string) =>
    ({
      'lx:under#prep.location': ['under', 'below'],
      'ck:where-is': ['where is'],
    })[item],
};

describe('B3 派生器', () => {
  it('只从更早批次取材，且限制每批一张、占比不超过 25%', async () => {
    const brief = smokeBrief();
    // 没有更早批次 → 不派生（R4：批内没有可回插的旧文本）
    expect(
      planDerivedScene({
        brief,
        priorTexts: new Map(),
        lexicon,
        recentlyWrong: [],
        baseCards: 4,
        usedSceneIds: ['s1', 's2', 's3', 's4'],
      }),
    ).toBeNull();

    // 更早批次里有 under 的原文 → 生成 cloak 场景，id 取第一个空位
    const plan = planDerivedScene({
      brief,
      priorTexts: new Map([['dd-0001', units([{ sceneId: 's1', path: 'panels[0].bubbles[0]', text: 'It is under the box.' }])]]),
      lexicon,
      recentlyWrong: [],
      baseCards: 4,
      usedSceneIds: ['s1', 's2', 's3', 's4'],
    });
    expect(plan).not.toBeNull();
    expect(plan!.scene.kind).toBe('cloze_pick');
    expect(plan!.scene.item).toBe('lx:under#prep.location');
    expect(plan!.from).toBe('dd-0001.s1.panels[0].bubbles[0]');
    expect(plan!.scene.id).toBe('s5');
  });

  it('卡片太少时不派生（1/3 > 25%），避免习题感上升', () => {
    const plan = planDerivedScene({
      brief: smokeBrief(),
      priorTexts: new Map([['dd-0001', units([{ sceneId: 's2', path: 'instruction', text: 'The key is under the table.' }])]]),
      lexicon,
      recentlyWrong: [],
      baseCards: 2,
      usedSceneIds: ['s1', 's2'],
    });
    expect(plan).toBeNull();
  });

  it('错题回插优先：最近答错的条目排在 brief 顺序之前', () => {
    const plan = planDerivedScene({
      brief: smokeBrief(),
      priorTexts: new Map([
        [
          'dd-0001',
          units([
            { sceneId: 's2', path: 'instruction', text: 'The key is under the table.' },
            { sceneId: 's3', path: 'messages[0]', text: 'Where is the hat?' },
          ]),
        ],
      ]),
      lexicon,
      recentlyWrong: ['ck:where-is'],
      baseCards: 4,
      usedSceneIds: ['s1', 's2', 's3', 's4'],
    });
    expect(plan?.item).toBe('ck:where-is');
    expect(plan?.errorReplay).toBe(true);
  });

  it('一句话里出现两次目标形式时跳过（挖空后干扰项没有区分度）', () => {
    const plan = planDerivedScene({
      brief: smokeBrief(),
      priorTexts: new Map([['dd-0001', units([{ sceneId: 's1', path: 'caption', text: 'Under the box, under the bed.' }])]]),
      lexicon: { formsOf: (i) => (i === 'lx:under#prep.location' ? ['under'] : i === 'ck:where-is' ? ['where is'] : undefined) },
      recentlyWrong: [],
      baseCards: 4,
      usedSceneIds: ['s1', 's2', 's3', 's4'],
    });
    expect(plan).toBeNull();
  });
});

describe('B3 接入流水线（R5 的真内容）', () => {
  const run = async (derive: boolean) => {
    const data = await loadLabData(DATA_DIR);
    return runExperiment({
      data,
      store: new InMemoryWorldStore(),
      llm: new StubLlmClient(makeStubScript()),
      outDir: null,
      runId: derive ? 'derive-on' : 'derive-off',
      batches: 5,
      persona: 'P1',
      seed: 42,
      director: 'two-stage',
      encoding: 'yaml',
      derive,
      worldState: true,
      tropeLedgerOn: true,
      strategy: 'S-B',
      feedbackLag: 2,
      channelOverride: 'duck_detective',
      briefOverrides: Array.from({ length: 5 }, () => smokeBrief() as LearningBrief),
      smokeSeed: true,
    });
  };

  it('derive 开：从第 2 批起产出派生卡，K5 上升；derive 关：一张都没有', async () => {
    const on = await run(true);
    const off = await run(false);
    const derivedOn = on.played.reduce((s, p) => s + p.ast.derived.length, 0);
    const derivedOff = off.played.reduce((s, p) => s + p.ast.derived.length, 0);
    expect(derivedOff).toBe(0);
    expect(derivedOn).toBeGreaterThan(0);
    // 派生卡来自更早批次：第 1 批不可能有
    expect(on.played[0]!.ast.derived).toHaveLength(0);
    // 卡数只数一次：基本场景 + 派生卡，不重复计
    expect(on.totals.cards).toBe(off.totals.cards + derivedOn);
    // V2 不受影响（派生只追加在已通过的批次上）
    expect(on.totals.batchesOk).toBe(off.totals.batchesOk);
  }, 60_000);

  it('派生卡的 evidenceType 是 recognition-4（跨批），不是 practice', async () => {
    const on = await run(true);
    const all = on.played.flatMap((p) => p.ast.derived);
    expect(all.length).toBeGreaterThan(0);
    for (const d of all) {
      expect(d.evidenceType).toBe('recognition-4');
      expect(d.options.length).toBeGreaterThanOrEqual(2);
      expect(d.correct.length).toBeGreaterThan(0);
      expect(d.clozeText).toContain('____');
    }
  }, 60_000);
});
