import { contentHash, stableStringify } from '@endless/esl';
import { exportProjection, projectSession, SessionSchema } from '@endless/player';
import type { Content } from './index.js';
import { parseBackup, type Backup } from './backup.js';
import { bridge, markTicketFailed } from './workspace.js';
import { basisPrefix } from './revision.js';
import { buildVolume } from './archive.js';
import type { ArchiveVolume, Branch, ContentRevision, GenerationBasis, Workspace } from './application-contract.js';

export const CLOUD_IMPORT_VALIDATOR = 'endless-cloud-import-validation/1' as const;
export const CLOUD_COPY_POLICY = 'endless-cloud-copy/1' as const;
export const CLOUD_BACKUP_LIMITS = { bytes: 2_097_152, entries: 500, revisions: 64, branches: 16, events: 10_000 } as const;

const reject = (): never => { throw new Error('当前备份无法完整验证；原始存档保留，不会截断、迁移或覆盖'); };
const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

function sessionWithoutStamps(branch: Branch) {
  const raw = {
    ...branch.session,
    events: branch.session.events.map(({ contentId: _content, revisionId: _revision, ...event }) => event),
  };
  const session = SessionSchema.parse(raw);
  if (!same(raw, session)) reject();
  return session;
}

function checkStamps(workspace: Workspace, branch: Branch, adopted = branch.adopted, count = branch.session.events.length) {
  const revisions = new Map(workspace.revisions.map((revision) => [revision.id, revision]));
  for (const event of branch.session.events.slice(0, count)) {
    const owner = adopted.find((entry) => revisions.get(entry.revisionId)?.episodeId === event.episode);
    if (!owner || (event.contentId !== undefined && event.contentId !== owner.contentId)
      || (event.revisionId !== undefined && event.revisionId !== owner.revisionId)
      || ((event.contentId === undefined) !== (event.revisionId === undefined))) reject();
  }
}

function checkBasis(content: Content, workspace: Workspace, basis: GenerationBasis) {
  const branch = workspace.branches.find((entry) => entry.id === basis.branchId) ?? reject();
  if (basis.catalogVersion !== content.pilot.version || basis.eventCount > branch.session.events.length
    || new Set(basis.adopted.map((entry) => entry.contentId)).size !== basis.adopted.length) reject();
  for (const entry of basis.adopted) {
    if (!workspace.revisions.some((revision) => revision.id === entry.revisionId && revision.contentId === entry.contentId)) reject();
  }
  const normalized = sessionWithoutStamps(branch);
  const prefix = { ...normalized, events: normalized.events.slice(0, basis.eventCount) };
  if (content.historyKey(prefix).hash !== basis.eventHash) reject();
  checkStamps(workspace, branch, basis.adopted, basis.eventCount);
}

function volumeProjection(content: Content, workspace: Workspace, volume: ArchiveVolume) {
  const branch = workspace.branches.find((entry) => entry.id === volume.derivedFrom.branchId) ?? reject();
  if (volume.derivedFrom.eventCount > branch.session.events.length || volume.strategy.version !== 1) reject();
  const runtime = bridge(content, workspace, branch.id);
  runtime.session = { ...runtime.session, events: runtime.session.events.slice(0, volume.derivedFrom.eventCount) };
  if (content.historyKey(runtime.session).hash !== volume.derivedFrom.eventHash) reject();
  for (const member of volume.members) {
    if (!branch.adopted.some((entry) => entry.contentId === member.contentId && entry.revisionId === member.revisionId)) reject();
  }
  return buildVolume(workspace, runtime, volume.members.map((member) => member.contentId), volume.title);
}

/** The same projection check is used for imported and synchronized archive bodies. No caller-supplied read/quote claim is authoritative. */
export function validateArchiveProjection(content: Content, workspace: Workspace, volume: ArchiveVolume): void {
  const expected = volumeProjection(content, workspace, volume);
  for (const key of ['members', 'series', 'facts', 'choices', 'threads', 'reading', 'quotes'] as const) {
    if (!same(volume[key], expected[key])) reject();
  }
}

export function validateCloudBackup(content: Content, raw: unknown): Backup {
  const backup = parseBackup(raw).backup;
  if (!same(raw, backup)) reject();
  const workspace = backup.workspace.data;
  if (workspace.entries.length > CLOUD_BACKUP_LIMITS.entries || workspace.revisions.length > CLOUD_BACKUP_LIMITS.revisions
    || workspace.branches.length > CLOUD_BACKUP_LIMITS.branches
    || workspace.branches.reduce((count, branch) => count + branch.session.events.length, 0) > CLOUD_BACKUP_LIMITS.events
    || workspace.identity.workspaceId.length > 128 || workspace.profile.id.length > 128) reject();
  const bundled = workspace.revisions.filter((revision) => revision.origin === 'bundled');
  if (bundled.length !== content.pilot.episodes.length || new Set(bundled.map((revision) => revision.episodeId)).size !== bundled.length) reject();
  for (const revision of bundled) {
    if (revision.origin !== 'bundled') reject();
    const episode = content.pilot.episodes.find((entry) => entry.id === revision.catalogId && entry.id === revision.episodeId);
    if (!episode || revision.hash !== contentHash(stableStringify(episode.ast))
      || revision.title !== episode.title || revision.subtitle !== episode.subtitle || revision.description !== episode.description) reject();
  }
  for (const branch of workspace.branches) {
    const normalized = sessionWithoutStamps(branch);
    if (normalized.catalog !== content.pilot.version) reject();
    checkStamps(workspace, branch);
    for (const revision of bundled) if (!branch.adopted.some((entry) => entry.contentId === revision.contentId && entry.revisionId === revision.id)) reject();
  }
  const done = new Set<string>();
  const visiting = new Set<string>();
  const verifyRevision = (revision: ContentRevision): void => {
    if (done.has(revision.id)) return;
    if (visiting.has(revision.id)) reject();
    visiting.add(revision.id);
    checkBasis(content, workspace, revision.basis);
    if (revision.draft !== revision.creation.draft || revision.episodeId !== revision.batch.batch) reject();
    for (const adopted of revision.basis.adopted) {
      const dependency = workspace.revisions.find((entry) => entry.id === adopted.revisionId)!;
      if (dependency.origin !== 'bundled') verifyRevision(dependency);
    }
    const prefix = basisPrefix(content, workspace, revision.basis);
    content.accept({
      version: 1, generatedAt: revision.plannedAt,
      basedOn: { eventCount: revision.basis.eventCount, hash: revision.basis.eventHash },
      title: revision.title, subtitle: revision.subtitle, description: revision.description,
      batch: revision.batch, hash: revision.hash, learningVersion: 4, creation: revision.creation,
    }, prefix.save);
    visiting.delete(revision.id);
    done.add(revision.id);
  };
  for (const revision of workspace.revisions) if (revision.origin !== 'bundled') verifyRevision(revision);
  for (const branch of workspace.branches) bridge(content, workspace, branch.id);
  for (const ticket of workspace.tickets) if (ticket.status === 'reserved' || ticket.status === 'submitted') {
    checkBasis(content, workspace, ticket.basis);
  }
  for (const checkpoint of workspace.checkpoints) {
    const runtime = bridge(content, workspace, checkpoint.branchId);
    runtime.session = { ...runtime.session, events: runtime.session.events.slice(0, checkpoint.eventPrefix.count) };
    if (!same(checkpoint.state, json(exportProjection(projectSession(runtime.session, runtime.library))))) reject();
  }
  for (const volume of workspace.volumes) {
    validateArchiveProjection(content, workspace, volume);
  }
  return backup;
}

export function deriveCloudCopy(backup: Backup, at: string, content?: Content): Workspace {
  let copy = structuredClone(backup.workspace.data);
  for (const ticket of copy.tickets) if (ticket.status === 'reserved' || ticket.status === 'submitted') {
    copy = markTicketFailed(copy, ticket.id, 'local-origin-only', new Date(at));
  }
  if (content) copy.volumes = copy.volumes.map((volume) => ({
    ...volumeProjection(content, copy, volume), id: volume.id, createdAt: volume.createdAt, checkpointId: volume.checkpointId,
  }));
  else if (copy.volumes.length) throw new Error('归档副本必须使用已验证内容上下文重建');
  return { ...copy, identity: { ...copy.identity, repositoryRevision: 0 } };
}
