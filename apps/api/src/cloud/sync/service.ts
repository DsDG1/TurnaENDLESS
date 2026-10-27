import { createHash, randomUUID } from 'node:crypto';
import { stableStringify } from '@endless/esl';
import { rebuildCloudReading, type Workspace, type Content } from '@endless/content';
import {
  CLOUD_LIMITS, UuidSchema, ReadingSnapshotRequestSchema, ReadingSnapshotSchema, type ReadingSnapshot, type ReadingSnapshotRequest,
  ResolveConflictRequestSchema, SyncBranchManifestSchema, SyncRecoveryRequestSchema, type SyncRecoveryRequest,
  type DeviceStreamState, type PutDeviceStreamStateRequest, type ResolveConflictRequest,
  type SyncBootstrap, type SyncChange, type SyncCommand, type SyncConflict, type SyncEventEntry,
  type SyncPullResponse, type SyncPushReceipt, type SyncPushRequest, type SyncStreamBinding,
  type RegisterStreamRequest, type RegisterStreamResponse, type SyncBranchManifest,
  type SyncStreamHistory, type ResolveConflictResponse,
} from '@endless/cloud-contracts';
import type { AuthContext } from '../auth/service.js';
import type { CloudPool, Querier } from '../db/client.js';
import { lockAccount } from '../db/locks.js';
import { CloudError, badRequest, idempotencyMismatch, notFound } from '../errors.js';
import { MetadataService, seedMetadata } from './metadata.js';
import { ManagementService, seedLifecycle } from './management.js';
import { seedArchives } from './archives.js';
import { revisionCatalog } from './revision-registry.js';

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

const manifestOf = (branch: Workspace['branches'][number]): SyncBranchManifest => ({
  streamId: branch.id, label: branch.label, parentBranchId: branch.parentBranchId,
  forkAtEventCount: branch.forkAtEventCount, adopted: branch.adopted,
  catalog: branch.session.catalog, createdAt: branch.createdAt,
  commonStreamId: branch.parentBranchId, commonPrefixSeq: branch.forkAtEventCount ?? 0,
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
  await seedMetadata(q, account, workspace, copy);
  await seedLifecycle(q, account, workspace, copy);
  await seedArchives(q, account, workspace, copy);
  for (const branch of copy.branches) {
    const events = branch.session.events as unknown as { type: string; scene: string; at: string; choice?: number; skip?: boolean }[];
    const rows = events.map((event, index) => ({
      seq: index + 1, eventId: randomUUID(), digest: sha(stableStringify(event)),
      body: event, command: commandOfEvent(event), occurredAt: event.at,
    }));
    await q.query(
      `INSERT INTO sync_streams (account_id, workspace_id, stream_id, branch_id, event_seq, last_event_id, branch_manifest)
       VALUES ($1, $2, $3, $3, $4, $5, $6)`,
      [account, workspace, branch.id, events.length, rows.length ? rows[rows.length - 1]!.eventId : null, JSON.stringify(manifestOf(branch))],
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
  readonly metadata: MetadataService;
  readonly management: ManagementService;
  constructor(
    private readonly app: CloudPool,
    private readonly source?: (ctx: AuthContext, workspaceId: string) => Promise<Workspace>,
    private readonly content?: Content,
  ) {
    this.metadata = new MetadataService(app, source);
    this.management = new ManagementService(app, this.metadata, source, content);
  }

  private async fallbackManifest(ctx: AuthContext, workspaceId: string, streamId: string) {
    const row = await this.app.withTenant(ctx.accountId, async (q) => {
      await workspaceRow(q, ctx, workspaceId, false);
      return (await q.query<{ branch_manifest: SyncBranchManifest | null }>(
        'SELECT branch_manifest FROM sync_streams WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3',
        [ctx.accountId, workspaceId, streamId],
      )).rows[0];
    });
    if (!row) throw notFound('事件流不存在');
    if (row.branch_manifest) return SyncBranchManifestSchema.parse(row.branch_manifest);
    const original = (await this.source?.(ctx, workspaceId))?.branches.find((branch) => branch.id === streamId);
    if (!original) throw new CloudError(409, 'UNSUPPORTED_CONTRACT', 'sync',
      '该旧事件流缺少可验证的采用清单；本机完整历史已保留，不能猜测分支内容', 'contact_support');
    return manifestOf(original);
  }

  private async history(q: Querier, ctx: AuthContext, workspaceId: string, streamId: string, fallback?: SyncBranchManifest): Promise<SyncStreamHistory> {
    const row = (await q.query<StreamRow & { branch_manifest: SyncBranchManifest | null }>(
      'SELECT stream_id, branch_id, event_seq, last_event_id, branch_manifest FROM sync_streams WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3',
      [ctx.accountId, workspaceId, streamId],
    )).rows[0];
    if (!row) throw notFound('事件流不存在');
    if (Number(row.event_seq) > 10_000) throw new CloudError(409, 'UNSUPPORTED_CONTRACT', 'sync',
      '冲突历史超过当前有界恢复上限；完整本机历史保留，不能截断恢复', 'contact_support');
    const rows = await q.query<{ event_seq: string; event_id: string; digest: string; body: SyncEventEntry['event']; command: SyncCommand; occurred_at: Date }>(
      `SELECT se.event_seq, e.event_id, e.digest, e.body, e.command, e.occurred_at
       FROM stream_events se JOIN event_objects e USING (account_id, workspace_id, event_id)
       WHERE se.account_id = $1 AND se.workspace_id = $2 AND se.stream_id = $3 ORDER BY se.event_seq`,
      [ctx.accountId, workspaceId, streamId],
    );
    if (rows.rows.length !== Number(row.event_seq)) throw badRequest('云端事件流不连续，不能恢复');
    const result = {
      stream: binding(row), branch: SyncBranchManifestSchema.parse(row.branch_manifest ?? fallback),
      events: rows.rows.map((entry): SyncEventEntry => ({
        seq: Number(entry.event_seq), eventId: entry.event_id, digest: entry.digest,
        at: entry.occurred_at.toISOString(), event: entry.body, command: entry.command,
      })),
    };
    if (Buffer.byteLength(JSON.stringify(result)) > CLOUD_LIMITS.uploadObjectBytes) {
      throw new CloudError(413, 'STORAGE_QUOTA', 'sync', '冲突恢复包超过当前容量上限；原历史保留，不会截断', 'contact_support');
    }
    return result;
  }

  private async streams(q: Querier, ctx: AuthContext, workspaceId: string): Promise<SyncStreamBinding[]> {
    const rows = await q.query<StreamRow>(
      'SELECT stream_id, branch_id, event_seq, last_event_id FROM sync_streams WHERE account_id = $1 AND workspace_id = $2 ORDER BY stream_id',
      [ctx.accountId, workspaceId],
    );
    return rows.rows.map(binding);
  }

  /** Source object reads happen before the retried transaction. One workspace lock fixes the whole cut. */
  async snapshot(ctx: AuthContext, raw: ReadingSnapshotRequest): Promise<ReadingSnapshot> {
    const input = ReadingSnapshotRequestSchema.parse(raw);
    await this.app.withTenant(ctx.accountId, (q) => workspaceRow(q, ctx, input.workspaceId, false));
    if (!this.source || !this.content) throw new CloudError(409, 'UNSUPPORTED_CONTRACT', 'sync', '缺少快照验证上下文，本机数据保留', 'contact_support');
    const source = await this.source(ctx, input.workspaceId);
    return this.app.withTenant(ctx.accountId, async (q) => {
      await lockAccount(q, ctx.accountId);
      const workspace = await workspaceRow(q, ctx, input.workspaceId, true);
      if (BigInt(workspace.cloud_version) < BigInt(input.cloudVersion)) throw new CloudError(409, 'BASIS_CHANGED', 'sync', '云端版本早于本机已确认版本，不能恢复快照', 'contact_support');
      const streams = await this.streams(q, ctx, input.workspaceId);
      if (!streams.length || streams.length > 64 || streams.reduce((n, s) => n + s.eventSeq, 0) > 10_000) {
        throw new CloudError(413, 'STORAGE_QUOTA', 'sync', '完整阅读快照超过当前容量，历史保留且不截断', 'contact_support');
      }
      const histories: ReadingSnapshot['histories'] = [];
      for (const stream of streams) histories.push(await this.history(q, ctx, input.workspaceId, stream.streamId,
        source.branches.some((b) => b.id === stream.streamId) ? manifestOf(source.branches.find((b) => b.id === stream.streamId)!) : undefined));
      for (const prefix of input.streams) {
        const h = histories.find((h) => h.stream.streamId === prefix.streamId);
        if (!h || h.events.length < prefix.eventSeq || (h.events[prefix.eventSeq - 1]?.eventId ?? null) !== prefix.lastEventId) {
          throw new CloudError(409, 'BASIS_CHANGED', 'sync', '快照不能证明本机已确认前缀，完整历史保留', 'contact_support');
        }
      }
      const head = (await q.query<{ change_seq: string }>('SELECT change_seq FROM workspace_change_heads WHERE account_id = $1 AND workspace_id = $2', [ctx.accountId, input.workspaceId])).rows[0]!;
      const body = { format: 'cloud-reading-snapshot/1' as const, workspaceId: input.workspaceId,
        cloudVersion: String(workspace.cloud_version), changeSeq: Number(head.change_seq),
        cursor: encodeSyncCursor(input.workspaceId, Number(head.change_seq), Number(workspace.sync_epoch)),
        source, sourceDigest: sha(stableStringify(source)), histories, revisionCatalog: await revisionCatalog(q, ctx, input.workspaceId) };
      const result = ReadingSnapshotSchema.parse({ ...body, digest: sha(stableStringify(body)) });
      if (Buffer.byteLength(JSON.stringify(result)) > CLOUD_LIMITS.uploadObjectBytes - 4096) throw new CloudError(413, 'STORAGE_QUOTA', 'sync', '完整阅读快照超过当前字节容量，历史保留且不截断', 'contact_support');
      try { await rebuildCloudReading(this.content!, result, async (value) => sha(stableStringify(value))); }
      catch { throw new CloudError(409, 'CONTENT_REJECTED', 'contract', '云端快照未通过原生内容与历史重放，完整本机数据保留', 'contact_support'); }
      return result;
    });
  }

  async bootstrap(ctx: AuthContext, workspaceId: string, recovery?: SyncRecoveryRequest): Promise<SyncBootstrap> {
    return this.app.withTenant(ctx.accountId, async (q) => {
      const workspace = await workspaceRow(q, ctx, workspaceId, true);
      if (recovery) {
        if (!SyncRecoveryRequestSchema.safeParse(recovery).success || recovery.workspaceId !== workspaceId) throw badRequest('恢复前缀格式无效');
        if (BigInt(workspace.cloud_version) < BigInt(recovery.cloudVersion)) {
          throw new CloudError(409, 'BASIS_CHANGED', 'sync', '云端版本早于本机已确认版本；完整历史保留，不能重新引导', 'contact_support');
        }
        // The workspace lock also serializes push/register/adopt. Never re-anchor over a DB rollback.
        for (const prefix of recovery.streams) {
          const row = (await q.query<{ event_seq: string; event_id: string | null }>(
            `SELECT s.event_seq, e.event_id FROM sync_streams s LEFT JOIN stream_events e
             ON e.account_id = s.account_id AND e.workspace_id = s.workspace_id
               AND e.stream_id = s.stream_id AND e.event_seq = $4
             WHERE s.account_id = $1 AND s.workspace_id = $2 AND s.stream_id = $3`,
            [ctx.accountId, workspaceId, prefix.streamId, prefix.eventSeq],
          )).rows[0];
          if (!row || Number(row.event_seq) < prefix.eventSeq || row.event_id !== prefix.lastEventId) {
            throw new CloudError(409, 'BASIS_CHANGED', 'sync', '云端不能证明本机已确认的历史前缀；完整历史保留，不能重新引导', 'contact_support');
          }
        }
      }
      const head = (await q.query<{ change_seq: string; retained_from: string }>(
        'SELECT change_seq, retained_from FROM workspace_change_heads WHERE account_id = $1 AND workspace_id = $2',
        [ctx.accountId, workspaceId],
      )).rows[0];
      if (recovery) {
        const inventory = (await q.query<{ count: string; first: string | null; last: string | null }>(
          `SELECT count(*) AS count, min(change_seq) AS first, max(change_seq) AS last
           FROM workspace_changes WHERE account_id = $1 AND workspace_id = $2`, [ctx.accountId, workspaceId],
        )).rows[0]!;
        const end = Number(head?.change_seq ?? 0);
        if (Number(inventory.count) !== end || (end > 0 && (Number(inventory.first) !== 1 || Number(inventory.last) !== end))) {
          throw new CloudError(409, 'UNSUPPORTED_CONTRACT', 'sync', '保留的阅读变更流不完整，需要完整快照恢复；本机数据保留', 'contact_support');
        }
      }
      const initial = await q.query<StreamRow>(
        `WITH initial AS (
          SELECT s.stream_id, s.branch_id,
            COALESCE((SELECT min(c.from_seq) FROM workspace_changes c
              WHERE c.account_id = s.account_id AND c.workspace_id = s.workspace_id AND c.stream_id = s.stream_id),
              s.event_seq) AS event_seq
          FROM sync_streams s JOIN cloud_id_mappings m
            ON m.account_id = s.account_id AND m.workspace_id = s.workspace_id AND m.kind = 'branch' AND m.source_id = s.stream_id
          WHERE s.account_id = $1 AND s.workspace_id = $2
        )
        SELECT i.stream_id, i.branch_id, i.event_seq, e.event_id AS last_event_id
        FROM initial i LEFT JOIN stream_events e
          ON e.account_id = $1 AND e.workspace_id = $2 AND e.stream_id = i.stream_id AND e.event_seq = i.event_seq
        ORDER BY i.stream_id`,
        [ctx.accountId, workspaceId],
      );
      return {
        workspaceId, cloudVersion: String(workspace.cloud_version),
        changeSeq: head ? Number(head.change_seq) : 0,
        ...(Number(head?.retained_from ?? 0) > 0 ? { retainedFrom: Number(head!.retained_from) } : {}),
        cursor: encodeSyncCursor(workspaceId, head ? Number(head.change_seq) : 0, Number(workspace.sync_epoch)),
        streams: await this.streams(q, ctx, workspaceId),
        origin: {
          cursor: encodeSyncCursor(workspaceId, 0, Number(workspace.sync_epoch)),
          streams: initial.rows.map(binding),
        },
      };
    });
  }

  /**
   * 注册本机新建分支的事件流。
   *
   * 只接受「父流 + 分叉点」：前缀成员关系由服务端从父流复制，事件正文不复制。
   * 这样新分支的第一条事件必须接在 `forkAtSeq` 之后，客户端不能凭空宣称
   * 一段自己没推过的历史；分叉点也不能超过父流已有的云端历史。
   * 同一 streamId 重复注册是幂等的（网络重试），参数不同则拒绝，不静默改绑。
   */
  async registerStream(ctx: AuthContext, input: RegisterStreamRequest): Promise<RegisterStreamResponse> {
    if (input.streamId === input.parentStreamId) throw badRequest('分叉流不能以自己为父流');
    return this.app.withTenant(ctx.accountId, async (q) => {
      await lockAccount(q, ctx.accountId);
      await workspaceRow(q, ctx, input.workspaceId, true);

      const existing = (await q.query<StreamRow & { parent_stream_id: string | null; fork_at_seq: string | null }>(
        `SELECT stream_id, branch_id, event_seq, last_event_id, parent_stream_id, fork_at_seq
         FROM sync_streams WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3 FOR UPDATE`,
        [ctx.accountId, input.workspaceId, input.streamId],
      )).rows[0];
      if (existing) {
        const sameFork = existing.parent_stream_id === input.parentStreamId
          && Number(existing.fork_at_seq) === input.forkAtSeq;
        if (!sameFork) throw badRequest('该事件流已绑定到另一个分叉点，不能改绑');
        return { stream: binding(existing) };
      }

      const parent = (await q.query<StreamRow>(
        `SELECT stream_id, branch_id, event_seq, last_event_id FROM sync_streams
         WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3 FOR UPDATE`,
        [ctx.accountId, input.workspaceId, input.parentStreamId],
      )).rows[0];
      if (!parent) throw notFound('父事件流不存在；不能声明一段云端没有的历史作为前缀');
      if (input.forkAtSeq > Number(parent.event_seq)) {
        throw badRequest('分叉点超出父流的云端历史；请先推送父流前缀再注册');
      }

      // 先建流头（空的），再复制前缀成员关系：stream_events 有指向 sync_streams 的外键
      await q.query(
        `INSERT INTO sync_streams
           (account_id, workspace_id, stream_id, branch_id, event_seq, last_event_id, parent_stream_id, fork_at_seq)
         VALUES ($1, $2, $3, $3, 0, NULL, $4, $5)`,
        [ctx.accountId, input.workspaceId, input.streamId, input.parentStreamId, input.forkAtSeq],
      );
      await q.query(
        `UPDATE sync_streams child SET branch_manifest = parent.branch_manifest ||
           jsonb_build_object('streamId', $4::text, 'parentBranchId', $3::text, 'forkAtEventCount', $5::bigint,
             'commonStreamId', $3::text, 'commonPrefixSeq', $5::bigint)
         FROM sync_streams parent
         WHERE child.account_id = $1 AND child.workspace_id = $2 AND child.stream_id = $4
           AND parent.account_id = $1 AND parent.workspace_id = $2 AND parent.stream_id = $3`,
        [ctx.accountId, input.workspaceId, input.parentStreamId, input.streamId, input.forkAtSeq],
      );
      await q.query(
        `INSERT INTO stream_events (account_id, workspace_id, stream_id, event_seq, event_id)
         SELECT account_id, workspace_id, $4, event_seq, event_id FROM stream_events
         WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3 AND event_seq <= $5`,
        [ctx.accountId, input.workspaceId, input.parentStreamId, input.streamId, input.forkAtSeq],
      );
      const last = (await q.query<{ event_id: string }>(
        `SELECT event_id FROM stream_events
         WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3 AND event_seq = $4`,
        [ctx.accountId, input.workspaceId, input.streamId, input.forkAtSeq],
      )).rows[0];
      if (input.forkAtSeq > 0) {
        await q.query(
          'UPDATE sync_streams SET event_seq = $4, last_event_id = $5, updated_at = now() WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3',
          [ctx.accountId, input.workspaceId, input.streamId, input.forkAtSeq, last!.event_id],
        );
      }
      return {
        stream: {
          streamId: input.streamId, branchId: input.streamId,
          eventSeq: input.forkAtSeq, lastEventId: last?.event_id ?? null,
        },
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
      // 候选记录单独提交：业务整批回滚，但「被拒绝的历史」不能跟着消失。
      const id = await this.app.withTenant(ctx.accountId, async (q) => {
        await lockAccount(q, ctx.accountId);
        await workspaceRow(q, ctx, input.workspaceId, true);
        // Like sync_batches, batch identity belongs to the workspace. A new OTP session may rotate
        // device_id while retrying the same durable Outbox; keep the first candidate and its author.
        const prior = (await q.query<{ id: string; payload: { requestDigest?: string } }>(
          `SELECT id, payload FROM sync_conflicts WHERE account_id = $1 AND workspace_id = $2
           AND payload->>'batchId' = $3 ORDER BY created_at, id LIMIT 1`,
          [ctx.accountId, input.workspaceId, input.batchId],
        )).rows[0];
        if (prior) {
          if (prior.payload.requestDigest !== digest) throw idempotencyMismatch();
          return prior.id;
        }
        const id = randomUUID();
        await q.query(`INSERT INTO sync_conflicts
           (account_id, workspace_id, id, stream_id, device_id, reason, base_seq, cloud_seq, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [ctx.accountId, input.workspaceId, id, error.streamId, ctx.deviceId, error.reason,
          error.baseSeq, error.cloudSeq, JSON.stringify({ batchId: input.batchId, requestDigest: digest, events: error.events })]);
        return id;
      });
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
          '云端还没有这条事件流；请先注册（父流 + 分叉点）。本机事件保留，不会被裁剪', 'contact_support');
      }
      const head = Number(row.event_seq);
      if (stream.baseSeq !== head || (stream.baseEventId ?? null) !== row.last_event_id) {
        throw new SyncRejection('stream-head-changed', stream.streamId, stream.baseSeq, head, stream.events);
      }
      await this.assertStamps(q, ctx, input.workspaceId, stream.events, stream.streamId);
      const ids: string[] = [];
      let expected = head + 1;
      for (const entry of stream.events) {
        if (entry.seq !== expected) throw badRequest('事件序号必须与流前缀连续');
        const body = sha(stableStringify(entry.event));
        if (body !== entry.digest) throw new SyncRejection('event-digest-mismatch', stream.streamId, stream.baseSeq, head, stream.events);
        if (entry.at !== entry.event.at || stableStringify(entry.command) !== stableStringify(commandOfEvent(entry.event))) {
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
          applied++;
        }
        await q.query(
          'INSERT INTO stream_events (account_id, workspace_id, stream_id, event_seq, event_id) VALUES ($1, $2, $3, $4, $5)',
          [ctx.accountId, input.workspaceId, stream.streamId, entry.seq, entry.eventId],
        );
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
             (account_id, workspace_id, change_seq, batch_id, device_id, stream_id, from_seq, to_seq, event_ids, branch_manifest)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid[],
             (SELECT branch_manifest FROM sync_streams WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $6))`,
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
  private async assertStamps(q: Querier, ctx: AuthContext, workspaceId: string, events: SyncEventEntry[], streamId?: string) {
    const contentIds = new Set<string>();
    const revisionIds = new Set<string>();
    for (const entry of events) {
      const { contentId, revisionId } = entry.event;
      if ((contentId === undefined) !== (revisionId === undefined)) throw badRequest('事件的内容/修订盖章必须成对出现');
      if (contentId && revisionId) { contentIds.add(contentId); revisionIds.add(revisionId); }
    }
    const registered = await revisionCatalog(q, ctx, workspaceId);
    const manifest = streamId ? (await q.query<{ branch_manifest: unknown }>(
      'SELECT branch_manifest FROM sync_streams WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3',
      [ctx.accountId, workspaceId, streamId])).rows[0]?.branch_manifest : undefined;
    const branch = SyncBranchManifestSchema.safeParse(manifest);
    if (registered.version && (!branch.success || events.some((e) => !e.event.contentId || !e.event.revisionId
      || !branch.data.adopted.some((a) => a.contentId === e.event.contentId && a.revisionId === e.event.revisionId)))) {
      throw new CloudError(409, 'BASIS_CHANGED', 'sync', '云端已采用新修订，请先接收修订清单；本机事件保留，不能按旧正文追加', 'retry_read');
    }
    if (!contentIds.size) return;
    const rows = await q.query<{ kind: string; source_id: string }>(
      `SELECT kind, source_id FROM cloud_id_mappings
       WHERE account_id = $1 AND workspace_id = $2
         AND ((kind = 'content' AND source_id = ANY($3::text[])) OR (kind = 'revision' AND source_id = ANY($4::text[])))`,
      [ctx.accountId, workspaceId, [...contentIds], [...revisionIds]],
    );
    const known = new Set(rows.rows.map((row) => `${row.kind}:${row.source_id}`));
    for (const registration of registered.registrations) known.add(`revision:${registration.entry.headRevisionId}`);
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
      const workspace = await workspaceRow(q, ctx, workspaceId, true);
      const epoch = Number(workspace.sync_epoch);
      const position = cursor ? decodeSyncCursor(cursor, workspaceId) : { seq: 0, epoch };
      if (position.epoch !== epoch) throw cursorExpired();
      const head = (await q.query<{ change_seq: string; retained_from: string }>(
        'SELECT change_seq, retained_from FROM workspace_change_heads WHERE account_id = $1 AND workspace_id = $2',
        [ctx.accountId, workspaceId],
      )).rows[0];
      const headSeq = head ? Number(head.change_seq) : 0;
      // 游标超前（库被回滚或恢复）只能重新引导，不能猜一个位置继续读。
      if (position.seq > headSeq || position.seq < Number(head?.retained_from ?? 0)) throw cursorExpired();

      const rows = await q.query<{
        change_seq: string; batch_id: string; device_id: string; stream_id: string;
        from_seq: string; to_seq: string; event_ids: string[]; created_at: Date; branch_manifest: SyncBranchManifest | null;
      }>(
        `SELECT change_seq, batch_id, device_id, stream_id, from_seq, to_seq, event_ids, created_at, branch_manifest
         FROM workspace_changes WHERE account_id = $1 AND workspace_id = $2 AND change_seq > $3
         ORDER BY change_seq LIMIT $4`,
        [ctx.accountId, workspaceId, position.seq, page + 1],
      );
      const pageRows = rows.rows.slice(0, page);
      if (pageRows.some((r, i) => Number(r.change_seq) !== position.seq + i + 1)
        || (!pageRows.length && position.seq < headSeq)) throw cursorExpired();
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
        ...(row.branch_manifest ? { branch: row.branch_manifest } : {}),
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
        fromChangeSeq: position.seq, changeSeq: lastSeq,
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

  private async listConflicts(q: Querier, ctx: AuthContext, workspaceId: string, conflictId?: string) {
    const rows = await q.query<{
      id: string; stream_id: string; device_id: string; reason: SyncConflict['reason'];
      status: SyncConflict['status']; base_seq: string; cloud_seq: string;
      created_at: Date; resolved_at: Date | null; payload: { events: SyncEventEntry[] };
    }>(
      `SELECT id, stream_id, device_id, reason, status, base_seq, cloud_seq, created_at, resolved_at, payload
       FROM sync_conflicts WHERE account_id = $1 AND workspace_id = $2 AND ($3::uuid IS NULL OR id = $3)
       ORDER BY created_at DESC LIMIT 50`,
      [ctx.accountId, workspaceId, conflictId ?? null],
    );
    return { conflicts: rows.rows.map((row): SyncConflict => ({
      id: row.id, workspaceId, streamId: row.stream_id as SyncConflict['streamId'], deviceId: row.device_id,
      reason: row.reason, status: row.status, baseSeq: Number(row.base_seq), cloudSeq: Number(row.cloud_seq),
      createdAt: row.created_at.toISOString(), resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
      events: row.payload.events,
    })) };
  }

  async resolve(ctx: AuthContext, workspaceId: string, conflictId: string, input: ResolveConflictRequest): Promise<ResolveConflictResponse> {
    const parsed = ResolveConflictRequestSchema.safeParse(input);
    if (!parsed.success || input.workspaceId !== workspaceId || !UuidSchema.safeParse(conflictId).success) throw badRequest('冲突处理格式无效');
    if (input.decision === 'keep-branch') return this.preserve(ctx, workspaceId, conflictId, input);
    const digest = sha(stableStringify(input));
    const cached = await this.app.withTenant(ctx.accountId, async (q) => {
      await workspaceRow(q, ctx, workspaceId, false);
      return (await q.query<{ stream_id: string; resolution_digest: string | null; resolution_receipt: ResolveConflictResponse | null }>(
        'SELECT stream_id, resolution_digest, resolution_receipt FROM sync_conflicts WHERE account_id = $1 AND workspace_id = $2 AND id = $3',
        [ctx.accountId, workspaceId, conflictId],
      )).rows[0];
    });
    if (!cached) throw notFound('冲突不存在');
    if (cached.resolution_receipt) {
      if (cached.resolution_digest !== digest) throw idempotencyMismatch();
      return cached.resolution_receipt;
    }
    // Verified original reads (only for old streams missing a manifest) stay outside retried transactions.
    const fallback = await this.fallbackManifest(ctx, workspaceId, cached.stream_id);
    return this.app.withTenant(ctx.accountId, async (q) => {
      await lockAccount(q, ctx.accountId);
      await workspaceRow(q, ctx, workspaceId, true);
      const held = (await q.query<{ stream_id: string; status: string; resolution_digest: string | null; resolution_receipt: ResolveConflictResponse | null }>(
        `SELECT stream_id, status, resolution_digest, resolution_receipt FROM sync_conflicts
         WHERE account_id = $1 AND workspace_id = $2 AND id = $3 FOR UPDATE`,
        [ctx.accountId, workspaceId, conflictId],
      )).rows[0];
      if (!held) throw notFound('冲突不存在');
      if (held.resolution_receipt) {
        if (held.resolution_digest !== digest) throw idempotencyMismatch();
        return held.resolution_receipt;
      }
      if (held.status !== 'open' && held.status !== 'discarded') throw idempotencyMismatch();
      const history = await this.history(q, ctx, workspaceId, held.stream_id, fallback);
      await q.query(`UPDATE sync_conflicts SET status = 'discarded', resolved_at = COALESCE(resolved_at, now())
        WHERE account_id = $1 AND workspace_id = $2 AND id = $3`, [ctx.accountId, workspaceId, conflictId]);
      const listed = await this.listConflicts(q, ctx, workspaceId, conflictId);
      const conflict = listed.conflicts.find((entry) => entry.id === conflictId);
      if (!conflict) throw notFound('冲突不存在');
      const receipt = { conflict, stream: history.stream, history };
      if (Buffer.byteLength(JSON.stringify(receipt)) > CLOUD_LIMITS.uploadObjectBytes) throw new CloudError(413, 'STORAGE_QUOTA', 'sync',
        '放弃恢复回执超过当前容量，原候选与历史保留；不能截断恢复', 'contact_support');
      await q.query(`UPDATE sync_conflicts SET resolution_digest = $4, resolution_receipt = $5
        WHERE account_id = $1 AND workspace_id = $2 AND id = $3`, [ctx.accountId, workspaceId, conflictId, digest, JSON.stringify(receipt)]);
      return receipt;
    });
  }

  private async preserve(ctx: AuthContext, workspaceId: string, conflictId: string, input: Extract<ResolveConflictRequest, { decision: 'keep-branch' }>): Promise<ResolveConflictResponse> {
    if (!UuidSchema.safeParse(conflictId).success || !input.streamId.startsWith('brn_')) throw badRequest('冲突或新分支身份格式无效');
    const digest = sha(stableStringify(input));
    const cached = await this.app.withTenant(ctx.accountId, async (q) => {
      await workspaceRow(q, ctx, workspaceId, false);
      return (await q.query<{ device_id: string; resolution_digest: string | null; resolution_receipt: ResolveConflictResponse | null }>(
        'SELECT device_id, resolution_digest, resolution_receipt FROM sync_conflicts WHERE account_id = $1 AND workspace_id = $2 AND id = $3',
        [ctx.accountId, workspaceId, conflictId],
      )).rows[0];
    });
    if (!cached) throw notFound('冲突候选不存在');
    if (cached.resolution_receipt) {
      if (cached.resolution_digest !== digest) throw idempotencyMismatch();
      return cached.resolution_receipt;
    }
    const conflict = (await this.app.withTenant(ctx.accountId, (q) => this.listConflicts(q, ctx, workspaceId, conflictId))).conflicts[0];
    if (!conflict) throw notFound('冲突候选不存在');
    const fallback = await this.fallbackManifest(ctx, workspaceId, conflict.streamId);
    return this.app.withTenant(ctx.accountId, async (q) => {
      await lockAccount(q, ctx.accountId);
      const workspace = await workspaceRow(q, ctx, workspaceId, true);
      const held = (await q.query<{
        status: string; resolution_digest: string | null; resolution_receipt: ResolveConflictResponse | null;
      }>(
        'SELECT status, resolution_digest, resolution_receipt FROM sync_conflicts WHERE account_id = $1 AND workspace_id = $2 AND id = $3 FOR UPDATE',
        [ctx.accountId, workspaceId, conflictId],
      )).rows[0];
      if (!held) throw notFound('冲突不存在');
      if (held.resolution_receipt) {
        if (held.resolution_digest !== digest) throw idempotencyMismatch();
        return held.resolution_receipt;
      }
      if (held.status !== 'open' || conflict.reason !== 'stream-head-changed') throw badRequest('该候选不能保留为合法独立分支');
      if (conflict.baseSeq + conflict.events.length > 10_000) throw new CloudError(409, 'STORAGE_QUOTA', 'sync',
        '保留历史超过当前恢复容量，候选与原历史保留；不能截断创建分支', 'contact_support');
      const original = await this.history(q, ctx, workspaceId, conflict.streamId, fallback);
      // An old rejected batch cannot inherit a newer adoption manifest during preservation.
      await this.assertStamps(q, ctx, workspaceId, conflict.events, conflict.streamId);
      if (input.streamId === conflict.streamId || (conflict.baseSeq ? original.events[conflict.baseSeq - 1]?.eventId : null) !== input.baseEventId) {
        throw badRequest('共同前缀身份不匹配，不能创建独立分支');
      }
      const count = await q.query<{ count: string }>('SELECT count(*) FROM sync_streams WHERE account_id = $1 AND workspace_id = $2', [ctx.accountId, workspaceId]);
      if (Number(count.rows[0]!.count) >= 64) throw new CloudError(409, 'STORAGE_QUOTA', 'sync', '分支容量不足，完整冲突包保留；不会删除旧分支腾空间', 'contact_support');
      const manifest: SyncBranchManifest = {
        ...original.branch, streamId: input.streamId, label: `${original.branch.label.slice(0, 45)} · 离线保留`,
        parentBranchId: null, forkAtEventCount: null,
        commonStreamId: conflict.streamId, commonPrefixSeq: conflict.baseSeq,
        createdAt: conflict.createdAt,
      };
      const created = await q.query(
        `INSERT INTO sync_streams (account_id, workspace_id, stream_id, branch_id, branch_manifest)
         VALUES ($1, $2, $3, $3, $4) ON CONFLICT DO NOTHING RETURNING stream_id`,
        [ctx.accountId, workspaceId, input.streamId, JSON.stringify(manifest)],
      );
      if (!created.rows[0]) throw idempotencyMismatch();
      await q.query(
        `INSERT INTO stream_events (account_id, workspace_id, stream_id, event_seq, event_id)
         SELECT account_id, workspace_id, $4, event_seq, event_id FROM stream_events
         WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3 AND event_seq <= $5`,
        [ctx.accountId, workspaceId, conflict.streamId, input.streamId, conflict.baseSeq],
      );
      if (conflict.baseSeq) await q.query(
        'UPDATE sync_streams SET event_seq = $4, last_event_id = $5 WHERE account_id = $1 AND workspace_id = $2 AND stream_id = $3',
        [ctx.accountId, workspaceId, input.streamId, conflict.baseSeq, input.baseEventId],
      );
      const push: SyncPushRequest = {
        workspaceId, batchId: input.streamId.slice(4), baseVersion: String(workspace.cloud_version),
        streams: [{ streamId: input.streamId, baseSeq: conflict.baseSeq, baseEventId: input.baseEventId, events: conflict.events }],
      };
      const result = await this.applyBatch(q, ctx, push, sha(stableStringify(push)));
      const response: ResolveConflictResponse = {
        conflict: { ...conflict, status: 'preserved', resolvedAt: new Date().toISOString() },
        stream: original.stream, preserved: result.receipt.streams[0]!, history: original,
      };
      await q.query(
        `UPDATE sync_conflicts SET status = 'preserved', resolved_at = $4, resolution_digest = $5, resolution_receipt = $6
         WHERE account_id = $1 AND workspace_id = $2 AND id = $3`,
        [ctx.accountId, workspaceId, conflictId, response.conflict.resolvedAt, digest, JSON.stringify(response)],
      );
      return response;
    }).catch((error: unknown) => {
      if (error instanceof SyncRejection) throw badRequest('候选事件的摘要或身份不一致；未创建分支，完整候选保留');
      throw error;
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
