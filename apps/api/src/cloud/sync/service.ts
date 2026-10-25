import { createHash, randomUUID } from 'node:crypto';
import { stableStringify } from '@endless/esl';
import type { Workspace } from '@endless/content';
import {
  CLOUD_LIMITS, UuidSchema,
  type DeviceStreamState, type PutDeviceStreamStateRequest, type ResolveConflictRequest,
  type SyncBootstrap, type SyncChange, type SyncCommand, type SyncConflict, type SyncEventEntry,
  type SyncPullResponse, type SyncPushReceipt, type SyncPushRequest, type SyncStreamBinding,
} from '@endless/cloud-contracts';
import type { AuthContext } from '../auth/service.js';
import type { CloudPool, Querier } from '../db/client.js';
import { lockAccount } from '../db/locks.js';
import { CloudError, badRequest, idempotencyMismatch, notFound } from '../errors.js';

/**
 * 增量同步（计划 §8）。
 *
 * 权威性是分层的：
 * - 事件正文不可变，去重只按 `eventId`，绝不按正文摘要——同一个动作在两次
 *   合法阅读里可以完全相同，按摘要去重会吃掉真实历史。
 * - 流按严格前缀追加：`baseSeq` 与 `baseEventId` 必须同时等于服务端流头，
 *   否则整批拒绝并保留候选，不把两条离线历史拼成一条。
 * - `change_seq` 在工作区头行锁内递增，因此「分配顺序 = 提交顺序」：
 *   较小的序号不可能在较大序号提交之后才出现，拉取端不会漏拉。
 * - 服务端在本轮只校验事件契约、盖章与流前缀；学习状态的重放等价性属 C4。
 */

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export const SYNC_CURSOR_VERSION = 1 as const;

interface StreamRow {
  stream_id: string;
  branch_id: string;
  event_seq: string;
  last_event_id: string | null;
}

interface BatchRow {
  request_digest: string;
  receipt: SyncPushReceipt | Record<string, never>;
}

/** 冲突在写入前中断事务，具体候选记录由外层单独提交，避免随业务回滚一起消失。 */
class SyncRejection extends Error {
  constructor(
    readonly reason: 'stream-head-changed' | 'event-body-mismatch' | 'event-digest-mismatch',
    readonly streamId: string,
    readonly baseSeq: number,
    readonly cloudSeq: number,
    readonly events: SyncEventEntry[],
  ) { super(reason); }
}

const conflictError = (id: string) => new CloudError(409, 'SYNC_CONFLICT', 'sync',
  '云端历史与本机提交不在同一前缀；整批未应用，候选事件已保留，需显式处理', 'resolve_conflict', { conflictId: id });
const cursorExpired = () => new CloudError(409, 'CURSOR_EXPIRED', 'sync',
  '同步游标已过期（工作区换代或游标超前）；需要重新引导后才能继续，未同步的本机事件不会被覆盖', 'retry_read');

export function encodeSyncCursor(workspaceId: string, seq: number, epoch: number): string {
  return Buffer.from(JSON.stringify({ v: SYNC_CURSOR_VERSION, w: workspaceId, s: seq, e: epoch }), 'utf8').toString('base64url');
}

export function decodeSyncCursor(raw: string, workspaceId: string): { seq: number; epoch: number } {
  let parsed: { v?: unknown; w?: unknown; s?: unknown; e?: unknown };
  try { parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); }
  catch { throw badRequest('同步游标格式无效'); }
  if (parsed.v !== SYNC_CURSOR_VERSION || parsed.w !== workspaceId
    || typeof parsed.s !== 'number' || typeof parsed.e !== 'number'
    || !Number.isInteger(parsed.s) || parsed.s < 0 || !Number.isInteger(parsed.e)) {
    throw badRequest('同步游标格式无效');
  }
  return { seq: parsed.s, epoch: parsed.e };
}

/** 从已发生的事件推导可重放命令：导入的历史没有原始命令，但同一 `at` 可确定性还原。 */
export function commandOfEvent(event: { type: string; scene: string; choice?: number; skip?: boolean }): SyncCommand {
  if (event.type === 'answer') return { type: 'answer', scene: event.scene, choice: event.choice! };
  if (event.type === 'advance') return { type: 'advance', scene: event.scene, skip: event.skip! };
  return { type: 'reveal', scene: event.scene };
}

const binding = (row: StreamRow): SyncStreamBinding => ({
  streamId: row.stream_id, branchId: row.branch_id,
  eventSeq: Number(row.event_seq), lastEventId: row.last_event_id,
});

async function workspaceRow(q: Querier, ctx: AuthContext, workspaceId: string, lock: boolean) {
  if (!UuidSchema.safeParse(workspaceId).success) throw notFound('工作区不存在');
  const row = (await q.query<{ id: string; status: string; cloud_version: string; sync_epoch: string }>(
    `SELECT id, status, cloud_version, sync_epoch FROM workspaces
     WHERE account_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
    [ctx.accountId, workspaceId],
  )).rows[0];
  if (!row) throw notFound('工作区不存在');
  if (row.status !== 'active') throw new CloudError(409, 'BASIS_CHANGED', 'sync', '工作区尚未激活或已归档，不能同步', 'resolve_conflict');
  return row;
}

/**
 * 导入激活时写入整段前缀的事件身份（§8.2）。只做一次：之后所有设备沿该绑定追加。
 * 全部行在调用方的事务里提交，与副本激活同生共死。
 */
export async function seedSyncStreams(q: Querier, account: string, workspace: string, copy: Workspace): Promise<void> {
  for (const branch of copy.branches) {
    const events = branch.session.events as unknown as { type: string; scene: string; at: string; choice?: number; skip?: boolean }[];
    const rows = events.map((event, index) => ({
      seq: index + 1, eventId: randomUUID(), digest: sha(stableStringify(event)),
      body: event, command: commandOfEvent(event), occurredAt: event.at,
    }));
    await q.query(
      `INSERT INTO sync_streams (account_id, workspace_id, stream_id, branch_id, event_seq, last_event_id)
       VALUES ($1, $2, $3, $3, $4, $5)`,
      [account, workspace, branch.id, events.length, rows.length ? rows[rows.length - 1]!.eventId : null],
    );
    if (!rows.length) continue;
    await q.query(
      `INSERT INTO event_objects (account_id, workspace_id, event_id, digest, body, command, occurred_at)
       SELECT $1, $2, r."eventId"::uuid, r.digest, r.body, r.command, r."occurredAt"::timestamptz
       FROM jsonb_to_recordset($3::jsonb) AS r("eventId" text, digest text, body jsonb, command jsonb, "occurredAt" text)`,
      [account, workspace, JSON.stringify(rows.map(({ eventId, digest, body, command, occurredAt }) => ({ eventId, digest, body, command, occurredAt })))],
    );
    await q.query(
      `INSERT INTO stream_events (account_id, workspace_id, stream_id, event_seq, event_id)
       SELECT $1, $2, $3, r.seq, r."eventId"::uuid
       FROM jsonb_to_recordset($4::jsonb) AS r(seq bigint, "eventId" text)`,
      [account, workspace, branch.id, JSON.stringify(rows.map(({ seq, eventId }) => ({ seq, eventId })))],
    );
  }
  await q.query(
    'INSERT INTO workspace_change_heads (account_id, workspace_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [account, workspace],
  );
}

export class SyncService {
  constructor(private readonly app: CloudPool) {}

  private async streams(q: Querier, ctx: AuthContext, workspaceId: string): Promise<SyncStreamBinding[]> {
    const rows = await q.query<StreamRow>(
      'SELECT stream_id, branch_id, event_seq, last_event_id FROM sync_streams WHERE account_id = $1 AND workspace_id = $2 ORDER BY stream_id',
      [ctx.accountId, workspaceId],
    );
    return rows.rows.map(binding);
  }

  async bootstrap(ctx: AuthContext, workspaceId: string): Promise<SyncBootstrap> {
    return this.app.withTenant(ctx.accountId, async (q) => {
      const workspace = await workspaceRow(q, ctx, workspaceId, false);
      const head = (await q.query<{ change_seq: string }>(
        'SELECT change_seq FROM workspace_change_heads WHERE account_id = $1 AND workspace_id = $2',
        [ctx.accountId, workspaceId],
      )).rows[0];
      return {
        workspaceId, cloudVersion: String(workspace.cloud_version),
        changeSeq: head ? Number(head.change_seq) : 0,
        cursor: encodeSyncCursor(workspaceId, head ? Number(head.change_seq) : 0, Number(workspace.sync_epoch)),
        streams: await this.streams(q, ctx, workspaceId),
      };
    });
  }

  async push(ctx: AuthContext, input: SyncPushRequest): Promise<{ receipt: SyncPushReceipt }> {
    // 路由已做严格解析；服务层再守一道，防止直接调用方绕过批次边界。
    if (!input.streams.length || input.streams.some((stream) => !stream.events.length)) {
      throw badRequest('同步批次至少包含一条事件');
    }
    const digest = sha(stableStringify(input));
    try {
      return await this.app.withTenant(ctx.accountId, (q) => this.applyBatch(q, ctx, input, digest));
    } catch (error) {
      if (!(error instanceof SyncRejection)) throw error;
      const id = randomUUID();
      // 候选记录单独提交：业务整批回滚，但「被拒绝的历史」不能跟着消失。
      await this.app.withTenant(ctx.accountId, (q) => q.query(
        `INSERT INTO sync_conflicts
           (account_id, workspace_id, id, stream_id, device_id, reason, base_seq, cloud_seq, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [ctx.accountId, input.workspaceId, id, error.streamId, ctx.deviceId, error.reason,
          error.baseSeq, error.cloudSeq, JSON.stringify({ batchId: input.batchId, events: error.events })],
      ));
      throw conflictError(id);
    }
  }

  private async applyBatch(q: Querier, ctx: AuthContext, input: SyncPushRequest, digest: string): Promise<{ receipt: SyncPushReceipt }> {
    await lockAccount(q, ctx.accountId);
    await workspaceRow(q, ctx, input.workspaceId, true);
    const claimed = await q.query(
      `INSERT INTO sync_batches (account_id, workspace_id, batch_id, device_id, request_digest)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING batch_id`,
      [ctx.accountId, input.workspaceId, input.batchId, ctx.deviceId, digest],
    );
    if (!claimed.rows[0]) {
      const held = (await q.query<BatchRow>(
        'SELECT request_digest, receipt FROM sync_batches WHERE account_id = $1 AND workspace_id = $2 AND batch_id = $3 FOR UPDATE',
        [ctx.accountId, input.workspaceId, input.batchId],
      )).rows[0]!;
      if (held.request_digest !== digest) throw idempotencyMismatch();
      if (!('batchId' in held.receipt)) {
        throw new CloudError(409, 'IDEMPOTENCY_IN_PROGRESS', 'sync', '同一批次仍在处理中，请用原批次重试', 'resume_same_request');
      }
      return { receipt: held.receipt as SyncPushReceipt };
    }

    // 固定顺序取流锁：同批多流时按 streamId 排序，避免两批交叉死锁。
    const ordered = [...input.streams].sort((left, right) => left.streamId.localeCompare(right.streamId));
    let applied = 0;
    let duplicate = 0;
    const changes: { streamId: string; fromSeq: number; toSeq: number; eventIds: string[] }[] = [];

    for (const stream of ordered) {
      const row = (await q.query<StreamRow>(
        'SELECT stream_id, branch_id, event_seq, last_event_id FROM sync_streams WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3 FOR UPDATE',
        [ctx.accountId, input.workspaceId, stream.streamId],
      )).rows[0];
      if (!row) {
        throw new CloudError(409, 'UNSUPPORTED_CONTRACT', 'sync',
          '云端还没有这条事件流（本机新建分支的同步尚未实现）；本机事件保留，不会被裁剪', 'contact_support');
      }
      const head = Number(row.event_seq);
      if (stream.baseSeq !== head || (stream.baseEventId ?? null) !== row.last_event_id) {
        throw new SyncRejection('stream-head-changed', stream.streamId, stream.baseSeq, head, stream.events);
      }
      await this.assertStamps(q, ctx, input.workspaceId, stream.events);
      const ids: string[] = [];
      let expected = head + 1;
      for (const entry of stream.events) {
        if (entry.seq !== expected) throw badRequest('事件序号必须与流前缀连续');
        const body = sha(stableStringify(entry.event));
        if (body !== entry.digest) throw new SyncRejection('event-digest-mismatch', stream.streamId, stream.baseSeq, head, stream.events);
        if (entry.at !== entry.event.at || entry.command.type !== entry.event.type || entry.command.scene !== entry.event.scene) {
          throw badRequest('事件与命令不一致');
        }
        const existing = (await q.query<{ digest: string }>(
          'SELECT digest FROM event_objects WHERE account_id = $1 AND workspace_id = $2 AND event_id = $3',
          [ctx.accountId, input.workspaceId, entry.eventId],
        )).rows[0];
        if (existing) {
          // 同一 eventId 只能对应同一正文；不同正文说明本机重用了身份，必须拒绝。
          if (existing.digest !== body) throw new SyncRejection('event-body-mismatch', stream.streamId, stream.baseSeq, head, stream.events);
          duplicate++;
        } else {
          await q.query(
            `INSERT INTO event_objects (account_id, workspace_id, event_id, digest, body, command, occurred_at, device_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [ctx.accountId, input.workspaceId, entry.eventId, body, JSON.stringify(entry.event), JSON.stringify(entry.command), entry.at, ctx.deviceId],
          );
          await q.query(
            'INSERT INTO stream_events (account_id, workspace_id, stream_id, event_seq, event_id) VALUES ($1, $2, $3, $4, $5)',
            [ctx.accountId, input.workspaceId, stream.streamId, entry.seq, entry.eventId],
          );
          applied++;
        }
        ids.push(entry.eventId);
        expected++;
      }
      const last = stream.events[stream.events.length - 1]!;
      await q.query(
        'UPDATE sync_streams SET event_seq = $4, last_event_id = $5, updated_at = now() WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3',
        [ctx.accountId, input.workspaceId, stream.streamId, last.seq, last.eventId],
      );
      changes.push({ streamId: stream.streamId, fromSeq: head, toSeq: last.seq, eventIds: ids });
    }

    const committed = changes.filter((change) => change.toSeq > change.fromSeq);
    let changeSeq = 0;
    if (committed.length) {
      await q.query(
        'INSERT INTO workspace_change_heads (account_id, workspace_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [ctx.accountId, input.workspaceId],
      );
      // 头行锁内递增：分配顺序即提交顺序，拉取端不会看到「先缺后补」的序号。
      const head = (await q.query<{ change_seq: string }>(
        `UPDATE workspace_change_heads SET change_seq = change_seq + $3, updated_at = now()
         WHERE account_id = $1 AND workspace_id = $2 RETURNING change_seq`,
        [ctx.accountId, input.workspaceId, committed.length],
      )).rows[0]!;
      const top = Number(head.change_seq);
      for (const [index, change] of committed.entries()) {
        changeSeq = top - committed.length + index + 1;
        await q.query(
          `INSERT INTO workspace_changes
             (account_id, workspace_id, change_seq, batch_id, device_id, stream_id, from_seq, to_seq, event_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid[])`,
          [ctx.accountId, input.workspaceId, changeSeq, input.batchId, ctx.deviceId, change.streamId,
            change.fromSeq, change.toSeq, change.eventIds],
        );
      }
    }

    const version = (await q.query<{ cloud_version: string }>(
      'UPDATE workspaces SET cloud_version = cloud_version + 1 WHERE account_id = $1 AND id = $2 RETURNING cloud_version',
      [ctx.accountId, input.workspaceId],
    )).rows[0]!;
    const allStreams = await this.streams(q, ctx, input.workspaceId);
    const receipt: SyncPushReceipt = {
      batchId: input.batchId, workspaceId: input.workspaceId, changeSeq,
      cloudVersion: String(version.cloud_version), applied, duplicate,
      streams: allStreams.filter((stream) => ordered.some((sent) => sent.streamId === stream.streamId)),
    };
    await q.query(
      'UPDATE sync_batches SET receipt = $4 WHERE account_id = $1 AND workspace_id = $2 AND batch_id = $3',
      [ctx.accountId, input.workspaceId, input.batchId, JSON.stringify(receipt)],
    );
    return { receipt };
  }

  /** 事件盖章必须指向本工作区真实的导入映射，客户端不能凭自称内容 ID 写入历史。 */
  private async assertStamps(q: Querier, ctx: AuthContext, workspaceId: string, events: SyncEventEntry[]) {
    const contentIds = new Set<string>();
    const revisionIds = new Set<string>();
    for (const entry of events) {
      const { contentId, revisionId } = entry.event;
      if ((contentId === undefined) !== (revisionId === undefined)) throw badRequest('事件的内容/修订盖章必须成对出现');
      if (contentId && revisionId) { contentIds.add(contentId); revisionIds.add(revisionId); }
    }
    if (!contentIds.size) return;
    const rows = await q.query<{ kind: string; source_id: string }>(
      `SELECT kind, source_id FROM cloud_id_mappings
       WHERE account_id = $1 AND workspace_id = $2
         AND ((kind = 'content' AND source_id = ANY($3::text[])) OR (kind = 'revision' AND source_id = ANY($4::text[])))`,
      [ctx.accountId, workspaceId, [...contentIds], [...revisionIds]],
    );
    const known = new Set(rows.rows.map((row) => `${row.kind}:${row.source_id}`));
    for (const entry of events) {
      const { contentId, revisionId } = entry.event;
      if (contentId && revisionId && (!known.has(`content:${contentId}`) || !known.has(`revision:${revisionId}`))) {
        throw badRequest('事件引用了本工作区不存在的内容或修订');
      }
    }
  }

  async pull(ctx: AuthContext, workspaceId: string, cursor: string | null, limit: number = CLOUD_LIMITS.listPageDefault): Promise<SyncPullResponse> {
    const page = Math.min(Math.max(limit, 1), CLOUD_LIMITS.listPageMax);
    return this.app.withTenant(ctx.accountId, async (q) => {
      const workspace = await workspaceRow(q, ctx, workspaceId, false);
      const epoch = Number(workspace.sync_epoch);
      const position = cursor ? decodeSyncCursor(cursor, workspaceId) : { seq: 0, epoch };
      if (position.epoch !== epoch) throw cursorExpired();
      const head = (await q.query<{ change_seq: string }>(
        'SELECT change_seq FROM workspace_change_heads WHERE account_id = $1 AND workspace_id = $2',
        [ctx.accountId, workspaceId],
      )).rows[0];
      const headSeq = head ? Number(head.change_seq) : 0;
      // 游标超前（库被回滚或恢复）只能重新引导，不能猜一个位置继续读。
      if (position.seq > headSeq) throw cursorExpired();

      const rows = await q.query<{
        change_seq: string; batch_id: string; device_id: string; stream_id: string;
        from_seq: string; to_seq: string; event_ids: string[]; created_at: Date;
      }>(
        `SELECT change_seq, batch_id, device_id, stream_id, from_seq, to_seq, event_ids, created_at
         FROM workspace_changes WHERE account_id = $1 AND workspace_id = $2 AND change_seq > $3
         ORDER BY change_seq LIMIT $4`,
        [ctx.accountId, workspaceId, position.seq, page + 1],
      );
      const pageRows = rows.rows.slice(0, page);
      const ids = pageRows.flatMap((row) => row.event_ids);
      const events = ids.length ? (await q.query<{ event_id: string; digest: string; body: unknown; command: unknown; occurred_at: Date }>(
        `SELECT event_id, digest, body, command, occurred_at FROM event_objects
         WHERE account_id = $1 AND workspace_id = $2 AND event_id = ANY($3::uuid[])`,
        [ctx.accountId, workspaceId, ids],
      )).rows : [];
      const byId = new Map(events.map((row) => [row.event_id, row]));

      const changes: SyncChange[] = pageRows.map((row) => ({
        seq: Number(row.change_seq), batchId: row.batch_id, deviceId: row.device_id,
        streamId: row.stream_id as SyncChange['streamId'],
        fromSeq: Number(row.from_seq), toSeq: Number(row.to_seq),
        createdAt: row.created_at.toISOString(),
        events: row.event_ids.map((id, index) => {
          const held = byId.get(id);
          if (!held) throw new CloudError(500, 'INTERNAL', 'internal', '同步变更引用了缺失的事件对象', 'contact_support');
          return {
            eventId: id, seq: Number(row.from_seq) + index + 1, at: held.occurred_at.toISOString(),
            event: held.body as SyncEventEntry['event'], command: held.command as SyncEventEntry['command'], digest: held.digest,
          };
        }),
      }));
      const lastSeq = pageRows.length ? Number(pageRows[pageRows.length - 1]!.change_seq) : position.seq;
      return {
        changes, hasMore: rows.rows.length > page,
        nextCursor: encodeSyncCursor(workspaceId, lastSeq, epoch),
        cloudVersion: String(workspace.cloud_version),
      };
    });
  }

  async conflicts(ctx: AuthContext, workspaceId: string): Promise<{ conflicts: SyncConflict[] }> {
    return this.app.withTenant(ctx.accountId, async (q) => {
      // 按 ID 查找必须先验归属：RLS 只是第二道防线，不能把「查不到」当成「不存在」的替身。
      await workspaceRow(q, ctx, workspaceId, false);
      return this.listConflicts(q, ctx, workspaceId);
    });
  }

  private async listConflicts(q: Querier, ctx: AuthContext, workspaceId: string) {
    const rows = await q.query<{
      id: string; stream_id: string; device_id: string; reason: SyncConflict['reason'];
      status: SyncConflict['status']; base_seq: string; cloud_seq: string;
      created_at: Date; resolved_at: Date | null; payload: { events: SyncEventEntry[] };
    }>(
      `SELECT id, stream_id, device_id, reason, status, base_seq, cloud_seq, created_at, resolved_at, payload
       FROM sync_conflicts WHERE account_id = $1 AND workspace_id = $2 ORDER BY created_at DESC LIMIT 50`,
      [ctx.accountId, workspaceId],
    );
    return { conflicts: rows.rows.map((row): SyncConflict => ({
      id: row.id, workspaceId, streamId: row.stream_id as SyncConflict['streamId'], deviceId: row.device_id,
      reason: row.reason, status: row.status, baseSeq: Number(row.base_seq), cloudSeq: Number(row.cloud_seq),
      createdAt: row.created_at.toISOString(), resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
      events: row.payload.events,
    })) };
  }

  async resolve(ctx: AuthContext, workspaceId: string, conflictId: string, input: ResolveConflictRequest) {
    if (input.decision !== 'discard') throw badRequest('首版只支持明确放弃本机候选；按分支保留尚未实现');
    return this.app.withTenant(ctx.accountId, async (q) => {
      await lockAccount(q, ctx.accountId);
      await workspaceRow(q, ctx, workspaceId, true);
      const updated = await q.query<{ stream_id: string }>(
        `UPDATE sync_conflicts SET status = 'discarded', resolved_at = now()
         WHERE account_id = $1 AND workspace_id = $2 AND id = $3 AND status = 'open' RETURNING stream_id`,
        [ctx.accountId, workspaceId, conflictId],
      );
      if (!updated.rows[0]) throw notFound('冲突不存在或已处理');
      const stream = (await q.query<StreamRow>(
        'SELECT stream_id, branch_id, event_seq, last_event_id FROM sync_streams WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3',
        [ctx.accountId, workspaceId, updated.rows[0].stream_id],
      )).rows[0];
      if (!stream) throw notFound('冲突对应的事件流不存在');
      const listed = await this.listConflicts(q, ctx, workspaceId);
      const conflict = listed.conflicts.find((entry) => entry.id === conflictId);
      if (!conflict) throw notFound('冲突不存在或已处理');
      return { conflict, stream: binding(stream) };
    });
  }

  async deviceStates(ctx: AuthContext, workspaceId: string): Promise<{ states: DeviceStreamState[] }> {
    if (!UuidSchema.safeParse(workspaceId).success) throw notFound('工作区不存在');
    return this.app.withTenant(ctx.accountId, (q) => this.readDeviceStates(q, ctx, workspaceId));
  }

  private async readDeviceStates(q: Querier, ctx: AuthContext, workspaceId: string) {
    const rows = await q.query<{ stream_id: string; current_episode: string; large_text: boolean; updated_at: Date }>(
      `SELECT stream_id, current_episode, large_text, updated_at FROM device_stream_state
       WHERE account_id = $1 AND device_id = $2 AND workspace_id = $3 ORDER BY stream_id`,
      [ctx.accountId, ctx.deviceId, workspaceId],
    );
    return { states: rows.rows.map((row): DeviceStreamState => ({
      streamId: row.stream_id as DeviceStreamState['streamId'],
      currentEpisode: row.current_episode, largeText: row.large_text, updatedAt: row.updated_at.toISOString(),
    })) };
  }

  /** 界面偏好按设备隔离：另一台设备写 current/字号不会覆盖本机，也不产生变更。 */
  async putDeviceStates(ctx: AuthContext, input: PutDeviceStreamStateRequest): Promise<{ states: DeviceStreamState[] }> {
    return this.app.withTenant(ctx.accountId, async (q) => {
      await workspaceRow(q, ctx, input.workspaceId, false);
      for (const state of input.states) {
        await q.query(
          `INSERT INTO device_stream_state (account_id, device_id, workspace_id, stream_id, current_episode, large_text)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (account_id, device_id, workspace_id, stream_id)
           DO UPDATE SET current_episode = EXCLUDED.current_episode, large_text = EXCLUDED.large_text, updated_at = now()`,
          [ctx.accountId, ctx.deviceId, input.workspaceId, state.streamId, state.currentEpisode, state.largeText],
        );
      }
      return this.readDeviceStates(q, ctx, input.workspaceId);
    });
  }
}
