/**
 * B1 采样轴 + D3 调度理由。
 *
 * 采样器要做的是「有序填空」：每批挑历史里出现最少的组合，而不是随机碰运气。
 * 这里钉住三件事：挑的是最冷格、同 seed 可复现、空格能枚举（B2 的输入）。
 */
import { describe, expect, it } from 'vitest';
import { assignCell, cellKey, contentCoverage, TEST_ANGLES, type SamplingCell } from '../src/sampler.js';

const SET_PIECES = ['interrogation', 'clue_search'];
const FAMILIES = ['wordplay', 'character'];

/** 可复现的伪随机（测试不看分布，只看「同 seed 同结果」）。 */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe('B1 采样轴', () => {
  it('第一批从零开始，返回一个合法格子并带调度理由', () => {
    const a = assignCell({ channel: 'duck_detective', setPieces: SET_PIECES, families: FAMILIES, history: [], rand: seq([0]) });
    expect(a).not.toBeNull();
    expect(SET_PIECES).toContain(a!.setPiece);
    expect(FAMILIES).toContain(a!.tropeFamily);
    expect(TEST_ANGLES).toContain(a!.testAngle);
    expect(a!.reason).toContain('历史 0 次');
  });

  it('挑最冷格：已用过的组合不再被挑中，直到所有组合都用过一遍', () => {
    const used: SamplingCell[] = [];
    const seen = new Set<string>();
    // 12 个格子 = 2 set_piece × 2 梗族 × 3 角度：连挑 12 次应当覆盖全部，且不重复
    for (let i = 0; i < 12; i++) {
      const a = assignCell({ channel: 'duck_detective', setPieces: SET_PIECES, families: FAMILIES, history: used, rand: () => 0 })!;
      const key = cellKey(a);
      expect(seen.has(key), `第 ${i + 1} 次挑到了已经用过的格子 ${key}`).toBe(false);
      seen.add(key);
      used.push(a);
    }
    expect(seen.size).toBe(12);
  });

  it('同样的 history + 同样的 rand 序列 → 同样的选择（可复现）', () => {
    const history: SamplingCell[] = [
      { channel: 'duck_detective', setPiece: 'interrogation', tropeFamily: 'wordplay', testAngle: 'sense_pick' as never },
    ];
    const a = assignCell({ channel: 'duck_detective', setPieces: SET_PIECES, families: FAMILIES, history, rand: seq([0.1, 0.7]) });
    const b = assignCell({ channel: 'duck_detective', setPieces: SET_PIECES, families: FAMILIES, history, rand: seq([0.1, 0.7]) });
    expect(cellKey(a!)).toBe(cellKey(b!));
  });

  it('没有 set_piece 的频道（improv）返回 null，而不是造一个假格子', () => {
    expect(assignCell({ channel: 'improv', setPieces: [], families: FAMILIES, history: [], rand: () => 0 })).toBeNull();
  });

  it('覆盖矩阵：空格可枚举，已用格按次数升序排', () => {
    const universe = [{ channel: 'duck_detective', setPieces: SET_PIECES, families: FAMILIES }];
    const history: SamplingCell[] = [
      { channel: 'duck_detective', setPiece: 'interrogation', tropeFamily: 'wordplay', testAngle: 'sense_pick' as never },
      { channel: 'duck_detective', setPiece: 'interrogation', tropeFamily: 'wordplay', testAngle: 'sense_pick' as never },
    ];
    const { used, empty } = contentCoverage({ history, universe });
    expect(used[0]).toMatchObject({ count: 2 });
    // 全集 12 格，用掉 1 格 → 空 11 格
    expect(used.length).toBe(1);
    expect(empty.length).toBe(11);
  });
});
