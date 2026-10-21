/**
 * 实验 CLI（第 11 节）：apps/lab，用 tsx 运行。
 * 子命令：check / smoke / run / render / metrics / replay / srs-sim / buffer-sim
 * 用户传入或来自配置文件的路径一律经 safePath / safeChild / readValidated / writeValidated 守卫。
 */
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { compileBatch, parseBatch, validateBatch } from '@endless/esl';
import { AiSdkLlmClient, StubLlmClient } from '@endless/director';
import type { LearningBrief } from '@endless/learning';
import { loadLabData } from './data.js';
import { loadBudgetConfig, loadModelsConfig, loadPricesConfig, loadRunConfig, resolveApiKey } from './config.js';
import { runExperiment, type RunResult } from './pipeline.js';
import { renderBatch } from './render.js';
import { SqliteWorldStore } from './storage/sqlite.js';
import { makeStubScript } from './stub.js';
import { runSrsSim } from './srsim.js';
import { sweepBuffer } from './buffersim.js';
import { computeMetrics, metricsMarkdown } from './critic/metrics.js';
import { FileLlmCache } from './filecache.js';
import { safeChild, safePath, writeValidated } from './safepath.js';
import { smokeBrief } from './smokebrief.js';
import { runJudge } from './critic/judge.js';

const HERE = import.meta.dirname; // apps/lab/src
const LAB_ROOT = resolve(HERE, '..');
const DATA_DIR = join(LAB_ROOT, 'data');
const CONFIG_DIR = join(LAB_ROOT, 'config');
const RUNS_DIR = join(LAB_ROOT, 'runs');
const REPO_ROOT = resolve(LAB_ROOT, '..', '..');

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}
const argInt = (name: string, fallback: number): number => Number(arg(name, String(fallback)));

async function cmdCheck(): Promise<void> {
  const data = await loadLabData(DATA_DIR);
  if (data.lexiconIssues.length > 0) {
    console.error('词库格式校验未通过：');
    for (const i of data.lexiconIssues) console.error(`- ${i.item ?? ''} ${i.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`词库：${data.lexicon.entries.size} 条（${[...data.lexicon.entries.values()].filter((e) => e.kind === 'sense').length} 词义 / ${[...data.lexicon.entries.values()].filter((e) => e.kind === 'chunk').length} 词块 / ${[...data.lexicon.entries.values()].filter((e) => e.kind === 'pattern').length} 句型），功能词 ${data.lexicon.functionWords.size} 个 ✅`);
  console.log(`频道：${[...data.channels.keys()].join(' / ')} ✅`);
  console.log(`素材：emoji ${data.glyphs.size} 个，标签 ${data.assetTags.size} 个，背景 ${data.backgrounds.size} 个（含位置表） ✅`);
  console.log(`角色规格：${[...data.charSpecs.keys()].join(' / ')} ✅`);
  console.log(`谓词 ${data.predicates.size} 个；梗分类 ${data.tropes.length} 项；故事筛选 ${data.sifting.length} 模式 ✅`);
  console.log(`提示词：${Object.keys(data.prompts).join(' / ')} ✅`);
  console.log('全部数据文件通过格式校验 ✅');
}

async function cmdSmoke(): Promise<void> {
  const data = await loadLabData(DATA_DIR);
  const outDir = safePath(arg('out') ?? join(RUNS_DIR, 'smoke'), [RUNS_DIR], '--out');
  for (const sub of ['batches', 'render']) {
    await mkdir(safeChild(outDir, sub, [RUNS_DIR], 'smoke 子目录'), { recursive: true });
  }
  // 冒烟总是从全新世界开始
  await rm(safeChild(outDir, 'world.sqlite', [RUNS_DIR], 'world 库'), { force: true });
  const store = new SqliteWorldStore(safeChild(outDir, 'world.sqlite', [RUNS_DIR], 'world 库'));
  const stub = new StubLlmClient(makeStubScript());
  const result = await runExperiment({
    data,
    store,
    llm: stub,
    outDir,
    runId: 'smoke',
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
  const metrics = computeMetrics(result, { store, card: result.totals.cards });
  await writeValidated(safeChild(outDir, 'metrics.json', [RUNS_DIR], 'metrics'), [RUNS_DIR], 'metrics', JSON.stringify(metrics, null, 2));
  await writeValidated(safeChild(outDir, 'report.md', [RUNS_DIR], 'report'), [RUNS_DIR], 'report', metricsMarkdown(metrics));
  store.close();
  const okAll = result.records.every((r) => r.ok);
  console.log(`冒烟：${result.totals.batchesOk}/5 批通过，${result.totals.cards} 卡`);
  console.log(`V2 修复后通过率 ${(metrics.executability.v2AfterRepairRate * 100).toFixed(0)}%，L1 覆盖率 ${(metrics.learning.l1Coverage * 100).toFixed(0)}%，K5 ${metrics.cost.k5DerivationFactor.toFixed(2)} 卡/调用`);
  console.log(`产物：${outDir}`);
  if (!okAll) {
    console.error('存在失败批次 ❌');
    process.exitCode = 1;
  } else {
    console.log('冒烟通过 ✅');
  }
}

async function makeLlm(): Promise<AiSdkLlmClient | StubLlmClient> {
  const models = await loadModelsConfig(join(CONFIG_DIR, 'models.yaml'));
  const key = resolveApiKey(models);
  if (!key) {
    console.error(`缺少环境变量 ${models.provider.api_key_env}（API key 只从环境变量读取）。冒烟请用 lab smoke。`);
    process.exit(1);
  }
  return new AiSdkLlmClient({
    baseURL: models.provider.base_url,
    apiKey: key,
    providerName: models.provider.name,
    models: models.models,
  });
}

async function executeRun(configPath: string, runRoot: string, readOnlyCache: boolean): Promise<RunResult> {
  const cfg = await loadRunConfig(configPath);
  const data = await loadLabData(DATA_DIR);
  // run_id 来自配置文件，视为不受信输入：解析后必须仍在 runs/ 内
  const outDir = safeChild(runRoot, cfg.run_id, [RUNS_DIR], 'run_id');
  const store = new SqliteWorldStore(safeChild(outDir, 'world.sqlite', [RUNS_DIR], 'world 库'));
  const llm = cfg.llm === 'stub' ? new StubLlmClient(makeStubScript()) : await makeLlm();
  const cache = new FileLlmCache(safeChild(outDir, 'cache', [RUNS_DIR], 'cache 目录'), readOnlyCache);
  const result = await runExperiment({
    data,
    store,
    llm,
    cache,
    outDir,
    runId: cfg.run_id,
    batches: cfg.batches,
    persona: cfg.persona,
    seed: cfg.seed,
    director: cfg.director,
    encoding: cfg.encoding,
    derive: cfg.derive,
    worldState: cfg.world_state,
    tropeLedgerOn: cfg.trope_ledger,
    strategy: cfg.strategy,
    feedbackLag: cfg.feedback_lag,
    smokeSeed: cfg.llm === 'stub',
    channelOverride: cfg.llm === 'stub' ? 'duck_detective' : undefined,
    briefOverrides: cfg.llm === 'stub' ? Array.from({ length: cfg.batches }, () => smokeBrief()) : undefined,
  });
  const prices = await loadPricesConfig(join(CONFIG_DIR, 'prices.yaml'));
  const budget = await loadBudgetConfig(join(CONFIG_DIR, 'budget.yaml'));
  const metrics = computeMetrics(result, {
    store,
    card: result.totals.cards,
    prices: { inputPerMtok: prices.prices.fast.input_per_mtok, outputPerMtok: prices.prices.fast.output_per_mtok },
    budgetPer100Cards: budget.budget.per_100_cards,
  });
  await writeValidated(safeChild(outDir, 'metrics.json', [RUNS_DIR], 'metrics'), [RUNS_DIR], 'metrics', JSON.stringify(metrics, null, 2));
  await writeValidated(safeChild(outDir, 'report.md', [RUNS_DIR], 'report'), [RUNS_DIR], 'report', metricsMarkdown(metrics));
  store.close();
  return result;
}

async function cmdRun(): Promise<void> {
  const configPath = arg('config');
  if (!configPath) {
    console.error('用法：lab run --config <run config yaml> [--batches N]');
    process.exit(1);
  }
  const safeConfig = safePath(configPath, [REPO_ROOT], '--config');
  const cfg = await loadRunConfig(safeConfig);
  const outDir = safeChild(RUNS_DIR, cfg.run_id, [RUNS_DIR], 'run_id');
  for (const sub of ['batches', 'render', 'cache']) {
    await mkdir(safeChild(outDir, sub, [RUNS_DIR], 'run 子目录'), { recursive: true });
  }
  const cfgCopy = { ...cfg, batches: argInt('batches', cfg.batches) };
  await writeValidated(safeChild(outDir, 'config.yaml', [RUNS_DIR], 'config 副本'), [RUNS_DIR], 'config 副本', yamlStringify(cfgCopy));
  const result = await executeRun(safeConfig, RUNS_DIR, false);
  console.log(`运行 ${cfg.run_id}：${result.totals.batchesOk}/${result.records.length} 批通过，${result.totals.cards} 卡，${result.totals.calls} 次 LLM 调用`);
  console.log(`产物：${outDir}`);
}

async function cmdReplay(): Promise<void> {
  const runDir = process.argv[3];
  if (!runDir) {
    console.error('用法：lab replay <runDir>');
    process.exit(1);
  }
  const safeRun = safePath(runDir, [RUNS_DIR], 'runDir');
  const configPath = safeChild(safeRun, 'config.yaml', [RUNS_DIR], 'run 配置');
  const result = await executeRun(configPath, RUNS_DIR, true);
  console.log(`回放完成：${result.totals.batchesOk}/${result.records.length} 批（全部命中响应缓存）`);
}

async function cmdMetrics(): Promise<void> {
  const runDir = process.argv[3];
  if (!runDir) {
    console.error('用法：lab metrics <runDir>（基于缓存回放重算）');
    process.exit(1);
  }
  const safeRun = safePath(runDir, [RUNS_DIR], 'runDir');
  const configPath = safeChild(safeRun, 'config.yaml', [RUNS_DIR], 'run 配置');
  await executeRun(configPath, RUNS_DIR, true);
  console.log(`指标已写入 ${safeChild(safeRun, 'metrics.json', [RUNS_DIR], 'metrics')} 与 report.md`);
}

async function cmdRender(): Promise<void> {
  const input = process.argv[3];
  if (!input) {
    console.error('用法：lab render <batch.esl.yaml> [-o out.md]');
    process.exit(1);
  }
  const data = await loadLabData(DATA_DIR);
  const { readValidated } = await import('./safepath.js');
  const parsed = parseBatch(await readValidated(input, [REPO_ROOT], 'input'), 'yaml');
  if (!parsed.ok) {
    console.error(parsed.issues.map((i) => `${i.code}: ${i.message}`).join('\n'));
    process.exit(1);
  }
  const properNouns = [...data.channels.values()].flatMap((b) => [...b.cast.map((c) => c.id), ...b.locations]);
  const allowed = new Set<string>([...data.lexicon.functionWords, ...properNouns.map((n) => n.toLowerCase())]);
  for (const forms of data.lexicon.forms.values()) for (const f of forms) allowed.add(f);
  const report = validateBatch(parsed.batch, {
    vocab: { allowedForms: allowed, oovWarn: 1, oovBlock: 1, maxWordsPerLine: 999 },
    lexicon: { formsOf: (i) => data.lexicon.forms.get(i), confusables: (i) => data.lexicon.entries.get(i)?.confusables ?? [] },
    assets: data.assetCatalog,
    entities: { exists: () => true },
    predicates: data.predicates,
    canonFacts: [],
    activeFacts: [],
    threads: new Map(),
  });
  const ast = compileBatch(parsed.batch, report, {
    lexicon: { formsOf: (i) => data.lexicon.forms.get(i), confusables: (i) => data.lexicon.entries.get(i)?.confusables ?? [] },
  });
  const md = renderBatch(parsed.batch, ast, data);
  const out = arg('o');
  if (out) {
    await writeValidated(out, [REPO_ROOT], '-o', md);
    console.log(`已写入 ${out}`);
  } else {
    console.log(md);
  }
  if (!report.ok) {
    console.error(`⚠ 校验有 ${report.issues.filter((i) => i.level === 'error').length} 个阻断级问题（渲染仍完成）`);
  }
}

async function cmdSrsSim(): Promise<void> {
  const report = runSrsSim({
    items: argInt('items', 300),
    days: argInt('days', 60),
    seeds: argInt('seeds', 2),
  });
  const outDir = safePath(arg('out') ?? join(RUNS_DIR, 'srs-sim'), [RUNS_DIR], '--out');
  await mkdir(outDir, { recursive: true });
  await writeValidated(safeChild(outDir, 'srs-sim.json', [RUNS_DIR], 'srs-sim 结果'), [RUNS_DIR], 'srs-sim 结果', JSON.stringify({ options: report.options, byStrategy: report.byStrategy }, null, 2));
  await writeValidated(safeChild(outDir, 'report.md', [RUNS_DIR], 'srs-sim 报告'), [RUNS_DIR], 'srs-sim 报告', report.markdown);
  console.log(report.markdown);
  console.log(`\n产物：${outDir}`);
}

async function cmdBufferSim(): Promise<void> {
  const buffers = (arg('buffer') ?? '1,2,3').split(',').map(Number);
  const prefetched = (arg('prefetched') ?? '0,3,5').split(',').map(Number);
  const persona = (arg('persona') ?? 'P1') as 'P1' | 'P2' | 'P3';
  const genMedianMs = argInt('gen-ms', 20_000);
  const { markdown } = sweepBuffer({ buffers, prefetched, persona, genMedianMs });
  const outDir = safePath(arg('out') ?? join(RUNS_DIR, 'buffer-sim'), [RUNS_DIR], '--out');
  await mkdir(outDir, { recursive: true });
  await writeValidated(safeChild(outDir, 'report.md', [RUNS_DIR], 'buffer-sim 报告'), [RUNS_DIR], 'buffer-sim 报告', markdown);
  console.log(markdown);
  console.log(`\n产物：${outDir}`);
}

async function cmdJudge(): Promise<void> {
  const runDir = process.argv[3];
  if (!runDir) {
    console.error('用法：lab judge <runDir>（LLM 评审，需 API key）');
    process.exit(1);
  }
  const safeRun = safePath(runDir, [RUNS_DIR], 'runDir');
  const verdicts = await runJudge(safeRun, 'premium');
  const parsed = verdicts.filter((v) => !v.parseError);
  const contradictions = parsed.reduce((s, v) => s + (v.contradictions?.length ?? 0), 0);
  const meanScore = (key: string) => {
    const vals = parsed.map((v) => v.scores?.[key]).filter((x): x is number => typeof x === 'number');
    return vals.length ? (vals.reduce((s, x) => s + x, 0) / vals.length).toFixed(2) : '—';
  };
  console.log(`评审 ${verdicts.length} 批（解析成功 ${parsed.length}）`);
  console.log(`want_next 均分 ${meanScore('want_next')}｜fun ${meanScore('fun')}｜drill_feel ${meanScore('drill_feel')}｜consistency ${meanScore('consistency')}`);
  console.log(`疑似矛盾 ${contradictions} 条（须人工确认并核对 fact_id）`);
  console.log('注意：评审模型须先在人工盲评样本上校准（ρ ≥ 0.5），未校准前只作参考。');
}

async function cmdAssert(): Promise<void> {
  // promptfoo 断言入口：校验一段 ESL 文本（文件或 stdin），通过退出码 0，否则 1
  const file = arg('file');
  const text = file
    ? await (await import('./safepath.js')).readValidated(file, [REPO_ROOT], '--file')
    : await new Promise<string>((resolveStdin) => {
        let buf = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => (buf += c));
        process.stdin.on('end', () => resolveStdin(buf));
      });
  const data = await loadLabData(DATA_DIR);
  const parsed = parseBatch(text, data ? (text.trimStart().startsWith('{') ? 'json' : 'yaml') : 'yaml');
  if (!parsed.ok) {
    console.error(parsed.issues.map((i) => `${i.code}: ${i.message}`).join('\n'));
    process.exit(1);
  }
  const properNouns = [...data.channels.values()].flatMap((b) => [...b.cast.map((c) => c.id), ...b.locations]);
  const allowed = new Set<string>([...data.lexicon.functionWords, ...properNouns.map((n) => n.toLowerCase())]);
  for (const forms of data.lexicon.forms.values()) for (const f of forms) allowed.add(f);
  const report = validateBatch(parsed.batch, {
    vocab: { allowedForms: allowed, oovWarn: 0.02, oovBlock: 0.05, maxWordsPerLine: 12 },
    lexicon: { formsOf: (i) => data.lexicon.forms.get(i), confusables: (i) => data.lexicon.entries.get(i)?.confusables ?? [] },
    assets: data.assetCatalog,
    entities: { exists: () => true },
    predicates: data.predicates,
    canonFacts: [],
    activeFacts: [],
    threads: new Map(),
  });
  if (!report.ok) {
    console.error(report.issues.filter((i) => i.level === 'error').map((i) => `${i.code} ${i.scene ?? ''}: ${i.message}`).join('\n'));
    process.exit(1);
  }
  console.log(`OK ${parsed.batch.batch}（${report.issues.filter((i) => i.level === 'warning').length} 条建议级）`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'check':
      await cmdCheck();
      break;
    case 'smoke':
      await cmdSmoke();
      break;
    case 'run':
      await cmdRun();
      break;
    case 'render':
      await cmdRender();
      break;
    case 'metrics':
      await cmdMetrics();
      break;
    case 'replay':
      await cmdReplay();
      break;
    case 'judge':
      await cmdJudge();
      break;
    case 'assert':
      await cmdAssert();
      break;
    case 'srs-sim':
      await cmdSrsSim();
      break;
    case 'buffer-sim':
      await cmdBufferSim();
      break;
    default:
      console.log('ENDLESS 实验 CLI（exp-00）');
      console.log('  lab check                     校验全部数据文件');
      console.log('  lab smoke [--out DIR]         Stub 导演 5 批端到端冒烟（无需 API key）');
      console.log('  lab run --config FILE         按运行配置跑批（需 API key；config/run-example.yaml 为模板）');
      console.log('  lab render FILE [-o OUT]      渲染一个 ESL 批次为 Markdown');
      console.log('  lab metrics RUNDIR            重算指标（基于响应缓存回放）');
      console.log('  lab replay RUNDIR             从缓存回放整个运行');
      console.log('  lab judge RUNDIR              LLM 评审（需 API key；先校准再参与判定）');
      console.log('  lab srs-sim [--items N --days N --seeds N]   证据策略对照（S-A/S-B/S-C，不调 LLM）');
      console.log('  lab buffer-sim [--buffer 1,2,3 --prefetched 0,3,5]  卡顿概率矩阵（K4）');
      if (cmd !== undefined) process.exit(1);
  }
}

await main();
