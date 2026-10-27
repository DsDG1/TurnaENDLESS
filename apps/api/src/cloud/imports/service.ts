import { createHash, randomUUID } from 'node:crypto';
import { stableStringify } from '@endless/esl';
import { contracts, newId, type Backup, type Content, type Workspace } from '@endless/content';
import { CLOUD_BACKUP_LIMITS, CLOUD_COPY_POLICY, CLOUD_IMPORT_VALIDATOR, deriveCloudCopy, validateCloudBackup } from '@endless/content/cloud';
import {
  UuidSchema, type ActivateImportRequest, type CloudImportPreview, type CloudImportReceipt,
  type InstallWorkspaceRequest, type WorkspaceInstallation,
} from '@endless/cloud-contracts';
import type { AuthContext } from '../auth/service.js';
import type { CloudPool, Querier } from '../db/client.js';
import { lockAccount } from '../db/locks.js';
import type { CloudDeployment } from '../deployment.js';
import { CloudError, idempotencyMismatch, notFound } from '../errors.js';
import { commitObjectGraph, type ObjectService } from '../objects/service.js';
import { seedSyncStreams } from '../sync/service.js';

interface PreviewRow {
  id: string;
  workspace_id: string;
  object_id: string;
  source_digest: string;
  snapshot_digest: string;
  validation_binding: string;
  details: Omit<CloudImportPreview, 'state' | 'expiresAt'>;
  state: 'preparing' | 'ready' | 'activated';
  expires_at: Date;
  retained: boolean;
}

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const changed = () => new CloudError(409, 'BASIS_CHANGED', 'contract', '来源存档、预览或验证版本已变化；不会覆盖既有云副本', 'resolve_conflict');
const expired = () => new CloudError(409, 'UPLOAD_EXPIRED', 'storage', '导入预览已过期，原件和游客存档保留');
const rejected = () => new CloudError(422, 'CONTENT_REJECTED', 'contract', '备份格式、正文、引用、历史或容量未通过完整验证；原存档保留');
const previewSelect = 'SELECT *, expires_at > now() AS retained FROM import_previews';

async function claim(q: Querier, account: string, operation: string, key: string, digest: string) {
  await q.query(
    `INSERT INTO idempotency_keys (account_id, operation, key, request_digest)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [account, operation, key, Buffer.from(digest, 'hex')],
  );
  const row = (await q.query<{ request_digest: Buffer; response: any }>(
    'SELECT request_digest, response FROM idempotency_keys WHERE account_id = $1 AND operation = $2 AND key = $3 FOR UPDATE',
    [account, operation, key],
  )).rows[0]!;
  if (row.request_digest.toString('hex') !== digest) throw idempotencyMismatch();
  return row.response;
}

async function finish(q: Querier, account: string, operation: string, key: string, response: unknown) {
  await q.query(
    `UPDATE idempotency_keys SET status_code = 200, response = $4, completed_at = now()
     WHERE account_id = $1 AND operation = $2 AND key = $3`,
    [account, operation, key, JSON.stringify(response)],
  );
}

export async function reserveContentIdentity(q: Querier, account: string, workspace: string, deliveryKey: string) {
  if (!UuidSchema.safeParse(deliveryKey).success) throw rejected();
  const held = await q.query("SELECT id FROM workspaces WHERE account_id = $1 AND id = $2 AND status = 'active' FOR UPDATE", [account, workspace]);
  if (!held.rows[0]) throw notFound();
  await q.query(
    `INSERT INTO cloud_content_identities (account_id, workspace_id, delivery_key, content_id, revision_id)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [account, workspace, deliveryKey, newId('content'), newId('revision')],
  );
  const row = (await q.query<{ content_id: string; revision_id: string }>(
    'SELECT content_id, revision_id FROM cloud_content_identities WHERE account_id = $1 AND workspace_id = $2 AND delivery_key = $3',
    [account, workspace, deliveryKey],
  )).rows[0]!;
  return { contentId: row.content_id, revisionId: row.revision_id };
}

export class ImportService {
  readonly validationBinding: string;

  constructor(
    private readonly app: CloudPool,
    private readonly objects: ObjectService,
    private readonly content: Content,
    deployment: CloudDeployment,
  ) {
    this.validationBinding = sha(stableStringify({
      validator: CLOUD_IMPORT_VALIDATOR, copyPolicy: CLOUD_COPY_POLICY, contracts, deployment: deployment.id,
      catalog: content.pilot, lexicon: [...content.lexicon.entries],
    }));
  }

  private validate(bytes: Buffer): Backup {
    if (!bytes.length || bytes.length > CLOUD_BACKUP_LIMITS.bytes) throw rejected();
    try { return validateCloudBackup(this.content, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
    catch { throw rejected(); }
  }

  private async previewRow(ctx: AuthContext, id: string) {
    if (!UuidSchema.safeParse(id).success) throw notFound();
    const row = (await this.app.withTenant(ctx.accountId, (q) => q.query<PreviewRow>(
      `${previewSelect} WHERE account_id = $1 AND id = $2`, [ctx.accountId, id],
    ))).rows[0];
    if (!row) throw notFound();
    return row;
  }

  private wire(row: PreviewRow): { preview: CloudImportPreview } {
    if (row.state === 'preparing') throw new CloudError(409, 'IDEMPOTENCY_IN_PROGRESS', 'storage', '原导入尚未完成校验，请沿用原请求恢复', 'resume_same_request');
    return { preview: {
      ...row.details, state: row.state, expiresAt: row.expires_at.toISOString(),
      relationship: row.state === 'activated' ? 'same-import' : row.details.relationship,
    } };
  }

  async previewStatus(ctx: AuthContext, id: string) {
    return this.wire(await this.previewRow(ctx, id));
  }

  async preview(ctx: AuthContext, bytes: Buffer, key: string) {
    const backup = this.validate(bytes);
    const workspace = backup.workspace.data;
    const sourceDigest = sha(bytes);
    const snapshotDigest = sha(stableStringify(backup.workspace));
    const allocated = { preview: randomUUID(), workspace: randomUUID(), object: randomUUID() };
    let row = await this.app.withTenant(ctx.accountId, async (q) => {
      await lockAccount(q, ctx.accountId);
      const previous = await claim(q, ctx.accountId, 'import_preview', key, sourceDigest);
      if (previous?.previewId) return (await q.query<PreviewRow>(
        `${previewSelect} WHERE account_id = $1 AND id = $2`, [ctx.accountId, previous.previewId],
      )).rows[0]!;
      let cloud = (await q.query<{ id: string; status: string }>(
        'SELECT id, status FROM workspaces WHERE account_id = $1 AND source_local_id = $2 FOR UPDATE',
        [ctx.accountId, workspace.identity.workspaceId],
      )).rows[0];
      const relationship = cloud ? 'empty-workspace' as const : 'new' as const;
      if (cloud?.status === 'archived') throw changed();
      if (!cloud) cloud = (await q.query<{ id: string; status: string }>(
        `INSERT INTO workspaces (id, account_id, source_local_id, contract, status)
         VALUES ($1, $2, $3, 'endless-workspace/1', 'staging') RETURNING id, status`,
        [allocated.workspace, ctx.accountId, workspace.identity.workspaceId],
      )).rows[0]!;
      const installed = (await q.query<{ receipt: CloudImportReceipt }>(
        'SELECT receipt FROM workspace_imports WHERE account_id = $1 AND workspace_id = $2', [ctx.accountId, cloud.id],
      )).rows[0];
      if (installed && (installed.receipt.snapshotDigest !== snapshotDigest || installed.receipt.validationBinding !== this.validationBinding)) throw changed();
      let held = (await q.query<PreviewRow>(
        `${previewSelect} WHERE account_id = $1 AND workspace_id = $2 AND snapshot_digest = $3 AND validation_binding = $4`,
        [ctx.accountId, cloud.id, snapshotDigest, this.validationBinding],
      )).rows[0];
      if (!held) {
        await this.objects.prepareInTransaction(q, ctx, {
          id: allocated.object, workspaceId: cloud.id, domainId: `import:${allocated.preview}`,
          contract: 'endless-backup/1', digest: sourceDigest, size: bytes.length,
        });
        const details: PreviewRow['details'] = {
          id: allocated.preview, workspaceId: cloud.id, sourceLocalId: workspace.identity.workspaceId,
          sourceProfileId: workspace.profile.id, sourceRepositoryRevision: workspace.identity.repositoryRevision,
          sourceDigest, snapshotDigest, objectId: allocated.object, size: bytes.length, counts: backup.manifest.counts,
          eventCount: workspace.branches.reduce((total, branch) => total + branch.session.events.length, 0),
          pendingLocalTickets: workspace.tickets.filter((ticket) => ['reserved', 'submitted'].includes(ticket.status)).length,
          sourceKinds: [...new Set(workspace.entries.map((entry) => entry.sourceKind))],
          relationship, validationBinding: this.validationBinding, copyPolicy: CLOUD_COPY_POLICY,
        };
        held = (await q.query<PreviewRow>(
          `INSERT INTO import_previews (account_id, id, workspace_id, object_id, source_digest, snapshot_digest, validation_binding, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *, true AS retained`,
          [ctx.accountId, allocated.preview, cloud.id, allocated.object, sourceDigest, snapshotDigest, this.validationBinding, JSON.stringify(details)],
        )).rows[0]!;
      }
      await finish(q, ctx.accountId, 'import_preview', key, { previewId: held.id });
      return held;
    });
    if (!row.retained && row.state !== 'activated') throw expired();
    if (row.validation_binding !== this.validationBinding) throw changed();
    if (row.state === 'preparing') {
      if (row.source_digest !== sourceDigest) throw new CloudError(409, 'IDEMPOTENCY_IN_PROGRESS', 'storage', '相同快照的首次上传尚未完成，请使用首次保留的原始请求恢复', 'resume_same_request');
      try { await this.objects.upload(ctx, row.object_id, bytes); }
      catch (error) { if (!(error instanceof CloudError && error.code === 'UPLOAD_EXPIRED')) throw error; }
      await this.objects.verify(ctx, row.object_id);
      await this.app.withTenant(ctx.accountId, (q) => q.query(
        "UPDATE import_previews SET state = 'ready' WHERE account_id = $1 AND id = $2 AND state = 'preparing'", [ctx.accountId, row.id],
      ));
      row = await this.previewRow(ctx, row.id);
    }
    return this.wire(row);
  }

  private async source(ctx: AuthContext, row: PreviewRow) {
    if (row.validation_binding !== this.validationBinding) throw changed();
    const source = await this.objects.readVerified(ctx, row.object_id);
    if (source.object.workspaceId !== row.workspace_id || source.object.digest !== row.source_digest
      || source.object.contract !== 'endless-backup/1') throw rejected();
    const backup = this.validate(source.bytes);
    if (sha(stableStringify(backup.workspace)) !== row.snapshot_digest) throw rejected();
    return backup;
  }

  async activate(ctx: AuthContext, input: ActivateImportRequest, key: string) {
    const row = await this.previewRow(ctx, input.previewId);
    if (row.snapshot_digest !== input.snapshotDigest || row.validation_binding !== input.validationBinding
      || input.validationBinding !== this.validationBinding) throw changed();
    if (row.state === 'preparing') throw rejected();
    if (!row.retained && row.state !== 'activated') throw expired();
    const backup = await this.source(ctx, row);
    const digest = sha(stableStringify(input));
    return this.app.withTenant(ctx.accountId, async (q) => {
      await lockAccount(q, ctx.accountId);
      const previous = await claim(q, ctx.accountId, 'import_activate', key, digest);
      if (previous) return previous as { receipt: CloudImportReceipt };
      await q.query('SELECT id FROM workspaces WHERE account_id = $1 AND id = $2 FOR UPDATE', [ctx.accountId, row.workspace_id]);
      const existing = (await q.query<{ receipt: CloudImportReceipt }>(
        'SELECT receipt FROM workspace_imports WHERE account_id = $1 AND workspace_id = $2', [ctx.accountId, row.workspace_id],
      )).rows[0];
      if (existing) {
        if (existing.receipt.snapshotDigest !== row.snapshot_digest || existing.receipt.validationBinding !== row.validation_binding) throw changed();
        await finish(q, ctx.accountId, 'import_activate', key, existing);
        return existing;
      }
      const current = (await q.query<PreviewRow>(
        `${previewSelect} WHERE account_id = $1 AND id = $2 FOR UPDATE`, [ctx.accountId, row.id],
      )).rows[0]!;
      if (!current.retained) throw expired();
      const at = (await q.query<{ at: Date }>('SELECT now() AS at')).rows[0]!.at.toISOString();
      const copy = deriveCloudCopy(backup, at, this.content);
      const receipt: CloudImportReceipt = {
        id: row.id, workspaceId: row.workspace_id, sourceLocalId: row.details.sourceLocalId,
        sourceProfileId: row.details.sourceProfileId, sourceRepositoryRevision: row.details.sourceRepositoryRevision,
        sourceObjectId: row.object_id, sourceDigest: row.source_digest, snapshotDigest: row.snapshot_digest,
        copyDigest: sha(stableStringify(copy)), copyCreatedAt: at, validationBinding: this.validationBinding, copyPolicy: CLOUD_COPY_POLICY,
        contentIds: copy.entries.map((entry) => entry.id), revisionIds: copy.revisions.map((revision) => revision.id),
        seedContentIds: copy.revisions.filter((revision) => revision.origin === 'bundled').map((revision) => revision.contentId),
      };
      const activated = await q.query(
        "UPDATE workspaces SET status = 'active', cloud_version = cloud_version + 1 WHERE account_id = $1 AND id = $2 AND status IN ('staging', 'active') RETURNING id",
        [ctx.accountId, row.workspace_id],
      );
      if (!activated.rows[0]) throw changed();
      await commitObjectGraph(q, ctx.accountId, row.workspace_id, row.object_id);
      // §8.2：第一次导入把整段前缀的事件身份一次性持久化，
      // 之后新设备在本机不需要重新分配 ID，只沿服务端绑定追加。
      await seedSyncStreams(q, ctx.accountId, row.workspace_id, copy);
      await q.query(
        `INSERT INTO workspace_imports (account_id, workspace_id, id, source_object_id, copy_digest, copy_created_at, receipt)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ctx.accountId, row.workspace_id, row.id, row.object_id, receipt.copyDigest, at, JSON.stringify(receipt)],
      );
      const mappings = [
        { kind: 'workspace', id: copy.identity.workspaceId }, { kind: 'profile', id: copy.profile.id },
        ...(['entries', 'revisions', 'branches', 'volumes', 'checkpoints', 'tickets', 'management'] as const)
          .flatMap((section, i) => copy[section].map((entry) => ({ kind: ['content', 'revision', 'branch', 'volume', 'checkpoint', 'ticket', 'management'][i], id: entry.id }))),
      ];
      await q.query(
        `INSERT INTO cloud_id_mappings (account_id, workspace_id, import_id, kind, source_id, canonical_id)
         SELECT $1, $2, $3, m.kind, m.id, m.id FROM jsonb_to_recordset($4::jsonb) AS m(kind text, id text)`,
        [ctx.accountId, row.workspace_id, row.id, JSON.stringify(mappings)],
      );
      await q.query("UPDATE import_previews SET state = 'activated' WHERE account_id = $1 AND id = $2", [ctx.accountId, row.id]);
      await q.query(
        "INSERT INTO audit_events (actor_account_id, action, object_type, object_id) VALUES ($1, 'workspace.imported', 'workspace', $2)",
        [ctx.accountId, row.workspace_id],
      );
      const response = { receipt };
      await finish(q, ctx.accountId, 'import_activate', key, response);
      return response;
    });
  }

  private async receipt(ctx: AuthContext, workspace: string) {
    if (!UuidSchema.safeParse(workspace).success) throw notFound();
    const row = (await this.app.withTenant(ctx.accountId, (q) => q.query<{ receipt: CloudImportReceipt }>(
      'SELECT receipt FROM workspace_imports WHERE account_id = $1 AND workspace_id = $2', [ctx.accountId, workspace],
    ))).rows[0];
    if (!row) throw notFound();
    return row.receipt;
  }

  async package(ctx: AuthContext, workspace: string): Promise<{ receipt: CloudImportReceipt; workspace: Workspace }> {
    const receipt = await this.receipt(ctx, workspace);
    const row = await this.previewRow(ctx, receipt.id);
    const backup = await this.source(ctx, row);
    const copy = deriveCloudCopy(backup, receipt.copyCreatedAt, this.content);
    if (sha(stableStringify(copy)) !== receipt.copyDigest) throw changed();
    return { receipt, workspace: copy };
  }

  async install(ctx: AuthContext, workspace: string, input: InstallWorkspaceRequest, key: string) {
    const receipt = await this.receipt(ctx, workspace);
    if (receipt.id !== input.importId || receipt.copyDigest !== input.copyDigest) throw changed();
    return this.app.withTenant(ctx.accountId, async (q) => {
      await lockAccount(q, ctx.accountId);
      const previous = await claim(q, ctx.accountId, 'workspace_install', key, sha(stableStringify({ workspace, ...input, device: ctx.deviceId })));
      if (previous) return previous as { installation: WorkspaceInstallation };
      await q.query(
        `INSERT INTO workspace_installations (account_id, workspace_id, import_id, device_id, copy_digest)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [ctx.accountId, workspace, receipt.id, ctx.deviceId, receipt.copyDigest],
      );
      await q.query(
        'INSERT INTO device_bindings (device_id, account_id, workspace_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [ctx.deviceId, ctx.accountId, workspace],
      );
      const row = (await q.query<{ id: string; installed_at: Date }>(
        'SELECT id, installed_at FROM workspace_installations WHERE account_id = $1 AND workspace_id = $2 AND import_id = $3 AND device_id = $4',
        [ctx.accountId, workspace, receipt.id, ctx.deviceId],
      )).rows[0]!;
      const response = { installation: {
        id: row.id, workspaceId: workspace, importId: receipt.id, deviceId: ctx.deviceId,
        copyDigest: receipt.copyDigest, installedAt: row.installed_at.toISOString(),
      } };
      await finish(q, ctx.accountId, 'workspace_install', key, response);
      return response;
    });
  }
}
