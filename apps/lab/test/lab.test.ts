/** lab 集成测试：SQLite 存储、学习者模拟器、渲染器、端到端冒烟、指标。 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBatch, validateBatch } from '@endless/esl';
import { InMemoryWorldStore } from '@endless/world';
import { StubLlmClient } from '@endless/director';
import { loadLabData } from '../src/data.js';
import { SqliteWorldStore } from '../src/storage/sqlite.js';
import { LearnerSimulator, studyDayOf } from '../src/sim/learner.js';
import { makeStubScript, stubBatchYaml } from '../src/stub.js';
import { runExperiment } from '../src/pipeline.js';
import { renderBatch } from '../src/render.js';
import { compileBatch } from '@endless/esl';
import { smokeBrief } from '../src/smokebrief.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data');

describe('SQLite 存储', () => {
  it('与内存实现行为一致（实体/事实/事件/伏笔往返）', () => {
    const db = new SqliteWorldStore(':memory:');
    db.upsertEntity({ id: 'duck', kind: 'character', name: 'duck', home_channel: 'duck_detective', created_card: 0, bible_ref: null });
    expect(db.entityExists('duck')).toBe(true);
    expect(db.listEntities('duck_detective')).toHaveLength(1);
    const fact = db.insertFact({ subject: 'duck', predicate: 'role', object: 'detective', valid_from_card: 0, valid_to_card: null, recorded_card: 0, source_batch: 'bible', source_scene: null, standing: 'canon' });
    db.endFact(fact.id, 5);
    expect(db.currentFacts()).toHaveLength(0);
    expect(db.endedFacts('duck')).toHaveLength(1);
    const ev = db.insertEvent({ card: 3, batch: 'b1', channel: 'duck_detective', type: 'set_fact', actors: ['duck'], summary_en: 'duck role detective', user_choice: null, tags: ['x'] });
    expect(db.allEvents()[0]!.id).toBe(ev.id);
    expect(db.recentEvents({ limit: 1 })).toHaveLength(1);
    db.upsertThread({ id: 't1', title: 'T', status: 'open', owner_channel: 'duck_detective', opened_card: 1, last_touched_card: 1, priority: 2, setup: 'T', payoff_hint: null, expires_after_cards: 50 });
    expect(db.openThreads()).toHaveLength(1);
    expect(db.getThread('t1')?.status).toBe('open');
    db.insertUserFact({ predicate: 'rejected', object: 'cat', card: 2, batch: 'b1' });
    expect(db.userFacts('rejected')).toHaveLength(1);
    db.insertSummary({ channel: 'duck_detective', from_card: 0, to_card: 9, text: 's' });
    expect(db.latestSummary('duck_detective')?.text).toBe('s');
    db.close();
  });

  it('SQLite 与内存实现给出相同的检索结果', async () => {
    const { applyEffects } = await import('@endless/world');
    const predicates = new Map<string, { cardinality: 'single' | 'multi' }>([['role', { cardinality: 'single' }], ['suspect_status', { cardinality: 'single' }]]);
    const run = (store: InstanceType<typeof InMemoryWorldStore> | SqliteWorldStore) => {
      store.upsertEntity({ id: 'cat', kind: 'character', name: 'cat', home_channel: 'c', created_card: 0, bible_ref: null });
      applyEffects(store, [{ set_fact: { subject: 'cat', predicate: 'suspect_status', object: 'suspect', standing: 'stated' } }], { card: 5, batch: 'b', channel: 'c', predicates, canonLocked: [] });
      return { facts: store.currentFacts(['cat']).map((f) => f.object), events: store.allEvents().length };
    };
    const mem = run(new InMemoryWorldStore());
    const sql = run(new SqliteWorldStore(':memory:'));
    expect(sql).toEqual(mem);
  });
});

describe('学习者模拟器', () => {
  it('同种子同结果（可复现）', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'];
    const s1 = new LearnerSimulator('P1', 42);
    const s2 = new LearnerSimulator('P1', 42);
    s1.seedKnowledge(items);
    s2.seedKnowledge(items);
    const r1 = items.map((i) => s1.answer(i, 0.25, 10));
    const r2 = items.map((i) => s2.answer(i, 0.25, 10));
    expect(r1).toEqual(r2);
  });

  it('S_true 更新规则：成功增强、失败衰减、曝光微增', () => {
    const sim = new LearnerSimulator('P2', 1);
    sim.seedKnowledge(['x']);
    const before = sim.recall('x', 'meaning', 1);
    sim.settleCorrect('x');
    const afterCorrect = sim.recall('x', 'meaning', 1 + 1e-9); // 同日近似，强度已变
    expect(afterCorrect).toBeGreaterThanOrEqual(before);
    sim.settleWrong('x');
    const afterWrong = sim.recall('x', 'meaning', 1 + 2e-9);
    expect(afterWrong).toBeLessThanOrEqual(afterCorrect);
  });

  it('学习时钟：每 60 卡一个时段，时段间天数推进', () => {
    expect(studyDayOf(0)).toBe(0);
    expect(studyDayOf(59)).toBe(0);
    expect(studyDayOf(60)).toBe(1);
    expect(studyDayOf(120)).toBe(2);
    expect(studyDayOf(180)).toBe(4); // 1+1+2
    expect(studyDayOf(600)).toBe(16); // 1+1+2+1+3+1+1+4+1+1
  });
});

describe('Stub 批次对真实数据自校验', () => {
  it('5 个 stub 批次都能通过 lab 数据上下文的校验', async () => {
    const data = await loadLabData(DATA_DIR);
    const store = new InMemoryWorldStore();
    // 播种世界（与 pipeline 相同逻辑）
    for (const bible of data.channels.values()) {
      for (const c of bible.cast) store.upsertEntity({ id: c.id, kind: 'character', name: c.id, home_channel: bible.id, created_card: 0, bible_ref: null });
      for (const loc of bible.locations) store.upsertEntity({ id: loc, kind: 'location', name: loc, home_channel: bible.id, created_card: 0, bible_ref: null });
      for (const f of [
        ...bible.canon_locked.map((l) => l.split(/\s+/)),
        ...bible.cast.flatMap((c) => c.canon.map((k) => [c.id, ...k.split(/\s+/)])),
      ]) {
        if (f.length >= 3) {
          store.insertFact({ subject: f[0]!, predicate: f[1]!, object: f.slice(2).join(' '), valid_from_card: 0, valid_to_card: null, recorded_card: 0, source_batch: 'bible', source_scene: null, standing: 'canon' });
        }
      }
    }
    const { buildValidationContext } = await import('../src/data.js');
    const brief = smokeBrief();
    for (let n = 1; n <= 5; n++) {
      const parsed = parseBatch(stubBatchYaml(n), 'yaml');
      if (!parsed.ok) throw new Error(`stub 批次 ${n} 解析失败：${parsed.issues.map((i) => i.message).join('; ')}`);
      const ctx = buildValidationContext(data, {
        brief: {
          id: brief.brief,
          review: brief.review.map((r) => ({ item: r.item, facet: r.facet, minEvidence: r.min_evidence })),
          expose: brief.expose.map((e) => ({ item: e.item })),
          introduce: [],
          avoidBeforeTest: brief.avoid_before_test,
        },
        knownForms: new Set([...data.lexicon.functionWords, 'duck', 'cat', 'moon']),
        allowedExtra: brief.vocab.allowed_extra,
        entitiesExists: (id) => store.entityExists(id),
        canonFacts: store.currentFacts().filter((f) => f.standing === 'canon').map((f) => ({ subject: f.subject, predicate: f.predicate, object: f.object })),
        activeFacts: store.currentFacts().map((f) => ({ subject: f.subject, predicate: f.predicate, object: f.object, standing: f.standing })),
        threads: new Map(),
        channelIsImprov: false,
        maxWordsPerLine: 12,
      });
      // 本批目标形式要进允许词表
      for (const item of [brief.review.map((r) => r.item), brief.expose.map((e) => e.item)].flat()) {
        for (const f of data.lexicon.forms.get(item) ?? []) ctx.vocab.allowedForms.add(f);
      }
      const report = validateBatch(parsed.batch, ctx);
      const errors = report.issues.filter((i) => i.level === 'error');
      if (errors.length > 0) {
        throw new Error(`stub 批次 ${n} 校验失败：\n${errors.map((e) => `${e.code} ${e.scene ?? ''}: ${e.message}`).join('\n')}`);
      }
    }
  });
});

describe('渲染器', () => {
  it('渲染 stub 批次包含关键元素', async () => {
    const data = await loadLabData(DATA_DIR);
    const parsed = parseBatch(stubBatchYaml(1), 'yaml');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const ast = compileBatch(parsed.batch, {
      ok: true,
      issues: [],
      derivedEvidence: [],
      factRefs: 0,
      textUnits: [],
      targets: [],
      ink: new Map(),
      sceneSequence: [],
      vocab: { totalTokens: 0, oovTokens: 0, oovRatio: 0 },
    }, { lexicon: { formsOf: (i) => data.lexicon.forms.get(i), confusables: () => [] } });
    const md = renderBatch(parsed.batch, ast, data);
    expect(md).toContain('dd-9001');
    expect(md).toContain('hidden_object');
    expect(md).toContain('Where was your hat last night?');
    expect(md).toContain('🦆');
  });
});

describe('端到端冒烟（Stub 导演 5 批）', () => {
  it('生成 → 校验 → 模拟 → 结算 → 反馈 → 渲染 → 落盘全部走通', async () => {
    const data = await loadLabData(DATA_DIR);
    const outDir = await mkdtemp(join(tmpdir(), 'endless-smoke-'));
    const result = await runExperiment({
      data,
      store: new SqliteWorldStore(':memory:'),
      llm: new StubLlmClient(makeStubScript()),
      outDir,
      runId: 'smoke-test',
      batches: 5,
      persona: 'P1',
      seed: 42,
      director: 'two-stage',
      encoding: 'yaml',
      derive: true,
      worldState: true,
      tropeLedgerOn: true,
      strategy: 'S-B',
      feedbackLag: 2,
      channelOverride: 'duck_detective',
      briefOverrides: Array.from({ length: 5 }, () => smokeBrief()),
      smokeSeed: true,
    });
    const failed = result.records.filter((r) => r.batchFailed);
    if (failed.length > 0) {
      const first = failed[0]!;
      throw new Error(`批次失败：${first.issues.map((i) => `${i.code}: ${i.message}`).join(' | ')}`);
    }
    expect(result.totals.batchesOk).toBe(5);
    expect(result.totals.cards).toBeGreaterThan(15);
    expect(result.feedbacks).toHaveLength(5);
    // 世界状态被写入（伏笔与事实）
    expect(result.played.length).toBe(5);
    const files = await readdir(join(outDir, 'batches'));
    expect(files.filter((f) => f.endsWith('.esl.yaml'))).toHaveLength(5);
    const renders = await readdir(join(outDir, 'render'));
    expect(renders).toHaveLength(5);
    const feedback = (await readFile(join(outDir, 'feedback.jsonl'), 'utf8')).trim().split('\n');
    expect(feedback).toHaveLength(5);
    const calls = (await readFile(join(outDir, 'calls.jsonl'), 'utf8')).trim().split('\n');
    expect(calls.length).toBeGreaterThanOrEqual(10); // 5×(showrunner+writer)
    // FSRS 被写入（复习有评分）
    expect(result.srs.size()).toBeGreaterThan(0);
    // 台账记录了 5 批
    expect(result.ledgerEntries).toHaveLength(5);
  }, 60_000);

  it('失败批次也把首版问题单落盘（否则分不清「没救回」和「被重写改坏」）', async () => {
    const data = await loadLabData(DATA_DIR);
    const outDir = await mkdtemp(join(tmpdir(), 'endless-failed-'));
    const ok = makeStubScript();
    const broken = 'scenes: []\n';
    const result = await runExperiment({
      data,
      store: new SqliteWorldStore(':memory:'),
      // writer/repair 一律返回空批次，保证首轮就带阻塞错误、且重写也救不回来
      llm: new StubLlmClient((req, i) => (req.stage === 'writer' || req.stage === 'repair' ? broken : ok(req, i))),
      outDir,
      runId: 'failed-test',
      batches: 1,
      persona: 'P1',
      seed: 42,
      director: 'two-stage',
      encoding: 'yaml',
      derive: false,
      worldState: true,
      tropeLedgerOn: true,
      strategy: 'S-B',
      feedbackLag: 2,
      channelOverride: 'duck_detective',
      briefOverrides: [smokeBrief()],
      smokeSeed: true,
    });
    expect(result.records[0]!.batchFailed).toBe(true);
    const failed = JSON.parse(await readFile(join(outDir, 'batches', '0001.failed.json'), 'utf8')) as {
      firstDraftIssues?: { code: string; level: string }[];
    };
    expect(failed.firstDraftIssues?.length).toBeGreaterThan(0);
    expect(failed.firstDraftIssues?.some((i) => i.level === 'error')).toBe(true);
  }, 60_000);
});
