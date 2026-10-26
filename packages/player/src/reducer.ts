/**
 * 播放器唯一的事件重放。
 *
 * 完整重放、检查点后续放和分段重放都走 applyReplayEvent。
 * 旧的 player-projection-1 导出仍把 seen/streaks 留空，不能拿来续放；
 * 这里的 player-replay-1 才保存会影响后续评分的连续状态。
 */
import { contentHash, stableStringify } from '@endless/esl';
import { AbilityEstimator, EvidenceProcessor, SrsStore } from '@endless/learning';
import { applyEffects, InMemoryWorldStore } from '@endless/world';
import {
  getOptions, getScenes,
  type Episode, type Library, type PlayerEvent, type PlayerView, type PlayableScene,
} from './index.js';

export const REPLAY_PROJECTOR_VERSION = 'player-replay-1' as const;
export const LEGACY_PROJECTOR_VERSION = 'player-projection-1' as const;

export type ProjectorClass = 'replay' | 'legacy-lossy' | 'unknown';

/** 旧投影只可整段重放；未知版本拒绝续放，避免把没见过的算法当成掌握度。 */
export function classifyProjector(version: string): ProjectorClass {
  if (version === REPLAY_PROJECTOR_VERSION) return 'replay';
  if (version === LEGACY_PROJECTOR_VERSION) return 'legacy-lossy';
  return 'unknown';
}

export interface EpisodeLoader {
  version: string;
  episodeIds: readonly string[];
  entities: Library['entities'];
  predicates: Library['predicates'];
  /** 只在事件真正落到该集时调用。未访问的集不编译场景。 */
  load(episodeId: string): Episode | undefined;
}

export function libraryLoader(library: Library): EpisodeLoader {
  const byId = new Map(library.episodes.map((episode) => [episode.id, episode]));
  return {
    version: library.version,
    episodeIds: library.episodes.map((episode) => episode.id),
    entities: library.entities,
    predicates: library.predicates,
    load: (episodeId) => byId.get(episodeId),
  };
}

export interface ReplayState {
  view: PlayerView;
  processor: EvidenceProcessor;
  seen: Map<string, Set<string>>;
  sceneCache: Map<string, PlayableScene[]>;
  episodeCache: Map<string, Episode>;
}

export interface ReplaySnapshot {
  projectorVersion: typeof REPLAY_PROJECTOR_VERSION;
  strategy: 'S-B';
  catalog: string;
  eventCount: number;
  eventHash: string;
  episodes: PlayerView['episodes'];
  srs: { key: string; card: Record<string, unknown> }[];
  bkt: { item: string; mastery: number }[];
  streaks: [string, number][];
  world: ReturnType<InMemoryWorldStore['dumpState']>;
  seen: { episode: string; items: string[] }[];
  answers: PlayerView['answers'];
  completed: number;
  skipped: number;
  exposed: string[];
}

export function replayPrefixHash(catalog: string, events: readonly unknown[]): string {
  return contentHash({ catalog, events });
}

export function createReplay(loader: EpisodeLoader): ReplayState {
  const world = new InMemoryWorldStore();
  for (const entity of loader.entities) world.upsertEntity(entity);
  return {
    view: {
      episodes: Object.fromEntries(loader.episodeIds.map((id) => [id, { cursor: 0, scenes: {} }])),
      srs: new SrsStore(),
      ability: new AbilityEstimator(),
      world,
      answers: [],
      completed: 0,
      skipped: 0,
      exposed: new Set(),
    },
    processor: new EvidenceProcessor('S-B'),
    seen: new Map(),
    sceneCache: new Map(),
    episodeCache: new Map(),
  };
}

function episodeOf(state: ReplayState, loader: EpisodeLoader, episodeId: string): Episode | undefined {
  const cached = state.episodeCache.get(episodeId);
  if (cached) return cached;
  const episode = loader.load(episodeId);
  if (!episode) return undefined;
  state.episodeCache.set(episodeId, episode);
  return episode;
}

function scenesOf(state: ReplayState, episode: Episode): PlayableScene[] {
  const cached = state.sceneCache.get(episode.id);
  if (cached) return cached;
  const scenes = getScenes(episode);
  state.sceneCache.set(episode.id, scenes);
  return scenes;
}

/** 与完整重放同一套评分、去重和世界序。调用方传入的事件按已发生的顺序，不再排序。 */
export function applyReplayEvent(state: ReplayState, event: PlayerEvent, loader: EpisodeLoader): void {
  const episode = episodeOf(state, loader, event.episode);
  const progress = state.view.episodes[event.episode];
  const scene = episode ? scenesOf(state, episode)[progress?.cursor ?? -1] : undefined;
  if (!episode || !progress || !scene || scene.id !== event.scene) throw new Error('存档场景顺序无效');
  const sceneState = progress.scenes[scene.id] ??= {};
  const options = getOptions(scene);
  if (event.type === 'reveal') {
    if (sceneState.revealed || sceneState.answer || !scene.evidence) throw new Error('无效的提示记录');
    sceneState.revealed = true;
  } else if (event.type === 'answer') {
    const option = options[event.choice];
    if (!option || sceneState.answer) throw new Error('无效的答题记录');
    const evidence = episode.ast.evidence.find((entry) => entry.sceneId === scene.id);
    const item = evidence?.item;
    const notDue = item && state.view.srs.hasCard(item, 'meaning') &&
      state.view.srs.getCard(item, 'meaning', new Date(event.at)).due.getTime() > new Date(event.at).getTime();
    const narrativePrime = item && episode.ast.targets.some((target) =>
      target.sceneId === scene.id && target.itemId === item && /^(messages|panels)\[/.test(target.path));
    const primed = sceneState.revealed || (item && state.seen.get(event.episode)?.has(item)) || narrativePrime || notDue;
    const type = evidence ? primed ? 'practice' : evidence.type : null;
    const outcome = item && type ? state.processor.process({
      item, facet: 'meaning', type, correct: option.correct === true,
    }) : null;
    if (item && outcome?.fsrsGrade) state.view.srs.grade(item, 'meaning', outcome.fsrsGrade, new Date(event.at));
    if (item && outcome?.bkt) state.view.ability.update(item, outcome.bkt.correct, outcome.bkt.guess);
    else if (item && outcome?.weak) state.view.ability.weakUpdate(item);
    sceneState.answer = {
      choice: event.choice,
      correct: option.correct === true,
      item,
      evidence: type,
      qualified: outcome?.fsrsGrade != null,
      grade: outcome?.fsrsGrade ?? null,
      at: event.at,
    };
    state.view.answers.push(sceneState.answer);
    if (option.effect) {
      const effect = episode.ast.effects.find((entry) => entry.sceneId === scene.id && entry.name === option.effect);
      if (!effect) throw new Error('选项引用了不存在的剧情效果');
      const reduced = applyEffects(state.view.world, effect.ops, {
        card: state.view.completed + state.view.skipped + 1,
        batch: episode.id,
        scene: scene.id,
        channel: episode.ast.channel,
        predicates: new Map(loader.predicates),
        canonLocked: [],
        userChoice: option.label,
      });
      if (reduced.violations.length) throw new Error(reduced.violations.map((violation) => violation.reason).join('；'));
    }
  } else {
    if (options.length && !sceneState.answer && !event.skip) throw new Error('请先作答或明确跳过');
    sceneState.completed = !event.skip;
    sceneState.skipped = event.skip;
    sceneState.at = event.at;
    if (event.skip) state.view.skipped++;
    else {
      state.view.completed++;
      const targets = new Set(episode.ast.targets.filter((target) => target.sceneId === scene.id).map((target) => target.itemId));
      const episodeSeen = state.seen.get(event.episode) ?? new Set<string>();
      for (const item of targets) {
        episodeSeen.add(item);
        state.view.exposed.add(item);
        if (sceneState.answer?.item !== item) state.view.ability.weakUpdate(item);
      }
      state.seen.set(event.episode, episodeSeen);
    }
    progress.cursor++;
  }
}

export function replayEvents(loader: EpisodeLoader, events: readonly PlayerEvent[]): ReplayState {
  const state = createReplay(loader);
  for (const event of events) applyReplayEvent(state, event, loader);
  return state;
}

function freezeCard(card: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(card)) out[key] = value instanceof Date ? value.toISOString() : value;
  return out;
}

function thawCard(card: Record<string, unknown>): Parameters<SrsStore['restoreCard']>[1] {
  const out: Record<string, unknown> = { ...card };
  if (typeof out.due === 'string') out.due = new Date(out.due);
  if (typeof out.last_review === 'string') out.last_review = new Date(out.last_review);
  return out as unknown as Parameters<SrsStore['restoreCard']>[1];
}

export function exportReplay(state: ReplayState, catalog: string, events: readonly unknown[]): ReplaySnapshot {
  const world = (state.view.world as InMemoryWorldStore).dumpState();
  return {
    projectorVersion: REPLAY_PROJECTOR_VERSION,
    strategy: 'S-B',
    catalog,
    eventCount: events.length,
    eventHash: replayPrefixHash(catalog, events),
    episodes: structuredClone(state.view.episodes),
    srs: state.view.srs.allCards()
      .map(({ key, card }) => ({ key, card: freezeCard(card) }))
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    bkt: state.view.ability.entries()
      .map(([item, mastery]) => ({ item, mastery }))
      .sort((a, b) => a.item < b.item ? -1 : a.item > b.item ? 1 : 0),
    streaks: state.processor.streaks().sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    world,
    seen: [...state.seen.entries()]
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([episode, items]) => ({ episode, items: [...items].sort() })),
    answers: structuredClone(state.view.answers),
    completed: state.view.completed,
    skipped: state.view.skipped,
    exposed: [...state.view.exposed],
  };
}

export function importReplay(snapshot: ReplaySnapshot, loader: EpisodeLoader): ReplayState {
  if (snapshot.projectorVersion !== REPLAY_PROJECTOR_VERSION || snapshot.strategy !== 'S-B') {
    throw new Error('该检查点不能作为续放依据');
  }
  if (snapshot.catalog !== loader.version) throw new Error('检查点内容目录与当前目录不一致');
  const state = createReplay(loader);
  state.view.episodes = structuredClone(snapshot.episodes);
  for (const { key, card } of snapshot.srs) state.view.srs.restoreCard(key, thawCard(card));
  for (const { item, mastery } of snapshot.bkt) state.view.ability.force(item, mastery);
  (state.view.world as InMemoryWorldStore).restoreState(structuredClone(snapshot.world));
  for (const [key, count] of snapshot.streaks) state.processor.setStreak(key, count);
  state.seen = new Map(snapshot.seen.map((row) => [row.episode, new Set(row.items)]));
  state.view.answers = structuredClone(snapshot.answers);
  state.view.completed = snapshot.completed;
  state.view.skipped = snapshot.skipped;
  state.view.exposed = new Set(snapshot.exposed);
  return state;
}

export function resumeReplay(snapshot: ReplaySnapshot, loader: EpisodeLoader, events: readonly PlayerEvent[]): ReplayState {
  const state = importReplay(snapshot, loader);
  for (const event of events) applyReplayEvent(state, event, loader);
  return state;
}

export function sameReplay(left: ReplaySnapshot, right: ReplaySnapshot): boolean {
  return stableStringify(left) === stableStringify(right);
}

/** 用原始事件重算。客户端自报的投影对不上就不是可信检查点。 */
export function verifyReplayPrefix(loader: EpisodeLoader, events: readonly PlayerEvent[], snapshot: ReplaySnapshot): boolean {
  if (classifyProjector(snapshot.projectorVersion) !== 'replay') return false;
  if (snapshot.catalog !== loader.version || snapshot.eventCount !== events.length) return false;
  if (snapshot.eventHash !== replayPrefixHash(loader.version, events)) return false;
  return sameReplay(exportReplay(replayEvents(loader, events), loader.version, events), snapshot);
}
