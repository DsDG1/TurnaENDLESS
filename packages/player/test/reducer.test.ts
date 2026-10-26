import { describe, expect, it } from 'vitest';
import { type Batch, type ValidationContext } from '@endless/esl';
import {
  SessionSchema, applyReplayEvent, classifyProjector, createEpisode, createReplay, createSession,
  exportProjection, exportReplay, libraryLoader, projectSession, replayEvents, resumeReplay,
  sameReplay, transition, verifyReplayPrefix, type EpisodeLoader, type Library, type PlayerEvent,
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

function library(source = batch, episodes = 1): Library {
  return {
    version: 'pilot-v1',
    episodes: Array.from({ length: episodes }, (_, index) => createEpisode(
      { ...source, batch: index === 0 ? 'pilot-1' : `pilot-${index + 1}` },
      ctx,
      { title: `试播${index + 1}`, subtitle: 'A small mystery', description: '一个小谜题' },
    )),
    glossary: {
      'ck:where-is': { label: 'where is', gloss: '在哪里', forms: ['where is', 'where was'] },
      'lx:under#prep.location': { label: 'under', gloss: '在……下面', forms: ['under'] },
    },
    entities: [{ id: 'cat', name: 'Cat', kind: 'character', home_channel: 'duck_detective', created_card: 0, bible_ref: null }],
    predicates: [],
  };
}

const now = '2026-10-23T08:00:00.000Z';

/** 旧校验要求 3–4 个基本场景。规模夹具只推进第一场，其余两场只为通过编译。 */
function scaleEpisode(description: string) {
  return createEpisode({
    batch: 'scale', channel: 'duck_detective', brief: 'scale', cast: ['cat'],
    scenes: [1, 2, 3].map((index) => ({
      id: `s${index}`, type: 'comic' as const, setting: '@tag:agency_office',
      panels: [{ shot: 'wide' as const, actors: ['@char:cat'], props: [], bubbles: [{ speaker: 'cat', text: 'The cat is here.' }] }],
    })),
  }, ctx, { title: '规模', subtitle: 'Synthetic', description });
}

function splitMatches(lib: Library, events: readonly PlayerEvent[]): void {
  const loader = libraryLoader(lib);
  const full = exportReplay(replayEvents(loader, events), lib.version, events);
  expect(verifyReplayPrefix(loader, events, full)).toBe(true);
  for (let at = 0; at <= events.length; at++) {
    const prefix = events.slice(0, at);
    const snap = exportReplay(replayEvents(loader, prefix), lib.version, prefix);
    const resumed = resumeReplay(snap, loader, events.slice(at));
    expect(sameReplay(exportReplay(resumed, lib.version, events), full), `切在第 ${at} 个事件`).toBe(true);
  }
}

describe('同一 reducer 的分段重放', () => {
  it('揭示、同集预习、未到期检索和世界顺序在任意切点都与全量重放一致', () => {
    const lib = library(batch, 2);
    let state = transition(createSession(lib), { type: 'advance', scene: 's1', skip: false }, lib, now);
    state = transition(state, { type: 'reveal', scene: 's2' }, lib, now);
    state = transition(state, { type: 'answer', scene: 's2', choice: 0 }, lib, now);
    state = transition(state, { type: 'advance', scene: 's2', skip: false }, lib, now);
    state = transition(state, { type: 'select', episode: 'pilot-2' }, lib, now);
    state = transition(state, { type: 'advance', scene: 's1', skip: false }, lib, now);
    state = transition(state, { type: 'answer', scene: 's2', choice: 1 }, lib, '2026-10-23T08:00:10.000Z');
    splitMatches(lib, state.events);
    const view = projectSession(state, lib);
    expect(view.episodes['pilot-1']?.scenes.s2?.answer?.evidence).toBe('practice');
    // 第一集是预习，不建卡；第二集的错误检索单独记一张 Again。
    expect(view.srs.size()).toBe(1);
    expect(view.episodes['pilot-2']?.scenes.s2?.answer?.grade).toBe('Again');
    // 世界序号由用户事实和效果日志共用：每次作答先写事实，再写一条事件。
    expect(view.world.userFacts().map((fact) => fact.id)).toEqual([1, 3]);
    expect(view.world.allEvents().map((event) => event.id)).toEqual([2, 4]);

    const primedSource = structuredClone(batch);
    const opening = primedSource.scenes[0]!;
    if (opening.type !== 'comic') throw new Error('fixture');
    opening.uses = ['ck:where-is'];
    opening.panels[0]!.bubbles[0]!.text = 'Where is your hat?';
    const primed = library(primedSource);
    let read = transition(createSession(primed), { type: 'advance', scene: 's1', skip: false }, primed, now);
    read = transition(read, { type: 'answer', scene: 's2', choice: 0 }, primed, now);
    splitMatches(primed, read.events);
    const primedView = projectSession(read, primed);
    expect(primedView.srs.size()).toBe(0);
    expect(exportProjection(primedView).seen).toEqual([]);
    expect(exportReplay(replayEvents(libraryLoader(primed), read.events), primed.version, read.events).seen
      .some((row) => row.items.includes('ck:where-is'))).toBe(true);
  });

  it('续放后的重复作答不会再次评分', () => {
    const lib = library();
    let state = transition(createSession(lib), { type: 'advance', scene: 's1', skip: false }, lib, now);
    state = transition(state, { type: 'answer', scene: 's2', choice: 0 }, lib, now);
    const loader = libraryLoader(lib);
    const prefix = state.events.slice(0, 2);
    const resumed = resumeReplay(exportReplay(replayEvents(loader, prefix), lib.version, prefix), loader, []);
    expect(() => applyReplayEvent(resumed, prefix[1]!, loader)).toThrow(/答题/);
    expect(resumed.view.srs.allCards()[0]?.card.reps).toBe(1);
    expect(resumed.view.world.userFacts()).toHaveLength(1);
  });

  it('证据连续计数和旧投影版本不能混用', () => {
    const lib = library();
    const loader = libraryLoader(lib);
    const state = createReplay(loader);
    state.processor.setStreak('ck:where-is#meaning', 1);
    const snap = exportReplay(state, lib.version, []);
    expect(resumeReplay(snap, loader, []).processor.getStreak('ck:where-is#meaning')).toBe(1);
    expect(classifyProjector('player-replay-1')).toBe('replay');
    expect(classifyProjector('player-projection-1')).toBe('legacy-lossy');
    expect(classifyProjector('player-replay-9')).toBe('unknown');
    expect(verifyReplayPrefix(loader, [], { ...snap, projectorVersion: 'player-projection-1' as 'player-replay-1' })).toBe(false);
    expect(() => resumeReplay({ ...snap, projectorVersion: 'player-projection-1' as 'player-replay-1' }, loader, [])).toThrow(/续放/);
  });

  it('未访问的集不加载场景', () => {
    const lib = library();
    let loads = 0;
    const loader: EpisodeLoader = {
      version: lib.version,
      episodeIds: ['pilot-1', 'later'],
      entities: lib.entities,
      predicates: lib.predicates,
      load(id) {
        loads += 1;
        return id === 'pilot-1' ? lib.episodes[0] : undefined;
      },
    };
    const state = createReplay(loader);
    expect(loads).toBe(0);
    applyReplayEvent(state, { type: 'advance', episode: 'pilot-1', scene: 's1', skip: false, at: now }, loader);
    applyReplayEvent(state, { type: 'advance', episode: 'pilot-1', scene: 's2', skip: true, at: now }, loader);
    expect(loads).toBe(1);
    expect(state.view.episodes.later?.cursor).toBe(0);
  });

  it('超过旧会话 10_000 上限的历史仍逐条重放，不截断', () => {
    const count = 10_001;
    const base = scaleEpisode('合成夹具');
    const ids = Array.from({ length: count }, (_, index) => `ep-${index}`);
    const known = new Set(ids);
    const loader: EpisodeLoader = {
      version: 'scale-v1', episodeIds: ids, entities: [], predicates: [],
      load: (id) => known.has(id) ? { ...base, id } : undefined,
    };
    const at = '2026-10-26T00:00:00.000Z';
    const events: PlayerEvent[] = ids.map((episode) => ({ type: 'advance', episode, scene: 's1', skip: false, at }));
    expect(SessionSchema.safeParse({
      version: 1, catalog: 'scale-v1', revision: count, current: ids[0], largeText: false, events,
    }).success).toBe(false);
    const view = replayEvents(loader, events).view;
    expect(view.completed).toBe(count);
    expect(view.episodes['ep-10000']?.cursor).toBe(1);
    expect(view.episodes['ep-0']?.cursor).toBe(1);
  });

  it('100_000 条合成事件可以重放完', () => {
    const count = 100_000;
    const base = scaleEpisode('合成性能夹具，不是设备阈值');
    const ids = Array.from({ length: count }, (_, index) => `ep-${index}`);
    const known = new Set(ids);
    const loader: EpisodeLoader = {
      version: 'scale-v1', episodeIds: ids, entities: [], predicates: [],
      load: (id) => known.has(id) ? { ...base, id } : undefined,
    };
    const at = '2026-10-26T00:00:00.000Z';
    const events: PlayerEvent[] = ids.map((episode) => ({ type: 'advance', episode, scene: 's1', skip: false, at }));
    const started = performance.now();
    const before = process.memoryUsage().heapUsed;
    const view = replayEvents(loader, events).view;
    const elapsedMs = Math.round(performance.now() - started);
    const heapDelta = process.memoryUsage().heapUsed - before;
    // 只记录这一次进程内的重放耗时和堆增量。不设时间门槛，也不把它当成首屏或恢复耗时。
    console.info(JSON.stringify({ replay100k: { elapsedMs, heapDelta, completed: view.completed } }));
    expect(view.completed).toBe(count);
    expect({ elapsedMs, heapDelta, synthetic: true }).toMatchObject({ synthetic: true });
  }, 120_000);
});
