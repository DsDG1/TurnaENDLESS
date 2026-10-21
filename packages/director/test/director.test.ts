/** director 包测试：上下文预算、梗台账、预检、两段式编排与修复循环（Stub LLM 驱动）。 */
import { describe, expect, it } from 'vitest';
import { parseBatch, validateBatch, type Batch, type ValidationContext } from '@endless/esl';
import type { LearningBrief } from '@endless/learning';
import { assembleContext, DEFAULT_BUDGETS } from '../src/context.js';
import { TropeLedger } from '../src/ledger.js';
import { precheckPlan, type ShowrunnerPlan } from '../src/showrunner.js';
import { StubLlmClient } from '../src/llm.js';
import { DirectorService, type DirectorConfig, type DirectorDeps } from '../src/director.js';
import type { PromptTemplates } from '../src/prompts.js';

// ---------- 最小可过校验的批次 ----------

const GOOD_BATCH = `
batch: tt-0001
channel: duck_detective
brief: lb-0001
cast: [duck]
hook_out: "Where is the hat?"
scenes:
  - id: s1
    type: comic
    cast: [duck]
    uses: [lx:behind#prep.location]
    setting: "@tag:office"
    panels:
      - shot: medium
        actors: ["@char:duck{expr=neutral}"]
        bubbles:
          - {speaker: duck, text: "Look behind the door."}
  - id: s2
    type: pick
    uses: [ck:where-is]
    evidence: {item: ck:where-is, type: recognition-4}
    question: "Where is the hat?"
    options:
      - {label: "Under the table.", correct: true}
      - {label: "On the table."}
      - {label: "In the sofa."}
      - {label: "Near the door."}
    feedback: {on_correct: "Good work.", on_wrong: "Look again."}
  - id: s3
    type: chat
    skin: messenger
    cast: [duck]
    messages:
      - {from: duck, text: "You found it."}
    reply:
      options:
        - {label: "It is under the table.", correct: true}
        - {label: "It is on the table."}
      on_correct: {from: duck, text: "Yes. Good."}
      on_wrong: {from: duck, text: "No. Look."}
`;

const PLAN_YAML = `
logline: "The duck looks for a lost hat."
channel: duck_detective
cast: [duck]
beats:
  - {n: 1, scene: comic, gist: "Duck looks behind the door."}
  - {n: 2, scene: pick, gist: "User answers a where-question."}
  - {n: 3, scene: chat, gist: "Duck chats with user."}
tropes: [literal_interpretation]
learning_placement:
  - {item: lx:behind#prep.location, beat: 1, as: exposure}
  - {item: ck:where-is, beat: 2, as: recognition-4}
hook_out: "Where is the hat?"
`;

const LEX: Record<string, string[]> = {
  'lx:behind#prep.location': ['behind'],
  'ck:where-is': ['where is', "where's", 'where are', 'where was', 'where were'],
};

function makeCtx(): ValidationContext {
  const allowed = new Set([
    'look', 'behind', 'the', 'door', 'where', 'is', 'hat', 'under', 'table', 'on', 'in', 'sofa',
    'near', 'good', 'work', 'it', 'you', 'found', 'again', 'yes', 'no', 'duck', 'am', 'my', 'a',
    'find', 'key', 'box', 'beside',
    ...Object.values(LEX).flat(),
  ]);
  return {
    vocab: { allowedForms: allowed, oovWarn: 0.02, oovBlock: 0.05, maxWordsPerLine: 12 },
    brief: {
      id: 'lb-0001',
      review: [{ item: 'ck:where-is', facet: 'meaning', minEvidence: 'recognition-4' }],
      expose: [{ item: 'lx:behind#prep.location' }],
      introduce: [],
      avoidBeforeTest: ['where is', "where's"],
    },
    lexicon: { formsOf: (i) => LEX[i], confusables: () => [] },
    assets: {
      emojis: new Set(['top_hat']),
      tags: new Set(['office']),
      chars: new Map([['duck', { expr: ['neutral', 'happy'], hat: ['none'], props_allowed: [] }]]),
    },
    entities: { exists: (id) => id === 'duck' },
    predicates: new Map([['role', { cardinality: 'single' }]]),
    canonFacts: [],
    activeFacts: [],
    threads: new Map(),
    exposureCounts: new Map(),
    channelIsImprov: false,
    recentSceneSequences: [],
    recentCastCounts: new Map(),
  };
}

function makeValidateEs() {
  return (text: string, enc: 'yaml' | 'json') => {
    const parsed = parseBatch(text, enc);
    if (!parsed.ok) return { ok: false, issues: parsed.issues };
    const report = validateBatch(parsed.batch, makeCtx());
    return { ok: report.ok, batch: parsed.batch, issues: report.issues };
  };
}

const TEMPLATES: PromptTemplates = {
  system: 'SYS',
  showrunner: 'SHOWRUNNER {{brief}} {{retry_note}}',
  writer: 'WRITER {{plan}}',
  single: 'SINGLE {{brief}}',
  repair: 'REPAIR {{problems}} {{scenes}}',
  judge: 'JUDGE',
};

function makeDeps(script: (stage: string, callIndex: Record<string, number>) => string): { deps: DirectorDeps; stub: StubLlmClient } {
  const counters: Record<string, number> = {};
  const stub = new StubLlmClient((req) => {
    counters[req.stage] = (counters[req.stage] ?? 0) + 1;
    return script(req.stage, counters);
  });  return {
    stub,
    deps: {
      llm: stub,
      templates: TEMPLATES,
      validateEs: makeValidateEs(),
      entityExists: (id) => id === 'duck',
      formsOf: (i) => LEX[i] ?? [],
    },
  };
}

const BRIEF: LearningBrief = {
  brief: 'lb-0001',
  level: 'A1+',
  introduce: [],
  expose: [{ item: 'lx:behind#prep.location', exposures_so_far: 0, need: 2 }],
  review: [{ item: 'ck:where-is', facet: 'meaning', min_evidence: 'recognition-4' }],
  vocab: { allowed_extra: ['hat', 'table'], max_words_per_line: 12, oov_budget: 0.02 },
  avoid_before_test: ['where is', "where's"],
};

describe('上下文组装器', () => {
  it('各块遵守预算并在超限时截断', () => {
    const long = 'x'.repeat(10_000);
    const { blocks, totalEstimatedTokens, anyTruncated } = assembleContext({
      system: 'SYS',
      channelBible: long,
      learnerProfile: 'p',
      brief: 'b',
      castFacts: 'f',
      openThreads: 't',
      recentSummary: 's',
      callback: 'c',
      tropeLedger: 'l',
      feedback: 'fb',
    });
    const bible = blocks.find((b) => b.name === 'channelBible')!;
    expect(bible.truncated).toBe(true);
    expect(bible.estimatedTokens).toBeLessThanOrEqual(DEFAULT_BUDGETS.channelBible + 1);
    expect(anyTruncated).toBe(true);
    expect(totalEstimatedTokens).toBeLessThan(4000);
  });
});

describe('梗台账', () => {
  it('重合率与禁止文本', () => {
    const ledger = new TropeLedger();
    ledger.add({ batch: 'b1', tropes: ['literal_interpretation', 'rule_loophole'], logline: 'L', sceneSequence: ['comic', 'pick'], cast: ['duck'] });
    expect(ledger.overlapRatio(['literal_interpretation'])).toBe(1);
    expect(ledger.overlapRatio(['brand_new_idea'])).toBe(0);
    expect(ledger.forbiddenText()).toContain('literal_interpretation');
    expect(ledger.recentSequences(5)).toEqual([['comic', 'pick']]);
  });
});

describe('编剧室预检', () => {
  const plan: ShowrunnerPlan = {
    logline: 'L',
    channel: 'duck_detective',
    cast: ['duck'],
    beats: [
      { n: 1, scene: 'comic', gist: 'Duck looks behind the door.' },
      { n: 2, scene: 'pick', gist: 'A where-question.' },
      { n: 3, scene: 'chat', gist: 'Chat.' },
    ],
    tropes: ['literal_interpretation'],
    learning_placement: [
      { item: 'lx:behind#prep.location', beat: 1, as: 'exposure' },
      { item: 'ck:where-is', beat: 2, as: 'recognition-4' },
    ],
    hook_out: 'Where is the hat?',
  };

  it('合格方案通过', () => {
    const check = precheckPlan({ plan, brief: BRIEF, ledger: new TropeLedger(), entityExists: (i) => i === 'duck', formsOf: (i) => LEX[i] ?? [] });
    expect(check.ok).toBe(true);
  });

  it('梗重合率超 1/3 被拒', () => {
    const ledger = new TropeLedger();
    ledger.add({ batch: 'b1', tropes: ['literal_interpretation'], logline: 'L', sceneSequence: ['x'], cast: [] });
    const check = precheckPlan({ plan, brief: BRIEF, ledger, entityExists: () => true, formsOf: (i) => LEX[i] ?? [] });
    expect(check.ok).toBe(false);
    expect(check.failures.some((f) => f.includes('重合率'))).toBe(true);
  });

  it('learning_placement 缺覆盖被拒', () => {
    const bad = { ...plan, learning_placement: plan.learning_placement.slice(0, 1) };
    const check = precheckPlan({ plan: bad, brief: BRIEF, ledger: new TropeLedger(), entityExists: () => true, formsOf: (i) => LEX[i] ?? [] });
    expect(check.failures.some((f) => f.includes('ck:where-is'))).toBe(true);
  });

  it('检测前的 gist 出现复习形式被拒（防启动粗查）', () => {
    const bad = { ...plan, beats: [{ n: 1, scene: 'comic' as const, gist: 'Where is my hat, asks duck.' }, ...plan.beats.slice(1)] };
    const check = precheckPlan({ plan: bad, brief: BRIEF, ledger: new TropeLedger(), entityExists: () => true, formsOf: (i) => LEX[i] ?? [] });
    expect(check.failures.some((f) => f.includes('提前出现'))).toBe(true);
  });
});

describe('导演编排（Stub LLM）', () => {
  const config = (over: Partial<DirectorConfig> = {}): DirectorConfig => ({
    mode: 'two-stage',
    encoding: 'yaml',
    showrunnerTier: 'fast',
    maxPrecheckRetries: 2,
    maxRepairRounds: 2,
    ...over,
  });

  it('两段式顺利路径：编剧室 → 分场 → 校验通过', async () => {
    const { deps } = makeDeps((stage) => (stage === 'showrunner' ? PLAN_YAML : GOOD_BATCH));
    const svc = new DirectorService(deps, config());
    const out = await svc.generate({
      batchId: 'tt-0001',
      channel: 'duck_detective',
      brief: BRIEF,
      ledger: new TropeLedger(),
      vars: {},
    });
    expect(out.batch).not.toBeNull();
    expect(out.plan?.logline).toContain('hat');
    expect(out.repairRounds).toBe(0);
    expect(out.calls.map((c) => c.stage)).toEqual(['showrunner', 'writer']);
  });

  it('预检失败自动重试一次后通过', async () => {
    const badPlan = PLAN_YAML.replace('tropes: [literal_interpretation]', 'tropes: [deadpan_escalation]');
    const ledger = new TropeLedger();
    ledger.add({ batch: 'prev', tropes: ['deadpan_escalation', 'absurd_client'], logline: 'L', sceneSequence: ['q'], cast: [] });
    // 第 1 次给会撞梗的方案，第 2 次给好方案
    const plans = [badPlan, PLAN_YAML];
    const { deps } = makeDeps((stage, counters) => {
      if (stage !== 'showrunner') return GOOD_BATCH;
      const idx = Math.min((counters.showrunner ?? 1) - 1, plans.length - 1);
      return plans[idx] ?? PLAN_YAML;
    });
    const svc = new DirectorService(deps, config());
    const out = await svc.generate({ batchId: 'tt-0002', channel: 'duck_detective', brief: BRIEF, ledger, vars: {} });
    expect(out.batch).not.toBeNull();
    expect(out.precheckRetries).toBe(1);
    expect(out.calls.filter((c) => c.stage === 'showrunner')).toHaveLength(2);
  });

  it('修复循环：首轮 E-PRIMED，修复场景后通过', async () => {
    const broken = GOOD_BATCH.replace('Look behind the door.', 'Where is my hat? Look behind the door.');
    const fixedScene = `
- id: s1
  type: comic
  cast: [duck]
  uses: [lx:behind#prep.location]
  setting: "@tag:office"
  panels:
    - shot: medium
      actors: ["@char:duck{expr=neutral}"]
      bubbles:
        - {speaker: duck, text: "Look behind the door."}
`;
    const { deps } = makeDeps((stage) => (stage === 'showrunner' ? PLAN_YAML : stage === 'writer' ? broken : fixedScene));
    const svc = new DirectorService(deps, config());
    const out = await svc.generate({ batchId: 'tt-0003', channel: 'duck_detective', brief: BRIEF, ledger: new TropeLedger(), vars: {} });
    expect(out.batch).not.toBeNull();
    expect(out.repairRounds).toBe(1);
    expect(out.calls.map((c) => c.stage)).toEqual(['showrunner', 'writer', 'repair']);
  });

  it('修复两轮仍失败：丢弃问题场景后 brief 仍覆盖则照常使用（V4）', async () => {
    // 4 场景版本，s4 的选项素材引用不存在的 emoji（E-ASSET-MISSING）；修复返回垃圾
    const withBadScene = GOOD_BATCH + `
  - id: s4
    type: pick
    question: "Find the key."
    options:
      - {label: "In the box.", asset: "@emoji:golden_key", correct: true}
      - {label: "On the box."}
    feedback: {on_correct: "Good.", on_wrong: "No."}
`;
    const { deps } = makeDeps((stage) => {
      if (stage === 'showrunner') return PLAN_YAML;
      if (stage === 'writer') return withBadScene;
      return '::: not a scene :::';
    });
    const svc = new DirectorService(deps, config());
    const out = await svc.generate({ batchId: 'tt-0004', channel: 'duck_detective', brief: BRIEF, ledger: new TropeLedger(), vars: {} });
    expect(out.batch).not.toBeNull();
    expect(out.droppedScenes).toEqual(['s4']);
    expect(out.batch!.scenes.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('丢弃后无法保底覆盖则整批失败', async () => {
    // 把唯一的复习场景 s2 弄坏（E-ANSWER-COUNT），修复给垃圾
    const broken = GOOD_BATCH.replace('- {label: "Under the table.", correct: true}', '- {label: "Under the table.", correct: true}\n      - {label: "Beside the table.", correct: true}');
    const { deps } = makeDeps((stage) => (stage === 'showrunner' ? PLAN_YAML : stage === 'writer' ? broken : 'garbage'));
    const svc = new DirectorService(deps, config());
    const out = await svc.generate({ batchId: 'tt-0005', channel: 'duck_detective', brief: BRIEF, ledger: new TropeLedger(), vars: {} });
    expect(out.batchFailed).toBe(true);
    expect(out.batch).toBeNull();
  });

  it('单段模式不调编剧室', async () => {
    const { deps } = makeDeps((stage) => {
      if (stage === 'single') return GOOD_BATCH;
      throw new Error(`不应调用 ${stage}`);
    });
    const svc = new DirectorService(deps, config({ mode: 'single' }));
    const out = await svc.generate({ batchId: 'tt-0006', channel: 'duck_detective', brief: BRIEF, ledger: new TropeLedger(), vars: {} });
    expect(out.batch).not.toBeNull();
    expect(out.calls.map((c) => c.stage)).toEqual(['single']);
  });
});
