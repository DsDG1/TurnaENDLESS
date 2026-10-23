/**
 * 中间产物落盘（C2）：让指标可以**离线重算**，不必重跑流水线读缓存。
 *
 * 结果 §5 #8 的问题：N2/N3 依赖 `ledgerEntries`、L1 依赖逐批 `briefs`，这些只在内存里，
 * 所以 `lab metrics` 只能重放整条流水线；代码一改（提示词/上限/哈希盐）缓存全部未命中，指标归零。
 *
 * 这里在运行结束时把「算指标需要的全部输入」写成 `artifacts/metrics-input.json`：
 * records、每批的 brief、反馈包、梗台账、批次场景（novelty 与 L1 用）、totals、伏笔卫生快照。
 * 不含 AST 与渲染文本（指标不用），所以文件大小与批次记录同量级。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Batch } from '@endless/esl';
import type { LearningBrief } from '@endless/learning';
import type { LedgerEntry } from '@endless/director';
import type { threadHygiene } from '@endless/world';
import type { BatchRecord, FeedbackPkg, RunResult } from './pipeline.js';

export const METRICS_INPUT_VERSION = 1;
export const METRICS_INPUT_FILE = join('artifacts', 'metrics-input.json');

export interface MetricsInput {
  version: number;
  runId: string;
  written_at: string;
  /** c2ThreadHygiene 在运行结束时算好存下来：离线重算时不需要 world 库也能对齐原值 */
  threadHygiene: ReturnType<typeof threadHygiene> | null;
  card: number;
  totals: RunResult['totals'];
  records: BatchRecord[];
  played: { seq: number; batch: Batch }[];
  briefs: [number, LearningBrief][];
  feedbacks: FeedbackPkg[];
  ledgerEntries: LedgerEntry[];
}

export function buildMetricsInput(
  result: RunResult,
  opts: { threadHygiene: ReturnType<typeof threadHygiene> | null; card: number },
): MetricsInput {
  return {
    version: METRICS_INPUT_VERSION,
    runId: result.runId,
    written_at: new Date().toISOString(),
    threadHygiene: opts.threadHygiene,
    card: opts.card,
    totals: result.totals,
    // calls 里含请求哈希与 token，指标只用 latency / finishReason 等少量字段；原样保留以便 K3 重算
    records: result.records,
    played: result.played.map(({ seq, batch }) => ({ seq, batch })),
    briefs: [...result.briefs.entries()],
    feedbacks: result.feedbacks,
    ledgerEntries: result.ledgerEntries,
  };
}

export async function writeMetricsInput(outDir: string, input: MetricsInput): Promise<string> {
  const path = join(outDir, METRICS_INPUT_FILE);
  await mkdir(join(outDir, 'artifacts'), { recursive: true });
  await writeFile(path, JSON.stringify(input, null, 2), 'utf8');
  return path;
}

export async function readMetricsInput(outDir: string): Promise<MetricsInput | null> {
  const text = await readFile(join(outDir, METRICS_INPUT_FILE), 'utf8').catch(() => null);
  if (text === null) return null;
  const parsed = JSON.parse(text) as MetricsInput;
  if (parsed.version !== METRICS_INPUT_VERSION) return null;
  return parsed;
}

/** 把落盘输入还原成 computeMetrics 需要的形状（AST 与模拟器都不参与指标）。 */
export function toRunResult(input: MetricsInput): RunResult {
  return {
    runId: input.runId,
    records: input.records,
    played: input.played.map((p) => ({ seq: p.seq, batch: p.batch, ast: undefined as never, render: '' })),
    briefs: new Map(input.briefs),
    feedbacks: input.feedbacks,
    ledgerEntries: input.ledgerEntries,
    sim: undefined as never,
    srs: undefined as never,
    ability: undefined as never,
    exposureCounts: new Map(),
    introduced: new Set(),
    totals: input.totals,
  };
}
