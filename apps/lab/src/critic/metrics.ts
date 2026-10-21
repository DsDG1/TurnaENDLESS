/**
 * Critic 程序指标（第 6 节中能自动计算的部分）：
 * N1–N4 新颖度、C1/C2 一致性、L1–L3 学习、V1–V5 可执行性、K1/K2/K3/K5 成本延迟。
 * 人工评分项（N5、L4、L5、C3、C1 的人工确认部分）与 LLM 评审不在此处。
 */
import { batchTextUnits, tokenize, EVIDENCE_RANK } from '@endless/esl';
import { threadHygiene, type WorldStore } from '@endless/world';
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
  };
  learning: {
    /** L1：有合格证据的到期复习 / 到期复习总数 */
    l1Coverage: number;
    /** L2：类似检测交互中证据合格的比例 */
    l2QualifiedRatio: number;
    /** L3：每批 OOV 中位数与 P95 */
    l3Oov: { median: number; p95: number };
  };
  executability: {
    v1FirstPassRate: number;
    v2AfterRepairRate: number;
    v3AvgRepairRounds: number;
    v4SceneDropRate: number;
    v5Revalidation: { checked: number; regenerated: number };
  };
  cost: {
    /** K1：每批 / 每卡 token（按阶段拆分见 calls.jsonl） */
    k1PerBatch: { input: number; output: number };
    k1PerCard: { input: number; output: number };
    /** K2：每 100 张卡成本（美元，按 prices.yaml；单价未填时为 0） */
    k2Per100Cards: number;
    /** K3：每批时延 P50/P95（毫秒） */
    k3BatchLatency: { p50: number; p95: number };
    /** K5：演绎倍数 = 用户可见卡片数 / LLM 调用次数（不含评审） */
    k5DerivationFactor: number;
  };
  thresholds: { name: string; value: string; threshold: string; pass: boolean | null }[];
}

export interface MetricsOptions {
  store?: WorldStore;
  card?: number;
  prices?: { inputPerMtok: number; outputPerMtok: number };
  budgetPer100Cards?: number;
}

function tfidfNovelty(docs: string[][], window = 20): number[] {
  const out: number[] = [];
  for (let i = 0; i < docs.length; i++) {
    const prev = docs.slice(Math.max(0, i - window), i);
    if (prev.length === 0) {
      out.push(1);
      continue;
    }
    const docSet = new Set(docs[i]!);
    let maxSim = 0;
    for (let j = Math.max(0, i - window); j < i; j++) {
      const other = new Set(docs[j]!);
      let dot = 0;
      for (const w of docSet) if (other.has(w)) dot++;
      const sim = dot / Math.sqrt(docSet.size * other.size);
      maxSim = Math.max(maxSim, sim);
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
  const docs = played.map(({ batch, seq }) => {
    const unitTexts = batchTextUnits(batch).map((u) => u.text);
    const meta = records.find((r) => r.seq === seq);
    return tokenize([meta?.logline ?? '', ...unitTexts].join(' '));
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
  const hygiene = opts.store ? threadHygiene(opts.store, opts.card ?? totals.cards) : null;

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

  // ---------- 可执行性 ----------
  const okCount = records.filter((r) => r.ok).length;
  const v5Checked = records.filter((r) => r.v5Revalidated).length;
  const v5Regen = records.filter((r) => r.v5Regenerated).length;

  // ---------- 成本与延迟 ----------
  const latencies = records.flatMap((r) => {
    const perBatch = r.calls.reduce((s, c) => s + c.latencyMs, 0);
    return r.ok ? [perBatch] : [];
  }).sort((a, b) => a - b);
  const prices = opts.prices ?? { inputPerMtok: 0, outputPerMtok: 0 };
  const cost =
    (totals.tokensIn / 1e6) * prices.inputPerMtok + (totals.tokensOut / 1e6) * prices.outputPerMtok;
  const k2 = totals.cards > 0 ? (cost / totals.cards) * 100 : 0;

  const thresholds: MetricsJson['thresholds'] = [];
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const batchesPlayed = Math.max(1, records.length);
  thresholds.push({ name: 'V2 修复后通过率', value: pct(okCount / batchesPlayed), threshold: '≥ 97%', pass: okCount / batchesPlayed >= 0.97 });
  if (c1Program !== null) {
    thresholds.push({ name: 'C1 矛盾率（程序部分）', value: pct(c1Program), threshold: '≤ 2%（另加人工确认）', pass: c1Program <= 0.02 });
  }
  if (reviewTotal > 0) {
    thresholds.push({ name: 'L1 brief 覆盖率', value: pct(reviewCovered / reviewTotal), threshold: '≥ 90%', pass: reviewCovered / reviewTotal >= 0.9 });
  }
  if (n2Tail.length > 0) {
    const n2Mean = n2Tail.reduce((s, x) => s + x, 0) / n2Tail.length;
    thresholds.push({ name: 'N2 梗复用率（第 21 批起）', value: pct(n2Mean), threshold: '≤ 20%', pass: n2Mean <= 0.2 });
  }
  if (opts.budgetPer100Cards !== undefined) {
    thresholds.push({ name: 'K2 每 100 张卡成本', value: `$${k2.toFixed(4)}`, threshold: `≤ $${opts.budgetPer100Cards}`, pass: k2 <= opts.budgetPer100Cards });
  }
  thresholds.push({ name: 'K4 卡顿概率', value: '见 buffer-sim', threshold: '≤ 5%（P1/缓冲2/预制3）', pass: null });
  thresholds.push({ name: 'N5 疲劳差 / 人工评分', value: '人工', threshold: '见 9.1 表', pass: null });

  return {
    runId: result.runId,
    batches: records.length,
    novelty: {
      n1,
      n2Mean: n2Tail.length ? n2Tail.reduce((s, x) => s + x, 0) / n2Tail.length : 0,
      n3SequenceRepeatRate: n3,
      n4Buckets,
    },
    consistency: { factRefs, eFactConflicts, c1Program, c2ThreadHygiene: hygiene },
    learning: {
      l1Coverage: reviewTotal > 0 ? reviewCovered / reviewTotal : 1,
      l2QualifiedRatio: evidenceTotal > 0 ? evidenceQualified / evidenceTotal : 1,
      l3Oov: l3,
    },
    executability: {
      v1FirstPassRate: records.length ? records.filter((r) => r.firstPass).length / records.length : 0,
      v2AfterRepairRate: okCount / batchesPlayed,
      v3AvgRepairRounds: records.reduce((s, r) => s + r.repairRounds, 0) / batchesPlayed,
      v4SceneDropRate: played.length ? totals.droppedScenes / played.reduce((s, p) => s + p.batch.scenes.length, 0) : 0,
      v5Revalidation: { checked: v5Checked, regenerated: v5Regen },
    },
    cost: {
      k1PerBatch: { input: records.length ? totals.tokensIn / records.length : 0, output: records.length ? totals.tokensOut / records.length : 0 },
      k1PerCard: { input: totals.cards ? totals.tokensIn / totals.cards : 0, output: totals.cards ? totals.tokensOut / totals.cards : 0 },
      k2Per100Cards: k2,
      k3BatchLatency: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
      k5DerivationFactor: totals.calls > 0 ? totals.cards / totals.calls : 0,
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
  lines.push('');
  lines.push('### 学习（L1–L3）');
  lines.push(`- L1 brief 覆盖率：${pct(m.learning.l1Coverage)}`);
  lines.push(`- L2 合格证据占比：${pct(m.learning.l2QualifiedRatio)}`);
  lines.push(`- L3 OOV：中位数 ${pct(m.learning.l3Oov.median)}，P95 ${pct(m.learning.l3Oov.p95)}`);
  lines.push('');
  lines.push('### 可执行性（V1–V5）');
  lines.push(`- V1 首次通过率：${pct(m.executability.v1FirstPassRate)}；V2 修复后通过率：${pct(m.executability.v2AfterRepairRate)}`);
  lines.push(`- V3 平均修复轮数：${m.executability.v3AvgRepairRounds.toFixed(2)}；V4 场景丢弃率：${pct(m.executability.v4SceneDropRate)}`);
  lines.push(`- V5 状态失效重校验：检查 ${m.executability.v5Revalidation.checked} 批，重生成 ${m.executability.v5Revalidation.regenerated} 批`);
  lines.push('');
  lines.push('### 成本与延迟（K1/K2/K3/K5）');
  lines.push(`- K1 每批：输入 ${m.cost.k1PerBatch.input.toFixed(0)} / 输出 ${m.cost.k1PerBatch.output.toFixed(0)} token；每卡：输入 ${m.cost.k1PerCard.input.toFixed(0)} / 输出 ${m.cost.k1PerCard.output.toFixed(0)}`);
  lines.push(`- K2 每 100 张卡成本：$${m.cost.k2Per100Cards.toFixed(4)}（单价来自 config/prices.yaml）`);
  lines.push(`- K3 批时延：P50 ${(m.cost.k3BatchLatency.p50 / 1000).toFixed(1)}s / P95 ${(m.cost.k3BatchLatency.p95 / 1000).toFixed(1)}s`);
  lines.push(`- K5 演绎倍数：${m.cost.k5DerivationFactor.toFixed(2)} 卡/调用`);
  lines.push('');
  lines.push('> 人工评分项（N5、L4、L5、C3、C1 人工确认）按第 7.4 节规程另行收集；LLM 评审先校准（第 5.12 节）。');
  return lines.join('\n');
}
