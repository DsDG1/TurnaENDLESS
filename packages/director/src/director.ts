/**
 * 导演编排（第 4.1 节单批循环的 3–7 步）：
 * 两段式（编剧室 → 预检 → 分场编剧）或单段；编译校验出阻断问题时进入修复循环，
 * 最多 2 轮；仍失败则丢弃问题场景（若 brief 仍被覆盖）或整批失败（第 5.9.4 节）。
 * 校验器由调用方注入（lab 组装词库/素材/世界上下文），导演保持与存储无关。
 */
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';
import { Scene, type Batch, type ValidationIssue } from '@endless/esl';
import type { LearningBrief } from '@endless/learning';
import type { LlmClient, LlmResponse } from './llm.js';
import type { PromptTemplates } from './prompts.js';
import { renderTemplate } from './prompts.js';
import { ShowrunnerPlan, precheckPlan, type ShowrunnerPlan as Plan } from './showrunner.js';
import type { TropeLedger } from './ledger.js';

export interface DirectorConfig {
  mode: 'two-stage' | 'single';
  encoding: 'yaml' | 'json';
  showrunnerTier: 'fast' | 'premium';
  maxPrecheckRetries: number;
  maxRepairRounds: number;
  /** 每阶段输出 token 上限。推理模型的思考 token 也计入，写死 4096 会把长输出挤成空串。 */
  maxTokensByStage?: Partial<Record<'showrunner' | 'writer' | 'single' | 'repair', number>>;
}

export const DEFAULT_DIRECTOR_CONFIG: DirectorConfig = {
  mode: 'two-stage',
  encoding: 'yaml',
  showrunnerTier: 'fast',
  maxPrecheckRetries: 2,
  maxRepairRounds: 2,
  maxTokensByStage: { showrunner: 2048, writer: 8192, single: 8192, repair: 4096 },
};

export interface CallRecord {
  stage: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheHit: boolean;
  requestHash: string;
  /** 供应商结束原因；缓存命中或未提供时不填 */
  finishReason?: string;
  /** 推理模型花在思考上的 token */
  reasoningTokens?: number;
  /** 正文为空（少见但会发生：输出上限被思考 token 吃光） */
  empty?: boolean;
}

export interface DirectorDeps {
  llm: LlmClient;
  templates: PromptTemplates;
  /** 校验 + 解析 ESL 文本（注入，lab 侧组装 ValidationContext） */
  validateEs: (text: string, encoding: 'yaml' | 'json') => { ok: boolean; batch?: Batch; issues: ValidationIssue[] };
  entityExists: (id: string) => boolean;
  formsOf: (item: string) => string[];
  /** 每次 LLM 调用后的回调（进度输出用；不得把 prompt 或 key 写进日志） */
  onCall?: (rec: CallRecord) => void;
}

export interface GenerateInput {
  batchId: string;
  channel: string;
  brief: LearningBrief;
  ledger: TropeLedger;
  /** 提示词的上下文占位符（频道圣经、当前事实等，已由 ContextAssembler 截断） */
  vars: Record<string, string>;
}

export interface DirectorOutcome {
  batch: Batch | null;
  plan?: Plan;
  issues: ValidationIssue[];
  repairRounds: number;
  precheckRetries: number;
  precheckFailures: string[];
  droppedScenes: string[];
  batchFailed: boolean;
  calls: CallRecord[];
}

const briefCoverageOk = (batch: Batch, brief: LearningBrief): boolean => {
  const rank = (t: string) =>
    t === 'recognition-2' ? 1 : t === 'recognition-4' || t === 'listening-4' ? 2 : t === 'production' ? 3 : 0;
  for (const r of brief.review) {
    const ok = batch.scenes.some(
      (s) =>
        s.evidence?.item === r.item &&
        s.evidence.type !== 'practice' &&
        rank(s.evidence.type) >= rank(r.min_evidence),
    );
    if (!ok) return false;
  }
  for (const e of brief.expose) {
    if (!batch.scenes.some((s) => (s.uses ?? []).includes(e.item))) return false;
  }
  return true;
};

/** 把学习任务变成逐条可执行的清单：编剧室方案里的 learning_placement 常被分场编剧忽略。 */
function learningChecklist(plan: Plan | undefined, brief: LearningBrief): string {
  const lines: string[] = [];
  if (plan && plan.learning_placement.length > 0) {
    for (const p of plan.learning_placement) {
      const beat = plan.beats.find((b) => b.n === p.beat);
      const where = `第 ${p.beat} 场${beat ? `（${beat.scene}）` : ''}`;
      lines.push(
        p.as === 'exposure'
          ? `- ${p.item}：${where} 只曝光 → 把 ${p.item} 写进该场景的 uses，不要写 evidence`
          : `- ${p.item}：${where} 检测 → 写 evidence: {item: ${p.item}, type: ${p.as}}`,
      );
    }
    return lines.join('\n');
  }
  for (const e of brief.expose) lines.push(`- ${e.item}：曝光 → 写进某个场景的 uses，不要写 evidence`);
  for (const r of brief.review) lines.push(`- ${r.item}：检测 → 写 evidence: {item: ${r.item}, type: ${r.min_evidence}}`);
  return lines.length > 0 ? lines.join('\n') : '（本批没有学习任务）';
}

export class DirectorService {
  constructor(
    private deps: DirectorDeps,
    private config: DirectorConfig = DEFAULT_DIRECTOR_CONFIG,
  ) {}

  private callLog: CallRecord[] = [];
  private record(stage: string, res: LlmResponse): void {
    const rec: CallRecord = {
      stage,
      latencyMs: res.latencyMs,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      cacheHit: res.cacheHit,
      requestHash: res.requestHash,
      finishReason: res.finishReason,
      reasoningTokens: res.reasoningTokens,
      empty: res.text.trim() === '',
    };
    this.callLog.push(rec);
    this.deps.onCall?.(rec);
  }

  private vars(extra: Record<string, string>): Record<string, string> {
    return extra;
  }

  private async complete(stage: string, template: string, vars: Record<string, string>, tier: 'fast' | 'premium' = 'fast'): Promise<string> {
    const stageKey = stage as 'showrunner' | 'writer' | 'single' | 'repair';
    const maxTokens = this.config.maxTokensByStage?.[stageKey];
    const res = await this.deps.llm.complete({
      stage,
      system: this.deps.templates.system,
      prompt: renderTemplate(template, this.vars(vars)),
      modelTier: tier,
      temperature: stage === 'showrunner' ? 1.0 : 0.8,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    });
    this.record(stage, res);
    return res.text;
  }

  async generate(input: GenerateInput): Promise<DirectorOutcome> {
    this.callLog = [];
    const { brief, ledger, batchId, channel } = input;
    const enc = this.config.encoding;
    let plan: Plan | undefined;
    let precheckRetries = 0;
    let precheckFailures: string[] = [];

    // ---------- 第一步：编剧室（仅两段式） ----------
    if (this.config.mode === 'two-stage') {
      let lastText = '';
      for (let attempt = 0; attempt <= this.config.maxPrecheckRetries; attempt++) {
        // 带上重试序号：同一句失败原因重复出现时，请求哈希不能相同，否则会命中上一次的坏方案缓存
        const retryNote = attempt === 0 ? '' : `\n第 ${attempt} 次重试：上一次方案未通过预检，原因：\n${precheckFailures.map((f) => `- ${f}`).join('\n')}\n请换一个方案。`;
        lastText = await this.complete(
          'showrunner',
          this.deps.templates.showrunner,
          { ...input.vars, batch_id: batchId, channel, brief: briefYaml(brief), retry_note: retryNote },
          this.config.showrunnerTier,
        );
        const parsed = ShowrunnerPlan.safeParse(parseLooseYaml(lastText));
        if (parsed.success) {
          plan = parsed.data;
          const check = precheckPlan({
            plan,
            brief,
            ledger,
            entityExists: this.deps.entityExists,
            formsOf: this.deps.formsOf,
          });
          precheckFailures = check.failures;
          if (check.ok) break;
        } else {
          precheckFailures = [`编剧室输出不符合规范：${parsed.error.issues.map((i) => i.message).slice(0, 3).join('; ')}`];
        }
        precheckRetries = attempt + 1;
      }
    }

    // ---------- 第二步：分场编剧 / 单段 ----------
    const genTemplate = this.config.mode === 'two-stage' ? this.deps.templates.writer : this.deps.templates.single;
    let text = await this.complete(
      this.config.mode === 'two-stage' ? 'writer' : 'single',
      genTemplate,
      {
        ...input.vars,
        batch_id: batchId,
        channel,
        brief: briefYaml(brief),
        plan: plan ? planYaml(plan) : '',
        learning_checklist: learningChecklist(plan, brief),
      },
    );

    let validated = this.deps.validateEs(text, enc);
    let repairRounds = 0;

    // ---------- 修复循环（第 5.9.4 节） ----------
    while (!validated.ok && repairRounds < this.config.maxRepairRounds) {
      repairRounds++;
      const blocking = validated.issues.filter((i) => i.level === 'error');
      const badSceneIds = [...new Set(blocking.map((i) => i.scene).filter((s): s is string => s !== undefined))];
      const current = validated.batch;
      if (!current || badSceneIds.length === 0) break; // 批次级问题（如 brief 覆盖缺口）局部修复救不了
      const badScenes = current.scenes.filter((s) => badSceneIds.includes(s.id));
      const problems = blocking
        .map((i) => `- ${i.scene ?? '(batch)'} ${i.code}: ${i.message}`)
        .join('\n');
      const repairedText = await this.complete(
        'repair',
        this.deps.templates.repair,
        {
          ...input.vars,
          batch_id: batchId,
          problems,
          scenes: scenesYaml(badScenes),
          avoid_before_test: brief.avoid_before_test.join(', '),
        },
      );
      const patched = applyScenePatches(current, repairedText);
      if (patched === null) continue; // 修复输出无法解析，进入下一轮
      text = serializeBatch(patched, enc);
      validated = this.deps.validateEs(text, enc);
    }

    // ---------- 场景丢弃（V4）或整批失败 ----------
    if (validated.ok && validated.batch) {
      return {
        batch: validated.batch,
        plan,
        issues: validated.issues,
        repairRounds,
        precheckRetries,
        precheckFailures,
        droppedScenes: [],
        batchFailed: false,
        calls: this.callLog,
      };
    }
    const last = validated.batch;
    if (last) {
      const blocking = validated.issues.filter((i) => i.level === 'error');
      const badSceneIds = new Set(blocking.map((i) => i.scene).filter((s): s is string => s !== undefined));
      const batchOnlyProblems = blocking.filter((i) => i.scene === undefined);
      const kept = last.scenes.filter((s) => !badSceneIds.has(s.id));
      const trimmed: Batch = { ...last, scenes: kept };
      const baseScenes = kept.filter((s) => s.type !== 'derive').length;
      if (batchOnlyProblems.length === 0 && baseScenes >= 3 && briefCoverageOk(trimmed, brief)) {
        return {
          batch: trimmed,
          plan,
          issues: validated.issues.filter((i) => !badSceneIds.has(i.scene ?? '')),
          repairRounds,
          precheckRetries,
          precheckFailures,
          droppedScenes: [...badSceneIds],
          batchFailed: false,
          calls: this.callLog,
        };
      }
    }
    return {
      batch: null,
      plan,
      issues: validated.issues,
      repairRounds,
      precheckRetries,
      precheckFailures,
      droppedScenes: [],
      batchFailed: true,
      calls: this.callLog,
    };
  }
}

// ---------- 序列化辅助 ----------

function parseLooseYaml(text: string): unknown {
  // 剥掉 markdown 代码围栏再解析；解析失败返回 null（由各 safeParse 分支兜住）
  const stripped = text.replace(/^```[a-z]*\r?\n?/i, '').replace(/\r?\n?```\s*$/i, '');
  try {
    return parseYaml(stripped);
  } catch {
    return null;
  }
}

function briefYaml(brief: LearningBrief): string {
  return yamlStringify(brief);
}

function planYaml(plan: Plan): string {
  return yamlStringify(plan);
}

function scenesYaml(scenes: Batch['scenes']): string {
  return yamlStringify(scenes);
}

function serializeBatch(batch: Batch, enc: 'yaml' | 'json'): string {
  return enc === 'json' ? JSON.stringify(batch, null, 2) : yamlStringify(batch);
}

/** 修复输出（一个或一组场景）替换进原批次；无法解析返回 null。 */
function applyScenePatches(batch: Batch, repairText: string): Batch | null {
  const raw = parseLooseYaml(repairText);
  let scenes: unknown[] = [];
  if (Array.isArray(raw)) scenes = raw;
  else if (raw && typeof raw === 'object' && 'scenes' in raw && Array.isArray((raw as { scenes: unknown }).scenes)) {
    scenes = (raw as { scenes: unknown[] }).scenes;
  } else if (raw && typeof raw === 'object') scenes = [raw];  const patched: Batch['scenes'] = [];
  let anyValid = false;
  for (const s of scenes) {
    const parsed = Scene.safeParse(s);
    if (parsed.success) {
      patched.push(parsed.data);
      anyValid = true;
    }
  }
  if (!anyValid) return null;
  const next: Batch = structuredClone(batch);
  for (const p of patched) {
    const idx = next.scenes.findIndex((s) => s.id === p.id);
    if (idx >= 0) next.scenes[idx] = p;
    else next.scenes.push(p);
  }
  return next;
}
