import {
  creativeHistoryPolicy, creativeKindLabels, creativeSeries, localVerifiedPrefix, planAtFrozenTime,
  SavedPlayerSchema, type ArchiveContextEntryWire, type Content, type GeneratedEpisode,
} from '@endless/content';
import { contentHash, type ValidationIssue } from '@endless/esl';
import { getOptions, getScenes } from '@endless/player';
import { buildCreativePrompt, creativeSystem } from './prompts.js';
import { describeContentFailure, GenerationFailureError } from './failure.js';
import { MeteredLlmClient, type GenerationLlm, type GenerationUsage } from './llm.js';

/** v4 整稿修复的硬上限：首次 + 5 次修复。超过即结束，不再无限调用供应商。 */
export const MAX_DRAFT_ATTEMPTS = 6;
/** 单次生成的 token 预算（输入 + 输出合计）；超限同样结束自动修复。 */
export const MAX_DRAFT_TOKENS = 120_000;

export interface GenerationLimits {
  maxAttempts: number;
  maxTokens: number;
}

/** 一次生成执行所需的全部输入；不读取时钟、文件、环境变量或请求上下文。 */
export interface CreativeGenerationRequest {
  /** 本机存档 JSON（端口内部仍用 SavedPlayerSchema 解析）。 */
  save: unknown;
  archives?: ArchiveContextEntryWire[];
  /** 冻结的计划时间（ISO）。写入文档 generatedAt，绝不改用执行时刻。 */
  plannedAt: string;
  /** 稳定批次 ID（本机 `ai-<requestId>`；云端由交付键派生）。 */
  batchId: string;
  limits?: Partial<GenerationLimits>;
}

export interface GenerationAttemptRecord {
  ordinal: number;
  stage: 'single' | 'repair';
  ok: boolean;
  inputTokens: number;
  outputTokens: number;
  /** 该轮失败的错误码（已去重）；成功为空数组。不含正文或供应商响应。 */
  issueCodes: string[];
}

export interface CreativeGenerationOutcome {
  episode: GeneratedEpisode;
  usage: GenerationUsage;
  attempts: GenerationAttemptRecord[];
}

export interface CreativeGenerationHooks {
  /** 阶段文案；调用方决定写到本机任务记录还是云端 job 行。 */
  phase(value: string): void;
  /** 每次外部调用结束后回调一次，供调用方在任何持久化之前记录 attempt。 */
  onAttempt?(record: GenerationAttemptRecord): void;
}

export interface CreativeGenerationDeps {
  content: Content;
  llm: GenerationLlm;
}

/**
 * 失败签名：用于判断「这一轮和上一轮是不是同一个问题」。
 * 数字折叠成 #，避免「场景数为 8」「场景数为 9」这类同类错误被当成新问题而无休止修复。
 */
function failureSignature(issues: ValidationIssue[]) {
  return issues
    .map((issue) => `${issue.code}${issue.scene ? ` ${issue.scene}` : ''}：${issue.message.replace(/\d+/g, '#')}`)
    .join('\n');
}

function issueCodes(issues: ValidationIssue[]): string[] {
  return [...new Set(issues.filter((issue) => issue.level === 'error').map((issue) => issue.code))];
}

/**
 * v4 创作草稿执行端口：模型只写 ENDLESS-DRAFT/1 草稿（形态/系列/组件/正文），
 * 程序编译成可执行批次并整稿修复；不接受可执行 JSON。
 *
 * 无副作用边界：不读写文件/数据库/网络凭据、不记录任务记录、不吞异常、不自动重试传输失败。
 * 计划时间与批次 ID 由调用方冻结传入，排队或重试不会改变已定的计划。
 */
export async function runCreativeGeneration(
  deps: CreativeGenerationDeps,
  request: CreativeGenerationRequest,
  hooks: CreativeGenerationHooks,
): Promise<CreativeGenerationOutcome> {
  const { content, llm } = deps;
  const save = SavedPlayerSchema.parse(request.save);
  const { session, library } = content.restore(save);
  const archivedByEpisode = new Map<string, ArchiveContextEntryWire>();
  for (const archive of request.archives ?? []) for (const episodeId of archive.episodeIds) archivedByEpisode.set(episodeId, archive);
  // 调用方冻结的计划时间：本机在提交时刻、云端在报价/排队时刻。执行时不再取 now()。
  const generatedAt = request.plannedAt;
  const task = planAtFrozenTime(content, localVerifiedPrefix(session, library, generatedAt));
  const batchId = request.batchId;
  const limits: GenerationLimits = {
    maxAttempts: request.limits?.maxAttempts ?? MAX_DRAFT_ATTEMPTS,
    maxTokens: request.limits?.maxTokens ?? MAX_DRAFT_TOKENS,
  };
  const view = task.view;
  const { episodesPerSeries, maxCharsPerScene, maxCharsPerEpisode } = creativeHistoryPolicy;
  const userFacts = view.world.userFacts();
  const canon = view.world.currentFacts();
  const threads = view.world.openThreads();
  const bySeries = new Map<string, typeof library.episodes>();
  for (const episode of library.episodes) {
    const series = episode.presentation?.series ?? 'duck_detective';
    bySeries.set(series, [...(bySeries.get(series) ?? []), episode]);
  }
  const seriesHistory = Object.fromEntries([...bySeries].map(([series, episodes]) => {
    const cast = new Set<string>(series in creativeSeries ? creativeSeries[series as keyof typeof creativeSeries].cast : ['duck', 'cat', 'moon']);
    const history = episodes.slice(-episodesPerSeries).map((episode) => {
      const progress = view.episodes[episode.id];
      const volume = archivedByEpisode.get(episode.id);
      if (volume) {
        // 已归档的集在提示词中走程序化摘要；校验仍使用 save 中的完整原件
        return { title: episode.title, archived: true as const, summary: volume.narrative, facts: volume.facts.slice(0, 20), choices: volume.choices.slice(0, 20) };
      }
      let remaining = maxCharsPerEpisode;
      const scenes = getScenes(episode).map((scene) => {
        const state = progress?.scenes[scene.id];
        const status = state?.completed ? 'read' : state?.skipped ? 'skipped' : 'unread';
        const raw = scene.type === 'comic'
          ? scene.panels.flatMap((panel) => [
              ...(panel.caption ? [panel.caption] : []),
              ...panel.bubbles.map((bubble) => `${bubble.speaker}: ${bubble.text}`),
            ]).join(' ')
          : scene.type === 'chat'
            ? scene.messages.map((message) => `${message.from}: ${message.text}`).join(' ')
            : scene.type === 'pick' ? scene.question
              : scene.type === 'quiz' ? scene.prompt : scene.front;
        const text = status === 'unread' ? '' : raw.slice(0, Math.max(0, Math.min(maxCharsPerScene, remaining)));
        remaining -= text.length;
        const options = getOptions(scene);
        const answer = state?.answer
          ? { chosen: options[state.answer.choice]?.label ?? null, correct: state.answer.correct }
          : null;
        return { id: scene.id, type: scene.type, status, text, ...(answer ? { answer } : {}) };
      });
      const recorded = userFacts.filter((fact) => fact.batch === episode.id)
        .map((fact) => `${fact.predicate} ${fact.object}`);
      return { title: episode.title, scenes, ...(recorded.length ? { recordedChoices: recorded } : {}) };
    });
    return [series, {
      canon: canon.filter((fact) => cast.has(fact.subject))
        .map((fact) => `${fact.subject} ${fact.predicate} ${fact.object}`),
      openThreads: threads.filter((thread) => thread.owner_channel === series)
        .map((thread) => ({ id: thread.id, title: thread.title, status: thread.status })),
      episodes: history,
    }];
  }));
  const input = {
    catalog: JSON.stringify({
      kinds: task.catalog.kinds, kindLabels: creativeKindLabels,
      series: task.catalog.series.map((s) => ({ id: s.id, kind: s.kind, label: s.label, premise: s.premise, cast: s.cast, backgrounds: s.backgrounds })),
      components: task.catalog.components,
      characters: task.catalog.characters,
      backgrounds: task.catalog.backgrounds,
      props: task.catalog.props,
      itemPictures: task.catalog.itemPictures,
      coldRecommendations: task.ranked,
    }),
    learning: JSON.stringify(task.targets),
    allowedWords: [...task.context.vocab.allowedForms].join(','),
    history: JSON.stringify(seriesHistory),
    recent: JSON.stringify(task.history.slice(-6)),
    feedback: JSON.stringify({ answers: view.answers.slice(-8), completed: view.completed, skipped: view.skipped }),
  };
  const budget = new MeteredLlmClient(llm, hooks.phase);
  const attempts: GenerationAttemptRecord[] = [];
  let draft = '';
  let compiled: ReturnType<Content['compileDraft']> | null = null;
  let problems = '';
  // 最多 maxAttempts 次（首次 + N-1 次整稿修复）；归一化签名与上一轮相同即提前停止；
  // 每轮失败后检查 token 预算。任何一条到顶都结束，不无限调用供应商。
  let attempt = 0;
  for (; attempt < limits.maxAttempts; attempt++) {
    const stage = attempt === 0 ? 'single' : 'repair';
    const before = budget.usage();
    const response = await budget.complete({
      stage,
      system: creativeSystem,
      prompt: buildCreativePrompt(attempt === 0 ? input : { ...input, previousDraft: draft, problems }),
      modelTier: 'fast',
      maxTokens: attempt === 0 ? 8192 : 4096,
    });
    draft = response.text;
    compiled = content.compileDraft(draft, task, library, batchId);
    const used = budget.usage();
    const record: GenerationAttemptRecord = {
      ordinal: attempt + 1, stage, ok: compiled.ok,
      inputTokens: used.inputTokens - before.inputTokens,
      outputTokens: used.outputTokens - before.outputTokens,
      issueCodes: compiled.ok ? [] : issueCodes(compiled.issues),
    };
    attempts.push(record);
    hooks.onAttempt?.(record);
    if (compiled.ok) break;
    const nextProblems = failureSignature(compiled.issues);
    if (nextProblems === problems) break;
    problems = nextProblems;
    if (used.inputTokens + used.outputTokens > limits.maxTokens) {
      throw generationFailure([...compiled.issues,
        { code: 'E-DRAFT-BUDGET', level: 'error', message: '本次生成已达到 token 预算上限，停止自动修复' }]);
    }
  }
  if (!compiled?.ok) {
    const last = compiled?.issues ?? [{ code: 'E-DRAFT', level: 'error' as const, message: '草稿编译失败' }];
    throw generationFailure(attempt >= limits.maxAttempts
      ? [...last, { code: 'E-DRAFT-ATTEMPTS', level: 'error' as const, message: `已自动修复 ${limits.maxAttempts} 次仍未通过校验，停止继续调用` }]
      : last);
  }
  const document: GeneratedEpisode = {
    version: 1, generatedAt, basedOn: content.historyKey(session), batch: compiled.batch,
    hash: contentHash(compiled.batch), title: compiled.title, subtitle: compiled.subtitle,
    description: compiled.description, learningVersion: 4, creation: compiled.creation,
    usage: budget.usage(),
  };
  hooks.phase('正在验证所有选项并保存内容');
  try {
    content.accept(document, save);
  } catch {
    throw generationFailure([{ code: 'E-PLAYER-PATH', level: 'error', message: 'final acceptance failed' }]);
  }
  return { episode: document, usage: budget.usage(), attempts };
}

function generationFailure(issues: ValidationIssue[]): GenerationFailureError {
  const { message, failure } = describeContentFailure(issues);
  return new GenerationFailureError(message, failure);
}
