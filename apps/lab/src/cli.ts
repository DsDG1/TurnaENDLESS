/**
 * 实验 CLI（第 11 节）：apps/lab，用 tsx 运行。
 * 子命令：check / smoke / run / render / metrics / replay / srs-sim / buffer-sim
 * 用户传入或来自配置文件的路径一律经 safePath / safeChild / readValidated / writeValidated 守卫。
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { compileBatch, parseBatch, validateBatch } from '@endless/esl';
import { AiSdkLlmClient, StubLlmClient } from '@endless/director';
import type { LearningBrief } from '@endless/learning';
import { loadLabData } from './data.js';
import { loadBudgetConfig, loadModelsConfig, loadPricesConfig, loadRunConfig, resolveApiKey, type RunConfig } from './config.js';
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
import { diffFrozen, driftReport, hashPrompts, manifestPath, nextVersion, readFrozen, writeFrozen } from './freeze.js';

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

/** 用户给的路径：绝对路径原样用，相对路径按仓库根解析。
 * `pnpm -C apps/lab` 会把 cwd 换到 apps/lab，所以不能依赖 cwd（README 里的示例都是仓库根相对路径）。 */
const repoPath = (p: string): string => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));

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
  // 冻结纪律（第 8 节）：check 是 CI 入口，提示词漂移必须让检查失败，否则冻结形同虚设
  const frozen = await readFrozen(DATA_DIR);
  if (!frozen) {
    console.warn('提示词尚未冻结（缺 data/prompts/FROZEN）；试跑前先 `lab freeze` 建立基线。');
  } else {
    const drift = diffFrozen(frozen, await hashPrompts(DATA_DIR));
    if (!drift.same) {
      for (const line of driftReport(frozen, drift)) console.error(line);
      console.error('先 `lab freeze`（版本递增）再跑批，旧 run_id 不可覆盖。');
      process.exitCode = 1;
      return;
    }
    console.log(`提示词与冻结版本 ${frozen.version} 一致 ✅`);
  }
  console.log('全部数据文件通过格式校验 ✅');
}

/** 冻结当前提示词内容（第 8 节）：写 data/prompts/FROZEN，版本号默认自动递增。 */
async function cmdFreeze(): Promise<void> {
  const label = arg('label');
  const version = label ?? (await nextVersion(DATA_DIR));
  const manifest = await writeFrozen(DATA_DIR, version);
  console.log(`提示词已冻结：${version}（${manifest.frozen_at}）`);
  console.log(`  清单：${relative(REPO_ROOT, manifestPath(DATA_DIR))}`);
  for (const [name, hash] of Object.entries(manifest.files)) {
    console.log(`  ${name.padEnd(10)} ${hash === 'missing' ? '⚠ 文件缺失' : hash.slice(0, 16)}`);
  }
  console.log(`  合并哈希 ${manifest.combined.slice(0, 16)}`);
  console.log('提示：此后改任何提示词都要重新 freeze 并换新 run_id。');
}

async function cmdSmoke(): Promise<void> {
  const data = await loadLabData(DATA_DIR);
  const outDir = safePath(repoPath(arg('out') ?? join(RUNS_DIR, 'smoke')), [RUNS_DIR], '--out');
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

async function makeLlm(allowMissingKey = false): Promise<AiSdkLlmClient | StubLlmClient> {
  const models = await loadModelsConfig(join(CONFIG_DIR, 'models.yaml'));
  const key = resolveApiKey(models);
  if (!key && !allowMissingKey) {
    console.error(`缺少环境变量 ${models.provider.api_key_env}（API key 只从环境变量读取）。冒烟请用 lab smoke。`);
    process.exit(1);
  }
  if (!key) {
    // 回放/重算指标只读缓存，不需要 key；缓存未命中时会因缺 key 报错，提示足够明确
    console.warn(`回放模式：未设置 ${models.provider.api_key_env}，只读缓存；缓存未命中的批次会失败。`);
  }
  return new AiSdkLlmClient({
    baseURL: models.provider.base_url,
    apiKey: key,
    providerName: models.provider.name,
    models: models.models,
    reasoningEffort: models.provider.reasoning_effort,
    timeoutMs: models.provider.timeout_ms,
  });
}

async function executeRun(
  configPath: string,
  runRoot: string,
  readOnlyCache: boolean,
  overrides: Partial<RunConfig> = {},
): Promise<RunResult> {
  const cfg = { ...(await loadRunConfig(configPath)), ...overrides };
  const data = await loadLabData(DATA_DIR);
  // run_id 来自配置文件，视为不受信输入：解析后必须仍在 runs/ 内
  const outDir = safeChild(runRoot, cfg.run_id, [RUNS_DIR], 'run_id');
  const store = new SqliteWorldStore(safeChild(outDir, 'world.sqlite', [RUNS_DIR], 'world 库'));
  const llm = cfg.llm === 'stub' ? new StubLlmClient(makeStubScript()) : await makeLlm(readOnlyCache);
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
    verbose: cfg.llm !== 'stub',
    recordCalls: !readOnlyCache,
    oovWarn: cfg.oov_warn,
    oovBlock: cfg.oov_block,
  });
  const prices = await loadPricesConfig(join(CONFIG_DIR, 'prices.yaml'));
  const budget = await loadBudgetConfig(join(CONFIG_DIR, 'budget.yaml'));
  const metrics = computeMetrics(result, {
    store,
    card: result.totals.cards,
    prices: { inputPerMtok: prices.prices.fast.input_per_mtok, outputPerMtok: prices.prices.fast.output_per_mtok },
    budgetPer100Cards: budget.budget.per_100_cards,
  });
  if (readOnlyCache) {
    // 回放全部命中缓存：token 与时延都是 0，不能覆盖首次运行记下的成本/时延
    const prevText = await readFile(safeChild(outDir, 'metrics.json', [RUNS_DIR], 'metrics'), 'utf8').catch(() => null);
    if (prevText) {
      try {
        const prev = JSON.parse(prevText) as { cost?: unknown };
        if (prev.cost) Object.assign(metrics, { cost: prev.cost });
      } catch {
        // 旧指标文件损坏：保留本次回放结果即可
      }
    }
  }
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
  const safeConfig = safePath(repoPath(configPath), [REPO_ROOT], '--config');
  const cfg = await loadRunConfig(safeConfig);
  // 冻结纪律（第 8 节）：提示词漂移时拒绝跑批，否则同一个 run_id 会混入不同提示词
  const frozen = await readFrozen(DATA_DIR);
  const promptHashes = await hashPrompts(DATA_DIR);
  if (frozen) {
    const drift = diffFrozen(frozen, promptHashes);
    if (!drift.same) {
      for (const line of driftReport(frozen, drift)) console.error(line);
      console.error('确认要改提示词：先 `lab freeze`（版本递增）并换新的 run_id。');
      process.exit(1);
    }
  } else {
    console.warn('提示词尚未冻结（无 data/prompts/FROZEN）：本次运行记录当前哈希，但后续改动无法追溯。建议先 `lab freeze`。');
  }
  const outDir = safeChild(RUNS_DIR, cfg.run_id, [RUNS_DIR], 'run_id');
  for (const sub of ['batches', 'render', 'cache']) {
    await mkdir(safeChild(outDir, sub, [RUNS_DIR], 'run 子目录'), { recursive: true });
  }
  const overrides = { batches: argInt('batches', cfg.batches) };
  const cfgCopy = { ...cfg, ...overrides };
  await writeValidated(safeChild(outDir, 'config.yaml', [RUNS_DIR], 'config 副本'), [RUNS_DIR], 'config 副本', yamlStringify(cfgCopy));
  await writeValidated(
    safeChild(outDir, 'prompts.json', [RUNS_DIR], '提示词哈希'),
    [RUNS_DIR],
    '提示词哈希',
    JSON.stringify({ frozenVersion: frozen?.version ?? null, frozenAt: frozen?.frozen_at ?? null, ...promptHashes }, null, 2),
  );
  const result = await executeRun(safeConfig, RUNS_DIR, false, overrides);
  console.log(`运行 ${cfg.run_id}：${result.totals.batchesOk}/${result.records.length} 批通过，${result.totals.cards} 卡，${result.totals.calls} 次 LLM 调用`);
  console.log(`产物：${outDir}`);
}

async function cmdReplay(): Promise<void> {
  const runDir = process.argv[3];
  if (!runDir) {
    console.error('用法：lab replay <runDir>');
    process.exit(1);
  }
  const safeRun = safePath(repoPath(runDir), [RUNS_DIR], 'runDir');
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
  const safeRun = safePath(repoPath(runDir), [RUNS_DIR], 'runDir');
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
  const outDir = safePath(repoPath(arg('out') ?? join(RUNS_DIR, 'srs-sim')), [RUNS_DIR], '--out');
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
  const outDir = safePath(repoPath(arg('out') ?? join(RUNS_DIR, 'buffer-sim')), [RUNS_DIR], '--out');
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
  const safeRun = safePath(repoPath(runDir), [RUNS_DIR], 'runDir');
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
    ? await (await import('./safepath.js')).readValidated(repoPath(file), [REPO_ROOT], '--file')
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
    case 'freeze':
      await cmdFreeze();
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
      console.log('  lab check                     校验全部数据文件（含提示词冻结漂移）');
      console.log('  lab freeze [--label vN]       冻结当前提示词内容为 vN（默认自动递增）');
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
