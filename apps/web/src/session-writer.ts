import type { Workspace } from '@endless/content';

/**
 * 写入协调层：只负责「内存工作区 → 递增 repositoryRevision → 原子提交 → 推进基线」。
 *
 * 抽成不依赖 React 的类，是因为这里的三条不变量最容易在异常路径上被破坏，
 * 而它们都需要在 Node 里用 fake-indexeddb 直接测：
 *   1. 只有提交成功才推进基线（否则下一次写入会被自己的 CAS 拒掉）；
 *   2. 导入备份同样要推进基线（导入后第一次答题不应该报「另一个窗口已更新」）；
 *   3. 提交失败必须把原因交回调用方（用于保留生成票据引用、提示可重试）。
 */
export interface WorkspaceCommitter {
  commit(next: Workspace, options?: { closingTicketId?: string }): Promise<void>;
}

export type CommitResult =
  | { ok: true; workspace: Workspace }
  | { ok: false; error: string };

export class SessionCommitter {
  private revision: number;

  constructor(private committer: WorkspaceCommitter, initialRevision: number) {
    this.revision = initialRevision;
  }

  /** 已提交的 repositoryRevision；-1 表示还没有任何存档。 */
  get committedRevision() {
    return this.revision;
  }

  /** 把内存工作区落到「已提交版本 + 1」，交给仓库做 CAS。 */
  bump(workspace: Workspace): Workspace {
    return { ...workspace, identity: { ...workspace.identity, repositoryRevision: this.revision + 1 } };
  }

  async commit(next: Workspace, options: { closingTicketId?: string } = {}): Promise<CommitResult> {
    const committed = this.bump(next);
    try {
      await this.committer.commit(committed, options);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '操作未保存，请重试' };
    }
    this.revision = committed.identity.repositoryRevision;
    return { ok: true, workspace: committed };
  }
}
