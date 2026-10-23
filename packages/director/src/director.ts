/**
 * 导演编排（第 4.1 节单批循环的 3–7 步）：
 * 两段式（编剧室 → 预检 → 分场编剧）或单段；编译校验出阻断问题时进入修复循环，
 * 最多 2 轮；仍失败则丢弃问题场景（若 brief 仍被覆盖）或整批失败（第 5.9.4 节）。
 * 校验器由调用方注入（lab 组装词库/素材/世界上下文），导演保持与存储无关。
 */
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';
import { Scene, contentHash, stripThinking, type Batch, type ValidationIssue } from '@endless/esl';
import type { LearningBrief } from '@endless/learning';
import type { LlmClient, LlmMessage, LlmResponse } from './llm.js';
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
  /** 输出解析失败时「带着错误重写」的次数（默认 1）。修复循环处理不了解析级失败。 */
  maxParseRetries?: number;
  /** 批次级问题（定位不到场景）时整批重写的次数（默认 1）。 */
  maxRewrites?: number;
  repairMode?: 'scenes' | 'batch';
  /** 是否保留 derive（派生）场景；关闭时校验前剔掉（R5 消融对照）。 */
  derive?: boolean;
  /**
   * 会话窗口大小（批次数，默认 6）。
   * > 1 时启用「同会话多轮追加 + 偏离重置」：
   * - 窗口第 1 批（或偏离重置后）发送完整提示词模板（含规范示例、静态角色/素材表）；
   * - 窗口内后续批次在同一 messages[] 对话历史末尾追加本批增量上下文，复用前序 KV 缓存与文风；
   * - 一旦检测到偏离（预检失败、解析失败、校验出阻断级错误）或达到窗口上限，
   *   立即清空会话历史并重新输出完整提示词模板。
   * 设为 1（或 <= 1）时退化为每批孤立的单轮请求。
   */
  sessionWindow?: number;
}

export const DEFAULT_DIRECTOR_CONFIG: DirectorConfig = {
  mode: 'two-stage',
  encoding: 'yaml',
  showrunnerTier: 'fast',
  maxPrecheckRetries: 2,
  maxRepairRounds: 2,
  maxParseRetries: 1,
  maxRewrites: 1,
  sessionWindow: 6,
  // 编剧室输出是计划（logline/节拍/卡司），正文不长，但思考 token 也计入：
  // 2048 时实测出现过 think=2047 finish=length 的空响应（20g 第 9 批，靠重试救回）；
  // 4096 在 v11/v12 更长的提示词下又顶到边缘（20n 的 b-0009/b-0013 各一次 finish=length，
  // 全是思考、正文空，合计空转约 8k token）。上限只在用满时计费，所以留出余量：
  maxTokensByStage: { showrunner: 6144, writer: 8192, single: 8192, repair: 4096 },
};

export interface CallRecord {
  stage: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /** 供应商报告的命中缓存输入 token 数（若有） */
  cachedInputTokens?: number;
  cacheHit: boolean;
  requestHash: string;
  /** 供应商结束原因；缓存命中或未提供时不填 */
  finishReason?: string;
  /** 推理模型花在思考上的 token */
  reasoningTokens?: number;
  /** 正文为空（少见但会发生：输出上限被思考 token 吃光） */
  empty?: boolean;
  /** 当前处于会话窗口的第几轮（1 表示刚输出完整模板的首轮） */
  sessionTurn?: number;
  /** 本次调用是否因检测到偏离或窗口满而重置并重新输出了完整模板 */
  sessionReset?: boolean;
  /** 传输类失败的重试次数（A4）：0 表示一次就成 */
  transportRetries?: number;
  /** 重试累计等待（毫秒） */
  transportWaitMs?: number;
  /** 不完整输出（finish=length / 空正文）：沿用解析重写路径，指标里单独计数 */
  incomplete?: boolean;
}

export interface DirectorDeps {
  llm: LlmClient;
  templates: PromptTemplates;
  /** 校验 + 解析 ESL 文本（注入，lab 侧组装 ValidationContext）。
   * 可回报「机械修复前/后」的内容哈希：批次版本链（C2）靠它区分首版、autofix 与最终版。 */
  validateEs: (
    text: string,
    encoding: 'yaml' | 'json',
  ) => { ok: boolean; batch?: Batch; issues: ValidationIssue[]; rawHash?: string; fixedHash?: string };
  entityExists: (id: string) => boolean;
  formsOf: (item: string) => string[];
  /** 名字解析（A2）：needs 里的人话名字 → 合法名字；不提供时跳过解析 */
  resolveNeed?: (kind: 'background' | 'prop' | 'cast', asked: string) => { ok: boolean; value?: string; reason?: string; via?: 'legit' | 'alias' };
  /** 该 id 是否有角色规格（决定能不能写 @char:<id>） */
  charExists?: (id: string) => boolean;
  /**
   * 写手短清单（A2）的池子：背景标签、常用道具、按频道取角色。
   * 用短清单替代两百多个 `asset_tags` —— 模型读不动长表，而名字只要「能选」就够了。
   */
  namePools?: {
    backgrounds: string[];
    props: string[];
    castOf: (channel: string) => string[];
  };
  /** 每次 LLM 调用后的回调（进度输出用；不得把 prompt 或 key 写进日志） */
  onCall?: (rec: CallRecord) => void;
}

/** needs 的解析结果（A2）：写手短清单的来源，也进批次记录便于事后核对。 */
export interface ResolvedNeed {
  kind: 'background' | 'prop' | 'cast';
  asked: string;
  value: string;
  via: 'legit' | 'alias';
}

/** 批次版本链的一步（C2）：首版 → 解析重写 → autofix → 逐场修复 → 整批重写 → 最终。 */
export interface VersionStep {
  stage: string;
  /** 该步文本解析出的批次内容哈希；解析不出时为空 */
  hash: string | null;
  /** 机械修复前的内容哈希（validateEs 提供） */
  rawHash?: string;
  /** 机械修复后的内容哈希 */
  fixedHash?: string;
  /** 该步的阻断级问题数 */
  blocking: number;
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
  /** 第一版模型输出（未经解析重写/修复/整批重写）的问题单 —— 用来量化「重写是净收益还是净损失」 */
  firstDraftIssues: ValidationIssue[];
  repairRounds: number;
  precheckRetries: number;
  precheckFailures: string[];
  droppedScenes: string[];
  batchFailed: boolean;
  calls: CallRecord[];
  /** 本批生成过程中因检测到偏离而触发会话重置并重发完整模板的次数 */
  sessionResets?: number;
  /** 批次版本链（C2）：首版 → 解析重写 → autofix → 修复 → 重写 → 最终，每步一个内容哈希 */
  versionChain: VersionStep[];
  /** `needs` 的解析结果（A2）：`via='alias'` 的项单独计数，用来核对「别名表救回了多少」 */
  resolvedNeeds?: ResolvedNeed[];
}

interface StageSession {
  history: LlmMessage[];
  batchesInWindow: number;
  lastChannel: string;
  seenAllowedWords: Set<string>;
  pendingResetFlag: boolean;
}

function createStageSession(): StageSession {
  return {
    history: [],
    batchesInWindow: 0,
    lastChannel: '',
    seenAllowedWords: new Set(),
    pendingResetFlag: false,
  };
}

function parseWordList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);
}

/**
 * 构造同会话窗口第 2..N 轮的增量提示词：
 * 首轮（history[0]）已经包含完整的 ESL 规范示例、角色规格表、素材与背景清单、学习者画像及基础允许词表；
 * 后续轮次只发送本批变化的动态块（若频道切换则附上新频道圣经，若允许词表有新增词则只附增量）。
 * 若传入的是测试用的极简模板（不含标准块标题），则直接渲染该模板。
 */
function buildFollowupPrompt(
  stage: 'showrunner' | 'writer' | 'single',
  template: string,
  vars: Record<string, string>,
  session: StageSession,
): string {
  const isStandardTemplate = template.includes('[角色规格表摘要]') || template.includes('[学习者画像]');
  if (!isStandardTemplate) {
    return renderTemplate(template, vars);
  }
  const lines: string[] = [
    `[续写下一批：batch=${vars.batch_id ?? ''}，channel=${vars.channel ?? ''}。继续严格遵守本会话首轮模板中的 ESL 规范、角色规格表、素材与背景位置清单，只输出 YAML，不要解释]`,
  ];
  if (stage === 'showrunner') {
    if (vars.channel_bible && vars.channel !== session.lastChannel) {
      lines.push(`\n[频道圣经]\n${vars.channel_bible}`);
    }
    lines.push(
      `\n[当前事实]\n${vars.cast_facts ?? ''}`,
      `\n[开放伏笔]\n${vars.open_threads ?? ''}`,
      `\n[最近剧情]\n${vars.recent_summary ?? ''}`,
      `\n[回调候选]\n${vars.callback ?? ''}`,
      `\n[梗台账]\n${vars.trope_ledger ?? ''}`,
      `\n[反馈摘要]\n${vars.feedback ?? ''}`,
      `\n[本批指定（采样轴，B1）]\n${vars.assigned ?? '（未指定）'}`,
      `\n[LearningBrief]（本批频道：${vars.channel ?? ''}）\n${vars.brief ?? ''}${vars.retry_note ?? ''}`,
    );
    return lines.join('\n');
  }
  const deltaWords = parseWordList(vars.allowed_words).filter((w) => !session.seenAllowedWords.has(w));
  if (deltaWords.length > 0) {
    lines.push(`\n[本批新增允许词（其余沿用首轮允许词表）]\n${deltaWords.join(', ')}`);
  }
  if (stage === 'single') {
    if (vars.channel_bible && vars.channel !== session.lastChannel) {
      lines.push(`\n[频道圣经]\n${vars.channel_bible}`);
    }
    lines.push(
      `\n[当前事实]\n${vars.cast_facts ?? ''}`,
      `\n[开放伏笔]\n${vars.open_threads ?? ''}`,
      `\n[最近剧情]\n${vars.recent_summary ?? ''}`,
      `\n[回调候选]\n${vars.callback ?? ''}`,
      `\n[梗台账]\n${vars.trope_ledger ?? ''}`,
      `\n[反馈摘要]\n${vars.feedback ?? ''}`,
      `\n[LearningBrief]\n${vars.brief ?? ''}`,
      `\n[本批学习任务（逐条落实，缺一条整批不通过）]\n${vars.learning_checklist ?? ''}${vars.retry_note ?? ''}`,
    );
    return lines.join('\n');
  }
  // writer
  lines.push(
    `\n[本批角色事实]\n${vars.cast_facts ?? ''}`,
    `\n[梗台账（禁止复用）]\n${vars.trope_ledger ?? ''}`,
    `\n[LearningBrief]\n${vars.brief ?? ''}`,
    `\n[编剧室方案]\n${vars.plan ?? ''}`,
    `\n[本批学习任务（逐条落实，缺一条整批不通过）]\n${vars.learning_checklist ?? ''}${vars.retry_note ?? ''}`,
  );
  return lines.join('\n');
}

const briefCoverageOk = (batch: Batch, brief: LearningBrief): boolean => {
  const rank = (t: string) =>
    t === 'recognition-2' ? 1 : t === 'recognition-4' || t === 'listening-4' ? 2 : t === 'production' ? 3 : 0;
  // 跨批 derive（from 指向更早批次）按第 5.8.4 节计作 recognition-4 检索证据
  const testEvidenceOf = (s: Batch['scenes'][number]): { item: string; type: string } | null => {
    if (s.evidence) return s.evidence;
    if (s.type === 'derive' && /^[a-z]+-\d+$/.test(s.from.split('.')[0]!)) return { item: s.item, type: 'recognition-4' };
    return null;
  };
  for (const r of brief.review) {
    const ok = batch.scenes.some((s) => {
      const ev = testEvidenceOf(s);
      return ev?.item === r.item && ev.type !== 'practice' && rank(ev.type) >= rank(r.min_evidence);
    });
    if (!ok) return false;
  }
  for (const e of brief.expose) {
    if (!batch.scenes.some((s) => (s.uses ?? []).includes(e.item))) return false;
  }
  return true;
};

/** 把编剧室的 `needs` 解析成合法名字；解析不了的项已经在预检里退回，这里只收成功的。 */
function resolvePlanNeeds(plan: Plan | undefined, resolve: DirectorDeps['resolveNeed']): ResolvedNeed[] {
  if (!plan?.needs || !resolve) return [];
  const out: ResolvedNeed[] = [];
  const push = (kind: ResolvedNeed['kind'], asked: string) => {
    const r = resolve(kind, asked);
    if (r.ok && r.value) out.push({ kind, asked, value: r.value, via: r.via ?? 'legit' });
  };
  if (plan.needs.background) push('background', plan.needs.background);
  for (const p of plan.needs.props) push('prop', p);
  for (const c of plan.needs.cast) push('cast', c);
  return out;
}

/**
 * 写手看到的短清单（A2）：解析结果 + 本批 cast 的 @char 引用 + 一小池默认道具。
 * 替代原来两百多个 `asset_tags` —— 模型读不动长表，而名字只要「能选」就够了。
 * 没有编剧室方案（单段模式）时退回池子：背景池、该频道角色、道具池。
 */
function availableNamesText(input: {
  plan: Plan | undefined;
  resolved: ResolvedNeed[];
  channel: string;
  pools: DirectorDeps['namePools'];
  charExists?: (id: string) => boolean;
}): string {
  const { plan, resolved, channel, pools, charExists } = input;
  const backgrounds: string[] = [];
  const chars: string[] = [];
  const props: string[] = [];
  const notes: string[] = [];
  for (const r of resolved) {
    if (r.kind === 'background') backgrounds.push(r.value);
    else if (r.kind === 'cast') chars.push(`@char:${r.value}`);
    else props.push(r.value);
    // 别名命中的项单独标一行：让模型知道「你以为的名字」在这里叫什么，下批不必再猜
    if (r.via === 'alias') notes.push(`${r.asked} → ${r.value}`);
  }
  for (const c of plan?.cast ?? []) {
    if (charExists && !charExists(c)) continue;
    const ref = `@char:${c}`;
    if (!chars.includes(ref)) chars.push(ref);
  }
  // 单段模式没有 schema 之外的声明入口，只能给池子；两段式只在池子为空时补
  if (backgrounds.length === 0 && !plan) backgrounds.push(...(pools?.backgrounds ?? []));
  if (chars.length === 0) for (const c of pools?.castOf(channel) ?? []) chars.push(`@char:${c}`);
  for (const p of pools?.props ?? []) if (!props.includes(p)) props.push(p);
  const lines: string[] = [];
  if (backgrounds.length) lines.push(`背景：${[...new Set(backgrounds)].join(' / ')}`);
  if (chars.length) lines.push(`角色：${[...new Set(chars)].join(' / ')}`);
  if (props.length) lines.push(`道具：${[...new Set(props)].slice(0, 12).join(' / ')}`);
  if (notes.length) lines.push(`别名（你想要的 → 合法名字）：${notes.join('；')}`);
  lines.push(
    '清单外的名字一律不要写：需要的东西不在清单里，就删掉这个道具或改写这句台词绕开它（这是允许的出路）。' +
      '改名、拼近似、自己发明名字都会让整批失败。',
  );
  return lines.join('\n');
}

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

/** 六种 effect 的字段提示：写错字段名就是 E-SCHEMA（整批失败）。 */
const EFFECT_FIELD_HINT: Record<string, string> = {
  set_fact: 'set_fact: {subject: <实体>, predicate: <谓词>, object: <值>, standing: stated}',
  end_fact: 'end_fact: {subject: <实体>, predicate: <谓词>}（只能结束当前仍成立的事实）',
  open_thread: 'open_thread: {id: <小写下划线>, title: "<一句英文>", priority: 2}',
  advance_thread: 'advance_thread: {id: <[开放伏笔] 里的 id>}',
  resolve_thread: 'resolve_thread: {id: <[开放伏笔] 里的 id>}',
  user_fact: 'user_fact: {predicate: <谓词>, object: <值>}',
};

/**
 * 世界状态要求（审计 §3）：把编剧室声明的 world_change 变成写手可执行的一行。
 *
 * 之前提示词只说「没人引用的 effect 要删掉」，从没说过「每批必须改一次世界」，
 * 于是 20 批真实产出里 effects 出现 0 次、story 场景 0 个 —— 世界状态层在真实产出上空转。
 * 这里把要求显式渲染进提示词，并给出承载它的唯一两种合法形态。
 */
export function worldChangeChecklist(plan: Plan | undefined): string {
  const wc = plan?.world_change;
  if (!wc) {
    return (
      '- 本批必须至少发生一次世界状态改变：让某个 chat 的 reply 选项带 `effect: 名字`，' +
      '或让 story 的 ink 行写 `# effect:名字`；对应场景的 `effects` 里放 set_fact / open_thread / user_fact 等。'
    );
  }
  const carrier = wc.carrier !== undefined ? `第 ${wc.carrier} 场` : '某个 chat 或 story 场景';
  return [
    `- 本批必须发生一次世界状态改变（${wc.kind}）：写在${carrier}的 ` + '`effects`' + ` 里 —— ${EFFECT_FIELD_HINT[wc.kind] ?? wc.kind}`,
    `- 意图：${wc.note}`,
  ].join('\n');
}

export class DirectorService {
  private readonly config: DirectorConfig;
  private readonly sessions: Record<'showrunner' | 'writer' | 'single', StageSession> = {
    showrunner: createStageSession(),
    writer: createStageSession(),
    single: createStageSession(),
  };

  /**
   * 只传部分字段时用默认值补齐（深合并 maxTokensByStage）。
   * 之前直接把调用方传的对象当配置用，导致 lab 侧不传 maxTokensByStage 时
   * 每阶段上限全落回 LLM 客户端的 4096：推理模型的思考 token 一多，长批次就被截断成
   * finish=length（20 批冒烟里 2 批整批失败即此因）。
   */
  constructor(private deps: DirectorDeps, config: Partial<DirectorConfig> = {}) {
    this.config = {
      ...DEFAULT_DIRECTOR_CONFIG,
      ...config,
      maxTokensByStage: { ...DEFAULT_DIRECTOR_CONFIG.maxTokensByStage, ...config.maxTokensByStage },
    };
  }

  /** 清空指定阶段或全部阶段的会话上下文，下次调用将重新输出完整提示词模板。 */
  resetSessions(stage?: 'showrunner' | 'writer' | 'single', markReset = true): void {
    const targets: ('showrunner' | 'writer' | 'single')[] = stage ? [stage] : ['showrunner', 'writer', 'single'];
    for (const s of targets) {
      this.sessions[s] = createStageSession();
      this.sessions[s].pendingResetFlag = markReset;
    }
  }

  private commitSessionTurn(
    stage: 'showrunner' | 'writer' | 'single',
    userMsg: string,
    assistantMsg: string,
    vars: Record<string, string>,
  ): void {
    const win = this.config.sessionWindow ?? 1;
    if (win <= 1) return;
    const sess = this.sessions[stage];
    sess.history.push({ role: 'user', content: userMsg }, { role: 'assistant', content: assistantMsg });
    sess.batchesInWindow++;
    sess.lastChannel = vars.channel ?? sess.lastChannel;
    for (const w of parseWordList(vars.allowed_words)) sess.seenAllowedWords.add(w);
  }

  private callLog: CallRecord[] = [];
  /** 版本链打点（C2）：每次 generate 重置 */
  private chain: VersionStep[] = [];
  private record(stage: string, res: LlmResponse, meta?: { sessionTurn?: number; sessionReset?: boolean }): void {
    const rec: CallRecord = {
      stage,
      latencyMs: res.latencyMs,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      ...(res.usage.cachedInputTokens !== undefined ? { cachedInputTokens: res.usage.cachedInputTokens } : {}),
      cacheHit: res.cacheHit,
      requestHash: res.requestHash,
      finishReason: res.finishReason,
      reasoningTokens: res.reasoningTokens,
      empty: res.text.trim() === '',
      ...(res.transportRetries !== undefined ? { transportRetries: res.transportRetries } : {}),
      ...(res.transportWaitMs !== undefined ? { transportWaitMs: res.transportWaitMs } : {}),
      // 不完整输出：正文为空或供应商说被上限截断。重试这一层不处理，只留证据给指标。
      ...(res.text.trim() === '' || res.finishReason === 'length' ? { incomplete: true } : {}),
      ...(meta?.sessionTurn !== undefined ? { sessionTurn: meta.sessionTurn } : {}),
      ...(meta?.sessionReset ? { sessionReset: true } : {}),
    };
    this.callLog.push(rec);
    this.deps.onCall?.(rec);
  }

  private vars(extra: Record<string, string>): Record<string, string> {
    return extra;
  }

  /**
   * 校验入口。derive 关闭时先把 derive 场景剔掉再校验：派生卡是「一稿多卡」的额外产物，
   * 关掉这个开关的消融运行（R5 对照）不该把它们的证据算进 brief 覆盖。
   * `stage` 只用于版本链打点（C2），不影响校验结果。
   */
  private validate(text: string, enc: 'yaml' | 'json', stage = 'unknown') {
    const first = this.deps.validateEs(text, enc);
    const result =
      this.config.derive || !first.batch || !first.batch.scenes.some((s) => s.type === 'derive')
        ? first
        : (() => {
            const stripped = { ...first.batch!, scenes: first.batch!.scenes.filter((s) => s.type !== 'derive') };
            return this.deps.validateEs(serializeBatch(stripped, enc), enc);
          })();
    this.chain.push({
      stage,
      hash: result.batch ? contentHash(result.batch) : null,
      ...(result.rawHash !== undefined ? { rawHash: result.rawHash } : {}),
      ...(result.fixedHash !== undefined ? { fixedHash: result.fixedHash } : {}),
      blocking: result.issues.filter((i) => i.level === 'error').length,
    });
    return result;
  }

  private async complete(
    stage: string,
    template: string,
    vars: Record<string, string>,
    tier: 'fast' | 'premium' = 'fast',
  ): Promise<{ text: string; userPrompt: string }> {
    const stageKey = stage as 'showrunner' | 'writer' | 'single' | 'repair';
    const maxTokens = this.config.maxTokensByStage?.[stageKey];
    const win = this.config.sessionWindow ?? 1;
    const isSessionStage = stageKey === 'showrunner' || stageKey === 'writer' || stageKey === 'single';

    let userPrompt: string;
    let messages: LlmMessage[] | undefined;
    let sessionTurn: number | undefined;
    let sessionReset = false;

    if (isSessionStage && win > 1) {
      const sess = this.sessions[stageKey];
      if (sess.batchesInWindow >= win) {
        this.resetSessions(stageKey);
      }
      const activeSess = this.sessions[stageKey];
      if (activeSess.pendingResetFlag) {
        sessionReset = true;
        activeSess.pendingResetFlag = false;
      }
      if (activeSess.history.length === 0) {
        userPrompt = renderTemplate(template, this.vars(vars));
        messages = [{ role: 'user', content: userPrompt }];
        sessionTurn = 1;
      } else {
        userPrompt = buildFollowupPrompt(stageKey, template, this.vars(vars), activeSess);
        messages = [...activeSess.history, { role: 'user', content: userPrompt }];
        sessionTurn = activeSess.batchesInWindow + 1;
      }
    } else {
      userPrompt = renderTemplate(template, this.vars(vars));
      sessionTurn = isSessionStage ? 1 : undefined;
    }

    const res = await this.deps.llm.complete({
      stage,
      system: this.deps.templates.system,
      prompt: userPrompt,
      ...(messages ? { messages } : {}),
      modelTier: tier,
      temperature: stage === 'showrunner' ? 1.0 : 0.8,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    });
    this.record(stage, res, { sessionTurn, sessionReset });
    return { text: res.text, userPrompt };
  }

  async generate(input: GenerateInput): Promise<DirectorOutcome> {
    this.callLog = [];
    this.chain = [];
    let sessionResets = 0;
    const { brief, ledger, batchId, channel } = input;
    const enc = this.config.encoding;
    let plan: Plan | undefined;
    let precheckRetries = 0;
    let precheckFailures: string[] = [];

    // ---------- 第一步：编剧室（仅两段式） ----------
    if (this.config.mode === 'two-stage') {
      let lastText = '';
      let lastUserPrompt = '';
      const showVarsBase = { ...input.vars, batch_id: batchId, channel, brief: briefYaml(brief) };
      for (let attempt = 0; attempt <= this.config.maxPrecheckRetries; attempt++) {
        // 带上重试序号：同一句失败原因重复出现时，请求哈希不能相同，否则会命中上一次的坏方案缓存
        const retryNote = attempt === 0 ? '' : `\n第 ${attempt} 次重试：上一次方案未通过预检，原因：\n${precheckFailures.map((f) => `- ${f}`).join('\n')}\n请换一个方案。`;
        const showVars = { ...showVarsBase, retry_note: retryNote };
        const res = await this.complete(
          'showrunner',
          this.deps.templates.showrunner,
          showVars,
          this.config.showrunnerTier,
        );
        lastText = res.text;
        lastUserPrompt = res.userPrompt;
        const parsed = ShowrunnerPlan.safeParse(parseLooseYaml(lastText));
        if (parsed.success) {
          plan = parsed.data;
          const check = precheckPlan({
            plan,
            brief,
            ledger,
            entityExists: this.deps.entityExists,
            formsOf: this.deps.formsOf,
            ...(this.deps.resolveNeed ? { resolveNeed: this.deps.resolveNeed } : {}),
          });
          precheckFailures = check.failures;
          if (check.ok) {
            this.commitSessionTurn('showrunner', lastUserPrompt, planYaml(plan).trim(), showVars);
            break;
          }
        } else {
          precheckFailures = [`编剧室输出不符合规范：${parsed.error.issues.map((i) => i.message).slice(0, 3).join('; ')}`];
        }
        // 检测到偏离（解析失败或预检不通过）：立即重置 showrunner 会话，下一轮重试直接重新输出完整模板
        this.resetSessions('showrunner');
        sessionResets++;
        precheckRetries = attempt + 1;
      }
    }

    // ---------- 第二步：分场编剧 / 单段 ----------
    const genTemplate = this.config.mode === 'two-stage' ? this.deps.templates.writer : this.deps.templates.single;
    const stage: 'writer' | 'single' = this.config.mode === 'two-stage' ? 'writer' : 'single';
    // A2：编剧室的 needs 在这里解析成合法名字，写手只看到这一份短清单
    const resolvedNeeds = resolvePlanNeeds(plan, this.deps.resolveNeed);
    const baseVars = {
      ...input.vars,
      batch_id: batchId,
      channel,
      brief: briefYaml(brief),
      plan: plan ? planYaml(plan) : '',
      learning_checklist: learningChecklist(plan, brief),
      world_change_checklist: worldChangeChecklist(plan),
      available_names: availableNamesText({
        plan,
        resolved: resolvedNeeds,
        channel,
        pools: this.deps.namePools,
        charExists: this.deps.charExists,
      }),
    };
    let text = '';
    let lastWriterUserPrompt = '';
    let validated = this.validate('', enc, 'empty');
    let parseRetries = 0;
    // 第一版输出的问题单（含解析失败）。后面的解析重写、逐场修复、整批重写都在改这份问题单，
    // 只有把它留下来，跑批结束后才能回答「重写救回来的多，还是改坏的多」。
    let firstDraftIssues: ValidationIssue[] | null = null;
    // 解析不出批次时，修复循环拿不到场景（badSceneIds 为空），只能整批失败；
    // 给它一次「带着解析错误重写」的机会，能把单个 schema 错误救回来。
    for (;;) {
      const note =
        parseRetries === 0
          ? ''
          : `\n上一次输出无法解析成合法批次，错误如下，请逐条修正后重新输出完整批次：\n${validated.issues
              .filter((i) => i.level === 'error')
              .slice(0, 6)
              .map((i) => `- ${i.path ?? ''} ${i.message}`)
              .join('\n')}`;
      const res = await this.complete(stage, genTemplate, { ...baseVars, retry_note: note });
      text = res.text;
      lastWriterUserPrompt = res.userPrompt;
      validated = this.validate(text, enc, parseRetries === 0 ? 'first-draft' : 'parse-retry');
      firstDraftIssues ??= validated.issues;
      if (validated.batch || parseRetries >= (this.config.maxParseRetries ?? 1)) break;
      // 解析级偏离：清空会话，下一轮重写强制重新输出完整模板
      this.resetSessions(stage);
      sessionResets++;
      parseRetries++;
    }
    let repairRounds = 0;
    const hadInitialDrift = !validated.ok;
    if (hadInitialDrift) {
      // 首版输出存在阻断级偏离：立即清空会话历史，防止错误在多轮上下文中传染，
      // 且后续整批重写或下一批次都会重新输出完整模板
      this.resetSessions(stage);
      sessionResets++;
    }

    // ---------- 修复循环（第 5.9.4 节） ----------
    let rewrites = 0;
    while (!validated.ok && repairRounds < this.config.maxRepairRounds) {
      repairRounds++;
      const blocking = validated.issues.filter((i) => i.level === 'error');
      const badSceneIds = [...new Set(blocking.map((i) => i.scene).filter((s): s is string => s !== undefined))];
      const current = validated.batch;
      const problems = blocking
        .map((i) => `- ${i.scene ?? '(batch)'} ${i.code}: ${i.message}`)
        .join('\n');
      if (!current) break; // 解析不出批次：上面的解析重写已经试过，再整批重写只是重复烧钱
      if (badSceneIds.length === 0 || this.config.repairMode === 'batch') {
        // 批次级问题（brief 覆盖缺口、新条目提前检测、OOV）定位不到场景，逐场修复救不了；
        // 整批重写一次，把问题单原样回填给分场编剧（此时会话已重置，必重新输出完整模板）。
        if (rewrites >= (this.config.maxRewrites ?? 1)) break;
        rewrites++;
        this.resetSessions(stage);
        const res = await this.complete(stage, genTemplate, {
          ...baseVars,
          retry_note: `\n上一批未通过校验，问题如下，请整批重写并逐条避免：\n${problems}${
            this.config.repairMode === 'batch' ? `\n[上一版完整批次]\n${serializeBatch(current, enc)}` : ''}`,
        });
        text = res.text;
        lastWriterUserPrompt = res.userPrompt;
        validated = this.validate(text, enc, 'rewrite');
        continue;
      }
      const badScenes = current.scenes.filter((s) => badSceneIds.includes(s.id));
      const repairedRes = await this.complete(
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
      const patched = applyScenePatches(current, repairedRes.text);
      if (patched === null) continue; // 修复输出无法解析，进入下一轮
      text = serializeBatch(patched, enc);
      validated = this.validate(text, enc, `repair-${repairRounds}`);
    }

    // ---------- 场景丢弃（V4）或整批失败 ----------
    if (validated.ok && validated.batch) {
      // 仅当本轮最终使用的 userPrompt 是干净首轮或整批重写后的完整模板（而非靠 repair 拼补），才入会话历史
      if (!hadInitialDrift || rewrites > 0) {
        this.commitSessionTurn(stage, lastWriterUserPrompt, serializeBatch(validated.batch, enc).trim(), baseVars);
      }
      return {
        batch: validated.batch,
        plan,
        issues: validated.issues,
        firstDraftIssues: firstDraftIssues ?? [],
        repairRounds,
        precheckRetries,
        precheckFailures,
        droppedScenes: [],
        batchFailed: false,
        calls: this.callLog,
        sessionResets,
        versionChain: this.chain,
        resolvedNeeds,
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
          firstDraftIssues: firstDraftIssues ?? [],
          repairRounds,
          precheckRetries,
          precheckFailures,
          droppedScenes: [...badSceneIds],
          batchFailed: false,
          calls: this.callLog,
          sessionResets,
          versionChain: this.chain,
          resolvedNeeds,
        };
      }
    }
    return {
      batch: null,
      plan,
      issues: validated.issues,
      firstDraftIssues: firstDraftIssues ?? [],
      repairRounds,
      precheckRetries,
      precheckFailures,
      droppedScenes: [],
      batchFailed: true,
      calls: this.callLog,
      sessionResets,
      versionChain: this.chain,
        resolvedNeeds,
    };
  }
}

// ---------- 序列化辅助 ----------

function parseLooseYaml(text: string): unknown {
  // 先剥掉推理模型内联的思考块（YAML 会把 `Thinking: …` 当成映射键，不剥就是 E-SCHEMA 而不是「在思考」），
  // 再剥掉 markdown 代码围栏；解析失败返回 null（由各 safeParse 分支兜住）
  const cleaned = stripThinking(text) ?? text;
  const stripped = cleaned.replace(/^```[a-z]*\r?\n?/i, '').replace(/\r?\n?```\s*$/i, '');
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
