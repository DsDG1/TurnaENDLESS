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
  EVIDENCE_RANK,
  type Batch,
  type EvidenceType,
  type RuntimeAst,
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
import { InMemoryWorldStore, applyEffects, relevantEvents, sift, topThreads, type WorldStore } from '@endless/world';
import {
  CachingLlmClient,
  DirectorService,
  MemoryLlmCache,
  TropeLedger,
  type CallRecord,
  type LlmClient,
  type LlmCache,
} from '@endless/director';
import type { LedgerEntry } from '@endless/director';
import { buildValidationContext, canonFactsOfBible, type LabData } from './data.js';
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
  issues: ValidationIssue[];
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
  firstPass: boolean;
  rawFirstPass: boolean;
  firstDraftIssues: ValidationIssue[];
  worldVersionAtGen: number;
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

  // 世界播种：实体与 canon 事实来自频道圣经（仅 world_state 开启时）
  let worldVersion = 0;
  if (opts.worldState) {
    for (const bible of data.channels.values()) {
      for (const c of bible.cast) {
        store.upsertEntity({ id: c.id, kind: 'character', name: c.id, home_channel: bible.id, created_card: 0, bible_ref: `${bible.id}#${c.id}` });
      }
      for (const loc of bible.locations) {
        store.upsertEntity({ id: loc, kind: 'location', name: loc, home_channel: bible.id, created_card: 0, bible_ref: bible.id });
      }
      for (const f of canonFactsOfBible(bible)) {
        store.insertFact({ ...f, valid_from_card: 0, valid_to_card: null, recorded_card: 0, source_batch: 'bible', source_scene: null, standing: 'canon' });
      }
    }
    worldVersion++;
  }

  const llm = new CachingLlmClient(opts.llm, opts.cache ?? new MemoryLlmCache());
  const reduceCtx = (card: number, batchId: string, channel: string, scene?: string) => ({
    card,
    batch: batchId,
    scene,
    channel,
    predicates: data.predicates,
    canonLocked: opts.worldState ? [...(data.channels.get(channel)?.canon_locked ?? [])] : [],
  });

  const properNouns = opts.worldState
    ? [...data.channels.values()].flatMap((b) => [...b.cast.map((c) => c.id), ...b.locations])
    : [];

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

  const pickChannel = (card: number): string => {
    if (opts.channelOverride) return opts.channelOverride;
    const weights: Record<string, number> = { duck_detective: 0.5, impossible_store: 0.3, improv: 0.2 };
    const scores: [string, number][] = [];
    for (const [id, base] of Object.entries(weights)) {
      const last = channelLastCard.get(id);
      const recency = last === undefined ? 1 : Math.min((card - last) / 100, 1);
      const pressure = opts.worldState ? store.openThreads().filter((t) => t.owner_channel === id).length / 5 : 0;
      scores.push([id, base * (1 + recency) * (1 + pressure)]);
    }
    const total = scores.reduce((s, [, w]) => s + w, 0);
    let r = sim.rand() * total;
    for (const [id, w] of scores) {
      r -= w;
      if (r <= 0) return id;
    }
    return scores[scores.length - 1]![0];
  };

  const buildVars = (brief: LearningBrief, channel: string, card: number): Record<string, string> => {
    const bible = data.channels.get(channel);
    const castIds = bible?.cast.map((c) => c.id) ?? [];
    const facts = opts.worldState ? store.currentFacts(castIds) : [];
    const threads = opts.worldState ? topThreads(store, card, channel, 3) : [];
    const events = opts.worldState ? relevantEvents(store, { card, actors: castIds, keywords: [], limit: 3 }) : [];
    const summary = opts.worldState ? store.latestSummary(channel) : undefined;
    const callback = opts.worldState ? sift(store, data.sifting, card).slice(0, 1) : [];
    const visibleFeedback = feedbackQueue.filter((f) => f.seq <= seqCounter - opts.feedbackLag).slice(-2);
    return {
      channel,
      channel_bible: bible ? yamlStringify(bible) : '（即兴频道）',
      learner_profile: `${sim.spec.name}（${sim.spec.id}）：${sim.spec.desc}`,
      brief: yamlStringify(brief),
      cast_facts: facts.length ? facts.map((f) => `${f.subject} ${f.predicate} ${f.object}（${f.standing}）`).join('\n') : '（无）',
      open_threads: threads.length ? threads.map((t) => `- ${t.thread.id}：${t.thread.title}（优先级 ${t.thread.priority}）`).join('\n') : '（无）',
      recent_summary: [summary?.text ?? '（暂无摘要）', ...events.map((e) => `- ${e.event.summary_en}`)].join('\n'),
      callback: callback.length ? `${callback[0]!.pattern}: ${callback[0]!.detail}（subject=${callback[0]!.subject}）` : 'null',
      trope_ledger: opts.tropeLedgerOn ? ledger.forbiddenText() : '（梗台账关闭）',
      feedback: visibleFeedback.length ? visibleFeedback.map((f) => f.summary_for_director).join('\n---\n') : '（暂无）',
      allowed_extra: (brief.vocab.allowed_extra ?? []).join(', '),
      // 校验器的真实允许词表（已知词 ∪ 额外词 ∪ 本批目标条目形式）：直接给模型看，比分头猜省事
      allowed_words: [...buildCtx(brief, channel, card).vocab.allowedForms].sort().join(', '),
      char_specs: yamlStringify(Object.fromEntries(data.charSpecs)),
      asset_tags: [...data.assetTags].join(', '),
      // 背景单独列出来：asset_tags 有两百多个名字，6 个背景混在里面模型看不见，
      // 20g 就自造过 @tag:apartment。这里连位置表一起给，hidden_object 的 spots 也就不用猜了。
      backgrounds: [...data.backgrounds.values()]
        .map((bg) => `@tag:${bg.tag}（${bg.description}；spots: ${bg.spots.join(' / ')}）`)
        .join('\n'),
      max_words_per_line: String(brief.vocab.max_words_per_line),
    };
  };

  let seqCounter = 0;
  let cardsConsumed = 0;
  const channelBatchCount = new Map<string, number>();
  /**
   * 每个批次「模型原始首轮输出」是否零阻断错误，键是批次 id。
   * 机械修复会把「素材名写错」这类错误直接改掉，所以 V1 已经不能代表模型的原始合规率；
   * 这里在修复前额外校验一次（纯本地、不花 token），得到 V0。
   * 用批次 id 而不是 seq 作键：生成是流水线式的，validateEs 回来时 seqCounter 可能已经前进。
   */
  const rawCleanByBatch = new Map<string, boolean>();

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
        const fixed = autoFixBatch(parsed.batch, ctx);
        if (fixed.fixes.length > 0) {
          for (const f of fixed.fixes) process.stderr.write(`[autofix] ${f}\n`);
        }
        const report = validateBatch(fixed.batch, ctx);
        return { ok: report.ok, batch: fixed.batch, issues: report.issues };
      },
      entityExists: (id) => store.entityExists(id),
      formsOf: (item) => data.lexicon.forms.get(item) ?? [],
      onCall: opts.verbose
        ? (rec) => {
            const secs = (rec.latencyMs / 1000).toFixed(1).padStart(5);
            const extra = [
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
        },
        seq,
      );
    const channel = pickChannel(card);
    briefs.set(seq, brief);
    try {
      const out = await director.generate({
        batchId: `b-${String(seq).padStart(4, '0')}`,
        channel,
        brief,
        ledger,
        vars: buildVars(brief, channel, card),
      });
      if (out.batch) {
        const report = validateBatch(out.batch, buildCtx(brief, channel, card));
        return {
          seq,
          batch: out.batch,
          report,
          tropes: out.plan?.tropes ?? [],
          logline: out.plan?.logline ?? '',
          calls: out.calls,
          issues: out.issues,
          repairRounds: out.repairRounds,
          droppedScenes: out.droppedScenes,
          batchFailed: false,
          firstPass: out.repairRounds === 0 && out.droppedScenes.length === 0,
          rawFirstPass: rawCleanByBatch.get(out.batch.batch) ?? false,
          firstDraftIssues: out.firstDraftIssues,
          worldVersionAtGen: worldVersion,
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
        firstPass: false,
        rawFirstPass: false,
        firstDraftIssues: out.firstDraftIssues,
        worldVersionAtGen: worldVersion,
      };
    } catch (e) {
      // 单批异常不能带走整轮跑批（真实模型会写出让校验器抛错的 ink 之类）：记成失败批次继续
      const message = e instanceof Error ? e.message.split('\n')[0]! : String(e);
      return {
        seq,
        batch: null as unknown as Batch,
        report: null as unknown as ReturnType<typeof validateBatch>,
        tropes: [],
        logline: '',
        calls: [],
        issues: [{ code: 'E-INTERNAL', level: 'error', message: `生成阶段异常：${message}` }],
        repairRounds: 0,
        droppedScenes: [],
        batchFailed: true,
        firstPass: false,
        rawFirstPass: false,
        firstDraftIssues: [],
        worldVersionAtGen: worldVersion,
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
        issues: pending.issues,
        factRefs: 0,
        oovRatio: null,
        tropes: [],
        logline: '',
        calls: pending.calls,
        v5Revalidated: false,
        v5Regenerated: false,
        tokensIn: 0,
        tokensOut: 0,
      });
      // 失败批次也要留证据：没有产物时无法判断是校验太严还是模型输出为空/被截断
      if (opts.outDir) {
        const id = String(seq).padStart(4, '0');
        const batchId = `b-${String(seq).padStart(4, '0')}`;
        await writeFile(
          join(opts.outDir, 'batches', `${id}.failed.json`),
          JSON.stringify(
            {
              seq,
              batchId,
              batchFailed: true,
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
    const sceneSims: SceneSim[] = [];
    const chosenEffectNames: { sceneId: string; name: string }[] = [];
    const evidenceEvents: { item: string; facet: 'meaning' | 'listening'; type: EvidenceType; correct: boolean; primed: boolean }[] = [];

    const ast = compileBatch(batch, pending.report, { lexicon: { formsOf: (i) => data.lexicon.forms.get(i), confusables: (i) => data.lexicon.entries.get(i)?.confusables ?? [] } });

    for (const scene of batch.scenes) {
      const textLen = pending.report.textUnits.filter((u) => u.sceneId === scene.id).reduce((s, u) => s + u.text.split(' ').length, 0);
      const dwell = sim.dwellMs(scene.type, textLen);
      const skipped = sim.skipsLongText(textLen);
      const entry: SceneSim = { sceneId: scene.id, dwellMs: dwell, completed: !skipped, skipped };

      if (scene.type === 'pick' && scene.evidence) {
        const primed = (scene.uses ?? []).some((i) => seenItems.has(i));
        const guess = scene.options.length === 4 && !scene.hint ? 0.25 : 0.5;
        const correct = sim.answer(scene.evidence.item, guess, day, { primed });
        entry.evidence = { item: scene.evidence.item, type: scene.evidence.type, correct, attempts: 1, qualified: EVIDENCE_RANK[scene.evidence.type] >= 1 && scene.evidence.type !== 'practice', primed };
        evidenceEvents.push({ item: scene.evidence.item, facet: 'meaning', type: scene.evidence.type, correct, primed });
        if (!correct && scene.options.length > 2) {
          entry.evidence.attempts = 2; // 答错后立即重试（retry，不重复计分）
        }
      } else if (scene.type === 'chat' && scene.reply && scene.evidence) {
        const primed = (scene.uses ?? []).some((i) => seenItems.has(i));
        const guess = scene.reply.options.length === 4 ? 0.25 : 0.5;
        const correct = sim.answer(scene.evidence.item, guess, day, { primed });
        const options = scene.reply.options;
        const wrongIdxs = options.map((_, i) => i).filter((i) => !options[i]!.correct);
        const chosenIdx = correct
          ? options.findIndex((o) => o.correct)
          : wrongIdxs[Math.floor(sim.rand() * wrongIdxs.length)] ?? 0;
        const chosen = options[chosenIdx] ?? options[0]!;
        entry.evidence = { item: scene.evidence.item, type: scene.evidence.type, correct, attempts: 1, qualified: EVIDENCE_RANK[scene.evidence.type] >= 1 && scene.evidence.type !== 'practice', primed };
        entry.choice = chosen.label;
        if (chosen.effect) chosenEffectNames.push({ sceneId: scene.id, name: chosen.effect });
        evidenceEvents.push({ item: scene.evidence.item, facet: 'meaning', type: scene.evidence.type, correct, primed });
      } else if (scene.type === 'hidden_object' && scene.evidence) {
        const primed = (scene.uses ?? []).some((i) => seenItems.has(i));
        const guess = scene.spots.length >= 4 ? 0.25 : 0.5;
        const correct = sim.answer(scene.evidence.item, guess, day, { primed });
        entry.evidence = { item: scene.evidence.item, type: scene.evidence.type, correct, attempts: 1, qualified: EVIDENCE_RANK[scene.evidence.type] >= 1 && scene.evidence.type !== 'practice', primed };
        evidenceEvents.push({ item: scene.evidence.item, facet: 'meaning', type: scene.evidence.type, correct, primed });
      } else if (scene.type === 'swipe' && scene.mode === 'judge' && scene.evidence) {
        const correct = sim.answer(scene.evidence.item, 0.5, day, {});
        entry.evidence = { item: scene.evidence.item, type: scene.evidence.type, correct, attempts: 1, qualified: true, primed: false };
        evidenceEvents.push({ item: scene.evidence.item, facet: 'meaning', type: scene.evidence.type, correct, primed: false });
      } else if (scene.type === 'story') {
        const inkInfo = ast.ink.find((x) => x.sceneId === scene.id);
        if (inkInfo) {
          const path = inkInfo.paths[sim.chooseOption(inkInfo.paths.map((p) => p.choices[0] ?? ''))] ?? inkInfo.paths[0]!;
          entry.choice = path.choices.join(' → ') || '（无选择）';
          for (const name of path.effects) chosenEffectNames.push({ sceneId: scene.id, name });
        }
      }
      // derive 场景在渲染层呈现为 practice 检测
      for (const d of ast.derived) {
        if (d.sceneId !== scene.id) continue;
        const correct = sim.answer(d.item, 0.25, day, { primed: true });
        sceneSims.push({
          sceneId: d.sceneId,
          dwellMs: sim.dwellMs('derive', 12),
          completed: true,
          skipped: false,
          evidence: { item: d.item, type: 'practice', correct, attempts: 1, qualified: false, primed: true },
        });
        evidenceEvents.push({ item: d.item, facet: 'meaning', type: 'practice', correct, primed: true });
      }

      for (const item of scene.uses ?? []) seenItems.add(item);
      sceneSims.push(entry);
    }

    // ---------- 结算（第 4.1 节第 9 步） ----------
    const reduceResult = opts.worldState
      ? applyEffects(
          store,
          chosenEffectNames.flatMap(({ sceneId, name }) => batch.scenes.find((s) => s.id === sceneId)?.effects?.[name] ?? []),
          reduceCtx(cardsConsumed, batch.batch, batch.channel),
        )
      : null;
    if (reduceResult) worldVersion++;

    for (const ev of evidenceEvents) {
      const outcome = processor.process({ item: ev.item, facet: ev.facet, type: ev.type, correct: ev.correct });
      if (outcome.fsrsGrade) srs.grade(ev.item, ev.facet, outcome.fsrsGrade, now);
      if (outcome.bkt) ability.update(ev.item, outcome.bkt.correct, outcome.bkt.guess);
      else if (outcome.weak) ability.weakUpdate(ev.item);
      if (ev.type === 'practice' || ev.primed) continue; // 短时记忆不更新 S_true
      if (ev.correct) sim.settleCorrect(ev.item);
      else sim.settleWrong(ev.item);
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
    const cards = batch.scenes.length + ast.derived.length;
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
      issues: pending.issues,
      factRefs: pending.report.factRefs,
      oovRatio: pending.report.vocab.oovRatio,
      tropes: pending.tropes,
      logline: pending.logline,
      calls: pending.calls,
      v5Revalidated: pending.worldVersionAtGen !== worldVersion,
      v5Regenerated: false,
      tokensIn: pending.calls.reduce((s, c) => s + c.inputTokens, 0),
      tokensOut: pending.calls.reduce((s, c) => s + c.outputTokens, 0),
    };
    records.push(record);
    played.push({ seq, batch, ast, render });
    cardsConsumed += cards;

    if (opts.outDir) {
      const id = String(seq).padStart(4, '0');
      await writeFile(join(opts.outDir, 'batches', `${id}.esl.yaml`), yamlStringify(batch));
      await writeFile(join(opts.outDir, 'batches', `${id}.ast.json`), JSON.stringify(ast, null, 2));
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

  // ---------- 主循环：预生成 1 批（反馈延迟），播放前重校验（V5） ----------
  let queue: PendingBatch[] = [await generateSlot()];
  for (let i = 0; i < opts.batches; i++) {
    let pending = queue.shift()!;
    // 第 4.2 节：已生成的批次与新世界状态冲突 → 重校验；只有状态检查失败才重生成
    let v5Regenerated = false;
    if (opts.worldState && !pending.batchFailed && pending.worldVersionAtGen !== worldVersion) {
      const brief = briefs.get(pending.seq);
      const recheck = validateBatch(pending.batch, buildCtx(brief, pending.batch.channel, cardsConsumed));
      const stateFail = recheck.issues.some((x) => x.level === 'error' && stateErrorCodes.has(x.code));
      if (stateFail) {
        pending = await generateSlot();
        v5Regenerated = true;
      }
    }
    await playSlot(pending);
    const last = records[records.length - 1]!;
    last.v5Regenerated = v5Regenerated || last.v5Regenerated;
    if (i < opts.batches - 1) queue.push(await generateSlot());
  }

  const totals = {
    batchesOk: records.filter((r) => r.ok).length,
    batchFailed: records.filter((r) => r.batchFailed).length,
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
