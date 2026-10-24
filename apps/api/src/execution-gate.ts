/**
 * 跨模式执行互斥（设计文档 §12.3）。
 *
 * ENDLESS 与 Edition 共用同一个显式注入的协调器：只有一个外部任务在跑时，
 * 另一模式的新任务返回可理解的 busy，不在后台偷排收费队列。
 * 这里只做「谁在跑」的资源互斥，不改任何一方的生成契约、重试或缓存。
 */
export type ExecutionMode = 'endless' | 'edition';

export class ExecutionBusyError extends Error {
  constructor(readonly holder: ExecutionMode) {
    super(holder === 'edition'
      ? 'Edition 编纂任务正在运行，请等待完成后再生成故事；不会在后台排队计费'
      : '故事生成任务正在运行，请等待完成后再开始 Edition 编纂；不会在后台排队计费');
  }
}

export class ExecutionGate {
  private holder: ExecutionMode | null = null;

  busy(): ExecutionMode | null {
    return this.holder;
  }

  acquire(mode: ExecutionMode): void {
    if (this.holder && this.holder !== mode) throw new ExecutionBusyError(this.holder);
    this.holder = mode;
  }

  /** 只释放自己持有的槽位；别人的任务不能被顺手清空。 */
  release(mode: ExecutionMode): void {
    if (this.holder === mode) this.holder = null;
  }
}
