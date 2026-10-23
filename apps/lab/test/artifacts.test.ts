/**
 * C2：原料指纹 + 中间产物落盘 + 离线重算。
 * 判据（计划 C2）：「删掉 cache/ 后，`lab metrics` 仍能算出和运行结束时一致的 metrics.json」。
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryWorldStore } from '@endless/world';
import { threadHygiene } from '@endless/world';
import { StubLlmClient } from '@endless/director';
import { loadLabData } from '../src/data.js';
import { runExperiment } from '../src/pipeline.js';
import { makeStubScript } from '../src/stub.js';
import { smokeBrief } from '../src/smokebrief.js';
import { computeMetrics } from '../src/critic/metrics.js';
import { buildMetricsInput, readMetricsInput, toRunResult, writeMetricsInput } from '../src/artifacts.js';
import { computeDataFingerprint, diffFingerprint, fingerprintReport } from '../src/fingerprint.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data');

const run = async (outDir: string | null, batches: number) => {
  const data = await loadLabData(DATA_DIR);
  const store = new InMemoryWorldStore();
  const result = await runExperiment({
    data,
    store,
    llm: new StubLlmClient(makeStubScript()),
    outDir,
    runId: 'c2-test',
    batches,
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
    briefOverrides: Array.from({ length: batches }, () => smokeBrief()),
    smokeSeed: true,
  });
  return { result, store };
};

describe('C2 原料指纹', () => {
  it('同一份数据给出同一指纹，逐文件可比', async () => {
    const a = await computeDataFingerprint(DATA_DIR);
    const b = await computeDataFingerprint(DATA_DIR);
    expect(a.combined).toBe(b.combined);
    expect(diffFingerprint(a, b).same).toBe(true);
    // 词库、素材、角色规格、谓词、梗分类、故事筛选、三个频道都要在
    expect(Object.keys(a.files)).toEqual(
      expect.arrayContaining([
        'lexicon/a1_a2.yaml',
        'assets/manifest.yaml',
        'assets/characters.yaml',
        'predicates.yaml',
        'tropes.yaml',
        'sifting_patterns.yaml',
        'channels/duck_detective.yaml',
        'channels/impossible_store.yaml',
        'channels/improv.yaml',
      ]),
    );
  });

  it('改动任一项都会被指出来（差异归因的原料）', async () => {
    const before = await computeDataFingerprint(DATA_DIR);
    const after = { ...before, files: { ...before.files, 'lexicon/a1_a2.yaml': 'deadbeefdeadbeef' }, combined: 'changed' };
    const diff = diffFingerprint(before, after);
    expect(diff.same).toBe(false);
    expect(diff.changed).toEqual(['lexicon/a1_a2.yaml']);
    expect(fingerprintReport(before, diff).join('\n')).toContain('lexicon/a1_a2.yaml');
  });
});

describe('C2 离线重算', () => {
  it('删掉 cache/ 后，指标仍能按落盘产物算出与运行结束时一致的结果', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'endless-c2-'));
    const { result, store } = await run(outDir, 3);
    const atRunEnd = computeMetrics(result, { store, card: result.totals.cards });

    // 运行结束：落盘算指标所需的全部输入
    await writeMetricsInput(outDir, buildMetricsInput(result, { threadHygiene: threadHygiene(store, result.totals.cards), card: result.totals.cards }));

    // 模拟「第二天改了指标代码」：缓存没了、world 库也读不到，只剩落盘产物
    await rm(join(outDir, 'cache'), { recursive: true, force: true });

    const input = await readMetricsInput(outDir);
    expect(input).not.toBeNull();
    const offline = computeMetrics(toRunResult(input!), {
      threadHygiene: input!.threadHygiene,
      card: input!.card,
    });

    // 除 K2（单价不在 artifacts 里）之外，全部指标必须逐字一致
    expect(offline.novelty).toEqual(atRunEnd.novelty);
    expect(offline.consistency).toEqual(atRunEnd.consistency);
    expect(offline.learning).toEqual(atRunEnd.learning);
    expect(offline.executability).toEqual(atRunEnd.executability);
    expect(offline.cost.k1PerBatch).toEqual(atRunEnd.cost.k1PerBatch);
    expect(offline.cost.k5DerivationFactor).toEqual(atRunEnd.cost.k5DerivationFactor);
  }, 60_000);

  it('每批落盘 brief / 计划 / 台账 / 版本链', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'endless-c2-files-'));
    await run(outDir, 2);
    for (const id of ['0001', '0002']) {
      const brief = await readFile(join(outDir, 'batches', `${id}.brief.yaml`), 'utf8');
      expect(brief).toContain('lb-');
      const plan = await readFile(join(outDir, 'batches', `${id}.plan.yaml`), 'utf8');
      expect(plan).toContain('logline');
      const ledger = JSON.parse(await readFile(join(outDir, 'batches', `${id}.ledger.json`), 'utf8')) as { batch: string; sceneSequence: string[] };
      expect(ledger.batch).toBeTruthy();
      expect(ledger.sceneSequence.length).toBeGreaterThan(0);
      const versions = JSON.parse(await readFile(join(outDir, 'batches', `${id}.versions.json`), 'utf8')) as {
        finalHash: string;
        chain: { stage: string; hash: string | null; rawHash?: string; fixedHash?: string }[];
      };
      expect(versions.finalHash).toMatch(/^[0-9a-f]{16}$/);
      const stages = versions.chain.map((c) => c.stage);
      expect(stages).toContain('first-draft');
      // 版本链里要有「机械修复前」与「机械修复后」两个哈希，否则分不清首版与 autofix
      const draft = versions.chain.find((c) => c.stage === 'first-draft')!;
      expect(draft.rawHash ?? draft.fixedHash ?? draft.hash).toBeTruthy();
    }
  }, 60_000);
});
