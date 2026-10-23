/**
 * S-R 回放（第 7.2 节 / RQ6 的第二条腿）：在**真实运行产出**上回放三种证据策略。
 *
 * 与 `srs-sim` 的分工：
 * - `srs-sim` 用合成事件流（300 条目 × 60 日），量的是调度逻辑在理想输入下的自洽性；
 * - 这里用真实运行里**实际发生过的检索事件**（条目、证据类型、对错、发生顺序）重放一遍，
 *   三种策略吃同一条事件流，差异只来自「什么样的证据才写进 FSRS」这一条规则。
 *
 * 这样 S-R 的结论与 R0–R5 的产出直接挂钩：如果真实产出里检测场景很少、或全是弱证据，
 * 回放结果会立刻显出来（总复习数、写入 FSRS 的次数、ECE 分箱的空档）。
 *
 * 口径说明（写进报告，避免读的人误以为和 srs-sim 完全等价）：
 * - 事件流来自 `feedback.jsonl`（每次播放后的反馈包），`correct` 是运行期学习者的真实作答；
 * - 因此这里**不需要种子**：同一条事件流，三种策略是确定性比较；
 * - `brierTrue` 无法计算（真实运行没有记录 R_true），只报对二元结果的 Brier 与 ECE；
 * - 「保持率」退化为可观测代理：**最后 20% 事件中的作答正确率**，不是第 60 日的平均回忆率。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvidenceType } from '@endless/esl';
import { EvidenceProcessor, SrsStore, type Facet, type Strategy } from '@endless/learning';
import { studyDayOf } from './sim/learner.js';
import { calibrationBins } from './srsim.js';

export interface ReplayEvent {
  /** 批次 id（b-0001），用于归因 */
  batch: string;
  /** 批次序号 */
  seq: number;
  item: string;
  facet: Facet;
  type: EvidenceType;
  correct: boolean;
  /** 该事件发生时的累计卡数（换算学习日） */
  card: number;
  day: number;
}

interface FeedbackLine {
  batch?: string;
  seq?: number;
  cards?: number[];
  scenes?: {
    sceneId?: string;
    evidence?: { item?: string; type?: string; correct?: boolean };
  }[];
}

const RETRIEVAL = new Set(['recognition-2', 'recognition-4', 'listening-4', 'production']);

/**
 * 从运行目录提取检索事件流。只认 `feedback.jsonl`：
 * 它同时给出「哪一批、几张卡、哪个场景考了什么、答对没有」，正是重放需要的全部字段。
 */
export async function readReplayEvents(runDir: string): Promise<{ events: ReplayEvent[]; batches: number }> {
  const text = await readFile(join(runDir, 'feedback.jsonl'), 'utf8');
  const events: ReplayEvent[] = [];
  let card = 0;
  let batches = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let rec: FeedbackLine;
    try {
      rec = JSON.parse(line) as FeedbackLine;
    } catch {
      continue; // 半行（进程被杀）跳过
    }
    batches++;
    card += rec.cards?.length ?? 0;
    const day = studyDayOf(card);
    for (const scene of rec.scenes ?? []) {
      const ev = scene.evidence;
      // 只回放检索型证据：exposure / practice 不写 FSRS，对三种策略没有区分度
      if (!ev?.item || !ev.type || !RETRIEVAL.has(ev.type)) continue;
      events.push({
        batch: rec.batch ?? `seq-${rec.seq ?? 0}`,
        seq: rec.seq ?? 0,
        item: ev.item,
        facet: 'meaning' as Facet,
        type: ev.type as EvidenceType,
        correct: ev.correct === true,
        card,
        day,
      });
    }
  }
  return { events, batches };
}

const BASE = new Date('2026-01-01T09:00:00Z');
const at = (day: number) => new Date(BASE.getTime() + day * 86_400_000);

/** 作答猜对率 g（第 5.3.3 节）：按证据类型取。
 * 注意回放里 `correct` 是记录值，g 只在需要「若换一种类型会怎样」时才用不上 —— 这里保留
 * 是为了把同一事件按策略的证据口径换算成 FSRS 分级，而不是重新抽一次随机。 */
export function guessRateOf(type: EvidenceType): number {
  switch (type) {
    case 'recognition-4':
      return 0.25;
    case 'recognition-2':
      return 0.5;
    case 'listening-4':
      return 0.25;
    case 'production':
      return 0.1;
    default:
      return 0.25;
  }
}

export interface ReplayStrategyResult {
  strategy: Strategy;
  /** 处理过的检索事件（= 输入事件数，三种策略相同） */
  events: number;
  /** 真正写进 FSRS 的复习次数（策略差异就体现在这里） */
  fsrsReviews: number;
  brier: number;
  ece: number;
  /** 最后 20% 事件的作答正确率（保持率代理指标） */
  tailAccuracy: number;
  /** 校准点数量（第二次及以后的合格复习才有预测基线） */
  calibPoints: number;
  bins: ReturnType<typeof calibrationBins>['bins'];
}

export interface ReplayReport {
  batches: number;
  events: number;
  items: number;
  days: number;
  byStrategy: ReplayStrategyResult[];
  markdown: string;
}

/**
 * 回放：同一条事件流喂给三种策略。
 * SrsStore 与 EvidenceProcessor 的用法与流水线一致（每批以该批的模拟日为「现在」）。
 */
export function replayStrategies(events: ReplayEvent[], strategies: Strategy[] = ['S-A', 'S-B', 'S-C'], batches = 0): ReplayReport {
  const items = new Set(events.map((e) => e.item));
  const lastDay = events.length > 0 ? events[events.length - 1]!.day : 0;
  const tailStart = Math.floor(events.length * 0.8);
  const byStrategy: ReplayStrategyResult[] = [];

  for (const strategy of strategies) {
    const srs = new SrsStore();
    const processor = new EvidenceProcessor(strategy);
    const points: { predicted: number; correct: boolean }[] = [];
    let fsrs = 0;
    let tailTotal = 0;
    let tailCorrect = 0;

    events.forEach((e, i) => {
      const now = at(e.day);
      // 预测基线必须在 grade 之前取：grade 之后就是「知道答案之后」的预测
      const predicted = srs.predictedRecall(e.item, e.facet, now);
      const outcome = processor.process({ item: e.item, facet: e.facet, type: e.type, correct: e.correct });
      if (outcome.fsrsGrade) {
        fsrs++;
        if (predicted !== null) points.push({ predicted, correct: e.correct });
        srs.grade(e.item, e.facet, outcome.fsrsGrade, now);
      }
      if (i >= tailStart) {
        tailTotal++;
        if (e.correct) tailCorrect++;
      }
    });

    const { bins, ece } = calibrationBins(points);
    const brier = points.length ? points.reduce((s, p) => s + (p.predicted - (p.correct ? 1 : 0)) ** 2, 0) / points.length : 0;
    byStrategy.push({
      strategy,
      events: events.length,
      fsrsReviews: fsrs,
      brier,
      ece,
      tailAccuracy: tailTotal > 0 ? tailCorrect / tailTotal : 0,
      calibPoints: points.length,
      bins,
    });
  }

  const summary = { batches, events: events.length, items: items.size, days: lastDay, byStrategy };
  return { ...summary, markdown: renderReplayReport(summary) };
}

function renderReplayReport(r: Omit<ReplayReport, 'markdown'>): string {
  const lines: string[] = [];
  lines.push('# S-R 回放：真实产出上的三种证据策略（RQ6 第二条腿）');
  lines.push('');
  lines.push(
    `事件流：${r.batches} 批 / ${r.events} 次检索 / ${r.items} 个条目 / 跨 ${r.days} 个模拟日。` +
      '来源是运行期真实发生的检测场景与作答，三种策略吃同一条流。',
  );
  lines.push('');
  if (r.events === 0) {
    lines.push('> ⚠ 这次运行里没有任何检索型证据事件，无法回放。');
    lines.push('> 先确认批次里有 pick / chat(reply) / hidden_object / story 的 evidence（R0–R5 的产出应当都有）。');
    return lines.join('\n');
  }
  lines.push('| 策略 | 检索事件 | 写入 FSRS | Brier(二元) | ECE | 校准点 | 尾部正确率 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const s of r.byStrategy) {
    lines.push(
      `| ${s.strategy} | ${s.events} | ${s.fsrsReviews} | ${s.brier.toFixed(4)} | ${s.ece.toFixed(4)} | ${s.calibPoints} | ${(s.tailAccuracy * 100).toFixed(1)}% |`,
    );
  }
  lines.push('');
  const best = [...r.byStrategy].sort((a, b) => a.ece - b.ece)[0];
  const sa = r.byStrategy.find((s) => s.strategy === 'S-A');
  const sb = r.byStrategy.find((s) => s.strategy === 'S-B');
  if (best) {
    lines.push('## H6 判读（真实产出）');
    lines.push('');
    lines.push(`- ECE 最小：**${best.strategy}**（${best.ece.toFixed(4)}）。`);
    if (sa && sb) {
      lines.push(
        sa.ece > sb.ece
          ? '- 与 H6 一致：S-A（弱证据也计入复习）的校准误差高于 S-B（按证据分级）。'
          : '- 与 H6 不符：S-A 不高于 S-B。真实产出的证据类型比例与合成流不同时会出现这种情况，值得记录。',
      );
      lines.push(
        `- 写入 FSRS 的次数：S-A ${sa.fsrsReviews} vs S-B ${sb.fsrsReviews}` +
          (sb.fsrsReviews > 0 ? `（${(sa.fsrsReviews / sb.fsrsReviews).toFixed(2)}×）` : '') +
          ' —— 这一列是策略差异的直接来源。',
      );
    }
  }
  lines.push('');
  lines.push('> 口径：`correct` 是运行期学习者的记录值，不是重新抽样，所以本回放不带种子、结果是确定性的；');
  lines.push('> 没有记录 R_true，故不报 `Brier(对 R_true)`；「尾部正确率」= 最后 20% 事件的作答正确率，是保持率的代理，不等于第 60 日平均回忆率。');
  return lines.join('\n');
}
