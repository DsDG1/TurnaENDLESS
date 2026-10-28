import {
  DirectorService, TropeLedger, type LlmClient,
} from '@endless/director';
import { autoFixBatch, batchTextUnits, contentHash, locateForm, parseBatch, stripThinking, type Batch, type ValidationIssue } from '@endless/esl';
import { SavedPlayerSchema, type Content, type GeneratedEpisode } from '@endless/content';
import {
  GenerationFailureError, MAX_DRAFT_ATTEMPTS, MAX_DRAFT_TOKENS, MeteredLlmClient,
  describeContentFailure, runCreativeGeneration,
} from '@endless/generation';
import { getScenes } from '@endless/player';
import { ApiError } from './jobs.js';
import { templates } from './prompts.js';

export { MAX_DRAFT_ATTEMPTS, MAX_DRAFT_TOKENS, MeteredLlmClient };

/**
 * v4 创作草稿生成器（本机适配器）。
 *
 * 真正的执行在 `@endless/generation` 的无副作用端口里；这里只负责本机语义：
 * 在提交时刻冻结计划时间、用 `ai-<requestId>` 作批次 ID，并把端口的失败分类映射成本机 HTTP 错误。
 * 云端 Worker 必须直接用端口，不能 import 本文件（会带进本机 jobs 与错误语义）。
 */
export function createGenerator(content: Content, llm: LlmClient) {
  return async (raw: unknown, requestId: string, phase: (value: string) => void, _apiKey?: string, archives?: import('@endless/content').ArchiveContextEntryWire[]): Promise<GeneratedEpisode> => {
    try {
      const outcome = await runCreativeGeneration(
        { content, llm },
        { save: raw, archives, plannedAt: new Date().toISOString(), batchId: `ai-${requestId}` },
        { phase },
      );
      return outcome.episode;
    } catch (error) {
      if (error instanceof GenerationFailureError) throw new ApiError(422, error.message, error.failure);
      throw error;
    }
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

/** 本机 HTTP 映射：文案与失败分类共用 `@endless/generation` 的唯一实现。 */
function contentFailure(issues: ValidationIssue[]) {
  const { message, failure } = describeContentFailure(issues);
  return new ApiError(422, message, failure);
}
