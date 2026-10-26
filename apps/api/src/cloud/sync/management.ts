import { createHash } from 'node:crypto';
import { stableStringify } from '@endless/esl';
import type { Workspace, Content } from '@endless/content';
import {
  CLOUD_LIMITS, LifecycleCommandSchema, LifecycleEntrySchema, ManagementChangeSchema, MetadataEntrySchema, UuidSchema,
  type LifecycleCommand, type LifecycleEntry, type LifecycleReceipt, type ManagementBootstrap, type ManagementPull,
} from '@endless/cloud-contracts';
import type { AuthContext } from '../auth/service.js';
import type { CloudPool, Querier } from '../db/client.js';
import { lockAccount } from '../db/locks.js';
import { badRequest, CloudError, idempotencyMismatch, notFound } from '../errors.js';
import type { MetadataService } from './metadata.js';
import { recordManagement } from './management-feed.js';
import { ArchiveService, archiveSnapshot } from './archives.js';
import { RevisionPreviewService } from './revisions.js';
import { revisionCatalog } from './revision-registry.js';

export async function seedLifecycle(q: Querier, accountId: string, workspaceId: string, copy: Workspace) {
  for (const entry of copy.entries) {
    const { lifecycle, trashedAt, archiveVolumeId } = entry;
    const memberships = copy.volumes.filter((volume) => volume.members.some((member) => member.contentId === entry.id));
    const restoreArchive = memberships[0]?.id ?? null;
    await q.query(`INSERT INTO content_lifecycle
      (account_id, workspace_id, content_id, source_kind, value, restore_archive_id, restore_ambiguous, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
    [accountId, workspaceId, entry.id, entry.sourceKind, JSON.stringify({ lifecycle, trashedAt, archiveVolumeId }), restoreArchive, memberships.length > 1, entry.updatedAt]);
  }
}
type Row = { content_id: string; source_kind: LifecycleEntry['sourceKind']; version: string; value: LifecycleEntry['value']; restore_archive_id: string | null; restore_ambiguous: boolean; updated_at: Date };
const wire = (row: Row): LifecycleEntry => LifecycleEntrySchema.parse({ contentId: row.content_id, sourceKind: row.source_kind,
  version: Number(row.version), value: row.value, updatedAt: row.updated_at.toISOString() });
const expired = () => new CloudError(409, 'CURSOR_EXPIRED', 'sync', '管理同步游标已过期，需要在保留本机待提交命令的前提下重新引导', 'retry_read');
const cursor = (workspace: string, seq: number, epoch: number) => Buffer.from(JSON.stringify({ kind: 'management/1', workspace, seq, epoch })).toString('base64url');
function position(raw: string, workspace: string) {
  let value;
  try { value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw badRequest('管理游标格式无效'); }
  if (!value || value.kind !== 'management/1' || value.workspace !== workspace || !Number.isSafeInteger(value.seq) || value.seq < 0
    || !Number.isSafeInteger(value.epoch) || value.epoch < 1) throw badRequest('管理游标格式无效');
  return { seq: value.seq as number, epoch: value.epoch as number };
}

export class ManagementService {
  readonly archives: ArchiveService;
  readonly revisionPreviews: RevisionPreviewService;
  constructor(private readonly app: CloudPool, private readonly metadata: MetadataService,
    private readonly source?: (ctx: AuthContext, id: string) => Promise<Workspace>, content?: Content) {
    this.archives = new ArchiveService(app, source, content, { ensure: (ctx, id) => this.ensure(ctx, id), lock: (q, ctx, id) => this.lock(q, ctx, id) });
    this.revisionPreviews = new RevisionPreviewService(app, source, content, {
      ensure: async (ctx, id) => { await this.ensure(ctx, id); await this.archives.ensure(ctx, id); },
      lock: (q, ctx, id) => this.lock(q, ctx, id),
    });
  }

  private async lock(q: Querier, ctx: AuthContext, workspaceId: string) {
    if (!UuidSchema.safeParse(workspaceId).success) throw notFound('工作区不存在');
    await lockAccount(q, ctx.accountId);
    const row = (await q.query<{ status: string; sync_epoch: string }>(
      'SELECT status, sync_epoch FROM workspaces WHERE account_id = $1 AND id = $2 FOR UPDATE', [ctx.accountId, workspaceId])).rows[0];
    if (!row) throw notFound('工作区不存在');
    if (row.status !== 'active') throw new CloudError(409, 'BASIS_CHANGED', 'sync', '工作区尚未激活或已归档', 'retry_read');
    return Number(row.sync_epoch);
  }

  private async ensure(ctx: AuthContext, workspaceId: string) {
    const present = await this.app.withTenant(ctx.accountId, async (q) => {
      await this.lock(q, ctx, workspaceId);
      return (await q.query('SELECT 1 FROM content_lifecycle WHERE account_id = $1 AND workspace_id = $2 LIMIT 1', [ctx.accountId, workspaceId])).rowCount;
    });
    if (present) return;
    await this.metadata.snapshot(ctx, workspaceId);
    const copy = await this.source?.(ctx, workspaceId);
    if (!copy) throw new CloudError(409, 'UNSUPPORTED_CONTRACT', 'sync', '旧工作区缺少可验证生命周期基线，原件保留', 'contact_support');
    await this.app.withTenant(ctx.accountId, async (q) => {
      await this.lock(q, ctx, workspaceId);
      await seedLifecycle(q, ctx.accountId, workspaceId, copy);
    });
  }

  async bootstrap(ctx: AuthContext, workspaceId: string): Promise<ManagementBootstrap> {
    await this.ensure(ctx, workspaceId);
    await this.archives.ensure(ctx, workspaceId);
    return this.app.withTenant(ctx.accountId, async (q) => {
      const epoch = await this.lock(q, ctx, workspaceId);
      const display = await q.query<{ content_id: string; version: string; value: unknown; updated_at: Date }>(
        'SELECT * FROM content_metadata WHERE account_id = $1 AND workspace_id = $2 ORDER BY content_id LIMIT 2001', [ctx.accountId, workspaceId]);
      const lifecycle = await q.query<Row>('SELECT * FROM content_lifecycle WHERE account_id = $1 AND workspace_id = $2 ORDER BY content_id LIMIT 2001', [ctx.accountId, workspaceId]);
      if (display.rows.length > 2000 || lifecycle.rows.length !== display.rows.length) {
        throw new CloudError(409, 'UNSUPPORTED_CONTRACT', 'sync', '管理清单不完整或超过容量，不能截断恢复', 'contact_support');
      }
      const changeSeq = await this.head(q, ctx, workspaceId);
      const origin = (await q.query<{ origin_volumes: unknown[] }>('SELECT origin_volumes FROM workspace_archives WHERE account_id = $1 AND workspace_id = $2', [ctx.accountId, workspaceId])).rows[0]!;
      const revisions = await revisionCatalog(q, ctx, workspaceId);
      return { workspaceId, cursor: cursor(workspaceId, changeSeq, epoch), changeSeq,
        ...(revisions.version ? { revisionCatalog: revisions } : {}),
        display: display.rows.map((row) => MetadataEntrySchema.parse({ contentId: row.content_id, version: Number(row.version), value: row.value, updatedAt: row.updated_at.toISOString() })),
        lifecycle: lifecycle.rows.map(wire), archive: (await archiveSnapshot(q, ctx, workspaceId)).state, archiveOrigin: origin.origin_volumes };
    });
  }

  private async head(q: Querier, ctx: AuthContext, workspaceId: string) {
    const row = (await q.query<{ change_seq: string }>('SELECT change_seq FROM management_heads WHERE account_id = $1 AND workspace_id = $2', [ctx.accountId, workspaceId])).rows[0];
    return row ? Number(row.change_seq) : 0;
  }

  async pull(ctx: AuthContext, workspaceId: string, rawCursor: string, limit: number = CLOUD_LIMITS.listPageDefault): Promise<ManagementPull> {
    if (rawCursor.length > 512 || !Number.isInteger(limit) || limit < 1 || limit > CLOUD_LIMITS.listPageMax) throw badRequest('管理分页参数无效');
    const at = position(rawCursor, workspaceId);
    return this.app.withTenant(ctx.accountId, async (q) => {
      const epoch = await this.lock(q, ctx, workspaceId);
      const head = await this.head(q, ctx, workspaceId);
      if (epoch !== at.epoch || at.seq > head) throw expired();
      const rows = await q.query<{ change_seq: string; body: unknown }>(`WITH page AS (
          SELECT change_seq, body FROM management_changes WHERE account_id = $1 AND workspace_id = $2 AND change_seq > $3 ORDER BY change_seq LIMIT $4
        ), bounded AS (
          SELECT change_seq, body, sum(octet_length(body::text)) OVER (ORDER BY change_seq) AS bytes FROM page
        ) SELECT change_seq, body FROM bounded WHERE bytes <= $5 ORDER BY change_seq`,
      [ctx.accountId, workspaceId, at.seq, limit, CLOUD_LIMITS.uploadObjectBytes - 2048]);
      const changes = rows.rows.map((row, index) => {
        const change = ManagementChangeSchema.parse(row.body);
        if (Number(row.change_seq) !== at.seq + index + 1 || change.seq !== Number(row.change_seq)) throw expired();
        return change;
      });
      const last = changes.at(-1)?.seq ?? at.seq;
      if (!changes.length && head > at.seq) throw expired();
      return { workspaceId, fromCursor: rawCursor, nextCursor: cursor(workspaceId, last, epoch), changes, hasMore: last < head };
    });
  }

  async submit(ctx: AuthContext, raw: LifecycleCommand): Promise<LifecycleReceipt> {
    const input = LifecycleCommandSchema.parse(raw);
    await this.ensure(ctx, input.workspaceId);
    const digest = createHash('sha256').update(stableStringify(input)).digest('hex');
    return this.app.withTenant(ctx.accountId, async (q) => {
      await this.lock(q, ctx, input.workspaceId);
      const held = (await q.query<{ request_digest: string; receipt: LifecycleReceipt }>(
        'SELECT request_digest, receipt FROM metadata_commands WHERE account_id = $1 AND command_id = $2', [ctx.accountId, input.commandId])).rows[0];
      if (held) { if (held.request_digest !== digest) throw idempotencyMismatch(); return held.receipt; }
      const row = (await q.query<Row>('SELECT * FROM content_lifecycle WHERE account_id = $1 AND workspace_id = $2 AND content_id = $3 FOR UPDATE',
        [ctx.accountId, input.workspaceId, input.contentId])).rows[0];
      if (!row) throw notFound('内容不存在');
      if (row.source_kind !== 'generated') throw badRequest('预置内容不能移入回收站或恢复');
      let entry = wire(row);
      const outcome = entry.version === input.baseVersion ? 'applied' : 'conflict';
      if (outcome === 'applied') {
        if (input.type === 'restore' && row.restore_ambiguous) throw new CloudError(409, 'UNSUPPORTED_CONTRACT', 'sync',
          '该回收内容仍属于多个归档卷；需要先处理归档引用，当前不会丢弃原卷或猜测恢复位置', 'contact_support');
        const time = new Date().toISOString();
        const value: LifecycleEntry['value'] = input.type === 'trash'
          ? { lifecycle: 'trashed', trashedAt: row.value.trashedAt ?? time, archiveVolumeId: null }
          : { lifecycle: 'active', trashedAt: null, archiveVolumeId: row.restore_archive_id };
        entry = wire((await q.query<Row>(`UPDATE content_lifecycle SET version = version + 1, value = $4, updated_at = $5
          WHERE account_id = $1 AND workspace_id = $2 AND content_id = $3 RETURNING *`,
        [ctx.accountId, input.workspaceId, input.contentId, JSON.stringify(value), time])).rows[0]!);
      }
      const receipt: LifecycleReceipt = { workspaceId: input.workspaceId, commandId: input.commandId, outcome, entry };
      await q.query(`INSERT INTO metadata_commands (account_id, workspace_id, command_id, device_id, request_digest, request, receipt)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [ctx.accountId, input.workspaceId, input.commandId, ctx.deviceId, digest, JSON.stringify(input), JSON.stringify(receipt)]);
      if (outcome === 'applied') await recordManagement(q, ctx.accountId, input.workspaceId, input.commandId, { type: 'lifecycle', entry });
      return receipt;
    });
  }
}
