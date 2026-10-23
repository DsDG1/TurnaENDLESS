/**
 * 从运行产物里汇总**实测时延**（第 5.13 节：生成侧用实测时延分布）。
 *
 * 之前 `lab buffer-sim` 默认 20s/批、要手传 `--gen-ms`，于是报告里的 K4 比实测乐观 3 倍
 * （20o 实测 P50 58s/批 vs 默认 20s）。这里把 `calls.jsonl` 变成唯一来源：
 * 一次批次时延 = 该批全部调用的 latencyMs 之和；`--from-run` 直接吃这一份分布。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { percentile } from './sim/rng.js';

export interface LatencySummary {
  /** 每批生成时延（毫秒，按 seq 汇总）—— buffer-sim 直接按这个分布抽样 */
  batches: number[];
  /** 单次调用时延（毫秒） */
  calls: number[];
  p50BatchMs: number;
  p95BatchMs: number;
  meanCallsPerBatch: number;
  /** 含传输重试等待的批次时延（K3 第二列口径） */
  p50BatchMsWithRetry: number;
  /** 调用日志来源（相对路径，写进报告以便核对） */
  source: string;
}

interface CallLine {
  seq?: number;
  latencyMs?: number;
  transportWaitMs?: number;
  failed?: boolean;
}

/**
 * 读 `<runDir>/calls.jsonl`。失败调用行（`failed: true`）不计入批次时延：
 * 那是熔断/重试路径的记录，不是「生成一批要多久」。
 */
export async function readLatencySummary(runDir: string): Promise<LatencySummary> {
  const path = join(runDir, 'calls.jsonl');
  const text = await readFile(path, 'utf8');
  const perSeq = new Map<number, { ms: number; wait: number }>();
  const calls: number[] = [];
  let lines = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let rec: CallLine;
    try {
      rec = JSON.parse(line) as CallLine;
    } catch {
      continue; // 半行（进程被杀）不是错误，跳过
    }
    if (rec.failed === true) continue;
    const ms = rec.latencyMs ?? 0;
    const wait = rec.transportWaitMs ?? 0;
    calls.push(ms);
    const seq = rec.seq ?? 0;
    const acc = perSeq.get(seq) ?? { ms: 0, wait: 0 };
    acc.ms += ms;
    acc.wait += wait;
    perSeq.set(seq, acc);
    lines++;
  }
  if (lines === 0) throw new Error(`${path} 里没有可用的调用记录`);
  const batches = [...perSeq.values()].map((v) => v.ms).sort((a, b) => a - b);
  const withRetry = [...perSeq.values()].map((v) => v.ms + v.wait).sort((a, b) => a - b);
  return {
    batches,
    calls,
    p50BatchMs: percentile(batches, 50),
    p95BatchMs: percentile(batches, 95),
    meanCallsPerBatch: calls.length / Math.max(1, perSeq.size),
    p50BatchMsWithRetry: percentile(withRetry, 50),
    source: 'calls.jsonl',
  };
}
