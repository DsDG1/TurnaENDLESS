/**
 * 实验 0 主流水道（第 4.1 节单批循环）：
 * 规划 → 选频道 → 组装上下文 → 导演（两段/单段）→ 编译校验（含修复）→
 * 交互模拟 → 结算（reducer + FSRS + 能力估计）→ 反馈包 → 渲染与落盘。
 * 反馈延迟（第 4.2 节）：预生成 1 批，导演只看到 N−lag 批及以前的反馈；
 * 播放前对预生成批次做状态重校验（V5），只有状态检查失败才重生成。
 */
import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import {
  autoFixBatch,
  compileBatch,
  parseBatch,
  validateBatch,
  contentHash,
  EVIDENCE_RANK,
  type Batch,
  type EvidenceType,
  type RuntimeAst,
  type TextUnit,
  type ValidationContext,
  type ValidationIssue,
} from '@endless/esl';
import {
  AbilityEstimator,
  EvidenceProcessor,
  Planner,
  SrsStore,
  knownWordSet,
  type LearningBrief,
  type Strategy,
} from '@endless/learning';
import { InMemoryWorldStore, applyEffects, pastFactsFor, relevantEvents, sift, topThreads, type WorldStore } from '@endless/world';
import {
  CachingLlmClient,
  DirectorService,
  LlmFailure,
  MemoryLlmCache,
  RetryingLlmClient,
  TropeLedger,
  type CallRecord,
  type LlmClient,
  type LlmCache,
  type RetryPolicy,
  type VersionStep,
  type ShowrunnerPlan as Plan,
} from '@endless/director';
import type { LedgerEntry } from '@endless/director';
import { buildValidationContext, canonFactsOfBible, renderCatalogEffects, renderCatalogScenes, type LabData } from './data.js';
import { shortAllowedWords } from './allowed-words.js';
import { planDerivedScene } from './deriver.js';
import { assignCell, TEST_ANGLE_NOTE, type SamplingAssignment, type SamplingCell } from './sampler.js';
import { resolveName } from './resolve.js';
import { LearnerSimulator, studyDayOf, type PersonaId } from './sim/learner.js';
import { renderBatch } from './render.js';

/** 允许词表候选池（R5：实际由程序生成，这里是实验期固定池）。 */
export const ALLOWED_EXTRA_POOL = [
  'hat', 'sofa', 'table', 'moon', 'sleep', 'find', 'steal', 'door', 'favourite', 'gone', 'saw',
  'nothing', 'nobody', 'asked', 'work', 'question', 'say', 'perfect', 'professional', 'confused',
  'someone', 'put', 'think', 'asleep', 'interesting', 'before', 'hid', 'own', 'attention',
  'classic', 'detective', 'seat', 'moment', 'coffee', 'drink', 'clue', 'case', 'agency',
  'apartment', 'night', 'last', 'news', 'show', 'fun', 'practice', 'key', 'box', 'bag', 'plant',
  'lamp', 'shelf', 'candle', 'bell', 'cheese', 'sock', 'banana', 'teapot', 'ladder', 'crate',
  'drawer', 'window', 'counter', 'bin', 'desk', 'store', 'shop', 'price', 'cheap', 'expensive',
  'button', 'coin', 'money', 'umbrella', 'customer', 'courier', 'mirror', 'search', 'room',
  'strange', 'strangely', 'secret', 'everyone', 'seven', 'becomes', 'official', 'small', 'missing',
  'seriously', 'different', 'things', 'mystery', 'check', 'wait', 'open', 'close', 'help', 'ask',
  'answer', 'look', 'see', 'know', 'want', 'need', 'like', 'good', 'bad', 'big', 'little', 'new',
  'old', 'happy', 'sad', 'angry', 'tired', 'hungry', 'ready', 'sorry', 'sure', 'maybe', 'really',
  'very', 'too', 'again', 'still', 'already', 'almost', 'nearly', 'useful', 'helpful', 'app',
  'phone', 'message', 'picture', 'story', 'idea', 'problem', 'today', 'tomorrow', 'morning',
  'evening', 'week', 'time', 'place', 'home', 'street', 'city', 'people', 'friend', 'family',
  'water', 'food', 'bread', 'milk', 'tea', 'cake', 'apple', 'orange', 'egg', 'rice', 'fish',
];

/** 初始允许的额外词数量：默认 8（方案 R5），但种子词库只有 62 条，8 个词写不出可读的 A1 内容，
 * 试跑期放大到 60 并在结果文档记录偏差；词库扩到方案规模后应调回。 */
const ALLOWED_EXTRA_COUNT = 60;

/**
 * 写手短清单里的常用道具（A2）。只列真正常用的十来个 —— 清单长了等于没清单。
 * 实际输出前按 manifest 的 emoji 名过滤，写错名字不会漏进提示词。
 */
const PROP_SHORTLIST = [
  'top_hat', 'magnifying_glass', 'notebook', 'envelope', 'flash_light', 'key', 'box',
  'sock', 'door', 'candle', 'bell', 'bag', 'ladder', 'crate', 'plant', 'cheese', 'teapot',
  'coin', 'mirror', 'umbrella', 'apple', 'cake', 'cup', 'phone',
];

export interface PipelineOptions {
  data: LabData;
  store?: WorldStore;
  llm: LlmClient;
  cache?: LlmCache;
  outDir: string | null;
  runId: string;
  batches: number;
  persona: PersonaId;
  seed: number;
  director: 'two-stage' | 'single';
  encoding: 'yaml' | 'json';
  derive: boolean;
  /** 编剧室用的模型档位（premium 只换编剧室、分场仍走 fast；目前两档同型号，未用于正式矩阵） */
  showrunnerTier?: 'fast' | 'premium';
  worldState: boolean;
  tropeLedgerOn: boolean;
  /** 频道初始权重（来自运行配置 channel_weights；缺省用方案默认 50/30/20） */
  channelWeights?: Record<string, number>;
  strategy: Strategy;
  feedbackLag: number;
  channelOverride?: string;
  briefOverrides?: LearningBrief[];
  /** 冒烟：把 8 个种子条目预置成到期复习 */
  smokeSeed?: boolean;
  /** 把每次 LLM 调用的耗时/token 打到 stderr（真实跑批时开，测试不开） */
  verbose?: boolean;
  /** 是否追加写 calls.jsonl；回放时关掉，避免缓存命中的 0 token 记录混进调用日志 */
  recordCalls?: boolean;
  /** OOV 阈值（默认取 buildValidationContext 的 0.02/0.05） */
  oovWarn?: number;
  oovBlock?: number;
  /** 会话窗口大小（默认 6 批；设为 1 时退化为单轮请求） */
  sessionWindow?: number;
  /** 传输类失败的重试策略（A4）；缺省 4 次尝试、800ms 起指数退避 */
  retry?: RetryPolicy;
  /** 连续传输失败多少批就熔断停跑（默认 3，对应迁移方案「批次失败三次就停」） */
  maxConsecutiveTransportFailures?: number;
  /** 熔断时打印的续跑命令（由 CLI 传入，pipeline 不认识 run 配置路径） */
  resumeHint?: string;
  /** 单批 token 上限（D1）；超出一批即视为配置错误，停跑 */
  maxTokensPerBatch?: number;
  /** 全量 token 上限（D1）；触顶即停 */
  maxTotalTokens?: number;
  /**
   * 采样轴（B1）：把「频道 × set_piece × 梗族 × 检测角度」的最冷格作为本批指定项写进编剧室上下文。
   * 默认关闭 —— 只有 R3s 这一行开，R0–R5 的口径不能被它动。
   */
  sampling?: boolean;
}

/** 熔断：连续传输失败达到阈值，继续跑只会把坏数据灌进队列。CLI 捕获后打印续跑命令。 */
export class RunAbortedError extends Error {
  constructor(
    message: string,
    readonly consecutiveFailures: number,
    readonly resumeHint?: string,
  ) {
    super(message);
    this.name = 'RunAbortedError';
  }
}

export interface SceneSim {
  sceneId: string;
  dwellMs: number;
  completed: boolean;
  skipped: boolean;
  evidence?: { item: string; type: string; correct: boolean; attempts: number; qualified: boolean; primed: boolean };
  choice?: string;
}

export interface FeedbackPkg {
  feedback: string;
  batch: string;
  seq: number;
  persona: PersonaId;
  cards: number[];
  scenes: SceneSim[];
  applied_effects: string[];
  interest: { liked_scene_types: string[]; skipped_scene_types: string[] };
  summary_for_director: string;
}

export interface BatchRecord {
  seq: number;
  batchId: string;
  channel: string;
  briefId: string;
  cards: number;
  ok: boolean;
  firstPass: boolean;
  /** 首轮模型原始输出是否零错误（未经机械修复）。用于区分「模型写对了」与「修好了」 */
  rawFirstPass: boolean;
  /** 第一版模型输出的问题单（含解析失败）：与 issues 对比即可看出重写救回了什么、改坏了什么 */
  firstDraftIssues: ValidationIssue[];
  repairRounds: number;
  droppedScenes: string[];
  batchFailed: boolean;
  /** 传输类失败（重试耗尽）：不计入 V2，单列传输失败率；续跑时补齐（A4） */
  transportFailed: boolean;
  /** 本批全部调用累计的传输重试次数 */
  transportRetries: number;
  /** 不完整输出（finish=length / 空正文）的调用数 */
  incompleteCalls: number;
  /** 首版里按别名表救回的名字数（A2）：V0 仍按替换前口径，这个数单列 */
  aliasHits: number;
  /** 编剧室 needs 里靠别名解析的项数（A2） */
  aliasNeeds: number;
  /** 调度理由（D3）：频道权重的三项分量、命中的筛选模式、选中的冷格（B1） */
  scheduleReason: string;
  issues: ValidationIssue[];
  /** 编剧室节拍 gist（N1 语料：梗概 + 节拍，方案 6.1） */
  gistText: string;
  factRefs: number;
  oovRatio: number | null;
  tropes: string[];
  logline: string;
  calls: CallRecord[];
  v5Revalidated: boolean;
  v5Regenerated: boolean;
  tokensIn: number;
  tokensOut: number;
}

export interface RunResult {
  runId: string;
  records: BatchRecord[];
  played: { seq: number; batch: Batch; ast: RuntimeAst; render: string }[];
  /** 每个批次实际使用的 brief（L1 覆盖率复核用） */
  briefs: Map<number, LearningBrief>;
  feedbacks: FeedbackPkg[];
  ledgerEntries: LedgerEntry[];
  sim: LearnerSimulator;
  srs: SrsStore;
  ability: AbilityEstimator;
  exposureCounts: Map<string, number>;
  introduced: Set<string>;
  totals: {
    batchesOk: number;
    batchFailed: number;
    /** 传输失败（E-TRANSPORT）批次：V2 的分母剔除它们，单列传输失败率 */
    transportFailed: number;
    transportRetries: number;
    incompleteCalls: number;
    /** 别名表救回的名字数 / 靠别名解析的 needs 项数（A2） */
    aliasHits: number;
    aliasNeeds: number;
    droppedScenes: number;
    cards: number;
    tokensIn: number;
    tokensOut: number;
    calls: number;
    firstPass: number;
    rawFirstPass: number;
  };
}

const BASE_DATE = new Date('2026-01-01T09:00:00Z');
const SMOKE_ITEMS = [
  'lx:behind#prep.location',
  'lx:under#prep.location',
  'lx:in-front-of#prep.location',
  'lx:next-to#prep.location',
  'lx:near#prep.location',
  'lx:between#prep.location',
  'lx:above#prep.location',
  'ck:where-is',
];

interface PendingBatch {
  seq: number;
  batch: Batch;
  report: ReturnType<typeof validateBatch>;
  tropes: string[];
  logline: string;
  calls: CallRecord[];
  issues: ValidationIssue[];
  repairRounds: number;
  droppedScenes: string[];
  batchFailed: boolean;
  transportFailed: boolean;
  firstPass: boolean;
  rawFirstPass: boolean;
  firstDraftIssues: ValidationIssue[];
  worldVersionAtGen: number;
  gistText: string;
  /** 编剧室计划（C2 落盘用） */
  plan?: Plan;
  /** 批次版本链（C2）：首版 → 解析重写 → autofix → 修复 → 重写 → 最终 */
  versionChain: VersionStep[];
  /** 首版里按别名表救回的名字数（A2，仅第一次校验计） */
  aliasHits: number;
  /** 编剧室 needs 里靠别名解析的项数（A2） */
  aliasNeeds: number;
  /** 调度理由（D3） */
  scheduleReason: string;
}

export async function runExperiment(opts: PipelineOptions): Promise<RunResult> {
  const { data } = opts;
  const store = opts.store ?? new InMemoryWorldStore();
  const sim = new LearnerSimulator(opts.persona, opts.seed);
  const srs = new SrsStore();
  const ability = new AbilityEstimator();
  const processor = new EvidenceProcessor(opts.strategy);
  const planner = new Planner(data.lexicon);
  const ledger = new TropeLedger();
  const feedbackQueue: FeedbackPkg[] = [];
  const records: BatchRecord[] = [];
  const played: RunResult['played'] = [];
  const feedbacks: FeedbackPkg[] = [];
  const briefs = new Map<number, LearningBrief>();

  const allLexiconItems = [...data.lexicon.entries.keys()];
  sim.seedKnowledge(allLexiconItems);
  // 预置能力（冒烟条目视为已学，进入已知词集合）
  for (const item of SMOKE_ITEMS) ability.force(item, 0.9);
  if (opts.smokeSeed) {
    // 预置到期复习：两次 Good 推入 Review 态且早已逾期
    const t0 = new Date(BASE_DATE.getTime() - 40 * 86_400_000);
    for (const item of SMOKE_ITEMS) {
      srs.grade(item, 'meaning', 'Good', t0);
      srs.grade(item, 'meaning', 'Good', new Date(t0.getTime() + 2 * 3600_000));
    }
  }
  const exposureCounts = new Map<string, number>();
  const introduced = new Set<string>(opts.smokeSeed ? SMOKE_ITEMS : []);
  for (const item of opts.smokeSeed ? SMOKE_ITEMS : []) exposureCounts.set(item, 3);

  // 世界播种：实体注册表（角色/地点）始终写入——cast 检查、专名词表与「是否追踪世界记忆」无关；
  // canon 事实只在 world_state 开启时写入（R0 没有世界记忆，但频道角色仍然是已知实体）。
  let worldVersion = 0;
  for (const bible of data.channels.values()) {
    for (const c of bible.cast) {
      store.upsertEntity({ id: c.id, kind: 'character', name: c.id, home_channel: bible.id, created_card: 0, bible_ref: `${bible.id}#${c.id}` });
    }
    for (const loc of bible.locations) {
      store.upsertEntity({ id: loc, kind: 'location', name: loc, home_channel: bible.id, created_card: 0, bible_ref: bible.id });
    }
    if (opts.worldState) {
      for (const f of canonFactsOfBible(bible)) {
        store.insertFact({ ...f, valid_from_card: 0, valid_to_card: null, recorded_card: 0, source_batch: 'bible', source_scene: null, standing: 'canon' });
      }
    }
  }
  worldVersion++;

  // A4：重试层在缓存内层 —— 请求哈希不变，重试不会污染缓存键，回放照旧 100% 命中。
  const llm = new CachingLlmClient(
    new RetryingLlmClient(opts.llm, opts.retry ?? {}),
    opts.cache ?? new MemoryLlmCache(),
  );
  const reduceCtx = (card: number, batchId: string, channel: string, scene?: string, userChoice?: string) => ({
    card,
    batch: batchId,
    scene,
    channel,
    predicates: data.predicates,
    canonLocked: opts.worldState ? [...(data.channels.get(channel)?.canon_locked ?? [])] : [],
    userChoice,
  });

  // 专名（角色名/地名）来自频道圣经声明，与世界状态开关无关（第 5.1 节已知词集合定义）
  const properNouns = [...data.channels.values()].flatMap((b) => [...b.cast.map((c) => c.id), ...b.locations]);

  const buildCtx = (brief: LearningBrief | undefined, channel: string, card: number): ValidationContext =>
    buildValidationContext(data, {
      brief: brief
        ? {
            id: brief.brief,
            review: brief.review.map((r) => ({ item: r.item, facet: r.facet, minEvidence: r.min_evidence })),
            expose: brief.expose.map((e) => ({ item: e.item })),
            introduce: brief.introduce,
            avoidBeforeTest: brief.avoid_before_test,
          }
        : undefined,
      knownForms: knownWordSet(data.lexicon, { ability: (i) => ability.get(i), properNouns }),
      allowedExtra: brief?.vocab.allowed_extra ?? ALLOWED_EXTRA_POOL.slice(0, 8),
      entitiesExists: (id) => store.entityExists(id),
      canonFacts: opts.worldState ? store.currentFacts().filter((f) => f.standing === 'canon').map((f) => ({ subject: f.subject, predicate: f.predicate, object: f.object })) : [],
      activeFacts: opts.worldState ? store.currentFacts().map((f) => ({ subject: f.subject, predicate: f.predicate, object: f.object, standing: f.standing })) : [],
      threads: opts.worldState ? new Map(store.allThreads().map((t) => [t.id, { status: t.status }])) : new Map(),
      exposureCounts,
      channelIsImprov: channel === 'improv',
      recentSceneSequences: ledger.recentSequences(5),
      recentCastCounts: recentCastCountsOf(ledger),
      maxWordsPerLine: brief?.vocab.max_words_per_line,
      oovWarn: opts.oovWarn,
      oovBlock: opts.oovBlock,
    });

  /** 每个频道上次出场的卡号（频道调度的新近度因子） */
  const channelLastCard = new Map<string, number>();

  /**
   * 频道调度：权重 = 基数 × 新近度 × 伏笔压力。
   * 返回调度理由（D3）：没有理由，N2 偏高或伏笔卫生差时无法分清「调度的问题」与「写作的问题」。
   */
  const pickChannel = (card: number): { channel: string; reason: string } => {
    if (opts.channelOverride) return { channel: opts.channelOverride, reason: '固定频道（运行配置覆盖了调度）' };
    const weights = opts.channelWeights ?? { duck_detective: 0.5, impossible_store: 0.3, improv: 0.2 };
    const rows: { id: string; base: number; recency: number; pressure: number; score: number }[] = [];
    for (const [id, base] of Object.entries(weights)) {
      const last = channelLastCard.get(id);
      const recency = last === undefined ? 1 : Math.min((card - last) / 100, 1);
      const pressure = opts.worldState ? store.openThreads().filter((t) => t.owner_channel === id).length / 5 : 0;
      rows.push({ id, base, recency, pressure, score: base * (1 + recency) * (1 + pressure) });
    }
    const total = rows.reduce((s, r) => s + r.score, 0);
    let r = sim.rand() * total;
    let chosen = rows[rows.length - 1]!;
    for (const row of rows) {
      r -= row.score;
      if (r <= 0) {
        chosen = row;
        break;
      }
    }
    return {
      channel: chosen.id,
      reason:
        `频道 ${chosen.id}：基数 ${chosen.base}×新近度 ${chosen.recency.toFixed(2)}×伏笔压力 ${(1 + chosen.pressure).toFixed(2)}` +
        ` = ${chosen.score.toFixed(2)}（占 ${((chosen.score / total) * 100).toFixed(0)}%）`,
    };
  };

  /** 已播放批次的 ESL 摘要（R0 基线：代替事实/伏笔/摘要三块，第 5.6 节） */
  const recentEslDigests: string[] = [];
  /** 已播放批次的文本单元（derive 跨批引用的解析来源，第 5.8.4 节） */
  const priorTextUnits = new Map<string, TextUnit[]>();
  /** 最近答错的条目（B3 错题回插：派生器优先选它们） */
  const recentlyWrong: string[] = [];
  /** 已用过的采样格（B1）：挑最冷格与 B2 覆盖矩阵都靠它 */
  const samplingHistory: SamplingCell[] = [];
  /** 每批的采样格（进台账条目，供 B2 内容侧覆盖矩阵用） */
  const samplingBySeq = new Map<number, SamplingCell>();
  const samplingCellOf = (seq: number): SamplingCell | undefined => samplingBySeq.get(seq);

  // 生成位置 = 已播放数 + 队列里已生成数 + 1（正在生成的这一个）。
  // 反馈延迟按位置算而不是按 seq：重生成会让 seq 与播放位置错开（第 4.2 节）。
  const genPosition = () => records.length + queue.length + 1;

  const buildVars = (brief: LearningBrief, channel: string, card: number): Record<string, string> => {
    const bible = data.channels.get(channel);
    const castIds = bible?.cast.map((c) => c.id) ?? [];
    const facts = opts.worldState ? store.currentFacts(castIds) : [];
    const pastFacts = opts.worldState ? castIds.flatMap((id) => pastFactsFor(store, id, 2)) : [];
    const threads = opts.worldState ? topThreads(store, card, channel, 3) : [];
    const events = opts.worldState ? relevantEvents(store, { card, actors: castIds, keywords: [], limit: 3 }) : [];
    const summary = opts.worldState ? store.latestSummary(channel) : undefined;
    const callback = opts.worldState ? sift(store, data.sifting, card).slice(0, 1) : [];
    const visibleCount = Math.max(0, genPosition() - opts.feedbackLag);
    const visibleFeedback = feedbackQueue.slice(0, visibleCount).slice(-2);
    const castFactsText = facts.length || pastFacts.length
      ? [
          ...facts.map((f) => `${f.subject} ${f.predicate} ${f.object}（${f.standing}）`),
          ...pastFacts.map((f) => `（曾经是）${f.subject} ${f.predicate} ${f.object}`),
        ].join('\n')
      : '（无）';
    const summaryText = opts.worldState
      ? [summary?.text ?? '（暂无摘要）', ...events.map((e) => `- ${e.event.summary_en}`)].join('\n')
      : recentEslDigests.length
        ? `最近 ${recentEslDigests.length} 批原文摘要：\n${recentEslDigests.join('\n')}`
        : '（暂无历史批次）';
    return {
      channel,
      channel_bible: bible ? yamlStringify(bible) : '（即兴频道）',
      learner_profile: `${sim.spec.name}（${sim.spec.id}）：${sim.spec.desc}`,
      brief: yamlStringify(brief),
      cast_facts: castFactsText,
      open_threads: threads.length ? threads.map((t) => `- ${t.thread.id}：${t.thread.title}（优先级 ${t.thread.priority}）`).join('\n') : '（无）',
      recent_summary: summaryText,
      callback: callback.length ? `${callback[0]!.pattern}: ${callback[0]!.detail}（subject=${callback[0]!.subject}）` : 'null',
      trope_ledger: opts.tropeLedgerOn ? ledger.forbiddenText() : '（梗台账关闭）',
      feedback: visibleFeedback.length ? visibleFeedback.map((f) => f.summary_for_director).join('\n---\n') : '（暂无）',
      allowed_extra: (brief.vocab.allowed_extra ?? []).join(', '),
      // A5：写手只看到短表；校验器的完整允许集合不受影响
      allowed_words: shortAllowedWords({
        data,
        brief,
        allowedForms: buildCtx(brief, channel, card).vocab.allowedForms,
        allowedExtra: brief.vocab.allowed_extra ?? ALLOWED_EXTRA_POOL.slice(0, 8),
      }),
      char_specs: yamlStringify(Object.fromEntries(data.charSpecs)),
      // 背景单独列出来（含位置表）：短清单里的背景只有名字，hidden_object 的 spots 还得看这张表。
      backgrounds: [...data.backgrounds.values()]
        .map((bg) => `@tag:${bg.tag}（${bg.description}；spots: ${bg.spots.join(' / ')}）`)
        .join('\n'),
      max_words_per_line: String(brief.vocab.max_words_per_line),
      // A1 第 2 步：组件说明由 catalog.yaml 渲染，与测试同源（不再散在提示词散文里）
      catalog_scenes: renderCatalogScenes(data.catalog),
      catalog_effects: renderCatalogEffects(data.catalog),
    };
  };

  let seqCounter = 0;
  let cardsConsumed = 0;
  /** 连续传输失败批次数：达到阈值就熔断（A4）。任何一次非传输结果都会归零。 */
  let runtimeTransportFailures = 0;
  const maxConsecutiveTransportFailures = Math.max(1, opts.maxConsecutiveTransportFailures ?? 3);
  const channelBatchCount = new Map<string, number>();
  /**
   * 每个批次「模型原始首轮输出」是否零阻断错误，键是批次 id。
   * 机械修复会把「素材名写错」这类错误直接改掉，所以 V1 已经不能代表模型的原始合规率；
   * 这里在修复前额外校验一次（纯本地、不花 token），得到 V0。
   * 用批次 id 而不是 seq 作键：生成是流水线式的，validateEs 回来时 seqCounter 可能已经前进。
   */
  const rawCleanByBatch = new Map<string, boolean>();
  /**
   * 首版里被别名表救回的名字数（A2 第六类 autofix）。
   * 只记第一次校验（= 模型首版），后面几轮的重写不再累加：这个数要回答的是
   * 「模型自己没能写对多少名字」，而不是「这条生成链路一共替换过几次」。
   */
  const aliasHitsByBatch = new Map<string, number>();

  const briefFor = (seq: number): LearningBrief | undefined =>
    opts.briefOverrides ? opts.briefOverrides[(seq - 1) % opts.briefOverrides.length] : undefined;

  const director = new DirectorService(
    {
      llm,
      templates: data.prompts,
      validateEs: (text, encoding) => {
        const parsed = parseBatch(text, encoding);
        if (!parsed.ok) return { ok: false, issues: parsed.issues };
        // 必须用「本批」的 brief：briefFor 只覆盖 stub 的固定 brief，真实跑批的 brief 在 generateSlot 里
        // 由规划器生成并放进 briefs；漏掉它会让 OOV/覆盖率/防启动都按错误的词表判定
        const brief = briefs.get(seqCounter);
        const ctx = buildCtx(brief, parsed.batch.channel, cardsConsumed);
        // 修复前先按原样判一次，只记第一次（首轮）：这是「模型自己写对了吗」的唯一来源
        if (!rawCleanByBatch.has(parsed.batch.batch)) {
          rawCleanByBatch.set(parsed.batch.batch, validateBatch(parsed.batch, ctx).ok);
        }
        // 程序化自检：先做「删声明」的机械修复，再校验。修完还错才进修复循环。
        // 版本链（C2）：机械修复前后各一个内容哈希，才能事后分清「模型首版」与「autofix 后的版本」
        const rawHash = contentHash(parsed.batch);
        const fixed = autoFixBatch(parsed.batch, ctx);
        if (!aliasHitsByBatch.has(parsed.batch.batch)) aliasHitsByBatch.set(parsed.batch.batch, fixed.aliasHits.length);
        if (fixed.fixes.length > 0) {
          for (const f of fixed.fixes) process.stderr.write(`[autofix] ${f}\n`);
        }
        const report = validateBatch(fixed.batch, ctx);
        return { ok: report.ok, batch: fixed.batch, issues: report.issues, rawHash, fixedHash: contentHash(fixed.batch) };
      },
      entityExists: (id) => store.entityExists(id),
      formsOf: (item) => data.lexicon.forms.get(item) ?? [],
      // A2：needs 里的人话名字 → 合法名字（纯查表，不猜）
      resolveNeed: (kind, asked) => {
        const r = resolveName(data, kind, asked);
        return r.ok ? { ok: true, value: r.value, via: r.via } : { ok: false, reason: r.reason };
      },
      charExists: (id) => data.charSpecs.has(id),
      namePools: {
        backgrounds: [...data.backgrounds.values()].map((bg) => `@tag:${bg.tag}`),
        // 只留 manifest 里真实存在的 emoji 名：清单里写错一个字就是给模型递一个非法名字
        props: PROP_SHORTLIST.filter((n) => data.glyphs.has(n)).map((n) => `@emoji:${n}`),
        castOf: (channel) => (data.channels.get(channel)?.cast ?? []).map((c) => c.id),
      },
      onCall: opts.verbose
        ? (rec) => {
            const secs = (rec.latencyMs / 1000).toFixed(1).padStart(5);
            const extra = [
              rec.cachedInputTokens !== undefined ? `cached=${rec.cachedInputTokens}` : '',
              rec.sessionTurn !== undefined ? `turn=${rec.sessionTurn}${rec.sessionReset ? '(reset)' : ''}` : '',
              rec.reasoningTokens ? `think=${rec.reasoningTokens}` : '',
              rec.finishReason ? `finish=${rec.finishReason}` : '',
              rec.empty ? '⚠ 空响应' : '',
              rec.cacheHit ? 'cache' : '',
            ]
              .filter(Boolean)
              .join(' ');
            process.stderr.write(`[llm] ${rec.stage.padEnd(10)} ${secs}s in=${rec.inputTokens} out=${rec.outputTokens} ${extra}\n`);
          }
        : undefined,
    },
    {
      mode: opts.director,
      encoding: opts.encoding,
      showrunnerTier: opts.showrunnerTier ?? 'fast',
      derive: opts.derive,
      maxPrecheckRetries: 2,
      maxRepairRounds: 2,
      ...(opts.sessionWindow !== undefined ? { sessionWindow: opts.sessionWindow } : {}),
    },
  );

  const generateSlot = async (): Promise<PendingBatch> => {
    seqCounter++;
    const seq = seqCounter;
    const card = cardsConsumed;
    const brief =
      briefFor(seq) ??
      planner.nextBrief(
        {
          now: new Date(BASE_DATE.getTime() + studyDayOf(card) * 86_400_000),
          level: 'A1',
          srs,
          ability,
          exposureCounts,
          introduced,
          allowedExtraPool: ALLOWED_EXTRA_POOL,
          allowedExtraCount: ALLOWED_EXTRA_COUNT,
          // brief 里告诉模型的 OOV 预算必须与校验器实际执行的告警阈值一致（第 5.2.3 节）
          oovBudget: opts.oovWarn,
        },
        seq,
      );
    const pick = pickChannel(card);
    const channel = pick.channel;
    briefs.set(seq, brief);
    // B1 采样轴：挑最冷的格子作为本批指定项（默认关闭，只有 R3s 开）
    let assignment: SamplingAssignment | null = null;
    if (opts.sampling) {
      const bible = data.channels.get(channel);
      assignment = assignCell({
        channel,
        setPieces: bible?.set_pieces.length ? bible.set_pieces : ['free'],
        families: data.families,
        history: samplingHistory,
        rand: () => sim.rand(),
      });
      if (assignment) {
        samplingHistory.push({ ...assignment });
        samplingBySeq.set(seq, { ...assignment });
      }
    }
    const scheduleReason = [pick.reason, assignment ? `采样格（B1）：${assignment.reason}` : '']
      .filter(Boolean)
      .join('；');
    const assignedText = assignment
      ? [
          `set_piece: ${assignment.setPiece}`,
          `trope_family: ${assignment.tropeFamily}（用这个族里的梗，不要跨族）`,
          `test_angle: ${assignment.testAngle} — ${TEST_ANGLE_NOTE[assignment.testAngle]}`,
        ].join('\n')
      : '（未指定，按 brief 与频道自行决定）';
    try {
      const out = await director.generate({
        batchId: `b-${String(seq).padStart(4, '0')}`,
        channel,
        brief,
        ledger,
        vars: { ...buildVars(brief, channel, card), assigned: assignedText },
      });
      // 生成跑通（无论批次最终是否通过校验）都说明管线可用，连续传输失败清零
      runtimeTransportFailures = 0;
      if (out.batch) {
        let batch = out.batch;
        let report = validateBatch(batch, buildCtx(brief, channel, card));
        // B3：程序派生一张跨批 cloze 卡（不调 LLM）。只有本批已通过校验才会走到这里，
        // 所以派生不会把失败批次救成通过（V2 口径不受影响），只是多一张卡（K5）。
        if (opts.derive) {
          const plan = planDerivedScene({
            brief,
            priorTexts: priorTextUnits,
            lexicon: { formsOf: (i) => data.lexicon.forms.get(i) },
            recentlyWrong,
            baseCards: batch.scenes.filter((s) => s.type !== 'derive').length,
            usedSceneIds: batch.scenes.map((s) => s.id),
          });
          if (plan) {
            // 插在最前面：派生卡之前没有任何本批文本，E-PRIMED 天然成立（本批自己的同条目检测在它之后，
            // 按「同批第二次检测 = practice」结算）
            const candidate: Batch = { ...batch, scenes: [plan.scene as unknown as Batch['scenes'][number], ...batch.scenes] };
            const candidateReport = validateBatch(candidate, buildCtx(brief, channel, card));
            if (candidateReport.ok) {
              process.stderr.write(
                `[derive] ${plan.scene.id} ${plan.item} ← ${plan.from}${plan.errorReplay ? '（错题回插）' : ''}\n`,
              );
              batch = candidate;
              report = candidateReport;
            } else {
              const why = candidateReport.issues.filter((i) => i.level === 'error').map((i) => `${i.code} ${i.message}`).join('; ');
              process.stderr.write(`[derive] 跳过 ${plan.item}：追加后校验失败（${why}）\n`);
            }
          }
        }
        return {
          seq,
          batch,
          report,
          tropes: out.plan?.tropes ?? [],
          logline: out.plan?.logline ?? '',
          calls: out.calls,
          issues: out.issues,
          repairRounds: out.repairRounds,
          droppedScenes: out.droppedScenes,
          batchFailed: false,
          transportFailed: false,
          firstPass: out.repairRounds === 0 && out.droppedScenes.length === 0,
          rawFirstPass: rawCleanByBatch.get(batch.batch) ?? false,
          firstDraftIssues: out.firstDraftIssues,
          worldVersionAtGen: worldVersion,
          gistText: out.plan?.beats.map((b) => b.gist).join(' ') ?? '',
          ...(out.plan ? { plan: out.plan } : {}),
          versionChain: out.versionChain,
          aliasHits: aliasHitsByBatch.get(batch.batch) ?? 0,
          aliasNeeds: out.resolvedNeeds?.filter((r) => r.via === 'alias').length ?? 0,
          scheduleReason,
        };
      }
      return {
        seq,
        batch: null as unknown as Batch,
        report: null as unknown as ReturnType<typeof validateBatch>,
        tropes: [],
        logline: '',
        calls: out.calls,
        issues: out.issues,
        repairRounds: out.repairRounds,
        droppedScenes: [],
        batchFailed: true,
        transportFailed: false,
        firstPass: false,
        rawFirstPass: false,
        firstDraftIssues: out.firstDraftIssues,
        worldVersionAtGen: worldVersion,
        gistText: '',
        ...(out.plan ? { plan: out.plan } : {}),
        versionChain: out.versionChain,
        aliasHits: 0,
        aliasNeeds: out.resolvedNeeds?.filter((r) => r.via === 'alias').length ?? 0,
        scheduleReason,
      };
    } catch (e) {
      // 失败分三类（A4）：
      // - 传输类重试耗尽（LlmFailure.klass='transport'）→ E-TRANSPORT，不计入 V2，续跑时补齐；
      // - 请求类（400 等）→ 立即失败，说明是配置/提示词问题，重试没用；
      // - 其它（校验器抛错、ink 解析崩）→ 保留原有 E-INTERNAL 口径。
      const transport = e instanceof LlmFailure && e.klass === 'transport';
      const message = e instanceof Error ? e.message.split('\n')[0]! : String(e);
      const attempts = e instanceof LlmFailure ? `（尝试 ${e.attempts} 次）` : '';
      runtimeTransportFailures = transport ? runtimeTransportFailures + 1 : 0;
      if (transport && runtimeTransportFailures >= maxConsecutiveTransportFailures) {
        // 熔断：无限流最危险的不是成本，是坏数据进入队列（迁移方案 §3.3）
        throw new RunAbortedError(
          `连续 ${runtimeTransportFailures} 批传输失败，已停止跑批：${message}`,
          runtimeTransportFailures,
          opts.resumeHint,
        );
      }
      return {
        seq,
        batch: null as unknown as Batch,
        report: null as unknown as ReturnType<typeof validateBatch>,
        tropes: [],
        logline: '',
        calls: [],
        issues: [
          transport
            ? { code: 'E-TRANSPORT', level: 'error', message: `传输失败${attempts}：${message}` }
            : { code: 'E-INTERNAL', level: 'error', message: `生成阶段异常：${message}` },
        ],
        repairRounds: 0,
        droppedScenes: [],
        batchFailed: true,
        transportFailed: transport,
        firstPass: false,
        rawFirstPass: false,
        firstDraftIssues: [],
        worldVersionAtGen: worldVersion,
        gistText: '',
        versionChain: [],
        aliasHits: 0,
        aliasNeeds: 0,
        scheduleReason,
      };
    }
  };

  const stateErrorCodes = new Set(['E-CANON', 'E-FACT-CONFLICT', 'E-EFFECT-INVALID', 'E-ENTITY-UNKNOWN']);

  const playSlot = async (pending: PendingBatch): Promise<void> => {
    const seq = pending.seq;
    if (pending.batchFailed) {
      records.push({
        seq,
        batchId: `b-${String(seq).padStart(4, '0')}`,
        channel: 'n/a',
        briefId: 'n/a',
        cards: 0,
        ok: false,
        firstPass: false,
        rawFirstPass: false,
        firstDraftIssues: pending.firstDraftIssues,
        repairRounds: pending.repairRounds,
        droppedScenes: [],
        batchFailed: true,
        transportFailed: pending.transportFailed,
        issues: pending.issues,
        gistText: '',
        factRefs: 0,
        oovRatio: null,
        tropes: [],
        logline: '',
        calls: pending.calls,
        v5Revalidated: false,
        v5Regenerated: false,
        tokensIn: pending.calls.reduce((s, c) => s + c.inputTokens, 0),
        tokensOut: pending.calls.reduce((s, c) => s + c.outputTokens, 0),
        transportRetries: pending.calls.reduce((s, c) => s + (c.transportRetries ?? 0), 0),
        incompleteCalls: pending.calls.filter((c) => c.incomplete).length,
        aliasHits: pending.aliasHits,
        aliasNeeds: pending.aliasNeeds,
        scheduleReason: pending.scheduleReason,
      });
      // 失败批次也要留证据：没有产物时无法判断是校验太严还是模型输出为空/被截断
      if (opts.outDir) {
        const id = String(seq).padStart(4, '0');
        const batchId = `b-${String(seq).padStart(4, '0')}`;
        const failedBrief = briefs.get(seq);
        if (failedBrief) await writeFile(join(opts.outDir, 'batches', `${id}.brief.yaml`), yamlStringify(failedBrief));
        if (pending.plan) await writeFile(join(opts.outDir, 'batches', `${id}.plan.yaml`), yamlStringify(pending.plan));
        if (pending.versionChain.length > 0) {
          await writeFile(
            join(opts.outDir, 'batches', `${id}.versions.json`),
            JSON.stringify({ batchId, finalHash: null, chain: pending.versionChain }, null, 2),
          );
        }
        await writeFile(
          join(opts.outDir, 'batches', `${id}.failed.json`),
          JSON.stringify(
            {
              seq,
              batchId,
              batchFailed: true,
              transportFailed: pending.transportFailed,
              repairRounds: pending.repairRounds,
              // 失败批次的首版问题单也要落盘：否则事后无法区分「首版就有问题但没救回」
              // 与「首版干净、被重写改坏」——后者是重写路径唯一的硬证据。
              firstDraftIssues: pending.firstDraftIssues,
              issues: pending.issues,
              calls: pending.calls,
            },
            null,
            2,
          ),
        );
        if (opts.recordCalls !== false) {
          for (const c of pending.calls) {
            await appendFile(join(opts.outDir, 'calls.jsonl'), `${JSON.stringify({ seq, batchId, failed: true, ...c })}\n`);
          }
        }
      }
      return;
    }
    const batch = pending.batch;
    const brief = briefs.get(seq);
    const day = studyDayOf(cardsConsumed);
    const now = new Date(BASE_DATE.getTime() + day * 86_400_000);

    // ---------- 交互模拟（第 4.1 节第 8 步） ----------
    const seenItems = new Set<string>();
    /** 本批已经考过的条目：同批第二次检测按 practice 语义结算（方案 §5.2.2） */
    const testedItems = new Set<string>();
    const sceneSims: SceneSim[] = [];
    const chosenEffectNames: { sceneId: string; name: string }[] = [];
    const evidenceEvents: { item: string; facet: 'meaning' | 'listening'; type: EvidenceType; correct: boolean; primed: boolean }[] = [];

    const ast = compileBatch(batch, pending.report, {
      lexicon: { formsOf: (i) => data.lexicon.forms.get(i), confusables: (i) => data.lexicon.entries.get(i)?.confusables ?? [] },
      priorTexts: priorTextUnits,
      distractorPool: ALLOWED_EXTRA_POOL,
    });

    for (const scene of batch.scenes) {
      const textLen = pending.report.textUnits.filter((u) => u.sceneId === scene.id).reduce((s, u) => s + u.text.split(' ').length, 0);
      const dwell = sim.dwellMs(scene.type, textLen);
      const skipped = sim.skipsLongText(textLen);
      const entry: SceneSim = { sceneId: scene.id, dwellMs: dwell, completed: !skipped, skipped };

      // 被启动判定：检测条目（而非任意 uses 条目）在本批更早场景里被声明使用过（第 5.2.2 节）
      const primed = scene.evidence ? seenItems.has(scene.evidence.item) : false;
      const recordEvidence = (guess: number) => {
        // 同批第二次检测同一条目 = practice（方案 §5.2.2）：派生卡插在最前面时，本批自己的检测成为第二次
        const duplicate = testedItems.has(scene.evidence!.item);
        const correct = sim.answer(scene.evidence!.item, guess, day, { primed: primed || duplicate });
        entry.evidence = {
          item: scene.evidence!.item,
          type: scene.evidence!.type,
          correct,
          attempts: 1,
          qualified: !primed && !duplicate && EVIDENCE_RANK[scene.evidence!.type] >= 1 && scene.evidence!.type !== 'practice',
          primed: primed || duplicate,
        };
        evidenceEvents.push({ item: scene.evidence!.item, facet: 'meaning', type: scene.evidence!.type, correct, primed: primed || duplicate });
        testedItems.add(scene.evidence!.item);
        return correct;
      };

      if (scene.type === 'pick' && scene.evidence) {
        const correct = recordEvidence(scene.options.length === 4 && !scene.hint ? 0.25 : 0.5);
        if (!correct && scene.options.length > 2) {
          entry.evidence!.attempts = 2; // 答错后立即重试（retry，不重复计分）
        }
      } else if (scene.type === 'chat') {
        if (scene.reply && scene.evidence) {
          const correct = recordEvidence(scene.reply.options.length === 4 ? 0.25 : 0.5);
          const options = scene.reply.options;
          const wrongIdxs = options.map((_, i) => i).filter((i) => !options[i]!.correct);
          const chosenIdx = correct
            ? options.findIndex((o) => o.correct)
            : wrongIdxs[Math.floor(sim.rand() * wrongIdxs.length)] ?? 0;
          const chosen = options[chosenIdx] ?? options[0]!;
          entry.choice = chosen.label;
          if (chosen.effect) chosenEffectNames.push({ sceneId: scene.id, name: chosen.effect });
        }
        // chat 可选的 ink 多轮分支与 story 同规则：走选定路径并落其 effects（第 5.8.4 节）
        const chatInk = ast.ink.find((x) => x.sceneId === scene.id);
        if (chatInk && chatInk.paths.length > 0) {
          const path = chatInk.paths[sim.chooseOption(chatInk.paths.map((p) => p.choices[0] ?? ''))] ?? chatInk.paths[0]!;
          for (const name of path.effects) chosenEffectNames.push({ sceneId: scene.id, name });
        }
      } else if (scene.type === 'hidden_object' && scene.evidence) {
        recordEvidence(scene.spots.length >= 4 ? 0.25 : 0.5);
      } else if (scene.type === 'swipe' && scene.mode === 'judge' && scene.evidence) {
        recordEvidence(0.5);
      } else if (scene.type === 'story') {
        const inkInfo = ast.ink.find((x) => x.sceneId === scene.id);
        if (inkInfo) {
          const path = inkInfo.paths[sim.chooseOption(inkInfo.paths.map((p) => p.choices[0] ?? ''))] ?? inkInfo.paths[0]!;
          entry.choice = path.choices.join(' → ') || '（无选择）';
          for (const name of path.effects) chosenEffectNames.push({ sceneId: scene.id, name });
        }
        // story 上声明的检索证据也必须真的作答——否则「已覆盖」的到期条目永远拿不到评分
        if (scene.evidence) recordEvidence(0.5);
      }
      // derive 场景在渲染层呈现为检测卡：同批来源 = practice，跨批来源 = 检索证据（第 5.8.4 节）
      for (const d of ast.derived) {
        if (d.sceneId !== scene.id) continue;
        // 同批第二次检测同一条目 = practice（不写 FSRS）；跨批派生本身是检索证据
        const isPractice = d.evidenceType === 'practice' || testedItems.has(d.item);
        const correct = sim.answer(d.item, 0.25, day, { primed: isPractice });
        sceneSims.push({
          sceneId: d.sceneId,
          dwellMs: sim.dwellMs('derive', 12),
          completed: true,
          skipped: false,
          evidence: { item: d.item, type: d.evidenceType, correct, attempts: 1, qualified: !isPractice, primed: isPractice },
        });
        evidenceEvents.push({ item: d.item, facet: 'meaning', type: d.evidenceType, correct, primed: isPractice });
      }

      for (const item of scene.uses ?? []) seenItems.add(item);
      sceneSims.push(entry);
    }

    // ---------- 结算（第 4.1 节第 9 步） ----------
    const reduceResult = opts.worldState
      ? applyEffects(
          store,
          chosenEffectNames.flatMap(({ sceneId, name }) => batch.scenes.find((s) => s.id === sceneId)?.effects?.[name] ?? []),
          reduceCtx(cardsConsumed, batch.batch, batch.channel, undefined, sceneSims.find((s) => s.choice)?.choice),
        )
      : null;
    if (reduceResult) worldVersion++;

    // 本批新建实体注册进实体表：之后批次的 cast/set_fact 不再需要重复声明 new_entities。
    // 实体表是注册表而非世界记忆，与 world_state 开关无关。
    for (const e of batch.new_entities ?? []) {
      store.upsertEntity({ id: e.id, kind: e.kind, name: e.name, home_channel: batch.channel, created_card: cardsConsumed, bible_ref: null });
    }
    priorTextUnits.set(batch.batch, pending.report.textUnits);
    recentEslDigests.push(
      `${batch.batch} ${batch.channel}：${pending.report.textUnits
        .map((u) => u.text)
        .join(' | ')
        .slice(0, 300)}`,
    );
    if (recentEslDigests.length > 3) recentEslDigests.shift();

    for (const ev of evidenceEvents) {
      // 被启动的检测按短时记忆（practice 语义）结算：不写 FSRS、只弱更新 BKT、不更新 S_true（第 5.2.2/5.3.3 节）
      const outcome = processor.process({ item: ev.item, facet: ev.facet, type: ev.primed ? 'practice' : ev.type, correct: ev.correct });
      if (outcome.fsrsGrade) srs.grade(ev.item, ev.facet, outcome.fsrsGrade, now);
      if (outcome.bkt) ability.update(ev.item, outcome.bkt.correct, outcome.bkt.guess);
      else if (outcome.weak) ability.weakUpdate(ev.item);
      if (ev.type === 'practice' || ev.primed) continue; // 短时记忆不更新 S_true
      if (ev.correct) {
        sim.settleCorrect(ev.item);
        const idx = recentlyWrong.indexOf(ev.item);
        if (idx >= 0) recentlyWrong.splice(idx, 1);
      } else {
        sim.settleWrong(ev.item);
        // 错题回插（B3）：最近答错的条目优先派生，越新越靠前，最多留 10 个
        const idx = recentlyWrong.indexOf(ev.item);
        if (idx >= 0) recentlyWrong.splice(idx, 1);
        recentlyWrong.unshift(ev.item);
        if (recentlyWrong.length > 10) recentlyWrong.length = 10;
      }
    }
    for (const scene of batch.scenes) {
      for (const item of scene.uses ?? []) {
        exposureCounts.set(item, (exposureCounts.get(item) ?? 0) + 1);
        introduced.add(item);
        const tested = evidenceEvents.some((e) => e.item === item && e.type !== 'exposure');
        if (!tested) {
          sim.settleExposure(item);
          ability.weakUpdate(item);
        }
      }
    }

    // ---------- 反馈包（第 5.11 节） ----------
    const cardStart = cardsConsumed;
    // 卡数 = 基本场景 + 成功编译出的派生卡。derive 场景本身已在 scenes 里，不能再算一次
    // （B3 的派生器接入后这条会直接抬高 K5，必须只数一次）。
    const cards = batch.scenes.filter((s) => s.type !== 'derive').length + ast.derived.length;
    const dwells = sceneSims.map((s) => s.dwellMs).sort((a, b) => a - b);
    const median = dwells.length ? dwells[Math.floor(dwells.length / 2)]! : 0;
    const fb: FeedbackPkg = {
      feedback: `fb-${batch.batch}`,
      batch: batch.batch,
      seq,
      persona: opts.persona,
      cards: Array.from({ length: cards }, (_, i) => cardStart + i),
      scenes: sceneSims,
      applied_effects: reduceResult?.applied.map((op) => Object.keys(op)[0]!) ?? [],
      interest: {
        liked_scene_types: [...new Set(sceneSims.filter((s) => s.dwellMs > median).map((s) => batch.scenes.find((x) => x.id === s.sceneId)?.type ?? 'derive'))],
        skipped_scene_types: [...new Set(sceneSims.filter((s) => s.skipped).map((s) => batch.scenes.find((x) => x.id === s.sceneId)?.type ?? 'derive'))],
      },
      summary_for_director: `Batch ${batch.batch}: user ${sceneSims.some((s) => s.skipped) ? 'skipped long text' : 'read everything'}, ${evidenceEvents.filter((e) => e.correct).length}/${evidenceEvents.length} correct, chose ${sceneSims.find((s) => s.choice)?.choice ?? 'no choice'}.`,
    };
    feedbacks.push(fb);
    feedbackQueue.push(fb);

    // ---------- 台账与摘要 ----------
    channelLastCard.set(batch.channel, cardsConsumed);
    const ledgerEntry: LedgerEntry = {
      batch: batch.batch,
      tropes: pending.tropes,
      logline: pending.logline || batch.hook_out || '',
      sceneSequence: pending.report.sceneSequence,
      cast: batch.cast,
      channel: batch.channel,
      ...(samplingCellOf(seq) ?? {}),
    };
    ledger.add(ledgerEntry);

    const chCount = (channelBatchCount.get(batch.channel) ?? 0) + 1;
    channelBatchCount.set(batch.channel, chCount);
    if (opts.worldState && chCount % 10 === 0) {
      const events = store.recentEvents({ channel: batch.channel, limit: 12 });
      const text = events
        .reverse()
        .map((e) => e.summary_en)
        .join('. ')
        .split(/\s+/)
        .slice(0, 120)
        .join(' ');
      store.insertSummary({ channel: batch.channel, from_card: Math.max(0, cardStart - 60), to_card: cardStart, text: text || '（无事件）' });
    }

    // ---------- 渲染与落盘 ----------
    const render = renderBatch(batch, ast, data);
    const record: BatchRecord = {
      seq,
      batchId: batch.batch,
      channel: batch.channel,
      briefId: batch.brief,
      cards,
      ok: true,
      firstPass: pending.firstPass,
      rawFirstPass: pending.rawFirstPass,
      firstDraftIssues: pending.firstDraftIssues,
      repairRounds: pending.repairRounds,
      droppedScenes: pending.droppedScenes,
      batchFailed: false,
      transportFailed: false,
      issues: pending.issues,
      gistText: pending.gistText,
      factRefs: pending.report.factRefs,
      oovRatio: pending.report.vocab.oovRatio,
      tropes: pending.tropes,
      logline: pending.logline,
      calls: pending.calls,
      // V5 重校验标记由主循环在播放前回填：此刻 worldVersion 已含本批自己的结算，在这里比较恒为真
      v5Revalidated: false,
      v5Regenerated: false,
      tokensIn: pending.calls.reduce((s, c) => s + c.inputTokens, 0),
      tokensOut: pending.calls.reduce((s, c) => s + c.outputTokens, 0),
      transportRetries: pending.calls.reduce((s, c) => s + (c.transportRetries ?? 0), 0),
      incompleteCalls: pending.calls.filter((c) => c.incomplete).length,
      aliasHits: pending.aliasHits,
      aliasNeeds: pending.aliasNeeds,
      scheduleReason: pending.scheduleReason,
    };
    records.push(record);
    played.push({ seq, batch, ast, render });
    cardsConsumed += cards;

    if (opts.outDir) {
      const id = String(seq).padStart(4, '0');
      await writeFile(join(opts.outDir, 'batches', `${id}.esl.yaml`), yamlStringify(batch));
      await writeFile(join(opts.outDir, 'batches', `${id}.ast.json`), JSON.stringify(ast, null, 2));
      // C2：brief、编剧室计划、梗台账条目、版本链随批次落盘 —— 指标离线重算与「差异归因」的原料
      await writeFile(join(opts.outDir, 'batches', `${id}.brief.yaml`), yamlStringify(brief ?? {}));
      if (pending.plan) await writeFile(join(opts.outDir, 'batches', `${id}.plan.yaml`), yamlStringify(pending.plan));
      await writeFile(join(opts.outDir, 'batches', `${id}.ledger.json`), JSON.stringify(ledgerEntry, null, 2));
      await writeFile(
        join(opts.outDir, 'batches', `${id}.versions.json`),
        JSON.stringify({ batchId: batch.batch, finalHash: contentHash(batch), chain: pending.versionChain }, null, 2),
      );
      await writeFile(
        join(opts.outDir, 'batches', `${id}.report.json`),
        JSON.stringify({ ...record, calls: undefined, issues: pending.issues, report: { factRefs: pending.report.factRefs, derivedEvidence: pending.report.derivedEvidence } }, null, 2),
      );
      await writeFile(join(opts.outDir, 'render', `${id}.md`), render);
      if (opts.recordCalls !== false) {
        await appendFile(join(opts.outDir, 'feedback.jsonl'), `${JSON.stringify(fb)}\n`);
        for (const c of pending.calls) {
          await appendFile(join(opts.outDir, 'calls.jsonl'), `${JSON.stringify({ seq, batchId: batch.batch, ...c })}\n`);
        }
      }
    }
  };

  if (opts.outDir) {
    await mkdir(join(opts.outDir, 'batches'), { recursive: true });
    await mkdir(join(opts.outDir, 'render'), { recursive: true });
    await mkdir(join(opts.outDir, 'cache'), { recursive: true });
  }

  // ---------- 主循环（第 4.2 节）：生成领先播放 feedbackLag 批 ----------
  // 批次在播放前 feedbackLag 个位置就生成完毕，所以导演看到的反馈与世界状态天然滞后 lag 批；
  // 播放前对已生成批次按最新世界状态重校验（V5），只有状态检查失败才重生成。
  const lookAhead = Math.max(1, opts.feedbackLag);
  const queue: PendingBatch[] = [];
  const maxTokensPerBatch = Math.max(0, opts.maxTokensPerBatch ?? 0);
  const maxTotalTokens = Math.max(0, opts.maxTotalTokens ?? 0);
  let totalTokens = 0;
  /**
   * 预算护栏（D1）：单批触顶说明提示词/上限配置出了问题；全量触顶说明该停下来核算成本。
   * 两种都按「停跑」处理并给出续跑命令 —— 请求哈希缓存保证重跑不会重复付费。
   */
  const guardBudget = (): void => {
    const last = records[records.length - 1];
    if (!last) return;
    const batchTokens = last.tokensIn + last.tokensOut;
    totalTokens += batchTokens;
    if (maxTokensPerBatch > 0 && batchTokens > maxTokensPerBatch) {
      throw new RunAbortedError(
        `批次 ${last.batchId} 用了 ${batchTokens} token，超过单批上限 ${maxTokensPerBatch}`,
        0,
        opts.resumeHint,
      );
    }
    if (maxTotalTokens > 0 && totalTokens > maxTotalTokens) {
      throw new RunAbortedError(`累计 token ${totalTokens} 已超过全量上限 ${maxTotalTokens}，停止跑批`, 0, opts.resumeHint);
    }
  };
  let produced = 0;
  for (; produced < Math.min(lookAhead, opts.batches); produced++) queue.push(await generateSlot());
  for (let i = 0; i < opts.batches; i++) {
    let pending = queue.shift()!;
    const v5Checked = opts.worldState && !pending.batchFailed && pending.worldVersionAtGen !== worldVersion;
    let v5Regenerated = false;
    if (v5Checked) {
      const brief = briefs.get(pending.seq);
      const recheck = validateBatch(pending.batch, buildCtx(brief, pending.batch.channel, cardsConsumed));
      const stateFail = recheck.issues.some((x) => x.level === 'error' && stateErrorCodes.has(x.code));
      if (stateFail) {
        director.resetSessions();
        pending = await generateSlot();
        v5Regenerated = true;
      }
    }
    await playSlot(pending);
    const last = records[records.length - 1]!;
    last.v5Revalidated = v5Checked;
    last.v5Regenerated = v5Regenerated || last.v5Regenerated;
    guardBudget();
    if (produced < opts.batches) {
      queue.push(await generateSlot());
      produced++;
    }
  }

  const totals = {
    batchesOk: records.filter((r) => r.ok).length,
    batchFailed: records.filter((r) => r.batchFailed).length,
    transportFailed: records.filter((r) => r.transportFailed).length,
    transportRetries: records.reduce((s, r) => s + r.calls.reduce((a, c) => a + (c.transportRetries ?? 0), 0), 0),
    incompleteCalls: records.reduce((s, r) => s + r.calls.filter((c) => c.incomplete).length, 0),
    aliasHits: records.reduce((s, r) => s + r.aliasHits, 0),
    aliasNeeds: records.reduce((s, r) => s + r.aliasNeeds, 0),
    droppedScenes: records.reduce((s, r) => s + r.droppedScenes.length, 0),
    cards: records.reduce((s, r) => s + r.cards, 0),
    tokensIn: records.reduce((s, r) => s + r.tokensIn, 0),
    tokensOut: records.reduce((s, r) => s + r.tokensOut, 0),
    calls: records.reduce((s, r) => s + r.calls.length, 0),
    firstPass: records.filter((r) => r.firstPass && r.ok).length,
    rawFirstPass: records.filter((r) => r.rawFirstPass && r.ok).length,
  };
  return {
    runId: opts.runId,
    records,
    played,
    briefs,
    feedbacks,
    ledgerEntries: ledger.window(),
    sim,
    srs,
    ability,
    exposureCounts,
    introduced,
    totals,
  };
}

function recentCastCountsOf(ledger: TropeLedger): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of ledger.window().slice(-10)) {
    for (const id of e.cast) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
