import { z } from 'zod';
import {
  Batch, batchTextUnits, contentHash, locateForm, stableStringify, validateBatch,
  type ValidationContext, type ValidationIssue,
} from '@endless/esl';
import { Planner, type PlannerInput } from '@endless/learning';
import {
  createEpisode, getOptions, getScenes, projectSession, restoreSession, SessionSchema, transition,
  type EpisodePresentation, type Library, type PlayerSession,
} from '@endless/player';
import { createPilotContent } from './pilot.js';
import { buildExerciseScenes } from './exercises.js';
import {
  creativeKinds, creativeSeries, creativeComponents, creativeScenePolicy, creativeProperNames, rankCreativeOptions,
  creativeIntroductionPolicy, creativeIntroductionCount, selectCreativeIntroductions,
  type CreativeKind, type CreativeSeriesId, type CreativeHistory,
} from './creative-policy.js';
import {
  GeneratedEpisodeSchema, type GeneratedEpisode,
} from './application-contract.js';
import { materialAssetCatalog, materialEntityExists, materialEntityRows, materialItemPictures, materialProps, materialCharacters, materialBackgrounds } from './materials.js';
import { tokenize } from '@endless/esl';
import { compileDraft as compileCreativeDraft, DRAFT_PROTOCOL, type CreativeTarget, type CreativeTask, type DraftResult } from './creative.js';

export * from './creative-policy.js';
export * from './materials.js';
export * from './application-contract.js';
export * from './archive.js';
export * from './backup.js';
export * from './cloud-import.js';
export * from './cloud-context.js';
export * from './cloud-catalog.js';
export * from './context.js';
export * from './lifecycle.js';
export * from './revision.js';
export * from './workspace.js';
/**
 * Edition 是独立契约的第二种模式：命名空间导出，避免与 ENDLESS 的 ID/摘要/校验
 * 名称冲突，也让「旧验收器不接受 Edition 文档」在类型层面可见。
 */
export * as edition from './edition/index.js';
export { DRAFT_HEADER, DRAFT_PROTOCOL } from './creative.js';
export type { CreativeTask, DraftResult, DraftSuccess } from './creative.js';

/**
 * 应用层统一契约（`endless-workspace`）在 `./application-contract.js`：
 * `GeneratedEpisodeSchema`、`DraftCreationSchema`、工作区快照与跨对象不变量都由它导出。
 * 下面保留的 `SavedPlayer` 只是实验/过渡期的请求信封，应用运行时使用 `WorkspaceSnapshot`。
 */

export const SavedPlayerSchema = z.object({
  version: z.literal(2),
  revision: z.number().int().nonnegative(),
  session: SessionSchema,
  generated: z.array(GeneratedEpisodeSchema),
});
export type SavedPlayer = z.infer<typeof SavedPlayerSchema>;

/** 归档上下文：覆盖卷的成员在提示词中走摘要；校验仍以 save 中的完整原件为准。 */
export const ArchiveContextEntrySchema = z.object({
  volumeId: z.string().min(1),
  series: z.string().min(1),
  title: z.string().min(1).max(100),
  narrative: z.string().min(1).max(2000),
  facts: z.array(z.object({ subject: z.string(), predicate: z.string(), object: z.string() })).max(200),
  choices: z.array(z.object({ chosen: z.string() })).max(500),
  threads: z.array(z.object({ id: z.string(), title: z.string(), status: z.string() })).max(200),
  episodeIds: z.array(z.string()).max(500),
});
export type ArchiveContextEntryWire = z.infer<typeof ArchiveContextEntrySchema>;

export const GenerationRequestSchema = z.object({
  requestId: z.string().uuid(),
  save: SavedPlayerSchema,
  archives: z.array(ArchiveContextEntrySchema).max(50).optional(),
});
export type GenerationRequest = z.infer<typeof GenerationRequestSchema>;

export const ApiStatusSchema = z.object({
  configured: z.boolean(), model: z.string(), token: z.string().min(1),
  acceptsUserKey: z.boolean().default(false),
  quota: z.object({ dailyLimit: z.number().int(), used: z.number().int(), remaining: z.number().int() }).optional(),
  /** 预留能力状态：服务端权威判定，全部默认 false */
  features: z.object({
    accounts: z.boolean(), cloudSync: z.boolean(), usageLedger: z.boolean(),
    pricing: z.boolean(), payments: z.boolean(),
  }).optional(),
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

  function plan(session: PlayerSession, library: Library, now = new Date(), learningVersion: 1 | 2 | 3 | 4 = 3) {
    const state = stateContext(session, library);
    if (library.episodes.some((episode) => state.view.episodes[episode.id]!.cursor < getScenes(episode).length)) {
      throw new Error('请先看完已有故事，再生成下一集');
    }
    const planner = new Planner(lexicon);
    const input: PlannerInput = {
      now, level: 'A2', srs: state.view.srs, ability: state.view.ability,
      exposureCounts: state.exposureCounts, introduced: state.view.exposed,
      allowedExtraPool: [], maxReviews: 1,
      maxIntroduce: learningVersion === 4 ? creativeIntroductionPolicy.max : 1,
    };
    const brief = planner.nextBrief(input, library.episodes.length + 1);
    if (learningVersion >= 2) {
      const candidates = planner.nextCandidates(input, lexicon.entries.size);
      const entryFor = (id: string) => {
        const entry = lexicon.entries.get(id);
        return entry ? { kind: entry.kind, forms: lexicon.forms.get(id) ?? [], example: entry.example } : undefined;
      };
      const allowedForms = new Set([...state.context.vocab.allowedForms, ...creativeProperNames]);
      // v4 每批引入 2–5 个新词/知识点；v2–3 仍是单条教学契约，存档不重解释。
      const selected = learningVersion === 4
        ? selectCreativeIntroductions(candidates, entryFor, allowedForms, creativeIntroductionCount(library.episodes.length + 1))
        : [
            candidates.find((item) => lexicon.entries.get(item)?.kind === 'sense') ?? brief.introduce[0],
          ].filter((item): item is string => !!item);
      const previous = new Set(brief.introduce);
      brief.introduce = selected;
      brief.expose = [
        ...brief.introduce.map((item) => ({ item, exposures_so_far: 0, need: 2 })),
        ...brief.expose.filter((entry) => !previous.has(entry.item) && !brief.introduce.includes(entry.item)),
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

  function validatePlayable(batch: Batch, context: ValidationContext, allowCreative = false): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const channelOk = batch.channel === 'duck_detective' || (allowCreative && batch.channel in creativeSeries);
    if (!channelOk || batch.new_entities?.length) {
      issues.push({ code: 'E-SCHEMA', level: 'error', message: '不支持的频道或声明了新实体；v4 只允许注册系列与既有角色' });
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

  /** v4 校验上下文：应用素材注册表 + 注册角色 + 10–20 场口径；旧契约上下文不变。
   *  词表只在原 allowedForms 之上加注册专有名词（badger/mouse/guide）；
   *  来源文本（fact/example）同样接受 5% OOV 与行长校验，不通过即为真实内容问题。 */
  function creativeContext(context: ValidationContext): ValidationContext {
    const allowed = new Set(context.vocab.allowedForms);
    for (const name of creativeProperNames) allowed.add(name);
    return {
      ...context,
      vocab: { ...context.vocab, allowedForms: allowed },
      assets: materialAssetCatalog(),
      entities: { exists: materialEntityExists },
      sceneCountPolicy: { ...creativeScenePolicy },
    };
  }

  function creativePresentation(kind: string, series: string, sceneSources?: Record<string, string>): EpisodePresentation {
    const registered = (creativeSeries as Record<string, { label: string }>)[series];
    return { kind, series, label: registered?.label ?? '鸭侦探事务所', ...(sceneSources && Object.keys(sceneSources).length ? { sceneSources } : {}) };
  }

  function episodePresentation(library: Library) {
    return (episode: { presentation?: EpisodePresentation }) =>
      episode.presentation ?? creativePresentation('story', 'duck_detective');
  }

  /**
   * v4 创作规划：与 plan(...,4) 同一学习契约，另给出短名目标、素材目录与冷门推荐。
   */
  function planCreative(session: PlayerSession, library: Library, now = new Date()) {
    const task = plan(session, library, now, 4);
    const aliases = new Map<string, string>();
    const order = [
      ...task.brief.introduce,
      ...task.brief.expose.map((entry) => entry.item),
      ...task.detection.map((entry) => entry.item),
      ...task.practice.map((entry) => entry.item),
    ];
    for (const item of order) if (!aliases.has(item)) aliases.set(item, `t${aliases.size + 1}`);
    const required = new Map<string, string>();
    for (const entry of task.detection) required.set(entry.item, entry.type);
    for (const entry of task.practice) required.set(entry.item, 'practice');
    const history: CreativeHistory[] = library.episodes.map((episode) => {
      const presentation = episodePresentation(library)(episode);
      return {
        kind: presentation.kind as CreativeKind,
        series: presentation.series as CreativeSeriesId,
        components: getScenes(episode).map((scene) => scene.type),
      };
    });
    const allowedForms = new Set([...task.context.vocab.allowedForms, ...creativeProperNames]);
    const usableExample = (item: string) => {
      const entry = lexicon.entries.get(item);
      return !!entry?.example &&
        (lexicon.forms.get(item) ?? []).some((form) => locateForm(entry.example!, form).length) &&
        tokenize(entry.example).every((token) => allowedForms.has(token));
    };
    const introduceSet = new Set(task.brief.introduce);
    const reviewSet = new Set(task.brief.review.map((entry) => entry.item));
    const targets: (CreativeTarget & {
      forms: string[];
      gloss: string;
      materials: { gloss: boolean; example: boolean; picture: boolean };
    })[] = [...aliases.entries()].map(([item, alias]) => {
      const entry = lexicon.entries.get(item);
      return {
        alias, item,
        /** 给创作提示词区分：introduce 要两处正文语境加一个 practice，review 要独立检索，expose 只需出现 */
        role: introduceSet.has(item) ? 'introduce' as const
          : reviewSet.has(item) ? 'review' as const : 'expose' as const,
        forms: lexicon.forms.get(item) ?? [],
        gloss: entry?.gloss_zh ?? '',
        interaction: (required.get(item) ?? null) as import('@endless/esl').EvidenceType | null,
        materials: {
          gloss: !!entry?.gloss_zh,
          example: usableExample(item),
          picture: Object.values(materialItemPictures).includes(item),
        },
      };
    });
    return {
      ...task,
      context: creativeContext(task.context),
      targets,
      ranked: rankCreativeOptions(history),
      history,
      catalog: {
        kinds: creativeKinds,
        series: Object.entries(creativeSeries).map(([id, s]) => ({ id, ...s })),
        components: creativeComponents,
        characters: materialCharacters.map((c) => ({ id: c.id, label: c.label, expressions: c.spec.expr })),
        backgrounds: materialBackgrounds,
        props: materialProps,
        itemPictures: materialItemPictures,
      },
    };
  }

  /** 严格编译创作草稿；task 必须来自 planCreative（带短名目标与 v4 上下文）。 */
  function compileDraft(text: string, task: ReturnType<typeof planCreative>, library: Library, batchId: string): DraftResult {
    return compileCreativeDraft(text, task, library, batchId, lexicon, (batch) => validatePlayable(batch, task.context, true));
  }

  /** v4 创作绑定复核：确定性重编译并逐项比较，伪造 kind/series/来源或篡改正文都会失配。 */
  function verifyCreation(document: GeneratedEpisode, session: PlayerSession, library: Library): DraftResult {
    const creation = document.creation;
    if (!creation || creation.protocol !== DRAFT_PROTOCOL) return { ok: false, issues: [{ code: 'E-DRAFT', level: 'error', message: '缺少合法的创作绑定' }] };
    const series = creativeSeries[creation.series];
    if (!series || series.kind !== creation.kind || document.batch.channel !== creation.series) {
      return { ok: false, issues: [{ code: 'E-DRAFT', level: 'error', message: '形态、系列或频道不匹配' }] };
    }
    const task = planCreative(session, library, new Date(document.generatedAt));
    if (document.batch.brief !== task.brief.brief) {
      return { ok: false, issues: [{ code: 'E-DRAFT', level: 'error', message: '学习任务版本不匹配' }] };
    }
    const compiled = compileDraft(creation.draft, task, library, document.batch.batch);
    if (!compiled.ok) return compiled;
    const mismatched = stableStringify(compiled.batch) !== stableStringify(document.batch) ||
      stableStringify(compiled.creation) !== stableStringify(creation) ||
      compiled.title !== document.title || compiled.subtitle !== document.subtitle || compiled.description !== document.description;
    if (mismatched) {
      return { ok: false, issues: [{ code: 'E-DRAFT', level: 'error', message: '创作绑定与已编译内容不一致' }] };
    }
    return compiled;
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

  /** v4 全路径校验：compiler 保证效果只是「记录所选选项」的 append-only user_fact，
   *  没有依赖先前分支的前置条件，因此各选项对应的安全状态完全等价——
   *  每个选项与跳过各验证一次，再用一个代表分支推进前缀即可，无需枚举笛卡尔积。 */
  function validatePathsCreative(session: PlayerSession, library: Library) {
    const episode = library.episodes.at(-1)!;
    let prefix = transition(session, { type: 'select', episode: episode.id }, library);
    for (const scene of getScenes(episode)) {
      const options = getOptions(scene);
      for (let choice = 0; choice < options.length; choice++) {
        transition(prefix, { type: 'answer', scene: scene.id, choice }, library);
      }
      transition(prefix, { type: 'advance', scene: scene.id, skip: true }, library);
      let working = prefix;
      if (scene.type === 'card') working = transition(working, { type: 'reveal', scene: scene.id }, library);
      const correct = options.findIndex((option) => option.correct === true);
      if (correct >= 0) working = transition(working, { type: 'answer', scene: scene.id, choice: correct }, library);
      prefix = transition(working, { type: 'advance', scene: scene.id, skip: false }, library);
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
      const isCreative = document.learningVersion === 4;
      if (isCreative) {
        const compiled = verifyCreation(document, prefix, library);
        if (!compiled.ok) throw new Error(`AI 创作绑定校验失败：${compiled.issues.map((i) => i.message).join('；')}`);
      }
      const errors = validatePlayable(document.batch, isCreative ? creativeContext(context) : context, isCreative)
        .filter((issue) => issue.level === 'error');
      if (errors.length) throw new Error(errors.map((issue) => issue.message).join('；'));
      const presentation = isCreative
        ? creativePresentation(document.creation!.kind, document.creation!.series,
            Object.fromEntries(document.creation!.sources.map((s) => [s.sceneId,
              `${s.field === 'gloss' ? '本地词库 · 词义' : s.field === 'example' ? '本地词库 · 例句'
                : s.reference.startsWith('draft.') ? '本集前文原句' : '已读故事原句'}（${lexicon.forms.get(s.item)?.[0] ?? s.item}）`])))
        : { ...creativePresentation('story', 'duck_detective'), legacy: true };
      const episode = createEpisode(document.batch, isCreative ? creativeContext(context) : context, { ...document, presentation });
      const entities = isCreative
        ? [...library.entities, ...materialEntityRows.filter((row) => !library.entities.some((e) => e.id === row.id))]
        : library.entities;
      library = { ...library, entities, episodes: [...library.episodes, episode] };
    }
    return { session: restoreSession(session, library), generated, library };
  }

  function accept(raw: unknown, save: SavedPlayer) {
    const document = GeneratedEpisodeSchema.parse(raw);
    const restored = restore(save);
    if (historyKey(restored.session).hash !== document.basedOn.hash ||
      document.basedOn.eventCount !== restored.session.events.length) throw new Error('生成内容不属于当前进度，请勿覆盖存档');
    const learningVersion = document.learningVersion ?? 1;
    if (learningVersion === 4) {
      const compiled = verifyCreation(document, restored.session, restored.library);
      if (!compiled.ok) throw new Error(`AI 创作绑定校验失败：${compiled.issues.map((i) => i.message).join('；')}`);
      const task = planCreative(restored.session, restored.library, new Date(document.generatedAt));
      const report = validateBatch(document.batch, task.context);
      if (!report.detectionScenes && [...task.detection, ...task.practice].length) {
        throw new Error('AI 内容必须包含有效学习互动');
      }
      const next = restore(snapshot(restored.session, [...restored.generated, document]));
      validatePathsCreative(restored.session, next.library);
      return { ...next, document };
    }
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

  return { pilot, lexicon, pilotContext, historyKey, snapshot, stateContext, plan, planCreative, compileDraft, verifyCreation, creativeContext, creativePresentation, learningIssues, learningNotes, validatePlayable, exerciseScenes, restore, accept, validatePathsCreative };
}

export type Content = ReturnType<typeof createContent>;
export { rebuildCloudReading } from './cloud-reading.js';
export { assertReadingObligationProgress, deriveReadingObligations, retainReadingCompletionTimes } from './reading-obligations.js';
