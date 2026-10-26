import { createHash } from 'node:crypto';
import { stableStringify } from '@endless/esl';
import { ContentRevisionSchema, type Workspace } from '@endless/content';
import { CLOUD_LIMITS, RevisionCatalogSchema, RevisionRegistrationSchema, type RevisionCatalog } from '@endless/cloud-contracts';
import type { Querier } from '../db/client.js';
import type { AuthContext } from '../auth/service.js';
import { CloudError } from '../errors.js';

export const revisionDigest = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex');
export const revisionUnsupported = () => new CloudError(409, 'UNSUPPORTED_CONTRACT', 'sync', '修订注册清单不完整或无法验证，原文与历史保留', 'contact_support');
export const revisionCapacity = () => new CloudError(413, 'STORAGE_QUOTA', 'sync', '修订分发超过当前有界容量，原修订与历史保留', 'contact_support');
export function boundRevisionCatalog(catalog: RevisionCatalog) {
  if (Buffer.byteLength(JSON.stringify(catalog)) > CLOUD_LIMITS.uploadObjectBytes - 8192) throw revisionCapacity();
}
/** Caller holds the workspace lock so the bounded snapshot and its version are from one commit. */
export async function revisionCatalog(q: Querier, ctx: AuthContext, workspaceId: string): Promise<RevisionCatalog> {
  const rows = await q.query<{ version: string; revision_id: string; content_id: string; digest: string; body: unknown }>(
    'SELECT * FROM revision_registrations WHERE account_id = $1 AND workspace_id = $2 ORDER BY version LIMIT 65', [ctx.accountId, workspaceId]);
  if (rows.rows.length > 64) throw revisionCapacity();
  const registrations = rows.rows.map((row, i) => {
    const parsed = RevisionRegistrationSchema.safeParse(row.body);
    if (!parsed.success || revisionDigest(row.body) !== row.digest || Number(row.version) !== i + 1 || parsed.data.version !== i + 1) throw revisionUnsupported();
    const item = parsed.data;
    const revision = ContentRevisionSchema.safeParse(item.artifact.revision);
    const { digest, ...artifact } = item.artifact;
    if (!revision.success || revisionDigest(revision.data) !== revisionDigest(item.artifact.revision)
      || revisionDigest(artifact) !== digest || revisionDigest(revision.data) !== item.artifact.revisionDigest
      || revision.data.id !== row.revision_id || revision.data.contentId !== row.content_id
      || item.entry.contentId !== row.content_id || item.entry.headRevisionId !== row.revision_id
      || item.display.contentId !== row.content_id || item.stream.streamId !== item.artifact.branch.streamId
      || !item.artifact.branch.adopted.some((a) => a.contentId === row.content_id && a.revisionId === row.revision_id)) throw revisionUnsupported();
    return item;
  });
  const catalog = RevisionCatalogSchema.parse({ workspaceId, version: registrations.length, registrations, digest: revisionDigest(registrations) });
  boundRevisionCatalog(catalog);
  return catalog;
}

/** Overlay registered native effects only; never rewrite an imported source, generation binding or event. */
export function withRegisteredRevisions(source: Workspace, catalog: RevisionCatalog): Workspace {
  let workspace = source;
  for (const registration of catalog.registrations) {
    const revision = ContentRevisionSchema.parse(registration.artifact.revision);
    const entry = workspace.entries.find((e) => e.id === revision.contentId);
    const parent = workspace.revisions.find((r) => r.id === revision.parentRevisionId);
    if (revisionDigest(workspace) !== registration.artifact.binding.sourceDigest
      || !entry || !parent || parent.contentId !== entry.id || workspace.revisions.some((r) => r.id === revision.id)
      || revisionDigest(registration.entry.revisionIds) !== revisionDigest([...entry.revisionIds, revision.id])) throw revisionUnsupported();
    workspace = { ...workspace, revisions: [...workspace.revisions, revision], obligations: registration.obligations,
      entries: workspace.entries.map((e) => e.id === entry.id ? { ...e, revisionIds: registration.entry.revisionIds,
        headRevisionId: revision.id, updatedAt: registration.entry.updatedAt } : e) };
  }
  return workspace;
}
