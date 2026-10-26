import { bridge, parseWorkspace, type Content, type Workspace } from '@endless/content';
import { stableStringify } from '@endless/esl';
import type { ResolveConflictRequest, ResolveConflictResponse, SyncConflict } from '@endless/cloud-contracts';
import type { SidecarEntry } from './outbox.js';

export interface PendingPreservation {
  conflict: SyncConflict;
  request: Extract<ResolveConflictRequest, { decision: 'keep-branch' }>;
  workspace: Workspace;
  identities: (SidecarEntry | null)[];
}

const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

export function checkPreservation(workspace: Workspace, conflict: SyncConflict) {
  const branch = workspace.branches.find((entry) => entry.id === conflict.streamId);
  if (!branch || conflict.reason !== 'stream-head-changed' || conflict.status !== 'open') {
    throw new Error('该候选不是可保留的离线分叉；完整本机历史保留');
  }
  if (workspace.branches.length >= 64 || branch.session.events.length > 10_000) {
    throw new Error('分支或历史超过当前恢复容量，完整冲突包已隔离保留；不会删除历史腾空间');
  }
  if (workspace.tickets.some((ticket) => ticket.status === 'reserved' || ticket.status === 'submitted')) {
    throw new Error('生成任务进行中，不能处理分支冲突');
  }
  if (workspace.revisions.some((revision) => revision.origin !== 'bundled'
    && revision.basis.branchId === branch.id && revision.basis.eventCount > conflict.baseSeq)
    || workspace.tickets.some((ticket) => ticket.basis.branchId === branch.id && ticket.basis.eventCount > conflict.baseSeq)) {
    throw new Error('本机历史还有不可变生成依据引用，完整冲突包已隔离保留；不能改写旧依据');
  }
  for (const [index, entry] of conflict.events.entries()) {
    if (entry.seq !== conflict.baseSeq + index + 1 || !same(branch.session.events[entry.seq - 1], entry.event)) {
      throw new Error('候选与本机完整历史或连续位置不一致，未处理冲突');
    }
  }
}

export function preservedWorkspace(plan: PendingPreservation, result: ResolveConflictResponse, content: Content): Workspace {
  const { history, preserved } = result;
  const { conflict, request } = plan;
  const source = plan.workspace.branches.find((branch) => branch.id === conflict.streamId)!;
  if (!history || !preserved || result.conflict.id !== conflict.id || result.conflict.status !== 'preserved'
    || !same(result.conflict.events, conflict.events) || !same(result.stream, history.stream)
    || history.stream.streamId !== source.id || preserved.streamId !== request.streamId
    || history.branch.streamId !== source.id
    || history.branch.catalog !== source.session.catalog || !same(history.branch.adopted, source.adopted)
    || history.events.length !== history.stream.eventSeq
    || (history.events.at(-1)?.eventId ?? null) !== history.stream.lastEventId
    || preserved.eventSeq !== conflict.baseSeq + conflict.events.length
    || preserved.lastEventId !== conflict.events.at(-1)?.eventId) {
    throw new Error('云端保留回执与本机恢复请求不一致，完整本机历史保留');
  }
  for (let index = 0; index < conflict.baseSeq; index++) {
    if (!same(history.events[index]?.event, source.session.events[index])) throw new Error('共同前缀不一致，不能恢复主线');
  }
  for (const { event } of history.events) {
    const owner = source.adopted.find((adopted) => plan.workspace.revisions.some((revision) =>
      revision.id === adopted.revisionId && revision.episodeId === event.episode));
    if (!owner || (event.contentId === undefined) !== (event.revisionId === undefined)
      || (event.contentId !== undefined && (event.contentId !== owner.contentId || event.revisionId !== owner.revisionId))) {
      throw new Error('恢复事件的内容与修订绑定不一致，完整本机历史保留');
    }
  }
  const kept = {
    ...source, id: request.streamId, label: `${history.branch.label.slice(0, 45)} · 离线保留`,
    parentBranchId: null, forkAtEventCount: null, createdAt: conflict.createdAt,
  };
  const next: Workspace = {
    ...plan.workspace,
    activeBranchId: plan.workspace.activeBranchId === source.id ? kept.id : plan.workspace.activeBranchId,
    branches: plan.workspace.branches.map((branch) => branch.id === source.id
      ? { ...branch, session: { ...branch.session, revision: branch.session.revision + 1, events: history.events.map((entry) => entry.event) } }
      : branch.parentBranchId === source.id && (branch.forkAtEventCount ?? 0) > conflict.baseSeq
        ? { ...branch, parentBranchId: kept.id } : branch).concat(kept),
    checkpoints: plan.workspace.checkpoints.map((checkpoint) => checkpoint.branchId === source.id && checkpoint.eventPrefix.count > conflict.baseSeq
      ? { ...checkpoint, branchId: kept.id } : checkpoint),
    volumes: plan.workspace.volumes.map((volume) => volume.derivedFrom.branchId === source.id && volume.derivedFrom.eventCount > conflict.baseSeq
      ? { ...volume, derivedFrom: { ...volume.derivedFrom, branchId: kept.id } } : volume),
  };
  const checked = parseWorkspace(next);
  for (const branch of checked.branches) bridge(content, checked, branch.id);
  return checked;
}
