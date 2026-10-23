import { describe, expect, it } from 'vitest';
import { type Batch, type ValidationContext } from '@endless/esl';
import {
  createEpisode,
  createSession,
  projectSession,
  restoreSession,
  transition,
  type Library,
} from '../src/index.js';

const ctx: ValidationContext = {
  vocab: {
    allowedForms: new Set('the cat is here ask a question where was your hat who when how good try again under on over near table'.split(' ')),
    oovWarn: 0.02, oovBlock: 0.05, maxWordsPerLine: 12,
  },
  lexicon: {
    formsOf: (id) => id === 'ck:where-is' ? ['where was', 'where is'] : id === 'lx:under#prep.location' ? ['under'] : undefined,
    confusables: () => [],
  },
  assets: {
    emojis: new Set(['cat']),
    tags: new Set(['agency_office']),
    chars: new Map([['cat', { expr: ['neutral'], hat: ['none'], props_allowed: [] }]]),
  },
  entities: { exists: (id) => id === 'cat' },
  predicates: new Map(),
  canonFacts: [], activeFacts: [], threads: new Map(),
};

const batch: Batch = {
  batch: 'pilot-1', channel: 'duck_detective', brief: 'pilot-1', cast: ['cat'],
  scenes: [
    {
      id: 's1', type: 'comic', setting: '@tag:agency_office',
      panels: [{ shot: 'wide', actors: ['@char:cat'], props: [], bubbles: [{ speaker: 'cat', text: 'The cat is here.' }] }],
    },
    {
      id: 's2', type: 'chat', skin: 'messenger',
      uses: ['ck:where-is'], evidence: { item: 'ck:where-is', type: 'recognition-4' },
      messages: [{ from: 'cat', text: 'Ask a question.' }],
      reply: {
        options: [
          { label: 'Where was your hat?', correct: true, effect: 'ask' },
          { label: 'Who was your hat?', effect: 'other' },
          { label: 'When was your hat?' },
          { label: 'How was your hat?' },
        ],
        on_correct: { from: 'cat', text: 'Good.' },
        on_wrong: { from: 'cat', text: 'Try again.' },
      },
      effects: {
        ask: [{ user_fact: { predicate: 'asked', object: 'cat' } }],
        other: [{ user_fact: { predicate: 'other', object: 'cat' } }],
      },
    },
    {
      id: 's3', type: 'pick', uses: ['lx:under#prep.location'],
      evidence: { item: 'lx:under#prep.location', type: 'recognition-4' },
      question: 'The hat is ____ the table.',
      options: [{ label: 'on' }, { label: 'under', correct: true }, { label: 'over' }, { label: 'near' }],
      feedback: { on_correct: 'Good.', on_wrong: 'Try again.' },
    },
  ],
};

function library(source = batch): Library {
  return {
    version: 'pilot-v1',
    episodes: [createEpisode(source, ctx, { title: '试播', subtitle: 'A small mystery', description: '一个小谜题' })],
    glossary: {
      'ck:where-is': { label: 'where is', gloss: '在哪里', forms: ['where is', 'where was'] },
      'lx:under#prep.location': { label: 'under', gloss: '在……下面', forms: ['under'] },
    },
    entities: [{ id: 'cat', name: 'Cat', kind: 'character', home_channel: 'duck_detective', created_card: 0, bible_ref: null }],
    predicates: [],
  };
}

const now = '2026-10-23T08:00:00.000Z';
const advance = { type: 'advance', scene: 's1', skip: false } as const;
const answer = { type: 'answer', scene: 's2', choice: 0 } as const;

describe('真实用户播放闭环', () => {
  it('先完成阅读，才允许回答下一场', () => {
    const lib = library();
    const start = createSession(lib);
    expect(() => transition(start, answer, lib, now)).toThrow();
    const next = transition(start, advance, lib, now);
    expect(projectSession(next, lib).episodes['pilot-1']?.cursor).toBe(1);
  });

  it('四选一首次作答更新 FSRS、BKT，并只应用选中选项的 effect', () => {
    const lib = library();
    const state = transition(transition(createSession(lib), advance, lib, now), answer, lib, now);
    const view = projectSession(state, lib);
    expect(view.srs.size()).toBe(1);
    expect(view.ability.get('ck:where-is')).toBeGreaterThan(0.2);
    expect(view.world.userFacts()).toHaveLength(1);
    expect(view.world.userFacts()[0]?.predicate).toBe('asked');
    expect(view.episodes['pilot-1']?.scenes.s2?.answer?.qualified).toBe(true);
  });

  it('重复点击与刷新恢复不会重复评分或重复写剧情', () => {
    const lib = library();
    const state = transition(transition(createSession(lib), advance, lib, now), answer, lib, now);
    expect(transition(state, answer, lib, now)).toBe(state);
    const recovered = restoreSession(JSON.parse(JSON.stringify(state)), lib);
    const view = projectSession(recovered, lib);
    expect(view.srs.allCards()[0]?.card.reps).toBe(1);
    expect(view.world.userFacts()).toHaveLength(1);
    expect(view.episodes['pilot-1']?.scenes.s2?.answer?.choice).toBe(0);
  });

  it('先查看提示的作答记为练习，不推进 FSRS', () => {
    const lib = library();
    let state = transition(createSession(lib), advance, lib, now);
    state = transition(state, { type: 'reveal', scene: 's2' }, lib, now);
    state = transition(state, answer, lib, now);
    const view = projectSession(state, lib);
    expect(view.srs.size()).toBe(0);
    expect(view.episodes['pilot-1']?.scenes.s2?.answer?.evidence).toBe('practice');
  });

  it('同批先读过目标词后的检测降为练习', () => {
    const source = structuredClone(batch);
    const scene = source.scenes[0]!;
    if (scene.type !== 'comic') throw new Error('fixture');
    scene.uses = ['ck:where-is'];
    scene.panels[0]!.bubbles[0]!.text = 'Where is your hat?';
    const lib = library(source);
    const state = transition(transition(createSession(lib), advance, lib, now), answer, lib, now);
    expect(projectSession(state, lib).srs.size()).toBe(0);
  });

  it('跳过互动不会捏造答题证据或剧情 effect', () => {
    const lib = library();
    let state = transition(createSession(lib), advance, lib, now);
    expect(() => transition(state, { type: 'advance', scene: 's2', skip: false }, lib, now)).toThrow();
    state = transition(state, { type: 'advance', scene: 's2', skip: true }, lib, now);
    const view = projectSession(state, lib);
    expect(view.srs.size()).toBe(0);
    expect(view.world.userFacts()).toHaveLength(0);
    expect(view.episodes['pilot-1']?.scenes.s2?.skipped).toBe(true);
  });

  it('错误首答记 Again，不能改成正确答案刷记录', () => {
    const lib = library();
    let state = transition(createSession(lib), advance, lib, now);
    state = transition(state, { type: 'answer', scene: 's2', choice: 1 }, lib, now);
    expect(transition(state, answer, lib, now)).toBe(state);
    const view = projectSession(state, lib);
    expect(view.episodes['pilot-1']?.scenes.s2?.answer?.correct).toBe(false);
    expect(view.episodes['pilot-1']?.scenes.s2?.answer?.grade).toBe('Again');
  });

  it('尚未到期的跨集重复只记练习，不提前推进 FSRS', () => {
    const lib = library();
    lib.episodes.push(createEpisode({ ...batch, batch: 'pilot-2' }, ctx, {
      title: '第二集', subtitle: 'Again', description: '重复表达',
    }));
    let state = transition(createSession(lib), advance, lib, now);
    state = transition(state, answer, lib, now);
    state = transition(state, { type: 'select', episode: 'pilot-2' }, lib, now);
    state = transition(state, advance, lib, now);
    state = transition(state, answer, lib, '2026-10-23T08:00:10.000Z');
    const view = projectSession(state, lib);
    expect(view.srs.allCards()[0]?.card.reps).toBe(1);
    expect(view.episodes['pilot-2']?.scenes.s2?.answer?.evidence).toBe('practice');
  });

  it('无效选项、未知场景和损坏存档不会被接受', () => {
    const lib = library();
    const state = transition(createSession(lib), advance, lib, now);
    expect(() => transition(state, { type: 'answer', scene: 's2', choice: 99 }, lib, now)).toThrow();
    expect(() => transition(state, { type: 'advance', scene: 's99', skip: true }, lib, now)).toThrow();
    expect(() => restoreSession({ ...state, version: 42 }, lib)).toThrow();
    expect(() => restoreSession({ ...state, catalog: 'unknown' }, lib)).toThrow();
    expect(() => restoreSession({ ...state, events: [{ type: 'answer', episode: 'pilot-1', scene: 's2', choice: 0, at: now }] }, lib)).toThrow();
  });

  it('未实现的场景在内容入口被拒绝，不在播放时静默跳过', () => {
    const source = structuredClone(batch);
    source.scenes[0] = { id: 's1', type: 'story', ink: '-> END' };
    expect(() => library(source)).toThrow(/场景/);
  });
});
