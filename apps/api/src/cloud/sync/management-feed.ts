import type { Querier } from '../db/client.js';
import { CLOUD_LIMITS, type MetadataEntry, type LifecycleEntry, type ArchiveSnapshot, type RevisionRegistration } from '@endless/cloud-contracts';
import { CloudError } from '../errors.js';

/** Caller holds account → workspace locks. Allocation and insertion commit with the command's receipt. */
export async function recordManagement(q: Querier, accountId: string, workspaceId: string, commandId: string,
  change: { type: 'display'; entry: MetadataEntry } | { type: 'lifecycle'; entry: LifecycleEntry } | { type: 'archive'; snapshot: ArchiveSnapshot }
    | { type: 'revision'; registration: RevisionRegistration }) {
  if (Buffer.byteLength(JSON.stringify(change)) > CLOUD_LIMITS.uploadObjectBytes - 4096) throw new CloudError(413, 'STORAGE_QUOTA', 'sync', '管理变更超过当前有界同步容量，整笔未提交', 'contact_support');
  if (change.type === 'archive' || change.type === 'revision') {
    const bytes = (await q.query<{ bytes: number }>('SELECT octet_length($1::jsonb::text) AS bytes', [JSON.stringify({ seq: 0, ...change })])).rows[0]!.bytes;
    if (bytes > CLOUD_LIMITS.uploadObjectBytes - 4096) throw new CloudError(413, 'STORAGE_QUOTA', 'sync', '归档变更超过当前分页容量，整笔未提交', 'contact_support');
  }
  const row = (await q.query<{ change_seq: string }>(`INSERT INTO management_heads (account_id, workspace_id, change_seq)
    VALUES ($1, $2, 1) ON CONFLICT (account_id, workspace_id) DO UPDATE
    SET change_seq = management_heads.change_seq + 1 RETURNING change_seq`, [accountId, workspaceId])).rows[0]!;
  const seq = Number(row.change_seq);
  await q.query('INSERT INTO management_changes (account_id, workspace_id, change_seq, command_id, body) VALUES ($1, $2, $3, $4, $5)',
    [accountId, workspaceId, seq, commandId, JSON.stringify({ seq, ...change })]);
}
