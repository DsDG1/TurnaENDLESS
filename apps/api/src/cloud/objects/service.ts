import { createHash } from 'node:crypto';
import {
  CLOUD_API_PREFIX, ObjectManifestSchema, PrepareObjectRequestSchema,
  UuidSchema, type CloudObject, type PrepareObjectRequest,
} from '@endless/cloud-contracts';
import type { AuthContext } from '../auth/service.js';
import type { CloudPool, Querier } from '../db/client.js';
import type { CloudDeployment } from '../deployment.js';
import { badRequest, CloudError, idempotencyMismatch, notFound, storageUnavailable } from '../errors.js';
import type { ObjectStorage } from './storage.js';

interface ObjectRow {
  account_id: string;
  id: string;
  workspace_id: string;
  domain_id: string;
  contract: PrepareObjectRequest['contract'];
  digest: string;
  size: number;
  storage_key: string;
  deployment_id: string;
  status: CloudObject['status'];
  upload_expires_at: Date;
  retain_until: Date;
  upload_open: boolean;
  retained: boolean;
}

const digestOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const rejected = () => new CloudError(422, 'CONTENT_REJECTED', 'contract', '对象正文、摘要、契约或引用不符合要求');
const expired = () => new CloudError(409, 'UPLOAD_EXPIRED', 'storage', '对象上传或暂存期限已过；原记录保留，不自动续期');
const selectObject = 'SELECT *, upload_expires_at > now() AS upload_open, retain_until > now() AS retained FROM content_objects';

function wire(row: ObjectRow): CloudObject {
  return {
    id: row.id, workspaceId: row.workspace_id, domainId: row.domain_id, contract: row.contract,
    digest: row.digest, size: row.size, digestAlgorithm: 'sha256-bytes/1', status: row.status,
    uploadExpiresAt: row.upload_expires_at.toISOString(), retainUntil: row.retain_until.toISOString(),
  };
}

async function activeWorkspace(q: Querier, accountId: string, workspaceId: string, staging = false): Promise<void> {
  const result = await q.query(
    'SELECT id FROM workspaces WHERE account_id = $1 AND id = $2 AND status = ANY($3::text[]) FOR UPDATE',
    [accountId, workspaceId, staging ? ['staging', 'active'] : ['active']],
  );
  if (!result.rows[0]) throw notFound();
}

export async function commitObjectGraph(q: Querier, accountId: string, workspaceId: string, rootId: string): Promise<void> {
  await activeWorkspace(q, accountId, workspaceId);
  const result = await q.query<ObjectRow>(
    `WITH RECURSIVE closure(id) AS (
       SELECT $3::uuid
       UNION
       SELECT r.to_object_id FROM object_references r JOIN closure c ON r.from_object_id = c.id
       WHERE r.account_id = $1 AND r.workspace_id = $2
     )
     SELECT o.*, o.retain_until > now() AS retained
     FROM content_objects o JOIN closure c ON o.id = c.id
     WHERE o.account_id = $1 AND o.workspace_id = $2 ORDER BY o.id FOR UPDATE OF o`,
    [accountId, workspaceId, rootId],
  );
  if (!result.rows.some((row) => row.id === rootId)) throw notFound();
  if (result.rows.some((row) => row.status === 'staging')) throw rejected();
  if (result.rows.some((row) => row.status !== 'committed' && !row.retained)) throw expired();
  await q.query(
    `UPDATE content_objects SET status = 'committed', committed_at = now()
     WHERE account_id = $1 AND workspace_id = $2 AND id = ANY($3::uuid[]) AND status = 'verified'`,
    [accountId, workspaceId, result.rows.map((row) => row.id)],
  );
  const root = await q.query(
    `INSERT INTO workspace_object_roots (account_id, workspace_id, object_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING object_id`,
    [accountId, workspaceId, rootId],
  );
  if (root.rows.length) await q.query(
    `INSERT INTO audit_events (actor_account_id, action, object_type, object_id)
     VALUES ($1, 'object.committed', 'object_root', $2)`,
    [accountId, rootId],
  );
}

export class ObjectService {
  constructor(
    private readonly app: CloudPool,
    private readonly storage: ObjectStorage,
    private readonly deployment: CloudDeployment,
    private readonly limits: { quotaBytes: number; backupValidator?: (raw: unknown) => void },
  ) {
    if (!Number.isSafeInteger(limits.quotaBytes) || limits.quotaBytes < 1) throw new Error('对象空间限额无效');
  }

  private async owned(ctx: AuthContext, id: string): Promise<ObjectRow> {
    if (!UuidSchema.safeParse(id).success) throw notFound();
    const result = await this.app.withTenant(ctx.accountId, (q) => q.query<ObjectRow>(
      `${selectObject} WHERE account_id = $1 AND id = $2 AND deployment_id = $3`,
      [ctx.accountId, id, this.deployment.id],
    ));
    if (!result.rows[0]) throw notFound();
    return result.rows[0];
  }

  async prepare(ctx: AuthContext, input: PrepareObjectRequest) {
    return this.app.withTenant(ctx.accountId, (q) => this.prepareInTransaction(q, ctx, input));
  }

  async prepareInTransaction(q: Querier, ctx: AuthContext, input: PrepareObjectRequest) {
    const parsed = PrepareObjectRequestSchema.safeParse(input);
    if (!parsed.success) throw badRequest('对象准备请求格式无效或契约不支持');
    input = parsed.data;
    if (input.contract === 'endless-backup/1' && !this.limits.backupValidator) {
      throw new CloudError(400, 'UNSUPPORTED_CONTRACT', 'contract', '本环境未启用存档正文验证');
    }
      await q.query('INSERT INTO account_control (account_id) VALUES ($1) ON CONFLICT DO NOTHING', [ctx.accountId]);
      await q.query('SELECT account_id FROM account_control WHERE account_id = $1 FOR UPDATE', [ctx.accountId]);
      await activeWorkspace(q, ctx.accountId, input.workspaceId, true);
      const existing = await q.query<ObjectRow>(
        `${selectObject} WHERE account_id = $1 AND (id = $2 OR (workspace_id = $3 AND contract = $4 AND domain_id = $5))`,
        [ctx.accountId, input.id, input.workspaceId, input.contract, input.domainId],
      );
      let row = existing.rows[0];
      if (row) {
        if (row.id !== input.id || row.workspace_id !== input.workspaceId || row.domain_id !== input.domainId
          || row.contract !== input.contract || row.digest !== input.digest || row.size !== input.size
          || row.deployment_id !== this.deployment.id) throw idempotencyMismatch();
      } else {
        const usage = await q.query<{ bytes: string; count: string }>(
          'SELECT COALESCE(sum(size), 0) AS bytes, count(*) AS count FROM content_objects WHERE account_id = $1',
          [ctx.accountId],
        );
        if (Number(usage.rows[0]!.bytes) + input.size > this.limits.quotaBytes || Number(usage.rows[0]!.count) >= 4096) {
          throw new CloudError(413, 'STORAGE_QUOTA', 'storage', '对象空间或数量达到当前测试限额；已有内容不会删除');
        }
        const key = `cloud/${this.deployment.id}/tenants/${ctx.accountId}/objects/${input.id}`;
        const created = await q.query<ObjectRow>(
          `INSERT INTO content_objects
           (account_id, id, workspace_id, domain_id, contract, digest, size, deployment_id, storage_key, kind)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [ctx.accountId, input.id, input.workspaceId, input.domainId, input.contract, input.digest, input.size, this.deployment.id, key,
            input.contract === 'endless-backup/1' ? 'workspace-backup' : 'manifest'],
        );
        row = created.rows[0]!;
      }
      return { object: wire(row), upload: { method: 'PUT' as const, path: `${CLOUD_API_PREFIX}/objects/${row.id}/body` } };
  }

  async upload(ctx: AuthContext, id: string, bytes: Buffer) {
    const row = await this.owned(ctx, id);
    if (bytes.length !== row.size || digestOf(bytes) !== row.digest) throw rejected();
    if (row.status !== 'staging') return { object: wire(row) };
    if (!row.upload_open) throw expired();
    await this.app.withTenant(ctx.accountId, (q) => activeWorkspace(q, ctx.accountId, row.workspace_id, true));
    await this.storage.put(row.storage_key, bytes);
    return { object: wire(row) };
  }

  private async bytes(row: ObjectRow): Promise<Buffer> {
    const bytes = await this.storage.read(row.storage_key, row.size);
    if (bytes.length !== row.size || digestOf(bytes) !== row.digest) throw storageUnavailable();
    return bytes;
  }

  async readVerified(ctx: AuthContext, id: string) {
    const row = await this.owned(ctx, id);
    if (row.status === 'staging') throw rejected();
    if (row.status !== 'committed' && !row.retained) throw expired();
    return { object: wire(row), bytes: await this.bytes(row) };
  }

  async verify(ctx: AuthContext, id: string) {
    const row = await this.owned(ctx, id);
    if (row.status !== 'committed' && !row.retained) throw expired();
    const bytes = await this.bytes(row);
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw rejected(); }
    let references: { id: string; digest: string; size: number }[] = [];
    if (row.contract === 'endless-backup/1') {
      if (!this.limits.backupValidator) throw rejected();
      try { this.limits.backupValidator(raw); } catch { throw rejected(); }
    } else {
      const manifest = ObjectManifestSchema.safeParse(raw);
      if (!manifest.success) throw rejected();
      references = manifest.data.objects;
    }
    return this.app.withTenant(ctx.accountId, async (q) => {
      await activeWorkspace(q, ctx.accountId, row.workspace_id, true);
      const current = (await q.query<ObjectRow>(
        `${selectObject} WHERE account_id = $1 AND id = $2 FOR UPDATE`, [ctx.accountId, id],
      )).rows[0];
      if (!current) throw notFound();
      if (current.status !== 'committed' && !current.retained) throw expired();
      if (current.status !== 'staging') return { object: wire(current) };
      if (references.length) {
        const targets = await q.query<ObjectRow>(
          `${selectObject} WHERE account_id = $1 AND workspace_id = $2 AND id = ANY($3::uuid[])`,
          [ctx.accountId, current.workspace_id, references.map((ref) => ref.id)],
        );
        const byId = new Map(targets.rows.map((target) => [target.id, target]));
        for (const ref of references) {
          const target = byId.get(ref.id);
          if (!target || target.status === 'staging' || (target.status !== 'committed' && !target.retained)
            || target.digest !== ref.digest || target.size !== ref.size || target.deployment_id !== this.deployment.id) throw rejected();
        }
        await q.query(
          `INSERT INTO object_references (account_id, workspace_id, from_object_id, to_object_id)
           SELECT $1, $2, $3, unnest($4::uuid[])`,
          [ctx.accountId, current.workspace_id, id, references.map((ref) => ref.id)],
        );
      }
      const updated = await q.query<ObjectRow>(
        "UPDATE content_objects SET status = 'verified', verified_at = now() WHERE account_id = $1 AND id = $2 RETURNING *",
        [ctx.accountId, id],
      );
      return { object: wire(updated.rows[0]!) };
    });
  }

  async download(ctx: AuthContext, id: string) {
    const row = await this.owned(ctx, id);
    if (row.status !== 'committed') throw notFound();
    const reachable = await this.app.withTenant(ctx.accountId, (q) => q.query(
      `WITH RECURSIVE reachable(id) AS (
         SELECT object_id FROM workspace_object_roots WHERE account_id = $1 AND workspace_id = $2
         UNION
         SELECT r.to_object_id FROM object_references r JOIN reachable c ON c.id = r.from_object_id
         WHERE r.account_id = $1 AND r.workspace_id = $2
       ) SELECT id FROM reachable WHERE id = $3`,
      [ctx.accountId, row.workspace_id, id],
    ));
    if (!reachable.rows[0]) throw notFound();
    await this.bytes(row);
    return { ...await this.storage.signDownload(row.storage_key), digest: row.digest, size: row.size };
  }

  async usage(ctx: AuthContext) {
    const result = await this.app.withTenant(ctx.accountId, (q) => q.query<{
      total: string; staging: string; verified: string; committed: string; count: string;
    }>(
      `SELECT COALESCE(sum(size), 0) AS total, count(*) AS count,
       COALESCE(sum(size) FILTER (WHERE status = 'staging'), 0) AS staging,
       COALESCE(sum(size) FILTER (WHERE status = 'verified'), 0) AS verified,
       COALESCE(sum(size) FILTER (WHERE status = 'committed'), 0) AS committed
       FROM content_objects WHERE account_id = $1`,
      [ctx.accountId],
    ));
    const row = result.rows[0]!;
    return {
      limitBytes: this.limits.quotaBytes, totalBytes: Number(row.total), stagingBytes: Number(row.staging),
      verifiedBytes: Number(row.verified), committedBytes: Number(row.committed), objectCount: Number(row.count),
    };
  }

  async unreferencedCandidates(ctx: AuthContext) {
    return this.app.withTenant(ctx.accountId, async (q) => {
      const rows = await q.query<ObjectRow>(
        `${selectObject} o WHERE account_id = $1 AND status <> 'committed' AND retain_until < now()
         AND NOT EXISTS (SELECT 1 FROM object_references r WHERE r.account_id = o.account_id AND r.to_object_id = o.id)
         AND NOT EXISTS (SELECT 1 FROM workspace_object_roots r WHERE r.account_id = o.account_id AND r.object_id = o.id)
         ORDER BY retain_until, id LIMIT 100`,
        [ctx.accountId],
      );
      return rows.rows.map(wire);
    });
  }
}
