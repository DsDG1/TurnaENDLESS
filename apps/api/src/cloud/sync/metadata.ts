import { createHash } from 'node:crypto';
import { stableStringify } from '@endless/esl';
import type { Workspace } from '@endless/content';
import {
  MetadataCommandSchema, MetadataEntrySchema, UuidSchema,
  type MetadataCommand, type MetadataEntry, type MetadataReceipt, type MetadataSnapshot,
} from '@endless/cloud-contracts';
import type { AuthContext } from '../auth/service.js';
import type { CloudPool, Querier } from '../db/client.js';
import { lockAccount } from '../db/locks.js';
import { CloudError, idempotencyMismatch, notFound } from '../errors.js';
import { recordManagement } from './management-feed.js';

export async function seedMetadata(q: Querier, accountId: string, workspaceId: string, copy: Workspace) {
  for (const entry of copy.entries) {
    const { title, tags, note } = entry.display;
    await q.query(`INSERT INTO content_metadata (account_id, workspace_id, content_id, value, updated_at)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [accountId, workspaceId, entry.id, JSON.stringify({ title, tags, note }), entry.updatedAt]);
  }
}

type Row = { content_id: string; version: string; value: MetadataEntry['value']; updated_at: Date };
const wire = (row: Row): MetadataEntry => MetadataEntrySchema.parse({
  contentId: row.content_id, version: Number(row.version), value: row.value, updatedAt: row.updated_at.toISOString(),
});

export class MetadataService {
  constructor(private readonly app: CloudPool, private readonly source?: (ctx: AuthContext, id: string) => Promise<Workspace>) {}

  private async lock(q: Querier, ctx: AuthContext, workspaceId: string) {
    if (!UuidSchema.safeParse(workspaceId).success) throw notFound('工作区不存在');
    await lockAccount(q, ctx.accountId);
    const row = (await q.query<{ status: string }>(
      'SELECT status FROM workspaces WHERE account_id = $1 AND id = $2 FOR UPDATE', [ctx.accountId, workspaceId],
    )).rows[0];
    if (!row) throw notFound('工作区不存在');
    if (row.status !== 'active') throw new CloudError(409, 'BASIS_CHANGED', 'sync', '工作区尚未激活或已归档', 'retry_read');
  }

  /** Older imports are initialized from their verified immutable copy, never from a client's editable values. */
  private async ensure(ctx: AuthContext, workspaceId: string) {
    const present = await this.app.withTenant(ctx.accountId, async (q) => {
      await this.lock(q, ctx, workspaceId);
      return (await q.query('SELECT 1 FROM content_metadata WHERE account_id = $1 AND workspace_id = $2 LIMIT 1',
        [ctx.accountId, workspaceId])).rowCount;
    });
    if (present) return;
    const copy = await this.source?.(ctx, workspaceId);
    if (!copy) throw new CloudError(409, 'UNSUPPORTED_CONTRACT', 'sync', '旧工作区缺少可验证的展示信息基线，原件保留', 'contact_support');
    await this.app.withTenant(ctx.accountId, async (q) => {
      await this.lock(q, ctx, workspaceId);
      await seedMetadata(q, ctx.accountId, workspaceId, copy);
    });
  }

  async snapshot(ctx: AuthContext, workspaceId: string): Promise<MetadataSnapshot> {
    await this.ensure(ctx, workspaceId);
    return this.app.withTenant(ctx.accountId, async (q) => {
      await this.lock(q, ctx, workspaceId);
      const rows = await q.query<Row>('SELECT * FROM content_metadata WHERE account_id = $1 AND workspace_id = $2 ORDER BY content_id LIMIT 2001',
        [ctx.accountId, workspaceId]);
      if (rows.rows.length > 2000) throw new CloudError(409, 'UNSUPPORTED_CONTRACT', 'sync', '展示信息超过当前容量，不会截断同步', 'contact_support');
      return { workspaceId, entries: rows.rows.map(wire) };
    });
  }

  async submit(ctx: AuthContext, raw: MetadataCommand): Promise<MetadataReceipt> {
    const input = MetadataCommandSchema.parse(raw);
    await this.ensure(ctx, input.workspaceId);
    const digest = createHash('sha256').update(stableStringify(input)).digest('hex');
    return this.app.withTenant(ctx.accountId, async (q) => {
      await this.lock(q, ctx, input.workspaceId);
      const held = (await q.query<{ request_digest: string; receipt: MetadataReceipt }>(
        'SELECT request_digest, receipt FROM metadata_commands WHERE account_id = $1 AND command_id = $2',
        [ctx.accountId, input.commandId],
      )).rows[0];
      if (held) {
        if (held.request_digest !== digest) throw idempotencyMismatch();
        return held.receipt;
      }
      const row = (await q.query<Row>(
        'SELECT * FROM content_metadata WHERE account_id = $1 AND workspace_id = $2 AND content_id = $3 FOR UPDATE',
        [ctx.accountId, input.workspaceId, input.contentId],
      )).rows[0];
      if (!row) throw notFound('内容不存在');
      let entry = wire(row);
      const outcome = input.baseVersion === entry.version ? 'applied' : 'conflict';
      if (outcome === 'applied') {
        entry = wire((await q.query<Row>(`UPDATE content_metadata SET version = version + 1, value = $4, updated_at = clock_timestamp()
          WHERE account_id = $1 AND workspace_id = $2 AND content_id = $3 RETURNING *`,
        [ctx.accountId, input.workspaceId, input.contentId, JSON.stringify(input.value)])).rows[0]!);
      }
      const receipt: MetadataReceipt = { workspaceId: input.workspaceId, commandId: input.commandId, outcome, entry };
      await q.query(`INSERT INTO metadata_commands (account_id, workspace_id, command_id, device_id, request_digest, request, receipt)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ctx.accountId, input.workspaceId, input.commandId, ctx.deviceId, digest, JSON.stringify(input), JSON.stringify(receipt)]);
      if (outcome === 'applied') await recordManagement(q, ctx.accountId, input.workspaceId, input.commandId, { type: 'display', entry });
      return receipt;
    });
  }
}
