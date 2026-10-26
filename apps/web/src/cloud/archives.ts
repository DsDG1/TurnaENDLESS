import { ArchiveVolumeSchema, type ArchiveVolume, type Workspace } from '@endless/content';
import { ArchiveOutboxSchema, type ArchiveOutbox, type ArchiveState, type ArchiveReceipt } from '@endless/cloud-contracts';
import { sameMetadata } from './metadata.js';

export type ParsedArchiveState = { version: number; volumes: ArchiveVolume[] };
export type ArchiveView = Omit<ArchiveOutbox, 'known'> & { known: ParsedArchiveState | null };
export const emptyArchives = (): ArchiveView => ({ format: 'archive-outbox/1', known: null, pending: null });
const ordered = (volumes: ArchiveVolume[]) => [...volumes].sort((a, b) => a.id.localeCompare(b.id));
export function nativeArchiveState(state: ArchiveState): ParsedArchiveState {
  const volumes = ArchiveVolumeSchema.array().max(500).parse(state.volumes);
  if (!sameMetadata(volumes, state.volumes) || new Set(volumes.map((v) => v.id)).size !== volumes.length) throw new Error('归档正文含未知字段或重复身份，原件保留');
  return { version: state.version, volumes: ordered(volumes) };
}
export function parseArchives(raw: unknown, workspaceId: string): ArchiveView {
  const state = raw === undefined ? emptyArchives() : ArchiveOutboxSchema.parse(raw);
  if (state.pending?.request.workspaceId !== undefined && state.pending.request.workspaceId !== workspaceId) throw new Error('归档命令来自其他工作区');
  return { ...state, known: state.known ? nativeArchiveState(state.known) : null };
}
export const initialArchives = (workspace: Workspace): ArchiveView => ({ ...emptyArchives(), known: nativeArchiveState({ version: 0, volumes: workspace.volumes }) });
export function rememberArchives(outbox: ArchiveView, state: ArchiveState, workspace: Workspace, historical = false): ArchiveView {
  const next = nativeArchiveState(state);
  if (outbox.known && state.version < outbox.known.version) {
    if (!historical) throw new Error('归档版本回退，原件保留');
    return outbox;
  }
  if (outbox.known && next.version === outbox.known.version && !sameMetadata(next.volumes, outbox.known.volumes)) throw new Error('相同归档版本的正文不同，原件保留');
  if (!outbox.known && !sameMetadata(ordered(workspace.volumes), next.volumes)) throw new Error('旧副本有未经同步的归档差异，原件已保留，不能覆盖');
  return { ...outbox, known: next };
}
export function acceptArchiveReceipt(outbox: ArchiveView, receipt: ArchiveReceipt): void {
  const request = outbox.pending?.request;
  if (!request || receipt.commandId !== request.commandId || receipt.workspaceId !== request.workspaceId) throw new Error('归档回执与原请求不一致');
  if (receipt.outcome !== 'applied') return;
  const state = nativeArchiveState(receipt.snapshot.state);
  if (state.version !== request.baseVersion + 1) throw new Error('归档回执版本不一致');
  const volume = state.volumes.find((v) => v.id === request.volumeId);
  if (request.type === 'unarchive') { if (volume) throw new Error('取消归档回执仍含目标卷'); return; }
  if (!volume || volume.title !== request.title || volume.derivedFrom.branchId !== request.basis.streamId
    || volume.derivedFrom.eventCount !== request.basis.eventCount || volume.derivedFrom.eventHash !== request.basis.eventHash
    || !sameMetadata(volume.members.map(({ contentId, revisionId }) => ({ contentId, revisionId })), request.members.map(({ contentId, revisionId }) => ({ contentId, revisionId })))) throw new Error('归档结果与冻结的成员、前缀或标题不一致');
}

/** A concurrent pending restore can keep its intent while the canonical graph changes; never retain a dangling archive pointer. */
export function archivePositions(entries: Workspace['entries'], volumes: ArchiveVolume[]): Workspace['entries'] {
  return entries.map((entry) => {
    const memberships = volumes.filter((volume) => volume.members.some((m) => m.contentId === entry.id));
    if (entry.lifecycle === 'active' && memberships.length > 1) throw new Error('活跃内容属于多个归档卷，原件保留');
    const archiveVolumeId = entry.lifecycle === 'active' ? memberships[0]?.id ?? null
      : volumes.some((v) => v.id === entry.archiveVolumeId) ? entry.archiveVolumeId : null;
    return archiveVolumeId === entry.archiveVolumeId ? entry : { ...entry, archiveVolumeId };
  });
}
