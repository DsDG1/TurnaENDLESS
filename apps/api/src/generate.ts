import {
  DirectorService, TropeLedger, type LlmClient, type LlmRequest, type LlmResponse,
} from '@endless/director';
import { autoFixBatch, batchTextUnits, contentHash, locateForm, parseBatch, stripThinking, type Batch, type ValidationIssue } from '@endless/esl';
import { creativeHistoryPolicy, creativeKindLabels, creativeSeries, SavedPlayerSchema, type Content, type GeneratedEpisode } from '@endless/content';
import { getOptions, getScenes } from '@endless/player';
import { ApiError } from './jobs.js';
import { templates } from './prompts.js';
import { buildCreativePrompt, creativeSystem } from './creative-prompts.js';

export class MeteredLlmClient implements LlmClient {
  private calls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  constructor(private inner: LlmClient, private phase: (value: string) => void) {}
  modelId(tier: 'fast' | 'premium') { return this.inner.modelId(tier); }
  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.calls++;
    this.phase(this.calls === 1 ? '正在生成剧情与互动' : '正在校验并修复内容');
    const response = await this.inner.complete(request);
    this.inputTokens += response.usage.inputTokens;
    this.outputTokens += response.usage.outputTokens;
    return response;
  }
  usage() { return { calls: this.calls, inputTokens: this.inputTokens, outputTokens: this.outputTokens }; }
}

/** v4 整稿修复的硬上限：首次 + 5 次修复。超过即结束，不再无限调用供应商。 */
export const MAX_DRAFT_ATTEMPTS = 6;
/** 单次生成的 token 预算（输入 + 输出合计）；超限同样结束自动修复。 */
export const MAX_DRAFT_TOKENS = 120_000;

/**
 * 失败签名：用于判断「这一轮和上一轮是不是同一个问题」。
 * 数字折叠成 #，避免「场景数为 8」「场景数为 9」这类同类错误被当成新问题而无休止修复。
 */
function failureSignature(issues: ValidationIssue[]) {
  return issues
    .map((issue) => `${issue.code}${issue.scene ? ` ${issue.scene}` : ''}：${issue.message.replace(/\d+/g, '#')}`)
    .join('\n');
}

/**
 * v4 创作草稿生成器：模型只写 ENDLESS-DRAFT/1 草稿（形态/系列/组件/正文），
 * 程序编译成可执行批次并整稿修复；不接受可执行 JSON。
 */
export function createGenerator(content: Content, llm: LlmClient) {
  return async (raw: unknown, requestId: string, phase: (value: string) => void, _apiKey?: string, archives?: import('@endless/content').ArchiveContextEntryWire[]): Promise<GeneratedEpisode> => {
    const save = SavedPlayerSchema.parse(raw);
    const { session, library } = content.restore(save);
    const archivedByEpisode = new Map<string, import('@endless/content').ArchiveContextEntryWire>();
    for (const archive of archives ?? []) for (const episodeId of archive.episodeIds) archivedByEpisode.set(episodeId, archive);
    const generatedAt = new Date().toISOString();
    const task = content.planCreative(session, library, new Date(generatedAt));
    const batchId = `ai-${requestId}`;
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
    const budget = new MeteredLlmClient(llm, phase);
    let draft = '';
    let compiled: ReturnType<Content['compileDraft']> | null = null;
    let problems = '';
    // 最多 6 次（首次 + 5 次整稿修复）；归一化签名与上一轮相同即提前停止；
    // 每轮失败后检查 token 预算。任何一条到顶都结束，不无限调用供应商。
    let attempt = 0;
    for (; attempt < MAX_DRAFT_ATTEMPTS; attempt++) {
      const response = await budget.complete({
        stage: attempt === 0 ? 'single' : 'repair',
        system: creativeSystem,
        prompt: buildCreativePrompt(attempt === 0 ? input : { ...input, previousDraft: draft, problems }),
        modelTier: 'fast',
        maxTokens: attempt === 0 ? 8192 : 4096,
      });
      draft = response.text;
      compiled = content.compileDraft(draft, task, library, batchId);
      if (compiled.ok) break;
      const nextProblems = failureSignature(compiled.issues);
      if (nextProblems === problems) break;
      problems = nextProblems;
      const used = budget.usage();
      if (used.inputTokens + used.outputTokens > MAX_DRAFT_TOKENS) {
        throw contentFailure([...compiled.issues,
          { code: 'E-DRAFT-BUDGET', level: 'error', message: '本次生成已达到 token 预算上限，停止自动修复' }]);
      }
    }
    if (!compiled?.ok) {
      const last = compiled?.issues ?? [{ code: 'E-DRAFT', level: 'error' as const, message: '草稿编译失败' }];
      throw contentFailure(attempt >= MAX_DRAFT_ATTEMPTS
        ? [...last, { code: 'E-DRAFT-ATTEMPTS', level: 'error' as const, message: `已自动修复 ${MAX_DRAFT_ATTEMPTS} 次仍未通过校验，停止继续调用` }]
        : last);
    }
    const document: GeneratedEpisode = {
      version: 1, generatedAt, basedOn: content.historyKey(session), batch: compiled.batch,
      hash: contentHash(compiled.batch), title: compiled.title, subtitle: compiled.subtitle,
      description: compiled.description, learningVersion: 4, creation: compiled.creation,
      usage: budget.usage(),
    };
    phase('正在验证所有选项并保存内容');
    try {
      content.accept(document, save);
    } catch {
      throw contentFailure([{ code: 'E-PLAYER-PATH', level: 'error', message: 'final acceptance failed' }]);
    }
    return document;
  };
}


/** 旧版整批 JSON 生成器（learningVersion 1–3 契约），保留给旧契约测试。 */
export function createLegacyGenerator(content: Content, llm: LlmClient) {
  return async (raw: unknown, requestId: string, phase: (value: string) => void): Promise<GeneratedEpisode> => {
    const save = SavedPlayerSchema.parse(raw);
    const { session, library } = content.restore(save);
    const generatedAt = new Date().toISOString();
    const task = content.plan(session, library, new Date(generatedAt));
    const { brief, context, view, exposureCounts, detection, practice } = task;
    const batchId = `ai-${requestId}`;
    const ledger = new TropeLedger();
    for (const episode of library.episodes.slice(-5)) ledger.add({
      batch: episode.id, tropes: [], logline: episode.subtitle,
      sceneSequence: getScenes(episode).map((scene) => scene.type), cast: episode.ast.channel === 'duck_detective' ? ['duck', 'cat', 'moon'] : [],
    });
    const validate = (text: string) => {
      const cleaned = (stripThinking(text) ?? text).trim().replace(/^```(?:json|yaml)?\s*\n/i, '').replace(/\n?```\s*$/, '');
      const parsed = parseBatch(cleaned);
      if (!parsed.ok) return parsed;
      const unsupported = parsed.batch.scenes.some((scene) =>
        !['comic', 'chat', 'pick'].includes(scene.type) || (scene.type === 'chat' && scene.ink));
      if (unsupported) return { ok: false, issues: [{
        code: 'E-SCHEMA', level: 'error' as const, message: '只支持 comic、无 Ink 的 chat、pick，不能通过删除其他场景绕过校验',
      }] };
      const rawHash = contentHash(parsed.batch);
      const candidate = parsed.batch;
      const units = batchTextUnits(candidate);
      const practiceItems = new Set([...detection, ...practice].filter((entry) => entry.type === 'practice').map((entry) => entry.item));
      for (const scene of candidate.scenes) {
        if (scene.evidence && practiceItems.has(scene.evidence.item) && (exposureCounts.get(scene.evidence.item) ?? 0) < 2) {
          scene.evidence.type = 'practice';
        }
        for (const item of brief.expose.map((entry) => entry.item)) {
          if (units.some((unit) => unit.sceneId === scene.id && unit.role === 'narrative' &&
            (content.lexicon.forms.get(item) ?? []).some((form) => locateForm(unit.text, form).length))) {
            scene.uses = [...new Set([...scene.uses ?? [], item])];
          }
        }
      }
      const batch = autoFixBatch(candidate, context).batch;
      const issues = [...content.validatePlayable(batch, context), ...content.learningIssues(batch, task)];
      const error = (message: string) => issues.push({ code: 'E-SCHEMA', level: 'error', message });
      if (batch.batch !== batchId || batch.brief !== brief.brief) error('batch 或 brief 与本次请求不一致');
      if (!batch.scenes.some((scene) => scene.type === 'chat' && scene.reply?.options.some((option) => option.effect))) {
        error('必须有 chat 回复承载至少一次可选剧情效果');
      }
      return { ok: !issues.some((issue) => issue.level === 'error'), batch, issues, rawHash, fixedHash: contentHash(batch) };
    };
    const budget = new MeteredLlmClient(llm, phase);
    const director = new DirectorService({
      llm: budget, templates,
      validateEs: (text) => validate(text),
      entityExists: (id) => library.entities.some((entity) => entity.id === id),
      formsOf: (item) => content.lexicon.forms.get(item) ?? [],
    }, {
      mode: 'single', encoding: 'json', derive: false, sessionWindow: 1,
      maxParseRetries: 1, maxRepairRounds: 2, maxRewrites: 2, repairMode: 'batch',
      maxTokensByStage: { single: 8192, repair: 4096 },
    });
    const outcome = await director.generate({
      batchId, channel: 'duck_detective', brief, ledger,
      vars: {
        brief_id: brief.brief,
        app_rules: '这是应用模式，生成过程中不得跳过或删除不合法的场景；只能修复后交付完整批次。',
        example: JSON.stringify({ batch: batchId, channel: 'duck_detective', brief: brief.brief, cast: ['duck', 'cat'],
          hook_out: 'Who is at the door?', scenes: [
            { id: 's1', type: 'pick', question: '<根据词义选择正确的英文>', uses: [], evidence: detection[0],
              options: [{ label: '<目标英文形式>', correct: true }, { label: '<干扰项>' }, { label: '<干扰项2>' }, { label: '<干扰项3>' }],
              feedback: { on_correct: '<英文反馈>', on_wrong: '<英文解释>' } },
            { id: 's2', type: 'comic', setting: '@tag:agency_office', uses: brief.expose.map((entry) => entry.item),
              panels: [{ shot: 'wide', actors: ['@char:duck'], props: [], bubbles: [{ speaker: 'duck', text: '<自然使用本集新词的英文台词>' }] }] },
            { id: 's3', type: 'chat', skin: 'messenger', uses: brief.introduce,
              ...(practice[0] ? { evidence: practice[0] } : {}),
              messages: [{ from: 'cat', text: '<再次使用新词的英文台词，提供情境和词义线索>' }],
              reply: { options: [{ label: '<含新词的正确回复>', correct: true, effect: 'clue_noted' }, { label: '<不合适的回复>' }],
                on_correct: { from: 'duck', text: '<英文反馈>' }, on_wrong: { from: 'duck', text: '<英文解释>' } },
              effects: { clue_noted: [{ user_fact: { predicate: 'noticed', object: '<本集独有线索>' } }] } },
          ] }),
        brief: JSON.stringify(brief),
        lexicon: [...new Set([...brief.expose.map((entry) => entry.item), ...detection.map((entry) => entry.item), ...practice.map((entry) => entry.item)])]
          .map((item) => `${item}: ${(content.lexicon.forms.get(item) ?? []).join('/')} (${content.lexicon.entries.get(item)?.gloss_zh})`).join('\n'),
        allowed_words: [...context.vocab.allowedForms].join(','),
        detection: JSON.stringify(detection.map((target) => ({ ...target, forms: content.lexicon.forms.get(target.item) }))),
        practice: JSON.stringify(practice.map((target) => ({ ...target, forms: content.lexicon.forms.get(target.item) }))),
        cast_facts: JSON.stringify({ facts: view.world.currentFacts(), userChoices: view.world.userFacts() }),
        open_threads: JSON.stringify(view.world.openThreads()),
        recent_summary: JSON.stringify(library.episodes.slice(-3).map((episode) => ({
          title: episode.title, scenes: getScenes(episode).map((scene) => ({
            type: scene.type, text: scene.type === 'comic' ? scene.panels.flatMap((panel) => panel.bubbles.map((bubble) => bubble.text)).join(' ').slice(0, 450)
              : scene.type === 'chat' ? scene.messages.map((message) => message.text).join(' ').slice(0, 450)
              : scene.type === 'pick' ? scene.question : scene.type === 'quiz' ? scene.prompt : scene.front,
          })), actualResponses: view.episodes[episode.id]?.scenes,
        }))),
        feedback: JSON.stringify({ answers: view.answers.slice(-8), completed: view.completed, skipped: view.skipped }),
        trope_ledger: ledger.forbiddenText(),
      },
    });
    if (!outcome.batch || outcome.batchFailed || outcome.droppedScenes.length) {
      throw contentFailure(outcome.issues);
    }
    const spliced: Batch = { ...outcome.batch, scenes: content.exerciseScenes(outcome.batch, task, library, library.episodes.length) };
    const exerciseIssues = [...content.validatePlayable(spliced, context), ...content.learningIssues(spliced, task)];
    if (exerciseIssues.some((issue) => issue.level === 'error')) throw contentFailure(exerciseIssues);
    const document: GeneratedEpisode = {
      version: 1, generatedAt, basedOn: content.historyKey(session), batch: spliced,
      hash: contentHash(spliced), title: `鸭侦探的新线索 · ${library.episodes.length + 1}`,
      usage: budget.usage(),
      learningVersion: 3,
      subtitle: outcome.batch.hook_out?.slice(0, 160) || 'A new case',
      description: '根据你实际的学习记录和剧情选择生成的新一集。',
    };
    phase('正在验证所有选项并保存内容');
    try {
      content.accept(document, save);
    } catch {
      throw contentFailure([{ code: 'E-PLAYER-PATH', level: 'error', message: 'final acceptance failed' }]);
    }
    return document;
  };
}

function contentFailure(issues: ValidationIssue[]) {
  const codes = [...new Set(issues.filter((issue) => issue.level === 'error').map((issue) => issue.code))]
    .filter((code) => /^E-[A-Z-]{1,50}$/.test(code));
  const labels: Record<string, string> = {
    'E-OOV-HIGH': '词表外用词过多', 'E-EFFECT-INVALID': '剧情效果引用不匹配',
    'E-USES-NOT-FOUND': '声明的学习词没有实际出现', 'E-NEW-TESTED-EARLY': '新词被过早当成独立测试',
    'E-LEARNING-TASK': '未完成指定的新词教学或复习', 'E-BRIEF-UNCOVERED': '学习任务未覆盖',
    'E-PRIMED': '复习题提前透露了答案', 'E-PARSE': '模型输出格式无法解析',
    'E-SCHEMA': '内容结构不符合播放器要求', 'E-PLAYER-PATH': '部分选项无法安全播放',
    'E-DRAFT': '创作草稿不符合协议或学习契约',
    'E-DRAFT-ATTEMPTS': '自动修复次数已达到上限', 'E-DRAFT-BUDGET': '自动修复的 token 预算已达到上限',
  };
  const reasons = codes.slice(0, 4).map((code) => labels[code] ?? code).join('；');
  return new ApiError(422, `AI 内容未通过校验：${reasons || '内容不完整'}${codes.length ? `（${codes.join(', ')}）` : ''}。本次未加入内容库，可手动重试；可能产生费用。`,
    { category: 'content', codes });
}
