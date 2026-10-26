import { stableStringify } from '@endless/esl';
import type { Workspace } from '@endless/content';
import {
  EditableMetadataSchema, MetadataCommandSchema, MetadataStateSchema,
  type EditableMetadata, type MetadataCommand, type MetadataEntry, type MetadataReceipt, type MetadataState,
} from '@endless/cloud-contracts';

export type { MetadataState } from '@endless/cloud-contracts';
export const emptyMetadata = (): MetadataState => ({ format: 'metadata-outbox/1', known: {}, pending: {} });
export const parseMetadata = (raw: unknown, workspaceId?: string) => {
  const state = raw === undefined ? emptyMetadata() : MetadataStateSchema.parse(raw);
  if (workspaceId && Object.values(state.pending).some((entry) => entry.request.workspaceId !== workspaceId)) {
    throw new Error('展示信息命令来自其他工作区，原件保留');
  }
  return state;
};
export const sameMetadata = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
export const editableMetadata = (value: Workspace['entries'][number]['display']): EditableMetadata =>
  EditableMetadataSchema.parse({ title: value.title, tags: value.tags, note: value.note });
const baseline = (entry: Workspace['entries'][number]): MetadataEntry => ({
  contentId: entry.id, version: 0, value: editableMetadata(entry.display), updatedAt: entry.updatedAt,
});

export function initialMetadata(workspace: Workspace): MetadataState {
  return { ...emptyMetadata(), known: Object.fromEntries(workspace.entries.map((e) => [e.id, baseline(e)])) };
}

/** Runs inside the business commit's transaction, before any request can leave the device. */
export function enqueueMetadata(state: MetadataState, before: Workspace['entries'], after: Workspace['entries'], workspaceId: string): MetadataState {
  const next = structuredClone(state);
  for (const entry of after) {
    const old = before.find((e) => e.id === entry.id);
    if (!old) continue;
    if (old.display.subtitle !== entry.display.subtitle || old.display.description !== entry.display.description) {
      throw new Error('云端目前只同步标题、标签和备注');
    }
    if (sameMetadata(editableMetadata(old.display), editableMetadata(entry.display))) continue;
    if (next.pending[entry.id]) throw new Error('这条内容的展示信息尚未同步或存在冲突，请先同步并处理后再编辑');
    const known = next.known[entry.id] ?? baseline(old);
    next.known[entry.id] = known;
    next.pending[entry.id] = { request: MetadataCommandSchema.parse({
      workspaceId, commandId: globalThis.crypto.randomUUID(), type: 'set-display',
      contentId: entry.id, baseVersion: known.version, value: editableMetadata(entry.display),
    }) };
  }
  return next;
}

/** Receipt identity must match the full saved request; an unrelated response must never release its outbox entry. */
export function receiveMetadata(state: MetadataState, receipt: MetadataReceipt): MetadataState {
  const next = structuredClone(state);
  const held = next.pending[receipt.entry.contentId];
  if (!held || receipt.commandId !== held.request.commandId || receipt.workspaceId !== held.request.workspaceId
    || (receipt.outcome === 'applied' && (receipt.entry.version !== held.request.baseVersion + 1
      || !sameMetadata(receipt.entry.value, held.request.value)))) throw new Error('展示信息回执与本机命令不一致，原请求已保留');
  const known = next.known[receipt.entry.contentId];
  if (!known || receipt.entry.version > known.version) next.known[receipt.entry.contentId] = receipt.entry;
  else if (receipt.entry.version === known.version && !sameMetadata(receipt.entry, known)) throw new Error('相同展示信息版本的正文不同，已停止同步');
  if (receipt.outcome === 'applied') delete next.pending[receipt.entry.contentId];
  else held.conflict = receipt;
  return next;
}

/** Existing local edits without a sidecar are quarantined as a conflict, never replaced on first contact. */
export function mergeMetadata(state: MetadataState, entries: MetadataEntry[], local: Workspace['entries'], workspaceId: string): MetadataState {
  if (entries.length !== local.length || local.some((entry) => !entries.some((remote) => remote.contentId === entry.id))) {
    throw new Error('云端展示信息清单不完整或引用未知内容，本机原件保留');
  }
  const next = structuredClone(state);
  for (const entry of entries) {
    const own = local.find((e) => e.id === entry.contentId);
    if (!own) throw new Error('云端展示信息引用未知内容，本机原件保留');
    const known = next.known[entry.contentId];
    if (known && entry.version < known.version) throw new Error('云端展示信息版本回退，本机原件保留');
    if (known && entry.version === known.version && !sameMetadata(entry, known)) throw new Error('相同展示信息版本的正文不同，已停止同步');
    if (!known && !next.pending[entry.contentId] && !sameMetadata(editableMetadata(own.display), entry.value)) {
      const request: MetadataCommand = { workspaceId, commandId: globalThis.crypto.randomUUID(), type: 'set-display',
        contentId: entry.contentId, baseVersion: entry.version, value: editableMetadata(own.display) };
      next.pending[entry.contentId] = { request, conflict: { workspaceId, commandId: request.commandId, outcome: 'conflict', entry } };
    }
    next.known[entry.contentId] = entry;
  }
  return next;
}

export function metadataEntries(entries: Workspace['entries'], state: MetadataState): Workspace['entries'] {
  return entries.map((entry) => {
    const known = state.known[entry.id];
    if (!known || state.pending[entry.id]) return entry;
    if (sameMetadata(editableMetadata(entry.display), known.value)) return entry;
    return { ...entry, display: { ...entry.display, ...known.value }, updatedAt: known.updatedAt };
  });
}

/** Old feed rows can precede a just-acknowledged command; they never roll a newer known version back. */
export function mergeDisplayChanges(state: MetadataState, entries: MetadataEntry[], local: Workspace['entries']): MetadataState {
  const next = structuredClone(state);
  for (const entry of entries) {
    const known = next.known[entry.contentId];
    if (!known || !local.some((e) => e.id === entry.contentId)) throw new Error('展示变更缺少本机基线或引用未知内容');
    if (entry.version < known.version) continue;
    if (entry.version === known.version && !sameMetadata(entry, known)) throw new Error('相同展示信息版本的正文不同');
    next.known[entry.contentId] = entry;
  }
  return next;
}
