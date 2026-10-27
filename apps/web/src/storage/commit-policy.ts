import type { Workspace } from '@endless/content';
import type { CommitOptions } from '../session-writer.js';
import { workspaceRows, type MetaRow } from './records.js';
export class WorkspaceCommitError extends Error {
}
/** Native CAS and ticket rules; call synchronously inside the adapter's read/write transaction. */
export function assertWorkspaceCommit(stored: {
  meta?: MetaRow;
  revisions: unknown[];
  branches: unknown[];
  objects: Record<string, unknown>[];
}, next: Workspace, options: CommitOptions) {
  const { meta, revisions, branches, objects } = stored;
  const rows = workspaceRows(next);
  const canonical = (value: unknown): unknown => Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value as object).sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
      : value;
  const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  // 「票据之外」的快照：meta 不含 repositoryRevision，objects 不含 ticket 行
  const snapshot = (metaRow: MetaRow | undefined, revs: unknown[], brs: unknown[], objs: Record<string, unknown>[]) => ({
    meta: metaRow && {
      identity: { ...metaRow.identity, repositoryRevision: -1 },
      profile: metaRow.profile, entries: metaRow.entries,
      obligations: metaRow.obligations, activeBranchId: metaRow.activeBranchId,
      management: metaRow.management ?? [],
    },
    revisions: revs, branches: brs, objects: objs.filter((o) => o.kind !== 'ticket'),
  });
  // 状态转换会合法地改写这些字段；其余票据字段（分支、依据、时间）必须一致
  const ticketBody = (ticket: Record<string, unknown>) => {
    const { kind: _kind, status: _status, updatedAt: _updatedAt, failureCategory: _failureCategory, resultContentId: _resultContentId, ...body } = ticket;
    return body;
  };
  const storedRev = meta?.identity?.repositoryRevision ?? -1;
  if (!meta && (revisions.length || branches.length || objects.length)) {
    throw new WorkspaceCommitError('本地存档缺少 meta 行但仍有修订或分支数据，原件保留，不能初始化');
  }
  const expected = next.identity.repositoryRevision - 1;
  if (meta && storedRev !== expected) {
    throw new WorkspaceCommitError('另一个窗口已更新进度，请刷新后继续，避免覆盖已有记录');
  }
  if (!meta && next.identity.repositoryRevision !== 0) {
    throw new WorkspaceCommitError('存档版本不匹配，请刷新后继续');
  }
  const open = (ticket: {
    status: string;
  }) => ticket.status === 'reserved' || ticket.status === 'submitted';
  const storedOpen = objects.filter((o) => o.kind === 'ticket' && open(o as {
    status: string;
  }));
  const nextOpen = next.tickets.filter(open);
  if (nextOpen.length > 1) {
    throw new WorkspaceCommitError('存在多个进行中的生成任务，状态不一致');
  }
  const restSame = () => same(snapshot(meta, revisions, branches, objects), snapshot({ ...rows.meta, management: rows.management } as MetaRow, rows.revisions, rows.branches, rows.objects));
  // 成功关闭允许夹带「该票据结果」的新增：条目/修订/义务/对象只许追加，
  // 既有行不得删改（展示信息只允许同步为采用修订的展示字段）；
  // 票据分支允许采用结果并推进会话，其余分支原样。
  const succeededDelta = (held: Record<string, unknown>, nextTicket: Record<string, unknown>) => {
    if (!meta || !same(ticketBody(held), ticketBody(nextTicket)))
      return false;
    const storedEntries = (meta!.entries ?? []) as {
      id: string;
    }[];
    const nextEntryMap = new Map(next.entries.map((e) => [e.id, e]));
    for (const before of storedEntries) {
      const after = nextEntryMap.get(before.id);
      if (!after)
        return false;
      const { display: _d, ...afterRest } = after as {
        display?: unknown;
      };
      const { display: _bd, ...beforeRest } = before as {
        display?: unknown;
      };
      if (!same(afterRest, beforeRest))
        return false;
    }
    const nextRevisionMap = new Map(rows.revisions.map((r) => [(r as {
        id: string;
      }).id, r]));
    for (const before of revisions as {
      id: string;
    }[]) {
      const after = nextRevisionMap.get(before.id);
      if (!after || !same(after, before))
        return false;
    }
    const nextBranchMap = new Map(rows.branches.map((b) => [(b as {
        id: string;
      }).id, b]));
    for (const before of branches as {
      id: string;
    }[]) {
      const after = nextBranchMap.get(before.id);
      if (!after || (before.id !== held.branchId && !same(after, before)))
        return false;
    }
    const storedObjects = objects.filter((o) => o.kind !== 'ticket');
    const nextObjectMap = new Map((rows.objects.filter((o) => o.kind !== 'ticket') as Record<string, unknown>[]).map((o) => [o.id as string, o]));
    // 结果提交不产生归档卷/检查点：非票据对象必须与存储态完全一致，不许增删改
    if (nextObjectMap.size !== storedObjects.length)
      return false;
    for (const before of storedObjects) {
      const after = nextObjectMap.get(before.id as string);
      if (!after || !same(after, before))
        return false;
    }
    const storedObligations = (meta!.obligations ?? []) as {
      contentId: string;
    }[];
    for (const before of storedObligations) {
      const after = next.obligations.find((o) => o.contentId === before.contentId);
      if (!after || !same(after, before))
        return false;
    }
    const storedManagement = (meta!.management ?? []) as unknown[];
    if (rows.management.length < storedManagement.length)
      return false;
    for (let i = 0; i < storedManagement.length; i++) {
      if (!same(storedManagement[i], rows.management[i]))
        return false;
    }
    if (next.activeBranchId !== meta!.activeBranchId)
      return false;
    if (!same(next.profile, meta!.profile))
      return false;
    return same({ ...next.identity, repositoryRevision: -1 }, { ...meta!.identity, repositoryRevision: -1 });
  };
  for (const held of storedOpen) {
    const heldId = held.id as string;
    const nextTicket = next.tickets.find((t) => t.id === heldId);
    if (!nextTicket) {
      throw new WorkspaceCommitError('进行中的生成任务不能被移除或替换，只能显式关闭');
    }
    if (open(nextTicket)) {
      if (held.status === 'submitted' && nextTicket.status === 'reserved') {
        throw new WorkspaceCommitError('生成任务状态不能回退');
      }
      if (!same(ticketBody(held), ticketBody(nextTicket as unknown as Record<string, unknown>)) || !restSame()) {
        throw new WorkspaceCommitError('生成任务进行中，不能改写票据或夹带其他写入');
      }
      continue;
    }
    if (options.closingTicketId !== heldId) {
      throw new WorkspaceCommitError('生成任务只能由持有本次操作的写入方关闭');
    }
    if (nextTicket.status === 'succeeded' && succeededDelta(held, nextTicket as unknown as Record<string, unknown>))
      continue;
    if ((nextTicket.status === 'failed' || nextTicket.status === 'cancelled')
      && same(ticketBody(held), ticketBody(nextTicket as unknown as Record<string, unknown>)) && restSame())
      continue;
    throw new WorkspaceCommitError(nextTicket.status === 'succeeded'
      ? '生成结果提交不得删改已有内容，只能追加任务结果'
      : nextTicket.status === 'failed' || nextTicket.status === 'cancelled'
        ? '取消或失败不能夹带无关的内容或事件变更'
        : '生成任务只能关闭为成功、失败或取消');
  }
}
