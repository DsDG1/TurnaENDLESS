/**
 * 实验 CLI（第 11 节）：apps/lab，用 tsx 运行。
 * 子命令：check / smoke / run / render / metrics / replay / srs-sim / buffer-sim
 * 用户传入或来自配置文件的路径一律经 safePath / safeChild / readValidated / writeValidated 守卫。
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';
import { z } from 'zod';
import { applyPatch, compileBatch, contentHash, parseBatch, patchLogLine, validateBatch } from '@endless/esl';
import { AiSdkLlmClient, StubLlmClient } from '@endless/director';
import type { LearningBrief } from '@endless/learning';
import { loadLabData } from './data.js';
import { loadBudgetConfig, loadModelsConfig, loadPricesConfig, loadRunConfig, resolveApiKey, type RunConfig } from './config.js';
import { runExperiment, RunAbortedError, type RunResult } from './pipeline.js';
import { renderBatch } from './render.js';
import { SqliteWorldStore } from './storage/sqlite.js';
import { makeStubScript } from './stub.js';
import { runSrsSim } from './srsim.js';
import { readReplayEvents, replayStrategies } from './srsreplay.js';
import { mulberry32 } from './sim/rng.js';
import { sweepBuffer } from './buffersim.js';
import { readLatencySummary } from './latency.js';
import { computeMetrics, metricsMarkdown } from './critic/metrics.js';
import { FileLlmCache } from './filecache.js';
import { safeChild, safePath, writeValidated } from './safepath.js';
import { smokeBrief } from './smokebrief.js';
import { runJudge, type JudgeVerdict } from './critic/judge.js';
import { buildReviewReport, parseRatingsCsv, ratingsTemplate } from './critic/review.js';
import { diffFrozen, driftReport, hashPrompts, manifestPath, nextVersion, readFrozen, writeFrozen } from './freeze.js';
import { computeDataFingerprint, diffFingerprint, fingerprintReport, type DataFingerprint } from './fingerprint.js';
import { auditChannelBibles, bibleAuditReport } from './bible-audit.js';
import { buildMetricsInput, readMetricsInput, toRunResult, writeMetricsInput } from './artifacts.js';
import { threadHygiene } from '@endless/world';

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
  console.log(
    `组件目录：场景 ${data.catalog.scenes.length} 类（写手可选 ${data.catalog.scenes.filter((s) => s.writer_selectable).length}）／effect ${data.catalog.effects.length} 种／素材类 ${data.catalog.assets.length} 类 ✅`,
  );
  // A3：圣经与素材清单对齐检查（建议级，只报不改，不影响退出码）
  for (const line of bibleAuditReport(auditChannelBibles(data))) console.log(line);
  console.log(`别名表：${data.aliases.size} 项（${[...data.aliases.entries()].map(([k, v]) => `${k}→${v.target}`).join(', ')}）`);
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
  await writeMetricsInput(outDir, buildMetricsInput(result, { threadHygiene: threadHygiene(store, result.totals.cards), card: result.totals.cards }));
  await writeValidated(safeChild(outDir, 'metrics.json', [RUNS_DIR], 'metrics'), [RUNS_DIR], 'metrics', JSON.stringify(metrics, null, 2));
  await writeValidated(safeChild(outDir, 'report.md', [RUNS_DIR], 'report'), [RUNS_DIR], 'report', metricsMarkdown(metrics));
  store.close();
  const okAll = result.records.every((r) => r.ok);
  console.log(`冒烟：${result.totals.batchesOk}/5 批通过，${result.totals.cards} 卡`);
  const l1 = metrics.learning.l1Coverage === null ? '不可判定' : `${(metrics.learning.l1Coverage * 100).toFixed(0)}%`;
  console.log(`V2 修复后通过率 ${(metrics.executability.v2AfterRepairRate * 100).toFixed(0)}%，L1 覆盖率 ${l1}，K5 ${metrics.cost.k5DerivationFactor.toFixed(2)} 卡/调用`);
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
): Promise<RunResult & { metricsWritten: boolean }> {
  const cfg = { ...(await loadRunConfig(configPath)), ...overrides };
  const data = await loadLabData(DATA_DIR);
  // run_id 来自配置文件，视为不受信输入：解析后必须仍在 runs/ 内
  const outDir = safeChild(runRoot, cfg.run_id, [RUNS_DIR], 'run_id');
  // 回放要从空世界重放：直接打开运行目录里的 world.sqlite 会带着原始运行结束时的状态，
  // 事实与伏笔全都在，校验必然大面积冲突（实测 20 批只剩 1 批通过）
  const store = new SqliteWorldStore(
    readOnlyCache ? ':memory:' : safeChild(outDir, 'world.sqlite', [RUNS_DIR], 'world 库'),
  );
  const llm = cfg.llm === 'stub' ? new StubLlmClient(makeStubScript()) : await makeLlm(readOnlyCache);
  const cache = new FileLlmCache(safeChild(outDir, 'cache', [RUNS_DIR], 'cache 目录'), readOnlyCache);
  const prices = await loadPricesConfig(join(CONFIG_DIR, 'prices.yaml'));
  const budget = await loadBudgetConfig(join(CONFIG_DIR, 'budget.yaml'));
  const budgetCircuit = budget.budget.run?.max_consecutive_failures;
  const rpm = budget.budget.llm?.requests_per_minute ?? 0;
  // 熔断后照原文重跑同一条命令即可：已完成的调用全部命中请求哈希缓存（A4）
  const resumeHint = `pnpm lab run --config ${relative(REPO_ROOT, configPath)} --persona ${cfg.persona}`;
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
    showrunnerTier: cfg.showrunner_tier,
    worldState: cfg.world_state,
    tropeLedgerOn: cfg.trope_ledger,
    channelWeights: cfg.channel_weights,
    strategy: cfg.strategy,
    feedbackLag: cfg.feedback_lag,
    smokeSeed: cfg.llm === 'stub',
    channelOverride: cfg.llm === 'stub' ? 'duck_detective' : undefined,
    briefOverrides: cfg.llm === 'stub' ? Array.from({ length: cfg.batches }, () => smokeBrief()) : undefined,
    verbose: cfg.llm !== 'stub',
    recordCalls: !readOnlyCache,
    oovWarn: cfg.oov_warn,
    oovBlock: cfg.oov_block,
    sessionWindow: cfg.session_window,
    sampling: cfg.sampling === true,
    maxConsecutiveTransportFailures: budgetCircuit,
    resumeHint,
    // A4 重试策略与 D1 配额：全部来自 config/budget.yaml，运行配置之外只此一处
    retry: {
      ...(budget.budget.llm?.retry?.max_attempts !== undefined ? { maxAttempts: budget.budget.llm.retry.max_attempts } : {}),
      ...(budget.budget.llm?.retry?.base_delay_ms !== undefined ? { baseDelayMs: budget.budget.llm.retry.base_delay_ms } : {}),
      ...(budget.budget.llm?.retry?.max_delay_ms !== undefined ? { maxDelayMs: budget.budget.llm.retry.max_delay_ms } : {}),
      ...(rpm > 0 ? { minIntervalMs: Math.ceil(60_000 / rpm) } : {}),
    },
    maxTokensPerBatch: budget.budget.llm?.max_tokens_per_batch ?? 0,
    maxTotalTokens: budget.budget.run?.max_total_tokens ?? 0,
  });
  const metrics = computeMetrics(result, {
    store,
    card: result.totals.cards,
    prices: { inputPerMtok: prices.prices.fast.input_per_mtok, outputPerMtok: prices.prices.fast.output_per_mtok },
    budgetPer100Cards: budget.budget.per_100_cards,
  });
  // C2：把「算指标需要的全部输入」落盘，之后 `lab metrics` 可以离线重算（删掉 cache/ 也不影响）
  if (!readOnlyCache) {
    const hygiene = threadHygiene(store, result.totals.cards);
    await writeMetricsInput(outDir, buildMetricsInput(result, { threadHygiene: hygiene, card: result.totals.cards }));
  }
  if (readOnlyCache) {
    // 回放全部命中缓存：token 与时延都是 0，不能覆盖首次运行记下的成本/时延
    const prevText = await readFile(safeChild(outDir, 'metrics.json', [RUNS_DIR], 'metrics'), 'utf8').catch(() => null);
    if (prevText) {
      try {
        const prev = JSON.parse(prevText) as { cost?: unknown; batches?: number };
        if (prev.cost) Object.assign(metrics, { cost: prev.cost });
        // 代码改动会改变请求哈希（例如分阶段输出上限），缓存不再命中 → 回放整批失败。
        // 这种情况绝不能把原来那份真实指标覆盖成 0，否则一次 `lab metrics` 就抹掉整轮数据。
        if (result.totals.batchesOk === 0 && (prev.batches ?? 0) > 0) {
          console.error(
            `回放没有通过任何批次（代码已改动，请求哈希与缓存不再匹配）：保留原 metrics.json（${prev.batches} 批）不覆盖。`,
          );
          console.error('需要重算指标时请用产生该运行的代码版本回放，或重跑一次。');
          store.close();
          return { ...result, metricsWritten: false };
        }
      } catch {
        // 旧指标文件损坏：保留本次回放结果即可
      }
    }
  }
  await writeValidated(safeChild(outDir, 'metrics.json', [RUNS_DIR], 'metrics'), [RUNS_DIR], 'metrics', JSON.stringify(metrics, null, 2));
  await writeValidated(safeChild(outDir, 'report.md', [RUNS_DIR], 'report'), [RUNS_DIR], 'report', metricsMarkdown(metrics));
  store.close();
  return { ...result, metricsWritten: true };
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
  // C2：原料指纹 —— 同一 run_id 不允许混两套数据/两版提示词，否则事后无法归因
  const fingerprint = await computeDataFingerprint(DATA_DIR);
  if (!arg('force')) {
    const prevFpText = await readFile(join(outDir, 'data-fingerprint.json'), 'utf8').catch(() => null);
    const prevPromptsText = await readFile(join(outDir, 'prompts.json'), 'utf8').catch(() => null);
    let blocked = false;
    if (prevFpText) {
      const before = JSON.parse(prevFpText) as DataFingerprint;
      const diff = diffFingerprint(before, fingerprint);
      if (!diff.same) {
        for (const line of fingerprintReport(before, diff)) console.error(line);
        blocked = true;
      }
    }
    if (prevPromptsText) {
      const prev = JSON.parse(prevPromptsText) as { combined?: string; frozenVersion?: string | null };
      if (prev.combined && prev.combined !== promptHashes.combined) {
        console.error(`提示词也变了（${prev.frozenVersion ?? '未知'} → ${frozen?.version ?? '未冻结'}），同一 run_id 不能混两版提示词。`);
        blocked = true;
      }
    }
    if (blocked) {
      console.error('换一个新的 run_id（推荐），或加 --force 覆盖（覆盖会让旧指标失去归因）。');
      process.exit(1);
    }
  }
  // --persona / --batches 覆盖配置文件：R0–R5 每个配置 × 3 个画像共用一份配置
  const persona = arg('persona');
  const overrides: Partial<RunConfig> = {
    batches: argInt('batches', cfg.batches),
    ...(persona ? { persona: persona as RunConfig['persona'] } : {}),
  };
  if (persona && !['P1', 'P2', 'P3'].includes(persona)) {
    console.error(`--persona 只能是 P1/P2/P3，收到 ${persona}`);
    process.exit(1);
  }
  const cfgCopy = { ...cfg, ...overrides };
  await writeValidated(safeChild(outDir, 'config.yaml', [RUNS_DIR], 'config 副本'), [RUNS_DIR], 'config 副本', yamlStringify(cfgCopy));
  await writeValidated(
    safeChild(outDir, 'prompts.json', [RUNS_DIR], '提示词哈希'),
    [RUNS_DIR],
    '提示词哈希',
    JSON.stringify({ frozenVersion: frozen?.version ?? null, frozenAt: frozen?.frozen_at ?? null, ...promptHashes }, null, 2),
  );
  await writeValidated(
    safeChild(outDir, 'data-fingerprint.json', [RUNS_DIR], '原料指纹'),
    [RUNS_DIR],
    '原料指纹',
    JSON.stringify(fingerprint, null, 2),
  );
  const result = await executeRun(safeConfig, RUNS_DIR, false, overrides).catch((e: unknown) => {
    if (e instanceof RunAbortedError) {
      console.error(`\n⛔ 跑批已熔断：${e.message}`);
      if (e.resumeHint) {
        console.error(`续跑命令（已完成的调用全部命中请求哈希缓存，不会重复付费）：`);
        console.error(`  ${e.resumeHint}`);
      }
      process.exit(1);
    }
    throw e;
  });
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
  if (result.totals.batchesOk === 0) {
    console.error(`回放没有通过任何批次（0/${result.records.length}）：当前代码的请求哈希与该次运行的缓存不匹配。`);
    process.exitCode = 1;
    return;
  }
  console.log(`回放完成：${result.totals.batchesOk}/${result.records.length} 批（全部命中响应缓存）`);
}

async function cmdMetrics(): Promise<void> {
  const runDir = process.argv[3];
  if (!runDir) {
    console.error('用法：lab metrics <runDir>（优先离线重算，缺产物时回放缓存）');
    process.exit(1);
  }
  const safeRun = safePath(repoPath(runDir), [RUNS_DIR], 'runDir');
  // C2：优先读运行结束时的落盘输入离线重算 —— 不再依赖响应缓存，代码改过也能复算
  const persisted = await readMetricsInput(safeRun);
  if (persisted) {
    const prices = await loadPricesConfig(join(CONFIG_DIR, 'prices.yaml'));
    const budget = await loadBudgetConfig(join(CONFIG_DIR, 'budget.yaml'));
    const metrics = computeMetrics(toRunResult(persisted), {
      threadHygiene: persisted.threadHygiene,
      card: persisted.card,
      prices: { inputPerMtok: prices.prices.fast.input_per_mtok, outputPerMtok: prices.prices.fast.output_per_mtok },
      budgetPer100Cards: budget.budget.per_100_cards,
    });
    await writeValidated(safeChild(safeRun, 'metrics.json', [RUNS_DIR], 'metrics'), [RUNS_DIR], 'metrics', JSON.stringify(metrics, null, 2));
    await writeValidated(safeChild(safeRun, 'report.md', [RUNS_DIR], 'report'), [RUNS_DIR], 'report', metricsMarkdown(metrics));
    console.log(`指标已按落盘产物离线重算（${persisted.records.length} 批，不需要响应缓存）：`);
    console.log(`  ${safeChild(safeRun, 'metrics.json', [RUNS_DIR], 'metrics')}`);
    console.log('  report.md');
    return;
  }
  console.warn('没有 artifacts/metrics-input.json（旧运行）：退回缓存回放，代码改动会导致全部未命中。');
  const configPath = safeChild(safeRun, 'config.yaml', [RUNS_DIR], 'run 配置');
  const result = await executeRun(configPath, RUNS_DIR, true);
  if (!result.metricsWritten) {
    console.error('回放未通过任何批次：已保留原 metrics.json 与 report.md（原因见上）。');
    process.exitCode = 1;
    return;
  }
  console.log(`指标已写入 ${safeChild(safeRun, 'metrics.json', [RUNS_DIR], 'metrics')} 与 report.md`);
}

/**
 * C1：把一个 ESL 批次按补丁改值，重新校验后写出新版本（带 parent_hash）。
 * 用法：lab patch <batch.esl.yaml> <patch.yaml> [-o out.yaml]
 * 补丁格式：
 *   - {path: "scenes[s1].setting", value: "@tag:living_room", note: "apartment 别名"}
 *   - {path: "batch.cast", value: [duck, delivery_mouse]}
 * 口径：人工补丁属于人工干预，不计入 V2（CLI 会明确打出来）。
 */
async function cmdPatch(): Promise<void> {
  const input = process.argv[3];
  const patchFile = process.argv[4];
  if (!input || !patchFile) {
    console.error('用法：lab patch <batch.esl.yaml> <patch.yaml> [-o out.yaml]');
    process.exit(1);
  }
  const outIdx = process.argv.indexOf('-o');
  const data = await loadLabData(DATA_DIR);
  const { readValidated, safeChild } = await import('./safepath.js');
  const parsed = parseBatch(await readValidated(input, [REPO_ROOT], 'input'), 'yaml');
  if (!parsed.ok) {
    console.error(parsed.issues.map((i) => `${i.code}: ${i.message}`).join('\n'));
    process.exit(1);
  }
  const rawPatches = parseYaml(await readValidated(patchFile, [REPO_ROOT], 'patch')) as unknown;
  const list = z
    .array(z.object({ op: z.literal('replace').optional(), path: z.string(), value: z.unknown(), note: z.string().optional() }))
    .parse(Array.isArray(rawPatches) ? rawPatches : (rawPatches as { patches?: unknown }).patches);
  const parentHash = contentHash(parsed.batch);
  const outcome = applyPatch(parsed.batch, list);
  for (const a of outcome.applied) console.log(patchLogLine(a));
  for (const r of outcome.rejected) console.error(`拒绝 ${r.path}（${r.cls}）：${r.reason}`);
  if (outcome.rejected.length > 0) {
    console.error('补丁未全部应用：一个都没写出去（宁可什么都不改，也不要半改的批次）');
    process.exit(1);
  }

  // text 类补丁会动台词，必须重跑校验：词汇/OOV/uses 定位都可能随之变化
  const properNouns = [...data.channels.values()].flatMap((b) => [...b.cast.map((c) => c.id), ...b.locations]);
  const allowed = new Set<string>([...data.lexicon.functionWords, ...properNouns.map((n) => n.toLowerCase())]);
  for (const forms of data.lexicon.forms.values()) for (const f of forms) allowed.add(f);
  const report = validateBatch(outcome.batch, {
    vocab: { allowedForms: allowed, oovWarn: 0.08, oovBlock: 0.25, maxWordsPerLine: 999 },
    lexicon: { formsOf: (i) => data.lexicon.forms.get(i), confusables: (i) => data.lexicon.entries.get(i)?.confusables ?? [] },
    assets: data.assetCatalog,
    entities: { exists: () => true },
    predicates: data.predicates,
    canonFacts: [],
    activeFacts: [],
    threads: new Map(),
  });
  const blocking = report.issues.filter((i) => i.level === 'error');
  if (!report.ok) {
    console.error(`补丁后校验未通过（${blocking.length} 个阻断问题）：`);
    for (const i of blocking) console.error(`  ${i.code}${i.scene ? `@${i.scene}` : ''}: ${i.message}`);
    process.exit(1);
  }
  const newHash = contentHash(outcome.batch);
  const outPath = outIdx > 0 ? process.argv[outIdx + 1]! : input.replace(/\.esl\.yaml$|\.yaml$/, '.patched.yaml');
  await writeFile(safeChild(REPO_ROOT, outPath, [REPO_ROOT], 'patch-out'), yamlStringify(outcome.batch));
  await writeFile(
    safeChild(REPO_ROOT, `${outPath}.versions.json`, [REPO_ROOT], 'patch-out'),
    JSON.stringify({ batchId: outcome.batch.batch, parentHash, newHash, applied: outcome.applied }, null, 2),
  );
  console.log(`补丁 ${outcome.applied.length} 处，校验通过；parent ${parentHash} → ${newHash}`);
  console.log(`已写出 ${outPath}（人工干预批次，不计入 V2）`);
}

/**
 * D2 成对盲评：同一序号、同一画像的两批输出，去标签后随机左右，评审人只回答「哪一批更想看下一批」。
 * 用法：lab render --pair <runA> <runB> [-n 15 --seed 7 -o runs/pairs]
 *
 * 为什么成对而不是 5 分制：评审人只有 2–3 人（方案 §10 自己写了统计力弱），
 * 成对比较的符号检验比绝对打分敏感得多。5 分制保留，成对结果作为 RQ1 的补充证据。
 * 键文件单独写，评审时不给评审人看。
 */
async function cmdPair(): Promise<void> {
  const i = process.argv.indexOf('--pair');
  const runA = process.argv[i + 1];
  const runB = process.argv[i + 2];
  if (!runA || !runB) {
    console.error('用法：lab render --pair <runA> <runB> [-n 15 --seed 7 -o OUTDIR]');
    process.exit(1);
  }
  // 允许写 `smoke`（runs 下的目录名）或完整相对路径 `apps/lab/runs/smoke`
  const runDir = (p: string) => (isAbsolute(p) || p.includes('/') || p.includes('\\') ? repoPath(p) : join(RUNS_DIR, p));
  const dirA = safePath(runDir(runA), [RUNS_DIR], 'runA');
  const dirB = safePath(runDir(runB), [RUNS_DIR], 'runB');
  // `-n` 与 `--n` 都认：手敲命令时短横线更顺手
  const shortN = process.argv.indexOf('-n');
  const n = shortN > 0 ? Number(process.argv[shortN + 1]) || 15 : argInt('n', 15);
  const seed = argInt('seed', 7);
  const outDir = safePath(repoPath(arg('out') ?? join(RUNS_DIR, 'pairs')), [RUNS_DIR], '--out');
  await mkdir(outDir, { recursive: true });

  const listOf = async (dir: string): Promise<Map<number, string>> => {
    const map = new Map<number, string>();
    for (const f of await readdir(join(dir, 'render'))) {
      const m = /^([0-9]+)\.md$/.exec(f);
      if (m) map.set(Number(m[1]), join(dir, 'render', f));
    }
    return map;
  };
  const a = await listOf(dirA);
  const b = await listOf(dirB);
  const common = [...a.keys()].filter((k) => b.has(k)).sort((x, y) => x - y);
  if (common.length === 0) {
    console.error('两个 run 没有可配对的批次（先各自跑一遍 `lab run`）');
    process.exit(1);
  }
  const rng = mulberry32(seed);
  const picked = [...common];
  // 洗牌后取前 n 对：评审人看不到序号顺序带来的偏好
  for (let j = picked.length - 1; j > 0; j--) {
    const k = Math.floor(rng() * (j + 1));
    [picked[j], picked[k]] = [picked[k]!, picked[j]!];
  }
  const key: { pair: number; seq: number; left: string; right: string }[] = [];
  const chosen = picked.slice(0, n).sort((x, y) => x - y);
  for (let idx = 0; idx < chosen.length; idx++) {
    const seq = chosen[idx]!;
    const leftIsA = rng() < 0.5;
    const left = await readFile(leftIsA ? a.get(seq)! : b.get(seq)!, 'utf8');
    const right = await readFile(leftIsA ? b.get(seq)! : a.get(seq)!, 'utf8');
    const name = `pair-${String(idx + 1).padStart(2, '0')}`;
    const body = [
      `# 对照稿 ${idx + 1}（批次序号已隐藏）`,
      '',
      '> 只回答一个问题：**哪一稿更让你想看下一批？**（允许平局）',
      '',
      '## 稿 A',
      '',
      stripRunLabels(left),
      '',
      '---',
      '',
      '## 稿 B',
      '',
      stripRunLabels(right),
      '',
    ].join('\n');
    await writeValidated(safeChild(outDir, `${name}.md`, [RUNS_DIR], 'pair'), [RUNS_DIR], 'pair', body);
    key.push({ pair: idx + 1, seq, left: leftIsA ? runA : runB, right: leftIsA ? runB : runA });
  }
  await writeValidated(
    safeChild(outDir, 'pair-key.json', [RUNS_DIR], 'pair-key'),
    [RUNS_DIR],
    'pair-key',
    JSON.stringify({ seed, pairs: key }, null, 2),
  );
  console.log(`已生成 ${chosen.length} 对盲评稿：${outDir}`);
  console.log('评审人只写「A / B / 平」；键文件 pair-key.json 不要给评审人看。');
  console.log(`汇总时用符号检验（平局按 0.5 计）：A 胜 ${'#'} 次、B 胜 ${'#'} 次 —— 键文件里有左右对应。`);
}

/** 去标签：输出里出现的 run_id、批次 id 前缀一律抹掉，避免评审人靠编号猜版本。 */
function stripRunLabels(text: string): string {
  return text
    .replace(/^# .*$/gm, (line) => line.replace(/(r[0-9a-z-]+|20[0-9]{2}[-_][0-9]{2}[-_][0-9]{2})/gi, '××'))
    .replace(/\bb-[0-9]{4}\b/g, 'b-××××');
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
  // S-R 回放（第 7.2 节第二条腿）：在真实运行产出上重放三种策略
  const runDirArg = arg('run-dir');
  if (runDirArg) {
    const dir = safePath(repoPath(runDirArg), [RUNS_DIR], '--run-dir');
    const { events, batches } = await readReplayEvents(dir);
    const report = replayStrategies(events, ['S-A', 'S-B', 'S-C'], batches);
    const tag = relative(RUNS_DIR, dir).replace(/[\\/]/g, '-');
    const outDir = safePath(repoPath(arg('out') ?? join(RUNS_DIR, `srs-replay-${tag}`)), [RUNS_DIR], '--out');
    await mkdir(outDir, { recursive: true });
    await writeValidated(
      safeChild(outDir, 'srs-replay.json', [RUNS_DIR], 'srs-replay 结果'),
      [RUNS_DIR],
      'srs-replay 结果',
      JSON.stringify({ run: tag, batches: report.batches, events: report.events, items: report.items, days: report.days, byStrategy: report.byStrategy }, null, 2),
    );
    await writeValidated(safeChild(outDir, 'report.md', [RUNS_DIR], 'srs-replay 报告'), [RUNS_DIR], 'srs-replay 报告', report.markdown);
    console.log(report.markdown);
    console.log(`\n产物：${outDir}`);
    if (report.events === 0) process.exitCode = 1;
    return;
  }
  const report = runSrsSim({
    items: argInt('items', 300),
    days: argInt('days', 60),
    // 方案 7.2：5 个种子；种子太少时校准误差的均值会被单次抽样左右
    seeds: argInt('seeds', 5),
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
  // 生成侧时延（第 5.13 节）：优先用实测分布，其次手传 --gen-ms，最后才是 20s 假设值
  const fromRun = arg('from-run');
  let genSamples: number[] | undefined;
  let latencySource: string | undefined;
  let genMedianMs = argInt('gen-ms', 20_000);
  if (fromRun) {
    const dir = safePath(repoPath(fromRun), [RUNS_DIR], '--from-run');
    const summary = await readLatencySummary(dir);
    genSamples = summary.batches;
    genMedianMs = Math.round(summary.p50BatchMs);
    latencySource = `${relative(REPO_ROOT, join(dir, 'calls.jsonl'))}（P50 ${(summary.p50BatchMs / 1000).toFixed(1)}s，P95 ${(summary.p95BatchMs / 1000).toFixed(1)}s，${summary.meanCallsPerBatch.toFixed(1)} 次调用/批）`;
  } else if (process.argv.includes('--gen-ms')) {
    latencySource = '--gen-ms 手传';
  }
  // B3：派生填空（每批可派生张数）；D1：并发与速率取同一份 budget.yaml，避免两处配置打架
  const derivePerBatch = argInt('derive-fill', 0);
  // 每批卡数（K5 的另一种表达）：K4 的量级账靠它，能在不改代码的前提下试「每批 12 卡」
  const cardsPerBatch = argInt('cards-per-batch', 4);
  const budget = await loadBudgetConfig(join(CONFIG_DIR, 'budget.yaml'));
  const concurrencyArg = argInt('concurrent', 0);
  const concurrent = (concurrencyArg > 0 ? concurrencyArg : (budget.budget.run?.concurrency ?? 1)) >= 2 ? 2 : 1;
  const { markdown } = sweepBuffer({
    buffers,
    prefetched,
    persona,
    genMedianMs,
    derivePerBatch,
    concurrent,
    cardsPerBatch,
    ...(genSamples ? { genSamples } : {}),
    ...(latencySource ? { latencySource } : {}),
  });
  const outDir = safePath(repoPath(arg('out') ?? join(RUNS_DIR, fromRun ? `buffer-sim-${fromRun.split('/').pop()}` : 'buffer-sim')), [RUNS_DIR], '--out');
  await mkdir(outDir, { recursive: true });
  await writeValidated(safeChild(outDir, 'report.md', [RUNS_DIR], 'buffer-sim 报告'), [RUNS_DIR], 'buffer-sim 报告', markdown);
  console.log(markdown);
  console.log(`\n产物：${outDir}`);
}

/**
 * 人工评分表聚合（方案 7.4 / 9.1 的人工阈值）。
 * 用法：
 *   lab review --ratings ratings.csv [--judge RUN] [-o runs/review]
 *   lab review --template --batches 60 --raters alice,bob [-o runs/review]
 */
async function cmdReview(): Promise<void> {
  const outDir = safePath(repoPath(arg('out') ?? join(RUNS_DIR, 'review')), [RUNS_DIR], '--out');
  await mkdir(outDir, { recursive: true });
  const judgeArg = arg('judge');
  const judgeDir = judgeArg ? safePath(repoPath(judgeArg), [RUNS_DIR], '--judge') : undefined;

  if (arg('template')) {
    const raters = (arg('raters') ?? 'rater1,rater2').split(',').map((s) => s.trim()).filter(Boolean);
    const csv = ratingsTemplate({
      batches: argInt('batches', 60),
      raters,
      dimensions: ['want_next', 'fun', 'natural_english', 'drill_feel', 'consistency', 'comprehensible'],
    });
    const path = safeChild(outDir, 'ratings-template.csv', [RUNS_DIR], '评分表模板');
    await writeValidated(path, [RUNS_DIR], '评分表模板', csv);
    console.log(`已写出评分表模板：${path}`);
    console.log('填完用 lab review --ratings <该文件> 汇总（batch 列写渲染稿序号，0001 → 1）。');
    return;
  }

  const ratingsPath = arg('ratings');
  if (!ratingsPath) {
    console.error('用法：lab review --ratings ratings.csv [--judge RUN] [-o OUT]');
    console.error('  或：lab review --template --batches 60 --raters alice,bob');
    process.exit(1);
  }
  const { readValidated } = await import('./safepath.js');
  const parsed = parseRatingsCsv(await readValidated(repoPath(ratingsPath), [REPO_ROOT], '--ratings'));
  if (parsed.rows.length === 0) {
    console.error(`评分表没有可用数据行：${parsed.errors.join('；') || '（空表）'}`);
    process.exit(1);
  }
  let judge: JudgeVerdict[] | undefined;
  if (judgeDir) {
    const text = await readFile(join(judgeDir, 'judge', 'judge.jsonl'), 'utf8').catch(() => null);
    if (text === null) {
      console.error(`没有 ${relative(REPO_ROOT, join(judgeDir, 'judge', 'judge.jsonl'))}：先跑 lab judge 才能算校准 ρ。`);
      process.exit(1);
    }
    judge = text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as JudgeVerdict);
  }
  const report = buildReviewReport(parsed, judge ? { judge } : {});
  await writeValidated(safeChild(outDir, 'review.json', [RUNS_DIR], 'review 结果'), [RUNS_DIR], 'review 结果', JSON.stringify(report, null, 2));
  await writeValidated(safeChild(outDir, 'report.md', [RUNS_DIR], 'review 报告'), [RUNS_DIR], 'review 报告', report.markdown);
  console.log(report.markdown);
  console.log(`\n产物：${outDir}`);
}

async function cmdJudge(): Promise<void> {  const runDir = process.argv[3];
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
  // promptfoo 断言入口：校验一段 ESL 文本（文件或 stdin），通过退出码 0，否则 1。
  // 阈值与 allowed_extra 可用参数覆盖：矩阵要按运行配置（run-*.yaml 的 oov_warn/oov_block）
  // 判，否则默认 2%/5% 会把「批本身合规、只是词表比流水线窄」的批次误判成失败。
  const file = arg('file');
  const oovWarn = Number(arg('oov-warn', '0.02'));
  const oovBlock = Number(arg('oov-block', '0.05'));
  const maxWords = Number(arg('max-words', '12'));
  const allowedExtra = (arg('allowed-extra', '') ?? '')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
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
  for (const w of allowedExtra) allowed.add(w);
  const report = validateBatch(parsed.batch, {
    vocab: { allowedForms: allowed, oovWarn, oovBlock, maxWordsPerLine: maxWords },
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
      if (process.argv.includes('--pair')) await cmdPair();
      else await cmdRender();
      break;
    case 'patch':
      await cmdPatch();
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
    case 'review':
      await cmdReview();
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
      console.log('  lab render --pair A B         D2 成对盲评稿（去标签、随机左右，键文件单独写）');
      console.log('  lab patch BATCH PATCHFILE     套补丁改值（locked 字段会被拒绝），重新校验后写新版本');
      console.log('  lab metrics RUNDIR            重算指标（基于响应缓存回放）');
      console.log('  lab replay RUNDIR             从缓存回放整个运行');
      console.log('  lab judge RUNDIR              LLM 评审（需 API key；先校准再参与判定）');
      console.log('  lab review --ratings CSV [--judge RUN]   人工评分汇总：α / ρ / 41–60 批均分 / N5 / L5');
      console.log('  lab review --template --batches 60        导出评分表模板（每评审一行一批）');
      console.log('  lab srs-sim [--items N --days N --seeds N]   证据策略对照（S-A/S-B/S-C，合成事件流，不调 LLM）');
      console.log('  lab srs-sim --run-dir RUN        在真实运行产出上回放三种策略（S-R，读 feedback.jsonl）');
      console.log('  lab buffer-sim [--buffer 1,2,3 --prefetched 0,3,5 --derive-fill N]  卡顿概率矩阵（K4，N 张/批 = B3 派生填空）');
      console.log('  lab buffer-sim --from-run RUN     用该运行 calls.jsonl 的实测时延分布算 K4（推荐，别用 20s 默认值）');
      if (cmd !== undefined) process.exit(1);
  }
}

await main();
