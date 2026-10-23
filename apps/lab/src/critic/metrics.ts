/**
 * Critic 程序指标（第 6 节中能自动计算的部分）：
 * N1–N4 新颖度、C1/C2 一致性、L1–L3 学习、V1–V5 可执行性、K1/K2/K3/K5 成本延迟。
 * 人工评分项（N5、L4、L5、C3、C1 的人工确认部分）与 LLM 评审不在此处。
 */
import { detectionAmbiguity, tokenize, EVIDENCE_RANK } from '@endless/esl';
import { threadHygiene, type WorldStore } from '@endless/world';
import { contentCoverage, TEST_ANGLES } from '../sampler.js';
import type { RunResult } from '../pipeline.js';
import { percentile } from '../sim/rng.js';

export interface MetricsJson {
  runId: string;
  batches: number;
  novelty: {
    /** 每批梗概新颖度曲线（1 − max cos 相对最近 W 批） */
    n1: number[];
    /** 梗复用率（第 21 批起） */
    n2Mean: number;
    n3SequenceRepeatRate: number;
    /** 每 10 批一桶的 distinct-2 */
    n4Buckets: number[];
  };
  consistency: {
    /** 事实引用总数（C1 分母，程序可判部分） */
    factRefs: number;
    /** 校验器 E-FACT-CONFLICT 出现次数（修复后仍残留的按 0 计） */
    eFactConflicts: number;
    /** C1 程序部分（人工确认部分另行相加） */
    c1Program: number | null;
    c2ThreadHygiene: ReturnType<typeof threadHygiene> | null;
    /**
     * 世界状态改变（审计 §3）：生效 effect 总数、零改变批次数。
     * 这一块不是 9.1 的阈值，而是「R1–R5 到底有没有和 R0 差别」的前提读数：
     * 20 批真实产出曾出现 0 次 effects，世界库除种子 canon 外全空，C1/C2/C3 全部无材料。
     */
    worldChange: { ops: number; batchesWithout: number; ratio: number };
  };
  learning: {
    /** L1：有合格证据的到期复习 / 到期复习总数。分母为 0 时是 null（不可判定），不是 1.0 */
    l1Coverage: number | null;
    /** 到期复习总数（L1 的分母）—— 为 0 时 L1 达标与否无从谈起 */
    reviewTotal: number;
    /** L2：类似检测交互中证据合格的比例。没有检测交互时是 null */
    l2QualifiedRatio: number | null;
    /** 检测交互总数（L2 的分母） */
    evidenceTotal: number;
    /** L3：每批 OOV 中位数与 P95 */
    l3Oov: { median: number; p95: number };
    /**
     * L4 歧义率（程序口径部分）：结构性歧义场景 / 检测场景。
     * rate 为 null 表示本运行没有检测场景（不可判定），不是「0% 达标」。
     */
    l4: { detectionScenes: number; ambiguousScenes: number; rate: number | null; examples: string[] };
    /** 学习层供给：有多少批真的带检测场景（20o 实测 2/18） */
    detection: { batchesWithDetection: number; batchesPlayed: number; ratio: number };
  };
  executability: {
    v1FirstPassRate: number;
    /** 模型原始首轮零错误（未经机械修复） */
    v0RawFirstPassRate: number;
    v2AfterRepairRate: number;
    v3AvgRepairRounds: number;
    v4SceneDropRate: number;
    v5Revalidation: { checked: number; regenerated: number };
    /** 重写/修复的净效果：首版带阻塞错误的批次里救回多少、丢掉多少 */
    rewriteEffect: { firstDraftDirty: number; recovered: number; lost: number; cleanButFailed: number };
    /** 传输失败（E-TRANSPORT）批次：V2 分母剔除，单列失败率（A4） */
    transport: { failed: number; rate: number; retries: number; incompleteCalls: number; evaluableBatches: number };
    /**
     * 名字出路（A2）：首版里被别名表救回的名字数、靠别名解析的 needs 项数、受影响批次。
     * 这三个数只作归因用 —— V0 仍是「别名命中前」口径，别名替换不许把 V0 抬虚。
     */
    alias: { hits: number; needs: number; batchesWithHits: number };
  };
  cost: {
    /** K1：每批 / 每卡 token（按阶段拆分见 calls.jsonl） */
    k1PerBatch: { input: number; output: number };
    k1PerCard: { input: number; output: number };
    /** K2：每 100 张卡成本（美元，按 prices.yaml；单价未填时为 0，此时 K2 不可判定） */
    k2Per100Cards: number;
    /** prices.yaml 是否给出了非零单价；false 时 K2 不参与阈值判定 */
    pricesConfigured: boolean;
    /** K3：每批时延 P50/P95（毫秒） */
    k3BatchLatency: { p50: number; p95: number };
    /** K3 含传输重试等待的版本（A4 风险表：重试会掩盖供应商的不稳定，两列分开看） */
    k3BatchLatencyWithRetry: { p50: number; p95: number };
    /** K5：演绎倍数 = 用户可见卡片数 / LLM 调用次数（不含评审） */
    k5DerivationFactor: number;
  };
  /** 覆盖矩阵（B2）：两张表都从已落盘批次算，只做报告、不改调度 */
  coverage: {
    learning: {
      items: number;
      cells: { item: string; evidence: string; scene: string; count: number }[];
      /** 只用过一种「证据类型 × 场景类型」形态的条目：记忆可能绑在这一个形态上 */
      singleShapeItems: string[];
    };
    content: { enabled: boolean; used: { cell: string; count: number }[]; empty: string[] };
  };
  thresholds: { name: string; value: string; threshold: string; pass: boolean | null }[];
}

export interface MetricsOptions {
  store?: WorldStore;
  /** 预计算的伏笔卫生快照（C2 离线重算用：不打开 world 库也能对齐原值） */
  threadHygiene?: ReturnType<typeof threadHygiene> | null;
  card?: number;
  prices?: { inputPerMtok: number; outputPerMtok: number };
  budgetPer100Cards?: number;
}

/** 真 tf-idf 余弦（方案 6.1：1 − max cos 相对最近 W 批）；此前是按词集合的二元余弦，非 tf-idf。 */
function tfidfNovelty(docs: string[][], window = 20): number[] {
  const n = docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const vecs = docs.map((doc) => {
    const v = new Map<string, number>();
    if (doc.length === 0) return v;
    const tf = new Map<string, number>();
    for (const w of doc) tf.set(w, (tf.get(w) ?? 0) + 1);
    for (const [w, c] of tf) v.set(w, (c / doc.length) * Math.log(n / (df.get(w) ?? 1)));
    return v;
  });
  const norm = (v: Map<string, number>) => Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const ni = norm(vecs[i]!);
    if (i === 0 || ni === 0) {
      out.push(1);
      continue;
    }
    let maxSim = 0;
    for (let j = Math.max(0, i - window); j < i; j++) {
      const nj = norm(vecs[j]!);
      if (nj === 0) continue;
      let dot = 0;
      for (const [w, x] of vecs[i]!) dot += x * (vecs[j]!.get(w) ?? 0);
      maxSim = Math.max(maxSim, dot / (ni * nj));
    }
    out.push(1 - maxSim);
  }
  return out;
}

function distinct2(tokens: string[]): number {
  if (tokens.length < 2) return 1;
  const grams = new Set<string>();
  for (let i = 0; i + 1 < tokens.length; i++) grams.add(`${tokens[i]} ${tokens[i + 1]}`);
  return grams.size / (tokens.length - 1);
}

export function computeMetrics(result: RunResult, opts: MetricsOptions = {}): MetricsJson {
  const { records, played, briefs, feedbacks, ledgerEntries, totals } = result;

  // ---------- 新颖度 ----------
  // N1 语料按方案限定为「梗概 + 节拍 gist」（第 6.1 节），不是全部台词文本
  const docs = played.map(({ seq }) => {
    const meta = records.find((r) => r.seq === seq);
    return tokenize([meta?.logline ?? '', meta?.gistText ?? ''].join(' '));
  });
  const n1 = tfidfNovelty(docs);
  const tropeSeries = ledgerEntries.map((e) => e.tropes);
  const n2PerBatch = tropeSeries.map((tropes, i) => {
    const prev = new Set(tropeSeries.slice(Math.max(0, i - 20), i).flat());
    if (tropes.length === 0) return 0;
    return tropes.filter((t) => prev.has(t)).length / tropes.length;
  });
  const n2Tail = n2PerBatch.slice(20);
  const seqs = ledgerEntries.map((e) => e.sceneSequence.join('|'));
  const n3 = seqs.length ? seqs.filter((s, i) => seqs.slice(Math.max(0, i - 5), i).includes(s)).length / seqs.length : 0;
  const n4Buckets: number[] = [];
  for (let i = 0; i < docs.length; i += 10) {
    n4Buckets.push(distinct2(docs.slice(i, i + 10).flat()));
  }

  // ---------- 一致性 ----------
  const factRefs = records.reduce((s, r) => s + r.factRefs, 0);
  const eFactConflicts = records.reduce((s, r) => s + r.issues.filter((i) => i.code === 'E-FACT-CONFLICT').length, 0);
  const c1Program = factRefs > 0 ? eFactConflicts / factRefs : null;
  // 世界状态改变：从批次记录里读（pipeline 在结算时把生效 effect 数写进 record）
  // 分母只取通过批次：失败批次按 0 计会把「写坏了」混进「写成了但没有世界改变」
  const okBatches = records.filter((r) => r.ok);
  const worldOps = okBatches.reduce((s, r) => s + (r.worldChanges ?? 0), 0);
  const noWorldChange = okBatches.filter((r) => (r.worldChanges ?? 0) === 0).length;
  const worldChange = {
    ops: worldOps,
    batchesWithout: noWorldChange,
    ratio: okBatches.length > 0 ? noWorldChange / okBatches.length : 0,
  };
  const hygiene =
    opts.threadHygiene !== undefined
      ? opts.threadHygiene
      : opts.store
        ? threadHygiene(opts.store, opts.card ?? totals.cards)
        : null;

  // ---------- 学习 ----------
  let reviewTotal = 0;
  let reviewCovered = 0;
  for (const { seq, batch } of played) {
    const brief = briefs.get(seq);
    if (!brief) continue;
    for (const r of brief.review) {
      reviewTotal++;
      const covered = batch.scenes.some(
        (s) => s.evidence?.item === r.item && s.evidence.type !== 'practice' && EVIDENCE_RANK[s.evidence.type] >= EVIDENCE_RANK[r.min_evidence],
      );
      if (covered) reviewCovered++;
    }
  }
  let evidenceTotal = 0;
  let evidenceQualified = 0;
  for (const fb of feedbacks) {
    for (const s of fb.scenes) {
      if (!s.evidence) continue;
      evidenceTotal++;
      if (s.evidence.qualified) evidenceQualified++;
    }
  }
  const oovs = records.map((r) => r.oovRatio).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const l3 = {
    median: oovs.length ? oovs[Math.floor(oovs.length / 2)]! : 0,
    p95: percentile(oovs, 95),
  };
  // L4 程序口径：直接判最终批次的选项结构（不看历史 issue —— 被修复循环改写过的批次
  // 在最终产物上是干净的，用 issue 计数当 L4 永远是 0，是空心读数）
  let l4Detection = 0;
  let l4Ambiguous = 0;
  const l4Examples: string[] = [];
  for (const { batch } of played) {
    const amb = detectionAmbiguity(batch);
    l4Detection += amb.detectionScenes;
    l4Ambiguous += amb.ambiguousScenes;
    for (const a of amb.ambiguous) {
      if (l4Examples.length < 5) l4Examples.push(`${batch.batch}.${a.sceneId}（${a.where}）：${a.reason}`);
    }
  }
  const l4 = {
    detectionScenes: l4Detection,
    ambiguousScenes: l4Ambiguous,
    rate: l4Detection > 0 ? l4Ambiguous / l4Detection : null,
    examples: l4Examples,
  };
  /**
   * 学习层的供给读数：有检测场景的批次占比。
   * 20o 实测：18 批 64 个场景里只有 2 个场景带 evidence —— L1/L2 的「100%」其实来自
   * 「分母为 0」，和 C1 的 0.0% 是同一种空心。这里把分母与供给量都摆出来。
   */
  const batchesWithDetection = played.filter(({ batch }) =>
    batch.scenes.some((s) => 'evidence' in s && s.evidence !== undefined),
  ).length;
  const detection = {
    batchesWithDetection,
    batchesPlayed: played.length,
    ratio: played.length > 0 ? batchesWithDetection / played.length : 0,
  };

  // ---------- 覆盖矩阵（B2）----------
  // 学习侧：条目 × 证据类型 × 场景类型。回答「某个条目是不是永远只在一个形态里被考」。
  const learningCounts = new Map<string, { item: string; evidence: string; scene: string; count: number }>();
  for (const { batch } of played) {
    for (const scene of batch.scenes) {
      const ev = scene.evidence;
      if (!ev) continue;
      const key = `${ev.item}|${ev.type}|${scene.type}`;
      const row = learningCounts.get(key) ?? { item: ev.item, evidence: ev.type, scene: scene.type, count: 0 };
      row.count++;
      learningCounts.set(key, row);
    }
  }
  const learningCells = [...learningCounts.values()].sort(
    (a, b) => a.item.localeCompare(b.item) || b.count - a.count,
  );
  const shapesPerItem = new Map<string, number>();
  for (const c of learningCells) shapesPerItem.set(c.item, (shapesPerItem.get(c.item) ?? 0) + 1);
  const singleShapeItems = [...shapesPerItem.entries()].filter(([, n]) => n === 1).map(([i]) => i);

  // 内容侧：频道 × set_piece × 梗族 × 检测角度（只有开了 B1 采样的运行才有数据）
  const samplingHistory = ledgerEntries
    .filter((e) => e.setPiece && e.tropeFamily && e.testAngle)
    .map((e) => ({
      channel: e.channel ?? 'unknown',
      setPiece: e.setPiece!,
      tropeFamily: e.tropeFamily!,
      testAngle: e.testAngle! as (typeof TEST_ANGLES)[number],
    }));
  // 台账条目没有频道字段时，退化成「样本数」而不是伪造空格
  const contentEnabled = samplingHistory.length > 0;
  const observed = {
    channels: [...new Set(samplingHistory.map((c) => c.channel))],
    setPieces: [...new Set(samplingHistory.map((c) => c.setPiece))],
    families: [...new Set(samplingHistory.map((c) => c.tropeFamily))],
  };
  const contentCoverageResult = contentCoverage({
    history: samplingHistory,
    universe: contentEnabled
      ? observed.channels.map((channel) => ({ channel, setPieces: observed.setPieces, families: observed.families }))
      : [],
  });

  // ---------- 可执行性 ----------
  const okCount = records.filter((r) => r.ok).length;
  const transportFailed = records.filter((r) => r.transportFailed).length;
  // V2 的分母剔除传输失败：它量的是「ESL 好不好写」，不是「供应商稳不稳」
  const evaluable = records.length - transportFailed;
  const v5Checked = records.filter((r) => r.v5Revalidated).length;
  const v5Regen = records.filter((r) => r.v5Regenerated).length;

  // ---------- 成本与延迟 ----------
  const latencies = records.flatMap((r) => {
    const perBatch = r.calls.reduce((s, c) => s + c.latencyMs, 0);
    return r.ok ? [perBatch] : [];
  }).sort((a, b) => a - b);
  // 含重试：把退避等待也算进批次时延（K3 的两列口径）
  const latenciesWithRetry = records.flatMap((r) => {
    const perBatch = r.calls.reduce((s, c) => s + c.latencyMs + (c.transportWaitMs ?? 0), 0);
    return r.ok ? [perBatch] : [];
  }).sort((a, b) => a - b);
  const prices = opts.prices ?? { inputPerMtok: 0, outputPerMtok: 0 };
  // 单价没填（两个费率都为 0）时算出来的成本恒为 0，K2 会假通过 —— 明确标记为不可判定
  const pricesConfigured = prices.inputPerMtok > 0 || prices.outputPerMtok > 0;
  const cost = pricesConfigured
    ? (totals.tokensIn / 1e6) * prices.inputPerMtok + (totals.tokensOut / 1e6) * prices.outputPerMtok
    : 0;
  const k2 = totals.cards > 0 ? (cost / totals.cards) * 100 : 0;

  const thresholds: MetricsJson['thresholds'] = [];
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const batchesPlayed = Math.max(1, records.length);
  // V2 的分母是可判定批次（剔除传输失败）；全部批次都传输失败时退回总批次数，避免 NaN
  const v2Denominator = Math.max(1, evaluable);
  thresholds.push({ name: 'V2 修复后通过率', value: pct(okCount / v2Denominator), threshold: '≥ 97%', pass: okCount / v2Denominator >= 0.97 });
  if (transportFailed > 0) {
    thresholds.push({
      name: '传输失败率（不计入 V2）',
      value: pct(transportFailed / batchesPlayed),
      threshold: '0%（出现即需续跑补齐）',
      pass: transportFailed === 0,
    });
  }
  if (c1Program !== null) {
    thresholds.push({ name: 'C1 矛盾率（程序部分）', value: pct(c1Program), threshold: '≤ 2%（另加人工确认）', pass: c1Program <= 0.02 });
  }
  if (reviewTotal > 0) {
    thresholds.push({ name: 'L1 brief 覆盖率', value: pct(reviewCovered / reviewTotal), threshold: '≥ 90%', pass: reviewCovered / reviewTotal >= 0.9 });
  }
  if (l4.rate !== null) {
    thresholds.push({ name: 'L4 歧义率（程序口径）', value: pct(l4.rate), threshold: '≤ 3%（另加评审与抽查）', pass: l4.rate <= 0.03 });
  }
  // 世界状态改变不是 9.1 的阈值，但它是 R1–R5 能不能叫"开了世界状态"的前提：
  // 全部批次都是零改变，世界状态层就只是 Context 里多了两块空表（审计 §3）
  thresholds.push({
    name: '零世界状态改变批次占比',
    value: pct(worldChange.ratio),
    threshold: '0%（非 9.1 阈值；> 0 则 R1–R5 无材料可验）',
    pass: null,
  });
  thresholds.push({
    name: '零检测批次占比',
    value: pct(1 - detection.ratio),
    threshold: '0%（非 9.1 阈值；> 0 则 L1/L2 的分母会缺一块）',
    pass: null,
  });
  if (n2Tail.length > 0) {
    const n2Mean = n2Tail.reduce((s, x) => s + x, 0) / n2Tail.length;
    thresholds.push({ name: 'N2 梗复用率（第 21 批起）', value: pct(n2Mean), threshold: '≤ 20%', pass: n2Mean <= 0.2 });
  }
  if (opts.budgetPer100Cards !== undefined) {
    thresholds.push({
      name: 'K2 每 100 张卡成本',
      value: pricesConfigured ? `$${k2.toFixed(4)}` : '单价未配置',
      threshold: `≤ $${opts.budgetPer100Cards}`,
      pass: pricesConfigured ? k2 <= opts.budgetPer100Cards : null,
    });
  }
  thresholds.push({ name: 'K4 卡顿概率', value: '见 buffer-sim', threshold: '≤ 5%（P1/缓冲2/预制3）', pass: null });
  thresholds.push({ name: 'N5 疲劳差 / 人工评分', value: '人工', threshold: '见 9.1 表', pass: null });

  // 重写/修复的净效果：首版就有阻塞错误的批次，最后救回来几批、丢掉几批。
  // 「首版干净但最终失败」虽然少见，但它一定是重写路径自己改坏的，单列出来盯。
  const dirty = records.filter((r) => (r.firstDraftIssues ?? []).some((i) => i.level === 'error'));
  const rewriteEffect = {
    firstDraftDirty: dirty.length,
    recovered: dirty.filter((r) => r.ok).length,
    lost: dirty.filter((r) => !r.ok).length,
    cleanButFailed: records.filter((r) => !r.ok && !(r.firstDraftIssues ?? []).some((i) => i.level === 'error')).length,
  };

  return {
    runId: result.runId,
    batches: records.length,
    novelty: {
      n1,
      n2Mean: n2Tail.length ? n2Tail.reduce((s, x) => s + x, 0) / n2Tail.length : 0,
      n3SequenceRepeatRate: n3,
      n4Buckets,
    },
    consistency: { factRefs, eFactConflicts, c1Program, c2ThreadHygiene: hygiene, worldChange },
    learning: {
      // 分母为 0 时给 null 而不是 1.0：跨运行比较时，「100%」与「没有数据」必须能区分开
      l1Coverage: reviewTotal > 0 ? reviewCovered / reviewTotal : null,
      reviewTotal,
      l2QualifiedRatio: evidenceTotal > 0 ? evidenceQualified / evidenceTotal : null,
      evidenceTotal,
      l3Oov: l3,
      l4,
      detection,
    },
    executability: {
      v1FirstPassRate: records.length ? records.filter((r) => r.firstPass).length / records.length : 0,
    /**
     * V0：模型原始首轮零错误率（未经机械修复）。
     * V1/V2 都是在 autoFixBatch 之后算的，看不出机械修复贡献了多少；V0 才代表「模型自己写对了」。
     */
    v0RawFirstPassRate: records.length ? records.filter((r) => r.rawFirstPass).length / records.length : 0,
      v2AfterRepairRate: okCount / v2Denominator,
      v3AvgRepairRounds: records.reduce((s, r) => s + r.repairRounds, 0) / batchesPlayed,
      v4SceneDropRate: played.length ? totals.droppedScenes / played.reduce((s, p) => s + p.batch.scenes.length, 0) : 0,
      v5Revalidation: { checked: v5Checked, regenerated: v5Regen },
      rewriteEffect,
      transport: {
        failed: transportFailed,
        rate: batchesPlayed > 0 ? transportFailed / batchesPlayed : 0,
        retries: totals.transportRetries ?? 0,
        incompleteCalls: totals.incompleteCalls ?? 0,
        evaluableBatches: evaluable,
      },
      alias: {
        hits: totals.aliasHits ?? 0,
        needs: totals.aliasNeeds ?? 0,
        batchesWithHits: records.filter((r) => (r.aliasHits ?? 0) > 0).length,
      },
    },
    cost: {
      k1PerBatch: { input: records.length ? totals.tokensIn / records.length : 0, output: records.length ? totals.tokensOut / records.length : 0 },
      k1PerCard: { input: totals.cards ? totals.tokensIn / totals.cards : 0, output: totals.cards ? totals.tokensOut / totals.cards : 0 },
      k2Per100Cards: k2,
      pricesConfigured,
      k3BatchLatency: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
      k3BatchLatencyWithRetry: { p50: percentile(latenciesWithRetry, 50), p95: percentile(latenciesWithRetry, 95) },
      k5DerivationFactor: totals.calls > 0 ? totals.cards / totals.calls : 0,
    },
    coverage: {
      learning: {
        items: shapesPerItem.size,
        cells: learningCells,
        singleShapeItems,
      },
      content: { enabled: contentEnabled, used: contentCoverageResult.used, empty: contentCoverageResult.empty },
    },
    thresholds,
  };
}

export function metricsMarkdown(m: MetricsJson): string {
  const lines: string[] = [];
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  lines.push(`# 运行报告：${m.runId}`);
  lines.push('');
  lines.push(`批次数：${m.batches}`);
  lines.push('');
  lines.push('## 阈值判定（第 9.1 节，程序可算部分）');
  lines.push('');
  lines.push('| 指标 | 值 | 阈值 | 判定 |');
  lines.push('|---|---|---|---|');
  for (const t of m.thresholds) {
    lines.push(`| ${t.name} | ${t.value} | ${t.threshold} | ${t.pass === null ? '—' : t.pass ? '✅' : '❌'} |`);
  }
  lines.push('');
  lines.push('## 指标明细');
  lines.push('');
  lines.push('### 新颖度（N1–N4）');
  lines.push(`- N1 梗概新颖度曲线：${m.novelty.n1.map((x) => x.toFixed(2)).join(', ')}`);
  lines.push(`- N2 梗复用率（第 21 批起均值）：${pct(m.novelty.n2Mean)}`);
  lines.push(`- N3 结构重复率：${pct(m.novelty.n3SequenceRepeatRate)}`);
  lines.push(`- N4 distinct-2（每 10 批）：${m.novelty.n4Buckets.map((x) => x.toFixed(2)).join(', ')}`);
  lines.push('');
  lines.push('### 一致性（C1–C2）');
  lines.push(`- 事实引用总数：${m.consistency.factRefs}；校验器 E-FACT-CONFLICT：${m.consistency.eFactConflicts}；C1 程序部分：${m.consistency.c1Program === null ? '—' : pct(m.consistency.c1Program)}（评审模型与人工确认另行相加）`);
  if (m.consistency.c2ThreadHygiene) {
    const h = m.consistency.c2ThreadHygiene;
    lines.push(`- C2 伏笔卫生：总 ${h.total}（open ${h.open} / resolved ${h.resolved} / abandoned ${h.abandoned}），过期未处理 ${h.expiredOpen}，孤儿 ${h.orphans}`);
  }
  {
    const w = m.consistency.worldChange;
    lines.push(
      `- 世界状态改变：生效 effect ${w.ops} 个；零改变批次 ${w.batchesWithout}（${pct(w.ratio)}）` +
        (w.ops === 0 ? ' ⚠ 世界状态层没有输入：本运行等同于 R0（关世界状态）的基线' : ''),
    );
  }
  lines.push('');
  lines.push('### 学习（L1–L4）');
  lines.push(`- L1 brief 覆盖率：${m.learning.l1Coverage === null ? `不可判定（本运行没有到期复习，分母 0）` : pct(m.learning.l1Coverage)}`);
  lines.push(`- L2 合格证据占比：${m.learning.l2QualifiedRatio === null ? '不可判定（本运行没有检测交互，分母 0）' : pct(m.learning.l2QualifiedRatio)}`);
  {
    const d = m.learning.detection;
    lines.push(
      `- 检测供给：${d.batchesWithDetection}/${d.batchesPlayed} 批带检测场景（${pct(d.ratio)}）` +
        (d.ratio < 1 ? ' ⚠ 有批次是纯展示，学习层拿不到证据' : ''),
    );
  }
  lines.push(`- L3 OOV：中位数 ${pct(m.learning.l3Oov.median)}，P95 ${pct(m.learning.l3Oov.p95)}`);
  {
    const l4 = m.learning.l4;
    lines.push(
      `- L4 歧义率（程序口径）：${l4.rate === null ? '不可判定（本运行没有检测场景）' : `${pct(l4.rate)}（${l4.ambiguousScenes}/${l4.detectionScenes} 个检测场景）`}` +
        '——语义级歧义仍需评审模型与人工抽查',
    );
    for (const e of l4.examples) lines.push(`  · ${e}`);
  }
  lines.push('');
  lines.push('### 覆盖矩阵（B2）');
  {
    const l = m.coverage.learning;
    lines.push(`- 学习侧：${l.items} 个条目进入过检测，共 ${l.cells.length} 个（条目 × 证据类型 × 场景类型）格子`);
    if (l.singleShapeItems.length > 0) {
      lines.push(
        `  · 只在一种形态里被考过的条目 ${l.singleShapeItems.length} 个（前 10：${l.singleShapeItems.slice(0, 10).join(', ')}）` +
          '——记忆可能绑在场景形态上，规划器可据此换形态',
      );
    }
    const c = m.coverage.content;
    if (!c.enabled) {
      lines.push('- 内容侧：本运行未开采样轴（B1），无内容覆盖数据（只有 R3s 这类对照行会开）');
    } else {
      const coldest = c.used.slice(0, 3).map((u) => `${u.cell}（${u.count}）`).join('；');
      lines.push(`- 内容侧（频道 × set_piece × 梗族 × 检测角度）：已用 ${c.used.length} 格，空格 ${c.empty.length} 个`);
      if (coldest) lines.push(`  · 最冷 3 格：${coldest}`);
      if (c.empty.length > 0) lines.push(`  · 空格样例：${c.empty.slice(0, 5).join('；')}`);
    }
  }
  lines.push('');
  lines.push('### 可执行性（V1–V5）');
  lines.push(`- V1 首次通过率：${pct(m.executability.v1FirstPassRate)}；V2 修复后通过率：${pct(m.executability.v2AfterRepairRate)}`);
  lines.push(`- V0 模型原始首轮零错误率：${pct(m.executability.v0RawFirstPassRate)}（机械修复前；V1 与它的差就是程序化自检的贡献）`);
  lines.push(`- V3 平均修复轮数：${m.executability.v3AvgRepairRounds.toFixed(2)}；V4 场景丢弃率：${pct(m.executability.v4SceneDropRate)}`);
  lines.push(`- V5 状态失效重校验：检查 ${m.executability.v5Revalidation.checked} 批，重生成 ${m.executability.v5Revalidation.regenerated} 批`);
  {
    const t = m.executability.transport;
    lines.push(
      `- 传输层（A4）：失败 ${t.failed} 批（${pct(t.rate)}，不计入 V2 分母）｜重试 ${t.retries} 次｜不完整输出 ${t.incompleteCalls} 次｜可判定批次 ${t.evaluableBatches}`,
    );
  }
  {
    const a = m.executability.alias;
    lines.push(
      `- 名字出路（A2）：别名表救回 ${a.hits} 个名字（涉及 ${a.batchesWithHits} 批）｜needs 靠别名解析 ${a.needs} 项｜V0 仍按别名命中前口径，不因替换抬高`,
    );
  }
  {
    const w = m.executability.rewriteEffect;
    lines.push(
      `- 重写净效果：首版带阻塞错误 ${w.firstDraftDirty} 批 → 救回 ${w.recovered} 批、丢掉 ${w.lost} 批` +
        (w.cleanButFailed > 0 ? `；另有 ${w.cleanButFailed} 批首版干净却最终失败（重写路径改坏的）` : ''),
    );
  }
  lines.push('');
  lines.push('### 成本与延迟（K1/K2/K3/K5）');
  lines.push(`- K1 每批：输入 ${m.cost.k1PerBatch.input.toFixed(0)} / 输出 ${m.cost.k1PerBatch.output.toFixed(0)} token；每卡：输入 ${m.cost.k1PerCard.input.toFixed(0)} / 输出 ${m.cost.k1PerCard.output.toFixed(0)}`);
  lines.push(`- K2 每 100 张卡成本：${m.cost.pricesConfigured ? `$${m.cost.k2Per100Cards.toFixed(4)}（单价来自 config/prices.yaml）` : '不可判定（config/prices.yaml 单价未配置，K2 记 —）'}`);
  lines.push(
    `- K3 批时延（不含重试）：P50 ${(m.cost.k3BatchLatency.p50 / 1000).toFixed(1)}s / P95 ${(m.cost.k3BatchLatency.p95 / 1000).toFixed(1)}s；` +
      `含重试：P50 ${(m.cost.k3BatchLatencyWithRetry.p50 / 1000).toFixed(1)}s / P95 ${(m.cost.k3BatchLatencyWithRetry.p95 / 1000).toFixed(1)}s`,
  );
  lines.push(`- K5 演绎倍数：${m.cost.k5DerivationFactor.toFixed(2)} 卡/调用`);
  lines.push('');
  lines.push('> 人工评分项（N5、L4、L5、C3、C1 人工确认）按第 7.4 节规程另行收集；LLM 评审先校准（第 5.12 节）。');
  return lines.join('\n');
}
