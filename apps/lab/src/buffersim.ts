/**
 * 时延与缓冲模拟（第 5.13 节 / K4）：离散事件模拟消费侧与生成侧。
 * 消费侧按画像的停留时间逐卡消费；生成侧按实测（或给定）的时延分布生成批次，
 * 支持 B ∈ {1,2,3} 缓冲目标、0/3/5 个预制批次、单任务串行与双任务并发。
 */
import { lognormal, mulberry32, percentile } from './sim/rng.js';
import { PERSONAS, type PersonaId } from './sim/learner.js';

export interface BufferSimInput {
  persona: PersonaId;
  /** 缓冲目标 B（批） */
  buffer: number;
  /** 首屏预制批次数 */
  prefetched: number;
  batches: number;
  cardsPerBatch: number;
  /** 单批生成时延（毫秒）：对数正态中位数与 σ；实测时从 calls.jsonl 汇总替换 */
  genMedianMs: number;
  genSigma: number;
  concurrent: 1 | 2;
  seed: number;
}

export interface BufferSimResult {
  input: BufferSimInput;
  /** 卡顿概率（K4）：消费到达批次头而批次未就绪的比例 */
  stallProbability: number;
  avgStallMs: number;
  p95StallMs: number;
  firstScreenWaitMs: number;
}

export function simulateBuffer(input: BufferSimInput): BufferSimResult {
  const rng = mulberry32(input.seed);
  const persona = PERSONAS[input.persona];
  const totalCards = input.batches * input.cardsPerBatch;

  // 消费侧：每张卡的到达时间（累计停留）
  const arrival: number[] = [];
  let t = 0;
  for (let c = 0; c < totalCards; c++) {
    arrival.push(t);
    t += lognormal(rng, Math.log(persona.dwellMedianMs), persona.dwellSigma);
  }

  // 生成侧：批次 j 在消费到「再往前 B 批」的位置时开始生成（维持缓冲目标）
  // ready[j] = 完成时间；串行 1 台机器 / 并发 2 台，取最早空闲的机器
  const ready: number[] = [];
  const machineFree = [0, 0];
  for (let j = 0; j < input.batches; j++) {
    if (j < input.prefetched) {
      ready.push(0);
      continue;
    }
    const startTriggerCard = Math.max(0, (j - input.buffer) * input.cardsPerBatch);
    const start = startTriggerCard === 0 ? 0 : arrival[startTriggerCard]!;
    let mIdx = 0;
    for (let m = 1; m < input.concurrent; m++) {
      if (machineFree[m]! < machineFree[mIdx]!) mIdx = m;
    }
    const begin = Math.max(start, machineFree[mIdx]!);
    const finish = begin + lognormal(rng, Math.log(input.genMedianMs), input.genSigma);
    machineFree[mIdx] = finish;
    ready.push(finish);
  }

  // 消费侧遇批次未就绪 → 卡顿
  const stalls: number[] = [];
  for (let j = 0; j < input.batches; j++) {
    const cardIdx = j * input.cardsPerBatch;
    const at = arrival[cardIdx]!;
    if (ready[j]! > at) stalls.push(ready[j]! - at);
  }
  const sorted = [...stalls].sort((a, b) => a - b);
  return {
    input,
    stallProbability: stalls.length / input.batches,
    avgStallMs: stalls.length ? stalls.reduce((s, x) => s + x, 0) / stalls.length : 0,
    p95StallMs: percentile(sorted, 95),
    firstScreenWaitMs: ready[0] ?? 0,
  };
}

export interface BufferSweepOptions {
  persona: PersonaId;
  buffers: number[];
  prefetched: number[];
  batches: number;
  cardsPerBatch: number;
  genMedianMs: number;
  genSigma: number;
  concurrent: 1 | 2;
  seed: number;
}

/** K4 判定矩阵（第 9.1 节）：P1、缓冲 2、3 个预制批 → 卡顿概率 ≤ 5%。 */
export function sweepBuffer(opts: Partial<BufferSweepOptions> = {}): { results: BufferSimResult[]; markdown: string } {
  const full: BufferSweepOptions = {
    persona: 'P1',
    buffers: [1, 2, 3],
    prefetched: [0, 3, 5],
    batches: 120,
    cardsPerBatch: 4,
    genMedianMs: 20_000,
    genSigma: 0.5,
    concurrent: 1,
    seed: 7,
    ...opts,
  };
  const results: BufferSimResult[] = [];
  for (const buffer of full.buffers) {
    for (const prefetched of full.prefetched) {
      results.push(simulateBuffer({ ...full, buffer, prefetched }));
    }
  }
  const lines: string[] = [];
  lines.push('# 缓冲与卡顿模拟（K4 / H7）');
  lines.push('');
  lines.push(`画像 ${full.persona}（${PERSONAS[full.persona].name}），${full.batches} 批 × ${full.cardsPerBatch} 卡，单批生成中位 ${full.genMedianMs / 1000}s，并发 ${full.concurrent}。`);
  lines.push('');
  lines.push('| 缓冲 B | 预制批 | 卡顿概率 | 平均卡顿(s) | P95 卡顿(s) | 首屏等待(s) |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of results) {
    lines.push(
      `| ${r.input.buffer} | ${r.input.prefetched} | ${(r.stallProbability * 100).toFixed(1)}% | ${(r.avgStallMs / 1000).toFixed(1)} | ${(r.p95StallMs / 1000).toFixed(1)} | ${(r.firstScreenWaitMs / 1000).toFixed(1)} |`,
    );
  }
  lines.push('');
  const key = results.find((r) => r.input.buffer === 2 && r.input.prefetched === 3);
  if (key) {
    lines.push(
      `判定格（P1 / 缓冲 2 / 3 预制批）：卡顿概率 **${(key.stallProbability * 100).toFixed(1)}%**，阈值 ≤ 5% → ${key.stallProbability <= 0.05 ? '✅ 达标（H7 成立）' : '❌ 未达标（H7 不成立）'}。`,
    );
  }
  return { results, markdown: lines.join('\n') };
}
