import { stableStringify } from '@endless/esl';
import type { CreateWorkspaceRequest, CreateWorkspaceResponse } from '@endless/cloud-contracts';
import type { CloudPool, Querier } from '../db/client.js';
import { idempotencyMismatch, CloudError } from '../errors.js';
import { requestDigestHex } from '../auth/secrets.js';
import type { AuthContext } from '../auth/service.js';

/**
 * 云工作区归属（§4.1 / §5.2）。
 * 首版只支持 owner 归属；同账号同 sourceLocalId 幂等复用不重复建实例；
 * 所有写入在租户事务内完成，RLS 是第二道隔离。
 */

interface WorkspaceRow {
  id: string;
  source_local_id: string | null;
  contract: string;
  cloud_version: string;
  status: string;
  created_at: Date;
}

function toWire(row: WorkspaceRow, role: 'owner' = 'owner') {
  return {
    id: row.id,
    sourceLocalId: row.source_local_id,
    contract: row.contract as 'endless-workspace/1',
    cloudVersion: String(row.cloud_version),
    status: row.status as 'active' | 'archived',
    role,
    createdAt: row.created_at.toISOString(),
  };
}

async function audit(q: Querier, actorAccountId: string, action: string, objectType: string, objectId: string, correlation?: string): Promise<void> {
  await q.query(
    'INSERT INTO audit_events (actor_account_id, action, object_type, object_id, correlation_id) VALUES ($1, $2, $3, $4, $5)',
    [actorAccountId, action, objectType, objectId, correlation ?? null]);
}

/** 工作区创建在租户事务内与幂等键同事务提交：要么全成立，要么不产生任何记录。 */
export async function createWorkspace(
  app: CloudPool, ctx: AuthContext,
  input: CreateWorkspaceRequest, idempotencyKey: string, correlation: string,
): Promise<{ status: number; body: CreateWorkspaceResponse }> {
  const digest = requestDigestHex(stableStringify(input));
  return app.withTenant(ctx.accountId, async (q) => {
    // 预留幂等键：RETURNING 命中表示本事务持有该键；未命中说明已有先前事务的键，
    // 按“同摘要→原回执 / 异摘要→409 / 在途→409”裁决。
    const claimed = await q.query<{ key: string }>(
      `INSERT INTO idempotency_keys (account_id, operation, key, request_digest)
       VALUES ($1, 'create_workspace', $2, $3) ON CONFLICT (account_id, operation, key) DO NOTHING RETURNING key`,
      [ctx.accountId, idempotencyKey, digest]);
    if (!claimed.rows[0]) {
      const keyRow = await q.query<{ request_digest: Buffer; status_code: number | null; response: unknown }>(
        'SELECT request_digest, status_code, response FROM idempotency_keys WHERE account_id = $1 AND operation = $2 AND key = $3 FOR UPDATE',
        [ctx.accountId, 'create_workspace', idempotencyKey]);
      const held = keyRow.rows[0];
      if (held) {
        if (!held.request_digest.equals(digest)) throw idempotencyMismatch();
        if (held.status_code !== null) return { status: held.status_code, body: held.response as CreateWorkspaceResponse };
        throw new CloudError(409, 'IDEMPOTENCY_IN_PROGRESS', 'sync', '同一请求正在处理中，请稍后用原幂等键查询', 'resume_same_request');
      }
      // 竞态窗口：冲突方回滚导致行消失——直接走正常创建路径。
    }
    await q.query('INSERT INTO account_control (account_id) VALUES ($1) ON CONFLICT DO NOTHING', [ctx.accountId]);
    await q.query('SELECT account_id FROM account_control WHERE account_id = $1 FOR UPDATE', [ctx.accountId]);
    // 导入锚幂等：同账号+原本地 ID 直接复用既有云实例，不重复创建。
    if (input.sourceLocalId) {
      const existing = await q.query<WorkspaceRow>(
        'SELECT * FROM workspaces WHERE account_id = $1 AND source_local_id = $2',
        [ctx.accountId, input.sourceLocalId]);
      if (existing.rows[0]) {
        await q.query(
          'INSERT INTO device_bindings (device_id, account_id, workspace_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [ctx.deviceId, ctx.accountId, existing.rows[0].id],
        );
        const body = { workspace: toWire(existing.rows[0]) };
        await q.query('UPDATE idempotency_keys SET status_code = $1, response = $2, completed_at = now() WHERE account_id = $3 AND operation = $4 AND key = $5',
          [200, JSON.stringify(body), ctx.accountId, 'create_workspace', idempotencyKey]);
        return { status: 200, body };
      }
    }
    const created = await q.query<WorkspaceRow>(
      `INSERT INTO workspaces (account_id, source_local_id, contract, display_name)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [ctx.accountId, input.sourceLocalId ?? null, input.contract, input.displayName ?? null]);
    const workspace = created.rows[0]!;
    await q.query(
      'INSERT INTO workspace_memberships (workspace_id, account_id, role) VALUES ($1, $2, $3)',
      [workspace.id, ctx.accountId, 'owner']);
    await q.query(
      'INSERT INTO device_bindings (device_id, account_id, workspace_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [ctx.deviceId, ctx.accountId, workspace.id]);
    const body = { workspace: toWire(workspace) };
    await q.query('UPDATE idempotency_keys SET status_code = $1, response = $2, completed_at = now() WHERE account_id = $3 AND operation = $4 AND key = $5',
      [201, JSON.stringify(body), ctx.accountId, 'create_workspace', idempotencyKey]);
    await audit(q, ctx.accountId, 'workspace.created', 'workspace', workspace.id, correlation);
    return { status: 201, body };
  });
}

export async function listWorkspaces(app: CloudPool, accountId: string) {
  return app.withTenant(accountId, async (q) => {
    const rows = await q.query<WorkspaceRow>("SELECT * FROM workspaces WHERE account_id = $1 AND status <> 'staging' ORDER BY created_at", [accountId]);
    return { workspaces: rows.rows.map((row) => toWire(row)) };
  });
}
