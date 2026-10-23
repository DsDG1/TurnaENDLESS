/**
 * B1 采样轴显式化（ScrollToStudy「焦点 × 题型 × 数量 × 措辞」的 ENDLESS 版本）。
 *
 * 现状：梗台账只负责「禁止复用」，新东西全靠编剧室自己发明 —— 新颖度不达标时没有把手。
 * 这里把「该写什么」变成可数的格子：**频道 × set_piece × 梗族 × 检测角度**，
 * 每批挑**最冷的一格**作为指定项写进编剧室上下文；台账继续负责禁止项。
 *
 * 两者分工不同：台账说「不要再写这些」，采样器说「这次请写这个」。只加一棵树，不替换台账。
 *
 * 用法上它是一条额外运行（例如 `R3s`），默认关闭 —— R0–R5 的口径不能被它动。
 */
export const TEST_ANGLES = ['sense_pick', 'context_infer', 'confusable_contrast'] as const;
export type TestAngle = (typeof TEST_ANGLES)[number];

/** 检测角度的中文说明（写进提示词，避免模型把 anges 当条目 id）。 */
export const TEST_ANGLE_NOTE: Record<TestAngle, string> = {
  sense_pick: '词义辨认：让学习者从选项里挑出该条目的意思',
  context_infer: '语境推断：句子里留空或换成近义说法，靠上下文推回来',
  confusable_contrast: '易混辨析：和词库里的易混条目放在一起，选对哪一个才合适',
};

/** 一个「格」：采样轴上的一个组合。 */
export interface SamplingCell {
  channel: string;
  setPiece: string;
  tropeFamily: string;
  testAngle: TestAngle;
}

export interface SamplingAssignment extends SamplingCell {
  /** 人读的调度理由（进批次记录，D3 用） */
  reason: string;
}

export const cellKey = (c: SamplingCell): string => `${c.channel} × ${c.setPiece} × ${c.tropeFamily} × ${c.testAngle}`;

/**
 * 挑最冷的一格：
 *   1. 先把本频道所有候选组合列出来（set_piece × 梗族 × 角度）；
 *   2. 统计每个组合在 `history` 里出现过几次；
 *   3. 取次数最少的那批，用 `rand()` 在其中挑一个（同 seed 可复现）。
 * `history` 为空时等价于随机挑一格 —— 第一批总得从某处开始。
 */
export function assignCell(input: {
  channel: string;
  setPieces: string[];
  families: string[];
  history: SamplingCell[];
  rand: () => number;
  angles?: readonly TestAngle[];
}): SamplingAssignment | null {
  const { channel, setPieces, families, history, rand } = input;
  const angles = input.angles ?? TEST_ANGLES;
  const candidates: Omit<SamplingCell, 'channel'>[] = [];
  for (const setPiece of setPieces) {
    for (const tropeFamily of families) {
      for (const testAngle of angles) candidates.push({ setPiece, tropeFamily, testAngle });
    }
  }
  if (candidates.length === 0) return null;

  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(cellKey({ channel, ...c }), 0);
  for (const h of history) {
    const k = cellKey(h);
    if (counts.has(k)) counts.set(k, counts.get(k)! + 1);
  }
  const min = Math.min(...[...counts.values()]);
  const coldest = candidates.filter((c) => counts.get(cellKey({ channel, ...c })) === min);
  const pick = coldest[Math.floor(rand() * coldest.length)] ?? coldest[0]!;
  return {
    channel,
    ...pick,
    reason: `${cellKey({ channel, ...pick })}（历史 ${min} 次，全场最冷）`,
  };
}

/**
 * 覆盖矩阵（B2 内容侧）：把历史汇总成「格 → 次数」，并给出还没被写过的格。
 * `universe` 由调用方给（`lab check` 能列出全集），这样「空格」是可枚举的，而不是靠推断。
 */
export function contentCoverage(input: {
  history: SamplingCell[];
  universe?: { channel: string; setPieces: string[]; families: string[] }[];
  angles?: readonly TestAngle[];
}): { used: { cell: string; count: number }[]; empty: string[] } {
  const angles = input.angles ?? TEST_ANGLES;
  const counts = new Map<string, number>();
  for (const h of input.history) counts.set(cellKey(h), (counts.get(cellKey(h)) ?? 0) + 1);
  const empty: string[] = [];
  for (const u of input.universe ?? []) {
    for (const setPiece of u.setPieces) {
      for (const tropeFamily of u.families) {
        for (const testAngle of angles) {
          const k = cellKey({ channel: u.channel, setPiece, tropeFamily, testAngle });
          if (!counts.has(k)) empty.push(k);
        }
      }
    }
  }
  const used = [...counts.entries()]
    .map(([cell, count]) => ({ cell, count }))
    .sort((a, b) => a.count - b.count || a.cell.localeCompare(b.cell));
  return { used, empty };
}
