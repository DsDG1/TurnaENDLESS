import {
  DirectorService, TropeLedger, estimateTokens, type LlmClient, type LlmRequest, type LlmResponse,
} from '@endless/director';
import { autoFixBatch, batchTextUnits, contentHash, locateForm, parseBatch, stripThinking, type Batch, type ValidationIssue } from '@endless/esl';
import { SavedPlayerSchema, type Content, type GeneratedEpisode } from '@endless/content';
import { getScenes } from '@endless/player';
import { ApiError } from './jobs.js';
import { templates } from './prompts.js';

export class BudgetLlmClient implements LlmClient {
  private calls = 0;
  private tokens = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  constructor(private inner: LlmClient, private phase: (value: string) => void) {}
  modelId(tier: 'fast' | 'premium') { return this.inner.modelId(tier); }
  async complete(request: LlmRequest): Promise<LlmResponse> {
    const estimatedInput = estimateTokens(`${request.system}\n${JSON.stringify(request.messages ?? request.prompt)}`);
    if (this.calls >= 3 || this.tokens + estimatedInput + (request.maxTokens ?? 8192) > 40_000) {
      throw new ApiError(429, '本次生成达到调用或 token 预算，已停止；不会无限重试', { category: 'budget', codes: [] });
    }
    this.calls++;
    this.phase(this.calls === 1 ? '正在生成剧情与互动' : '正在校验并修复内容');
    const response = await this.inner.complete(request);
    this.tokens += response.usage.inputTokens + response.usage.outputTokens;
    this.inputTokens += response.usage.inputTokens;
    this.outputTokens += response.usage.outputTokens;
    return response;
  }
  usage() { return { calls: this.calls, inputTokens: this.inputTokens, outputTokens: this.outputTokens }; }
}

export function createGenerator(content: Content, llm: LlmClient) {
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
    const budget = new BudgetLlmClient(llm, phase);
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
    // 双层生成下半层：叙事批次校验通过后，按学习任务拼入程序练习卡（单词卡/填空/选句等），
    // 再对完整批次整体复验——练习卡由程序构造，材料来自词库与已播放文本，零额外模型调用。
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
  };
  const reasons = codes.slice(0, 4).map((code) => labels[code] ?? code).join('；');
  return new ApiError(422, `AI 内容未通过校验：${reasons || '内容不完整'}${codes.length ? `（${codes.join(', ')}）` : ''}。本次未加入内容库，可手动重试；可能产生费用。`,
    { category: 'content', codes });
}
