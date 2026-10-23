import { z } from 'zod';
import { Batch, batchTextUnits, contentHash, locateForm, validateBatch, type ValidationContext, type ValidationIssue } from '@endless/esl';
import { Planner, type PlannerInput } from '@endless/learning';
import {
  createEpisode, getOptions, getScenes, projectSession, restoreSession, SessionSchema, transition,
  type Library, type PlayerSession,
} from '@endless/player';
import { createPilotContent } from './pilot.js';
import { buildExerciseScenes } from './exercises.js';

export const MAX_GENERATED_EPISODES = 50;

export const GeneratedEpisodeSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  basedOn: z.object({ eventCount: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{16}$/) }),
  title: z.string().min(1).max(100),
  subtitle: z.string().min(1).max(160),
  description: z.string().min(1).max(400),
  batch: Batch,
  hash: z.string().regex(/^[a-f0-9]{16}$/),
  /** v2 = 学习任务契约（introduce/expose/review 覆盖规则）；v3 = v2 + 可含程序练习卡（quiz/card 场景） */
  learningVersion: z.union([z.literal(2), z.literal(3)]).optional(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    calls: z.number().int().min(1).max(3),
  }).optional(),
});
export type GeneratedEpisode = z.infer<typeof GeneratedEpisodeSchema>;

export const SavedPlayerSchema = z.object({
  version: z.literal(2),
  revision: z.number().int().nonnegative(),
  session: SessionSchema,
  generated: z.array(GeneratedEpisodeSchema).max(MAX_GENERATED_EPISODES),
});
export type SavedPlayer = z.infer<typeof SavedPlayerSchema>;

export const GenerationRequestSchema = z.object({
  requestId: z.string().uuid(),
  save: SavedPlayerSchema,
});
export type GenerationRequest = z.infer<typeof GenerationRequestSchema>;

export const ApiStatusSchema = z.object({
  configured: z.boolean(), model: z.string(), token: z.string().min(1),
  acceptsUserKey: z.boolean().default(false),
  quota: z.object({ dailyLimit: z.number().int(), used: z.number().int(), remaining: z.number().int() }),
});
export type ApiStatus = z.infer<typeof ApiStatusSchema>;

export const GenerationFailureSchema = z.object({
  category: z.enum(['content', 'auth', 'rate-limit', 'timeout', 'network', 'provider', 'budget', 'storage', 'unknown']),
  codes: z.array(z.string().regex(/^[A-Z][A-Z0-9-]{1,64}$/)).max(30),
});
export type GenerationFailure = z.infer<typeof GenerationFailureSchema>;

export const GenerationJobSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  phase: z.string(),
  result: GeneratedEpisodeSchema.optional(),
  error: z.string().optional(),
  failure: GenerationFailureSchema.optional(),
});

export function createContent(lexiconText: string) {
  const { pilot, lexicon, context: pilotContext } = createPilotContent(lexiconText);

  function historyKey(session: PlayerSession) {
    return { eventCount: session.events.length, hash: contentHash({ catalog: session.catalog, events: session.events }) };
  }

  function snapshot(session: PlayerSession, generated: GeneratedEpisode[]): SavedPlayer {
    return { version: 2, revision: session.revision, session, generated };
  }

  function stateContext(session: PlayerSession, library: Library) {
    const view = projectSession(session, library);
    const exposureCounts = new Map<string, number>();
    for (const episode of library.episodes) {
      for (const scene of getScenes(episode)) {
        if (!view.episodes[episode.id]?.scenes[scene.id]?.completed) continue;
        const targets = new Set(episode.ast.targets.filter((t) => t.sceneId === scene.id).map((t) => t.itemId));
        for (const item of targets) exposureCounts.set(item, (exposureCounts.get(item) ?? 0) + 1);
      }
    }
    const context: ValidationContext = {
      ...pilotContext,
      canonFacts: [{ subject: 'duck', predicate: 'is_a', object: 'duck' }],
      activeFacts: view.world.currentFacts(),
      threads: new Map(view.world.allThreads().map((thread) => [thread.id, thread])),
      exposureCounts,
    };
    return { view, exposureCounts, context };
  }

  function plan(session: PlayerSession, library: Library, now = new Date(), learningVersion: 1 | 2 | 3 = 3) {
    if (library.episodes.length >= pilot.episodes.length + MAX_GENERATED_EPISODES) {
      throw new Error('已达到本机 MVP 的 50 集 AI 内容上限，请先导出备份');
    }
    const state = stateContext(session, library);
    if (library.episodes.some((episode) => state.view.episodes[episode.id]!.cursor < getScenes(episode).length)) {
      throw new Error('请先看完已有故事，再生成下一集');
    }
    const planner = new Planner(lexicon);
    const input: PlannerInput = {
      now, level: 'A2', srs: state.view.srs, ability: state.view.ability,
      exposureCounts: state.exposureCounts, introduced: state.view.exposed,
      allowedExtraPool: [], maxReviews: 1, maxIntroduce: 1,
    };
    const brief = planner.nextBrief(input, library.episodes.length + 1);
    if (learningVersion >= 2) {
      const candidate = planner.nextCandidates(input, lexicon.entries.size)
        .find((item) => lexicon.entries.get(item)?.kind === 'sense') ?? brief.introduce[0];
      const previous = new Set(brief.introduce);
      brief.introduce = candidate ? [candidate] : [];
      brief.expose = [
        ...brief.introduce.map((item) => ({ item, exposures_so_far: 0, need: 2 })),
        ...brief.expose.filter((entry) => !previous.has(entry.item) && entry.item !== candidate),
      ];
      brief.review = state.view.srs.dueItems(now, 'meaning')
        .filter((entry) => (state.exposureCounts.get(entry.item) ?? 0) >= 2).slice(0, 1)
        .map((entry) => ({ item: entry.item, facet: 'meaning', min_evidence: 'recognition-4' }));
      brief.avoid_before_test = brief.review.flatMap((entry) => lexicon.forms.get(entry.item) ?? []);
    }
    const excluded = new Set([...brief.introduce, ...brief.expose.map((entry) => entry.item)]);
    const known = [...lexicon.entries.keys()].filter((item) => !excluded.has(item) &&
      (state.exposureCounts.get(item) ?? 0) >= 2 && (lexicon.forms.get(item)?.length ?? 0) > 0)
      .sort((a, b) => (learningVersion >= 2
        ? Number(state.view.srs.hasCard(a, 'meaning')) - Number(state.view.srs.hasCard(b, 'meaning')) : 0) ||
        state.view.ability.get(a) - state.view.ability.get(b));
    const detection = brief.review.length
      ? brief.review.map((review) => ({ item: review.item, type: review.min_evidence }))
      : known[0] ? [{ item: known[0], type: 'recognition-4' as const }]
      : brief.expose[0] ? [{ item: brief.expose[0].item, type: 'practice' as const }] : [];
    return {
      ...state, brief, detection,
      practice: learningVersion >= 2
        ? brief.introduce.filter((item) => !detection.some((target) => target.item === item)).map((item) => ({ item, type: 'practice' as const }))
        : [],
      context: {
        ...state.context,
        brief: {
          id: brief.brief, review: brief.review.map((r) => ({ ...r, minEvidence: r.min_evidence })),
          expose: brief.expose, introduce: brief.introduce, avoidBeforeTest: brief.avoid_before_test,
        },
      } satisfies ValidationContext,
    };
  }

  function validatePlayable(batch: Batch, context: ValidationContext): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (batch.channel !== 'duck_detective' || batch.new_entities?.length) {
      issues.push({ code: 'E-SCHEMA', level: 'error', message: '本版只支持 Duck Detective 和既有角色，不允许新实体' });
    }
    for (const scene of batch.scenes) {
      // 写手只交叙事场景（comic/chat/pick）；quiz/card 是程序练习卡，由拼接器产出、校验放行
      if (!['comic', 'chat', 'pick', 'quiz', 'card'].includes(scene.type) || (scene.type === 'chat' && scene.ink)) {
        issues.push({ code: 'E-SCHEMA', level: 'error', scene: scene.id, message: '仅支持 comic、无 Ink 的 chat、pick 与程序练习卡；不得丢弃其他场景' });
      }
    }
    return [...issues, ...validateBatch(batch, context).issues];
  }

  function learningIssues(batch: Batch, task: ReturnType<typeof plan>, learningVersion: 1 | 2 | 3 = 3): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const error = (message: string, scene?: string) =>
      issues.push({ code: 'E-LEARNING-TASK', level: 'error', message, scene });
    for (const target of [...task.detection, ...task.practice]) {
      if (!batch.scenes.some((scene) => scene.evidence?.item === target.item && scene.evidence.type === target.type)) {
        error(`缺少互动 ${target.item}，evidence.type 必须为 ${target.type}`);
      }
    }
    for (const scene of batch.scenes) {
      if (scene.evidence && scene.evidence.type !== 'practice' && (task.exposureCounts.get(scene.evidence.item) ?? 0) < 2) {
        error(`条目 ${scene.evidence.item} 曝光不足两次，只能记 practice`, scene.id);
      }
    }
    if (learningVersion >= 2) {
      const units = batchTextUnits(batch);
      for (const target of task.detection.filter((entry) => entry.type !== 'practice')) {
        const index = batch.scenes.findIndex((scene) => scene.evidence?.item === target.item);
        if (index < 0) continue;
        const primed = units.find((unit) => (unit.sceneIndex < index || (unit.sceneIndex === index && unit.role === 'narrative')) &&
          (lexicon.forms.get(target.item) ?? []).some((form) => locateForm(unit.text, form).length));
        if (primed) issues.push({
          code: 'E-PRIMED', level: 'error', scene: primed.sceneId,
          message: `独立检索 ${target.item} 之前已经出现答案；把检索放在教学前，或改写前文`,
        });
      }
      for (const item of task.brief.introduce) {
        const scenes = new Set(units.filter((unit) => unit.role === 'narrative' &&
          (lexicon.forms.get(item) ?? []).some((form) => locateForm(unit.text, form).length)).map((unit) => unit.sceneId));
        if (scenes.size < 2) error(`新词 ${item} 需要在两个不同场景的正文出现，再配一个 practice 互动；不要仅出现在选项中`);
      }
    }
    return issues;
  }

  function learningNotes(session: PlayerSession, library: Library) {
    const { view, exposureCounts } = stateContext(session, library);
    const items = new Set([...view.exposed, ...view.answers.flatMap((answer) => answer.item ? [answer.item] : [])]);
    return [...items].map((item) => {
      const attempts = view.answers.filter((answer) => answer.item === item).length;
      const card = view.srs.allCards().find((row) => row.key === `${item}#meaning`)?.card;
      return {
        item, ...library.glossary[item], exposures: exposureCounts.get(item) ?? 0, attempts, due: card?.due,
        status: card ? 'scheduled' as const : attempts ? 'practice' as const : 'exposed' as const,
      };
    });
  }

  function validatePaths(session: PlayerSession, library: Library) {
    const episode = library.episodes.at(-1)!;
    let paths = [transition(session, { type: 'select', episode: episode.id }, library)];
    for (const scene of getScenes(episode)) {
      paths = paths.flatMap((path) => {
        const options = getOptions(scene);
        const branches = options.length
          ? options.map((_, choice) => transition(path, { type: 'answer', scene: scene.id, choice }, library))
          : [path];
        // 每个选项都各自验证过一遍（索引合法、effect 可应用）；但只有带 effect 的选项会改变
        // 世界状态——无 effect 的分支对后续可玩性完全等价，合并成一条，避免选项数级联爆炸
        const diverging = options.some((option) => option.effect) ? branches : branches.slice(0, 1);
        return [
          transition(path, { type: 'advance', scene: scene.id, skip: true }, library),
          ...diverging.map((branch) => transition(branch, { type: 'advance', scene: scene.id, skip: false }, library)),
        ];
      });
    }
  }

  function restore(raw: unknown) {
    const envelope = SavedPlayerSchema.safeParse(raw);
    const legacy = envelope.success ? null : SessionSchema.safeParse(raw);
    if (!envelope.success && !legacy?.success) throw new Error('本地存档格式无法识别，原始数据已保留，可先下载备份');
    const session = envelope.success ? envelope.data.session : legacy!.data!;
    const generated = envelope.success ? envelope.data.generated : [];
    if (envelope.success && envelope.data.revision !== session.revision) throw new Error('本地存档修订号不匹配，原始数据已保留');
    let library = pilot;
    for (const document of generated) {
      if (contentHash(document.batch) !== document.hash) throw new Error('AI 内容哈希不匹配，原始存档已保留');
      if (library.episodes.some((episode) => episode.id === document.batch.batch)) throw new Error('AI 内容 ID 重复');
      if (document.basedOn.eventCount > session.events.length) throw new Error('AI 内容引用了不存在的历史');
      const prefix = {
        ...session, current: library.episodes.at(-1)!.id,
        events: session.events.slice(0, document.basedOn.eventCount),
      };
      restoreSession(prefix, library);
      if (historyKey(prefix).hash !== document.basedOn.hash) throw new Error('AI 内容与存档历史不匹配');
      const { context, view } = stateContext(prefix, library);
      if (library.episodes.some((episode) => view.episodes[episode.id]!.cursor < getScenes(episode).length)) {
        throw new Error('AI 内容生成时仍有未看完的故事');
      }
      const errors = validatePlayable(document.batch, context).filter((issue) => issue.level === 'error');
      if (errors.length) throw new Error(errors.map((issue) => issue.message).join('；'));
      const episode = createEpisode(document.batch, context, document);
      library = { ...library, episodes: [...library.episodes, episode] };
    }
    return { session: restoreSession(session, library), generated, library };
  }

  function accept(raw: unknown, save: SavedPlayer) {
    const document = GeneratedEpisodeSchema.parse(raw);
    const restored = restore(save);
    if (historyKey(restored.session).hash !== document.basedOn.hash ||
      document.basedOn.eventCount !== restored.session.events.length) throw new Error('生成内容不属于当前进度，请勿覆盖存档');
    const learningVersion = document.learningVersion ?? 1;
    const task = plan(restored.session, restored.library, new Date(document.generatedAt), learningVersion);
    const { context } = task;
    if (document.batch.brief !== context.brief!.id) throw new Error('生成内容的学习任务版本不匹配');
    const errors = validatePlayable(document.batch, context).filter((issue) => issue.level === 'error');
    if (errors.length) throw new Error(errors.map((issue) => issue.message).join('；'));
    const report = validateBatch(document.batch, context);
    if (!report.detectionScenes || !report.worldChanges) throw new Error('AI 内容必须包含有效学习互动和可选剧情效果');
    const learning = learningIssues(document.batch, task, learningVersion);
    if (learning.length) throw new Error(learning.map((issue) => issue.message).join('；'));
    const next = restore(snapshot(restored.session, [...restored.generated, document]));
    validatePaths(restored.session, next.library);
    return { ...next, document };
  }

  /**
   * 双层生成下半层：把校验通过的 LLM 叙事批次拼入程序练习卡（quiz/card）。
   * 返回新的场景数组（未重新 parse；调用方写回 batch.scenes 后再跑完整校验）。
   */
  function exerciseScenes(batch: Batch, task: ReturnType<typeof plan>, library: Library, seq: number) {
    return buildExerciseScenes({
      batch, library, task, lexicon,
      emojis: [...pilotContext.assets.emojis],
      seq,
    });
  }

  return { pilot, lexicon, pilotContext, historyKey, snapshot, stateContext, plan, learningIssues, learningNotes, validatePlayable, exerciseScenes, restore, accept };
}

export type Content = ReturnType<typeof createContent>;
