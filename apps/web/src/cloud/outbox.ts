import { stableStringify } from '@endless/esl';
import { SyncPushRequestSchema, type SyncCommand, type SyncPlayerEvent, type SyncPushRequest } from '@endless/cloud-contracts';

/**
 * 事务内 Outbox 的纯逻辑（计划 §8.3）。
 *
 * 三条不变量，全部在这里用纯函数表达，便于在 Node 里直接测：
 *   1. 身份只分配一次：同一 (流, 序号) 已分配过 eventId 就沿用，网络重试不会换 ID。
 *   2. 只认前缀：提交态必须把存储态的事件当作严格前缀，否则不猜、不重写——
 *      标记 `replaced` 交给人处理，避免把「恢复旧备份」当成「追加了两千个事件」。
 *   3. 界面偏好不是事件：`select`/`text` 从不进入 `session.events`，
 *      这一层也就不可能把它们写进 Outbox。
 */

/** 流身份即分支 ID（`brn_<uuid>`）；线上 schema 会再校验一次格式。 */
type StreamId = string;

export interface BranchSlice {
  id: string;
  parentBranchId: string | null;
  forkAtEventCount: number | null;
  events: readonly unknown[];
}

export interface SidecarEntry { eventId: string; event: SyncPlayerEvent }

export interface OutboxEntry {
  streamId: StreamId;
  seq: number;
  eventId: string;
  at: string;
  event: SyncPlayerEvent;
  command: SyncCommand;
}

/**
 * 本机同步状态。`streams` 是「云端已确认的前缀」，推送只从这里往后接；
 * `needsRebase` 表示本机历史被整体替换过，该分支停止推送，等待显式处理。
 */
export interface CloudSyncState {
  cursor: string | null;
  cloudVersion: string | null;
  streams: Record<string, { seq: number; eventId: string | null }>;
  paused: boolean;
  conflicts: { id: string; streamId: string; baseSeq: number; cloudSeq: number; createdAt: string }[];
  needsRebase: string[];
  lastError: string | null;
  lastSyncedAt: string | null;
  pendingPush?: SyncPushRequest;
}

export const emptySyncState = (): CloudSyncState => ({
  cursor: null, cloudVersion: null, streams: {}, paused: false,
  conflicts: [], needsRebase: [], lastError: null, lastSyncedAt: null,
});

/** 读取存储态时容错：损坏的同步状态按空状态处理，绝不因此清空业务数据。 */
export function parseSyncState(raw: unknown): CloudSyncState {
  const value = (raw ?? {}) as Partial<CloudSyncState>;
  const streams: CloudSyncState['streams'] = {};
  for (const [key, entry] of Object.entries(value.streams ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    const { seq, eventId } = entry as { seq?: unknown; eventId?: unknown };
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) continue;
    streams[key] = { seq, eventId: typeof eventId === 'string' ? eventId : null };
  }
  return {
    cursor: typeof value.cursor === 'string' ? value.cursor : null,
    cloudVersion: typeof value.cloudVersion === 'string' ? value.cloudVersion : null,
    streams,
    paused: value.paused === true,
    conflicts: Array.isArray(value.conflicts) ? value.conflicts.filter((entry) => entry && typeof entry.id === 'string') : [],
    needsRebase: Array.isArray(value.needsRebase) ? value.needsRebase.filter((entry): entry is string => typeof entry === 'string') : [],
    lastError: typeof value.lastError === 'string' ? value.lastError : null,
    lastSyncedAt: typeof value.lastSyncedAt === 'string' ? value.lastSyncedAt : null,
    ...(value.pendingPush === undefined ? {} : { pendingPush: SyncPushRequestSchema.parse(value.pendingPush) }),
  };
}

export interface SyncPlan {
  enqueue: OutboxEntry[];
  sidecar: { key: string; value: SidecarEntry }[];
  /** 本机历史被整体替换（例如恢复旧备份）的分支：不再分配身份，等待显式处理。 */
  replaced: StreamId[];
}

export const sidecarKey = (streamId: string, seq: number) => `${streamId}:${seq}`;

/** 事件 → 可重放命令：另一台设备在同一前缀上用同一 `at` 重放得到同一事件。 */
export function commandOfEvent(event: { type: string; scene: string; choice?: number; skip?: boolean }): SyncCommand {
  if (event.type === 'answer') return { type: 'answer', scene: event.scene, choice: event.choice ?? 0 };
  if (event.type === 'advance') return { type: 'advance', scene: event.scene, skip: event.skip ?? false };
  return { type: 'reveal', scene: event.scene };
}

const same = (left: unknown, right: unknown) => stableStringify(left) === stableStringify(right);

export function planOutbox(input: {
  stored: readonly BranchSlice[];
  next: readonly BranchSlice[];
  sidecar: ReadonlyMap<string, SidecarEntry>;
  /** 远端已确认的事件身份：重放云端变更时不产生 Outbox 回环。 */
  remote?: { streamId: string; startSeq: number; eventIds: readonly string[]; prefixStreamId?: string };
  newId: () => string;
}): SyncPlan {
  const plan: SyncPlan = { enqueue: [], sidecar: [], replaced: [] };
  const stored = new Map(input.stored.map((branch) => [branch.id, branch]));

  for (const branch of input.next) {
    const held = stored.get(branch.id);
    const prefixStreamId = input.remote?.streamId === branch.id ? input.remote.prefixStreamId : undefined;
    const parent = branch.parentBranchId ? stored.get(branch.parentBranchId) : prefixStreamId ? stored.get(prefixStreamId) : undefined;
    let base: readonly unknown[];
    let replaysPrefix = true;
    if (held) {
      base = held.events;
    } else if (parent) {
      // 新分支复制父分支前缀：前缀沿用父流自己的事件身份，不重新分配
      const forkAt = prefixStreamId ? input.remote!.startSeq - 1 : branch.forkAtEventCount ?? parent.events.length;
      base = parent.events.slice(0, forkAt);
      for (let index = 0; index < base.length; index++) {
        if (!same(branch.events[index], base[index])) { replaysPrefix = false; break; }
        const inherited = input.sidecar.get(sidecarKey(parent.id, index + 1));
        if (inherited) plan.sidecar.push({ key: sidecarKey(branch.id, index + 1), value: inherited });
      }
    } else {
      base = [];
    }

    if (held) {
      for (let index = 0; index < base.length; index++) {
        if (!same(branch.events[index], base[index])) { replaysPrefix = false; break; }
      }
    }
    if (!replaysPrefix || branch.events.length < base.length) {
      plan.replaced.push(branch.id as StreamId);
      continue;
    }

    for (let index = base.length; index < branch.events.length; index++) {
      const seq = index + 1;
      const event = branch.events[index]!;
      const key = sidecarKey(branch.id, seq);
      const known = input.sidecar.get(key);
      const remote = input.remote?.streamId === branch.id && seq >= input.remote.startSeq
        ? input.remote.eventIds[seq - input.remote.startSeq]
        : undefined;
      const eventId = remote ?? known?.eventId ?? input.newId();
      const typed = event as SyncPlayerEvent;
      if (!known || known.eventId !== eventId) plan.sidecar.push({ key, value: { eventId, event: typed } });
      // 云端已经确认过的事件不再回推，否则两个设备会互相回声
      if (remote || known) continue;
      plan.enqueue.push({
        streamId: branch.id as StreamId, seq, eventId,
        at: typed.at,
        event: typed, command: commandOfEvent(typed),
      });
    }
  }
  return plan;
}

/** 待推送事件按流分组：只有能接在当前云端前缀之后的连续段可以发。 */export function outgoing(entries: readonly OutboxEntry[], confirmed: Record<string, { seq: number; eventId: string | null }>) {
  const groups = new Map<StreamId, OutboxEntry[]>();
  for (const entry of [...entries].sort((left, right) => left.seq - right.seq)) {
    const list = groups.get(entry.streamId) ?? [];
    list.push(entry);
    groups.set(entry.streamId, list);
  }
  const streams: { streamId: StreamId; baseSeq: number; baseEventId: string | null; events: OutboxEntry[] }[] = [];
  for (const [streamId, list] of groups) {
    const known = confirmed[streamId];
    if (!known) continue; // 没有云端绑定前不猜起点
    const ready: OutboxEntry[] = [];
    let expected = known.seq + 1;
    for (const entry of list) {
      if (entry.seq < expected) continue;
      if (entry.seq !== expected) break; // 有空洞就停，不跳着发
      ready.push(entry);
      expected++;
    }
    if (!ready.length) continue;
    streams.push({ streamId, baseSeq: known.seq, baseEventId: known.eventId, events: ready });
  }
  return streams;
}
