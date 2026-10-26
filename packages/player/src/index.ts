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
import { type AbilityEstimator, type Grade3, type SrsStore } from '@endless/learning';
import { type EntityRow, type InMemoryWorldStore, type PredicateSpec } from '@endless/world';
import { libraryLoader, replayEvents } from './reducer.js';

export type PlayableScene = ComicSceneT | ChatSceneT | PickSceneT | QuizSceneT | CardSceneT;

/** 播放器可呈现的场景：三种叙事场景 + 程序练习卡（quiz/card）。 */
const PLAYABLE_TYPES = new Set(['comic', 'chat', 'pick', 'quiz', 'card']);

/** 呈现元数据：内容形态 / 系列 / 展示标签与每场景来源说明（由内容层注入，播放器不自查目录）。 */
export interface EpisodePresentation {
  kind: string;
  series: string;
  label: string;
  /** sceneId → 来源说明（如「本地词库 · 词义」「本集前文原句」）；无来源的场景不列出 */
  sceneSources?: Record<string, string>;
  /** 旧契约（learningVersion 1–3）生成集；试播集无 presentation，靠缺省识别 */
  legacy?: boolean;
}

export interface Episode {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  ast: RuntimeAst;
  presentation?: EpisodePresentation;
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
  meta: Pick<Episode, 'title' | 'subtitle' | 'description'> & { presentation?: EpisodePresentation },
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

/**
 * 一集的真实完成状态。
 *
 * `cursor` 只表示「推进到第几段」——跳过也会推进，所以不能单独当作「读完了」。
 * 只有走到末尾且没有任何跳过，才算真正完成；这与 AGENTS.md 的
 * 「未看、跳过与仅生成的内容不算学过」一致。
 */
export function episodeCompletion(progress: EpisodeProgress | undefined, sceneCount: number) {
  const cursor = progress?.cursor ?? 0;
  const skipped = Object.values(progress?.scenes ?? {}).filter((state) => state.skipped).length;
  return { cursor, total: sceneCount, skipped, read: sceneCount > 0 && cursor >= sceneCount && skipped === 0 };
}

export function createSession(library: Library): PlayerSession {
  const first = library.episodes[0];
  if (!first) throw new Error('内容库为空');
  return { version: 1, catalog: library.version, revision: 0, current: first.id, largeText: false, events: [] };
}

export function projectSession(session: PlayerSession, library: Library): PlayerView {
  return replayEvents(libraryLoader(library), session.events).view;
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

export * from './checkpoint.js';
export {
  REPLAY_PROJECTOR_VERSION, LEGACY_PROJECTOR_VERSION, classifyProjector, libraryLoader,
  createReplay, applyReplayEvent, replayEvents, exportReplay, importReplay, resumeReplay,
  sameReplay, verifyReplayPrefix, replayPrefixHash,
  type EpisodeLoader, type ProjectorClass, type ReplaySnapshot, type ReplayState,
} from './reducer.js';
