import { z } from 'zod';
import {
  compileBatch,
  Scene,
  validateBatch,
  type Batch,
  type CardSceneT,
  type ChatSceneT,
  type ComicSceneT,
  type EvidenceType,
  type PickSceneT,
  type QuizSceneT,
  type RuntimeAst,
  type ValidationContext,
} from '@endless/esl';
import { AbilityEstimator, EvidenceProcessor, SrsStore, type Grade3 } from '@endless/learning';
import { applyEffects, InMemoryWorldStore, type EntityRow, type PredicateSpec } from '@endless/world';

export type PlayableScene = ComicSceneT | ChatSceneT | PickSceneT | QuizSceneT | CardSceneT;

/** 播放器可呈现的场景：三种叙事场景 + 程序练习卡（quiz/card）。 */
const PLAYABLE_TYPES = new Set(['comic', 'chat', 'pick', 'quiz', 'card']);

export interface Episode {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  ast: RuntimeAst;
}

export interface Library {
  version: string;
  episodes: Episode[];
  glossary: Record<string, { label: string; gloss: string; forms: string[] }>;
  entities: EntityRow[];
  predicates: [string, PredicateSpec][];
}

export function createEpisode(
  batch: Batch,
  context: ValidationContext,
  meta: Pick<Episode, 'title' | 'subtitle' | 'description'>,
): Episode {
  if (batch.scenes.some((s) => !PLAYABLE_TYPES.has(s.type) || (s.type === 'chat' && s.ink))) {
    throw new Error('当前播放器仅支持漫画、无 Ink 分支的聊天、选择题与程序练习卡场景');
  }
  const report = validateBatch(batch, context);
  if (!report.ok) throw new Error(report.issues.filter((i) => i.level === 'error').map((i) => i.message).join('\n'));
  return { id: batch.batch, ...meta, ast: compileBatch(batch, report, context) };
}

export function getScenes(episode: Episode): PlayableScene[] {
  return episode.ast.nodes.filter((n) => n.parent === episode.ast.batch).map((n) => {
    const scene = Scene.parse(n.data);
    if (!PLAYABLE_TYPES.has(scene.type)) {
      throw new Error(`不支持的场景：${scene.type}`);
    }
    return scene as PlayableScene;
  });
}

export function getOptions(scene: PlayableScene): { label: string; correct?: boolean; effect?: string; asset?: string }[] {
  return scene.type === 'pick' || scene.type === 'quiz' ? scene.options : scene.type === 'chat' ? scene.reply?.options ?? [] : [];
}

const EventBase = z.object({
  episode: z.string().min(1),
  scene: z.string().min(1),
  at: z.string().datetime(),
});

const PlayerEvent = z.discriminatedUnion('type', [
  EventBase.extend({ type: z.literal('answer'), choice: z.number().int().nonnegative() }),
  EventBase.extend({ type: z.literal('advance'), skip: z.boolean() }),
  EventBase.extend({ type: z.literal('reveal') }),
]);
export type PlayerEvent = z.infer<typeof PlayerEvent>;

export const SessionSchema = z.object({
  version: z.literal(1),
  catalog: z.string(),
  revision: z.number().int().nonnegative(),
  current: z.string(),
  largeText: z.boolean(),
  events: z.array(PlayerEvent).max(10_000),
});
export type PlayerSession = z.infer<typeof SessionSchema>;

export interface AnswerResult {
  choice: number;
  correct: boolean;
  item?: string;
  evidence: EvidenceType | null;
  qualified: boolean;
  grade: Grade3 | null;
  at: string;
}

export interface SceneProgress {
  revealed?: boolean;
  answer?: AnswerResult;
  completed?: boolean;
  skipped?: boolean;
  at?: string;
}

export interface EpisodeProgress {
  cursor: number;
  scenes: Record<string, SceneProgress>;
}

export interface PlayerView {
  episodes: Record<string, EpisodeProgress>;
  srs: SrsStore;
  ability: AbilityEstimator;
  world: InMemoryWorldStore;
  answers: AnswerResult[];
  completed: number;
  skipped: number;
  exposed: Set<string>;
}

export function createSession(library: Library): PlayerSession {
  const first = library.episodes[0];
  if (!first) throw new Error('内容库为空');
  return { version: 1, catalog: library.version, revision: 0, current: first.id, largeText: false, events: [] };
}

export function projectSession(session: PlayerSession, library: Library): PlayerView {
  const view: PlayerView = {
    episodes: Object.fromEntries(library.episodes.map((e) => [e.id, { cursor: 0, scenes: {} }])),
    srs: new SrsStore(),
    ability: new AbilityEstimator(),
    world: new InMemoryWorldStore(),
    answers: [],
    completed: 0,
    skipped: 0,
    exposed: new Set(),
  };
  for (const entity of library.entities) view.world.upsertEntity(entity);
  const processor = new EvidenceProcessor('S-B');
  const seen = new Map<string, Set<string>>();
  const scenes = new Map(library.episodes.map((episode) => [episode.id, getScenes(episode)]));
  for (const event of session.events) {
    const episode = library.episodes.find((e) => e.id === event.episode);
    const progress = view.episodes[event.episode];
    const scene = scenes.get(event.episode)?.[progress?.cursor ?? -1];
    if (!episode || !progress || !scene || scene.id !== event.scene) throw new Error('存档场景顺序无效');
    const state = progress.scenes[scene.id] ??= {};
    const options = getOptions(scene);
    if (event.type === 'reveal') {
      if (state.revealed || state.answer || !scene.evidence) throw new Error('无效的提示记录');
      state.revealed = true;
    } else if (event.type === 'answer') {
      const option = options[event.choice];
      if (!option || state.answer) throw new Error('无效的答题记录');
      const evidence = episode.ast.evidence.find((e) => e.sceneId === scene.id);
      const item = evidence?.item;
      const notDue = item && view.srs.hasCard(item, 'meaning') &&
        view.srs.getCard(item, 'meaning', new Date(event.at)).due.getTime() > new Date(event.at).getTime();
      const narrativePrime = item && episode.ast.targets.some((t) =>
        t.sceneId === scene.id && t.itemId === item && /^(messages|panels)\[/.test(t.path));
      const primed = state.revealed || (item && seen.get(event.episode)?.has(item)) || narrativePrime || notDue;
      const type = evidence ? primed ? 'practice' : evidence.type : null;
      const outcome = item && type ? processor.process({
        item, facet: 'meaning', type, correct: option.correct === true,
      }) : null;
      if (item && outcome?.fsrsGrade) view.srs.grade(item, 'meaning', outcome.fsrsGrade, new Date(event.at));
      if (item && outcome?.bkt) view.ability.update(item, outcome.bkt.correct, outcome.bkt.guess);
      else if (item && outcome?.weak) view.ability.weakUpdate(item);
      const result: AnswerResult = {
        choice: event.choice,
        correct: option.correct === true,
        item,
        evidence: type,
        qualified: outcome?.fsrsGrade != null,
        grade: outcome?.fsrsGrade ?? null,
        at: event.at,
      };
      state.answer = result;
      view.answers.push(result);
      if (option.effect) {
        const effect = episode.ast.effects.find((e) => e.sceneId === scene.id && e.name === option.effect);
        if (!effect) throw new Error('选项引用了不存在的剧情效果');
        const reduced = applyEffects(view.world, effect.ops, {
          card: view.completed + view.skipped + 1,
          batch: episode.id,
          scene: scene.id,
          channel: episode.ast.channel,
          predicates: new Map(library.predicates),
          canonLocked: [],
          userChoice: option.label,
        });
        if (reduced.violations.length) throw new Error(reduced.violations.map((v) => v.reason).join('；'));
      }
    } else {
      if (options.length && !state.answer && !event.skip) throw new Error('请先作答或明确跳过');
      state.completed = !event.skip;
      state.skipped = event.skip;
      state.at = event.at;
      if (event.skip) view.skipped++;
      else {
        view.completed++;
        const targets = new Set(episode.ast.targets.filter((t) => t.sceneId === scene.id).map((t) => t.itemId));
        const episodeSeen = seen.get(event.episode) ?? new Set<string>();
        for (const item of targets) {
          episodeSeen.add(item);
          view.exposed.add(item);
          if (state.answer?.item !== item) view.ability.weakUpdate(item);
        }
        seen.set(event.episode, episodeSeen);
      }
      progress.cursor++;
    }
  }
  return view;
}

export function restoreSession(raw: unknown, library: Library): PlayerSession {
  const parsed = SessionSchema.safeParse(raw);
  if (!parsed.success) throw new Error('本地存档格式无法识别，原始数据已保留，可先下载备份');
  const session = parsed.data;
  if (session.catalog !== library.version || !library.episodes.some((e) => e.id === session.current)) {
    throw new Error('存档内容版本不匹配，原始数据已保留');
  }
  projectSession(session, library);
  return session;
}

export type PlayerCommand =
  | { type: 'select'; episode: string }
  | { type: 'text'; large: boolean }
  | { type: 'answer'; scene: string; choice: number }
  | { type: 'advance'; scene: string; skip: boolean }
  | { type: 'reveal'; scene: string };

export function transition(
  session: PlayerSession,
  command: PlayerCommand,
  library: Library,
  at = new Date().toISOString(),
): PlayerSession {
  if (command.type === 'select') {
    if (!library.episodes.some((e) => e.id === command.episode)) throw new Error('频道内容不存在');
    return session.current === command.episode ? session : { ...session, current: command.episode, revision: session.revision + 1 };
  }
  if (command.type === 'text') {
    return session.largeText === command.large ? session : { ...session, largeText: command.large, revision: session.revision + 1 };
  }
  const episode = library.episodes.find((e) => e.id === session.current);
  const view = projectSession(session, library);
  const progress = view.episodes[session.current];
  const scene = episode && getScenes(episode)[progress?.cursor ?? -1];
  if (!scene || scene.id !== command.scene) throw new Error('操作不属于当前场景');
  const state = progress?.scenes[scene.id];
  if ((command.type === 'answer' && state?.answer) || (command.type === 'reveal' && state?.revealed)) return session;
  const next: PlayerSession = {
    ...session,
    revision: session.revision + 1,
    events: [...session.events, { ...command, episode: session.current, at }],
  };
  projectSession(next, library);
  return next;
}
