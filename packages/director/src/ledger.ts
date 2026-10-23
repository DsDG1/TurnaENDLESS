/** 梗台账（第 5.10 节）：确定性地对抗 LLM 创意输出趋同。 */
export interface LedgerEntry {
  batch: string;
  tropes: string[];
  logline: string;
  sceneSequence: string[];
  cast: string[];
  punchlineType?: string;
  location?: string;
  /** 本批所属频道（B2 内容侧覆盖矩阵用） */
  channel?: string;
  /** 采样格（B1）：本批被指定的 set_piece / 梗族 / 检测角度；没开采样时为空 */
  setPiece?: string;
  tropeFamily?: string;
  testAngle?: string;
}

export const LEDGER_WINDOW = 20;

export class TropeLedger {
  private entries: LedgerEntry[] = [];

  add(entry: LedgerEntry): void {
    this.entries.push(entry);
    if (this.entries.length > LEDGER_WINDOW) this.entries.splice(0, this.entries.length - LEDGER_WINDOW);
  }

  window(): LedgerEntry[] {
    return [...this.entries];
  }

  /** 与最近 W 批的梗重合率（本批梗标签中出现在台账里的比例）。 */
  overlapRatio(tropes: string[]): number {
    if (tropes.length === 0) return 0;
    const used = new Set(this.window().flatMap((e) => e.tropes));
    const hit = tropes.filter((t) => used.has(t)).length;
    return hit / tropes.length;
  }

  /** 最近 n 批的场景类型序列（W-SEQUENCE-REPEAT 与编剧室预检用）。 */
  recentSequences(n = 5): string[][] {
    return this.window().slice(-n).map((e) => e.sceneSequence);
  }

  /** 导演上下文里的「禁止复用」文本块。 */
  forbiddenText(): string {
    const win = this.window();
    if (win.length === 0) return '（暂无历史，注意不要重复自己）';
    const lines = win.map((e) => `- ${e.batch}：${e.tropes.join('/')}｜${e.sceneSequence.join('>')}｜${e.logline}`);
    return `最近 ${win.length} 批（窗口 ${LEDGER_WINDOW}），以下梗与结构禁止复用：\n${lines.join('\n')}`;
  }
}
