import type { Workspace } from '@endless/content';
import {
  LifecycleCommandSchema, LifecycleStateSchema,
  type LifecycleState, type LifecycleEntry, type LifecycleReceipt,
} from '@endless/cloud-contracts';
import { sameMetadata } from './metadata.js';

export type { LifecycleState } from '@endless/cloud-contracts';
export const emptyLifecycle = (): LifecycleState => ({ format: 'lifecycle-outbox/1', cursor: null, changeSeq: 0, known: {}, pending: {} });
export const lifecycleValue = (entry: Workspace['entries'][number]): LifecycleEntry['value'] => ({
  lifecycle: entry.lifecycle, trashedAt: entry.trashedAt, archiveVolumeId: entry.archiveVolumeId,
});
const baseline = (entry: Workspace['entries'][number]): LifecycleEntry => ({
  contentId: entry.id, sourceKind: entry.sourceKind, version: 0, value: lifecycleValue(entry), updatedAt: entry.updatedAt,
});
export const initialLifecycle = (workspace: Workspace): LifecycleState => ({
  ...emptyLifecycle(), known: Object.fromEntries(workspace.entries.map((entry) => [entry.id, baseline(entry)])),
});
export function parseLifecycle(raw: unknown, workspaceId: string): LifecycleState {
  const state = raw === undefined ? emptyLifecycle() : LifecycleStateSchema.parse(raw);
  if (Object.values(state.pending).some((entry) => entry.request.workspaceId !== workspaceId)) throw new Error('回收站命令不属于本机工作区');
  return state;
}

export function enqueueLifecycle(state: LifecycleState, before: Workspace['entries'], after: Workspace['entries'], workspaceId: string): LifecycleState {
  const next = structuredClone(state);
  for (const entry of after) {
    const old = before.find((e) => e.id === entry.id);
    if (!old || sameMetadata(lifecycleValue(old), lifecycleValue(entry))) continue;
    if (entry.sourceKind !== 'generated') throw new Error('预置内容不能移入回收站');
    if (entry.lifecycle === old.lifecycle) throw new Error('云端尚未接入归档命令，不能只改归档位置');
    if (next.pending[entry.id]) throw new Error('这条内容的回收站命令尚未同步或存在冲突，请先处理');
    next.known[entry.id] ??= baseline(old);
    next.pending[entry.id] = { request: LifecycleCommandSchema.parse({ workspaceId, commandId: crypto.randomUUID(),
      contentId: entry.id, baseVersion: next.known[entry.id]!.version, type: entry.lifecycle === 'trashed' ? 'trash' : 'restore' }) };
  }
  return next;
}

function remember(state: LifecycleState, entry: LifecycleEntry, historical: boolean) {
  const known = state.known[entry.contentId];
  if (known && entry.version < known.version) {
    if (!historical) throw new Error('云端生命周期版本回退，原件保留');
    return;
  }
  if (known && (known.sourceKind !== entry.sourceKind || (known.version === entry.version && !sameMetadata(known, entry)))) {
    throw new Error('相同生命周期版本的正文或来源不同，已停止同步');
  }
  state.known[entry.contentId] = entry;
}

export function mergeLifecycle(state: LifecycleState, entries: LifecycleEntry[], local: Workspace['entries'], workspaceId: string, historical = false): LifecycleState {
  if (!historical && (entries.length !== local.length || local.some((entry) => !entries.some((e) => e.contentId === entry.id)))) throw new Error('生命周期清单不完整，原件保留');
  const next = structuredClone(state);
  for (const entry of entries) {
    const own = local.find((e) => e.id === entry.contentId);
    if (!own || own.sourceKind !== entry.sourceKind) throw new Error('生命周期变更引用未知内容或来源不同');
    if (!next.known[entry.contentId] && !next.pending[entry.contentId] && !sameMetadata(lifecycleValue(own), entry.value)) {
      if (own.lifecycle === entry.value.lifecycle) throw new Error('旧副本有尚不支持同步的归档差异，原件保留');
      const request = LifecycleCommandSchema.parse({ workspaceId, commandId: crypto.randomUUID(), contentId: entry.contentId,
        baseVersion: entry.version, type: own.lifecycle === 'trashed' ? 'trash' : 'restore' });
      next.pending[entry.contentId] = { request, conflict: { workspaceId, commandId: request.commandId, outcome: 'conflict', entry } };
    }
    remember(next, entry, historical);
  }
  return next;
}

export function receiveLifecycle(state: LifecycleState, receipt: LifecycleReceipt): LifecycleState {
  const next = structuredClone(state), held = next.pending[receipt.entry.contentId];
  if (!held || held.request.commandId !== receipt.commandId || held.request.workspaceId !== receipt.workspaceId
    || (receipt.outcome === 'applied' && (receipt.entry.version !== held.request.baseVersion + 1
      || receipt.entry.value.lifecycle !== (held.request.type === 'trash' ? 'trashed' : 'active')))) throw new Error('回收站回执与原命令不一致');
  remember(next, receipt.entry, true);
  if (receipt.outcome === 'applied') delete next.pending[receipt.entry.contentId];
  else held.conflict = receipt;
  return next;
}

export function lifecycleEntries(entries: Workspace['entries'], state: LifecycleState): Workspace['entries'] {
  return entries.map((entry) => {
    const known = state.known[entry.id];
    if (!known || state.pending[entry.id] || sameMetadata(lifecycleValue(entry), known.value)) return entry;
    return { ...entry, ...known.value, updatedAt: known.updatedAt };
  });
}
