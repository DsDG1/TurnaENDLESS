import { stableStringify } from '@endless/esl';
import { applyPlayerCommand, type Content, type Workspace } from '@endless/content';
import { CLOUD_LIMITS, type SyncBootstrap, type SyncChange, type SyncConflict, type SyncPushReceipt, type SyncPushRequest } from '@endless/cloud-contracts';
import { SessionCommitter, type CommitOutcome } from '../session-writer.js';
import { CloudFailure } from './client.js';
import { emptySyncState, outgoing, type CloudSyncState, type OutboxEntry } from './outbox.js';

/**
 * 增量同步驱动（计划 §8.3–8.7）。不依赖 React，全部副作用可注入。
 *
 * 纪律：
 * 1. 先推送再拉取：本机未同步事件先取得云端的接受或明确拒绝，之后才应用别人的变更；
 * 2. 冲突不猜：`SYNC_CONFLICT` 只记录冲突 ID 并停手，绝不把两条历史拼接成一条；
 * 3. 游标过期不覆盖：有过期错误时先检查本机是否还有未推送事件，有就要求显式处理；
 * 4. 应用远端变更必须逐条重放并对齐正文，重放不出来的变更直接停在该处并上报。
 */

export interface SyncRepository {
  syncState(): Promise<CloudSyncState>;
  pendingOutbox(): Promise<OutboxEntry[]>;
  saveSyncState(state: CloudSyncState): Promise<void>;
  acknowledgePush(receipt: SyncPushReceipt, keys: readonly string[]): Promise<void>;
  discardConflict(streamId: string, binding: { seq: number; eventId: string | null }): Promise<void>;
  load(): Promise<Workspace | null>;
  commit(next: Workspace, options?: { remote?: { streamId: string; startSeq: number; eventIds: readonly string[] } }): Promise<void | CommitOutcome>;
}

export interface SyncApiPort {
  bootstrap(workspaceId: string): Promise<SyncBootstrap>;
  push(input: SyncPushRequest): Promise<{ receipt: SyncPushReceipt }>;
  pull(workspaceId: string, cursor: string | null, limit?: number): Promise<{
    changes: SyncChange[]; nextCursor: string; hasMore: boolean; cloudVersion: string;
  }>;
  conflicts(workspaceId: string): Promise<{ conflicts: SyncConflict[] }>;
  resolveConflict(workspaceId: string, conflictId: string, decision: 'discard'): Promise<{ conflict: SyncConflict; stream: { eventSeq: number; lastEventId: string | null } }>;
}

export interface SyncDeps {
  repo: SyncRepository;
  api: SyncApiPort;
  content: Content;
  workspaceId: string;
  deviceId: string;
  digest(value: unknown): Promise<string>;
  newBatchId(): string;
  now?(): Date;
}

export interface SyncStatus {
  pending: number;
  state: CloudSyncState;
}

export interface SyncReport {
  pushed: number;
  applied: number;
  pending: number;
  note: string;
  stopped: 'conflict' | 'cursor' | 'replay' | 'ticket' | 'prefix' | null;
}

const stopText: Record<NonNullable<SyncReport['stopped']>, string> = {
  conflict: '云端历史与本机提交不在同一前缀：这批事件整批未上传，候选已保留，需要显式处理',
  cursor: '同步游标已过期：先确认本机未同步事件，再重新引导；不会用云端快照覆盖本机',
  replay: '云端有一条变更无法在本机重放成同一事件，已停在该处并保留本机存档',
  ticket: '本机有进行中的生成任务，暂不应用云端事件',
  prefix: '本机分支历史与云端变更的起点不一致，已停止应用；不会覆盖本机事件',
};

const rebaseText = '这些分支的本机历史被替换过，已停止推送；需要显式处理后才继续';

export class WorkspaceSync {
  private running = false;

  constructor(private readonly deps: SyncDeps) {}

  private now() { return this.deps.now?.() ?? new Date(); }

  async status(): Promise<SyncStatus> {
    const [state, pending] = await Promise.all([this.deps.repo.syncState(), this.deps.repo.pendingOutbox()]);
    return { pending: pending.length, state };
  }

  async setPaused(paused: boolean): Promise<void> {
    const state = await this.deps.repo.syncState();
    await this.deps.repo.saveSyncState({ ...state, paused });
  }

  /** 一次完整往返：先推送本机事件，再拉取并应用别人已经落库的变更。 */
  async run(): Promise<SyncReport> {
    if (this.running) return { pushed: 0, applied: 0, pending: 0, stopped: null, note: '同步已在进行中' };
    this.running = true;
    try {
      const state = await this.deps.repo.syncState();
      if (state.paused) {
        const pending = (await this.deps.repo.pendingOutbox()).length;
        return { pushed: 0, applied: 0, pending, stopped: null, note: '同步已暂停；本机事件继续排队，不会被丢弃' };
      }
      const pushed = await this.pushOnce();
      if (pushed.stopped) return pushed;
      const pulled = await this.pullOnce();
      return {
        ...pulled,
        pushed: pushed.pushed,
        note: [pushed.note, pulled.note].filter(Boolean).join('；'),
      };
    } finally {
      this.running = false;
    }
  }

  private async fail(code: string): Promise<CloudSyncState> {
    const state = await this.deps.repo.syncState();
    const next = { ...state, lastError: code };
    await this.deps.repo.saveSyncState(next);
    return next;
  }

  async pushOnce(): Promise<SyncReport> {
    const state = await this.deps.repo.syncState();
    const pending = await this.deps.repo.pendingOutbox();
    if (!pending.length) {
      return state.needsRebase.length
        ? { pushed: 0, applied: 0, pending: 0, stopped: 'prefix', note: rebaseText }
        : { pushed: 0, applied: 0, pending: 0, stopped: null, note: '' };
    }
    // 没有云端绑定就不猜起点：先 bootstrap 拿到已确认前缀
    let current = state;
    if (!current.cloudVersion || Object.keys(current.streams).length === 0) {
      const boot = await this.bootstrap(current);
      if (!boot) return { pushed: 0, applied: 0, pending: pending.length, stopped: 'prefix', note: stopText.prefix };
      current = boot;
    }
    const groups = outgoing(pending, current.streams)
      .filter((group) => !current.needsRebase.includes(group.streamId));
    if (!groups.length) {
      if (current.needsRebase.length) {
        return { pushed: 0, applied: 0, pending: pending.length, stopped: 'prefix', note: rebaseText };
      }
      // 有待推送事件却一条都排不上：通常是本机新建分支还没有云端事件流。
      // 不能默默返回「无事可做」，否则界面会永远显示「待推送 N 条」却没有任何解释。
      const orphaned = pending.filter((entry) => !current.streams[entry.streamId]);
      return {
        pushed: 0, applied: 0, pending: pending.length, stopped: orphaned.length ? 'prefix' : null,
        note: orphaned.length
          ? '这些分支在云端还没有对应事件流（本机新建分支的注册尚未实现）；事件已保留，不会被丢弃'
          : '',
      };
    }

    let budget = CLOUD_LIMITS.eventsPerBatch;
    const streams: SyncPushRequest['streams'] = [];
    const keys: string[] = [];
    for (const group of groups) {
      if (budget <= 0) break;
      const events = group.events.slice(0, budget);
      if (!events.length) continue;
      budget -= events.length;
      streams.push({
        streamId: group.streamId, baseSeq: group.baseSeq, baseEventId: group.baseEventId,
        events: await Promise.all(events.map(async (entry) => ({
          eventId: entry.eventId, seq: entry.seq, at: entry.at,
          event: entry.event, command: entry.command, digest: await this.deps.digest(entry.event),
        }))),
      });
      for (const entry of events) keys.push(`${entry.streamId}:${entry.seq}`);
    }

    try {
      const { receipt } = await this.deps.api.push({
        workspaceId: this.deps.workspaceId, batchId: this.deps.newBatchId(),
        baseVersion: current.cloudVersion ?? '0', streams,
      });
      await this.deps.repo.acknowledgePush(receipt, keys);
      const left = (await this.deps.repo.pendingOutbox()).length;
      return { pushed: receipt.applied, applied: 0, pending: left, stopped: null, note: `已推送 ${receipt.applied} 条事件` };
    } catch (error) {
      if (error instanceof CloudFailure && error.code === 'SYNC_CONFLICT') {
        const state0 = await this.deps.repo.syncState();
        await this.deps.repo.saveSyncState({
          ...state0,
          lastError: error.message,
          conflicts: [...state0.conflicts, {
            id: error.conflictId ?? 'unknown', streamId: groups[0]!.streamId,
            baseSeq: groups[0]!.baseSeq, cloudSeq: -1, createdAt: this.now().toISOString(),
          }],
        });
        return { pushed: 0, applied: 0, pending: pending.length, stopped: 'conflict', note: stopText.conflict };
      }
      await this.fail(error instanceof Error ? error.message : '推送失败');
      throw error;
    }
  }

  private async bootstrap(state: CloudSyncState): Promise<CloudSyncState | null> {
    const boot = await this.deps.api.bootstrap(this.deps.workspaceId);
    const streams: CloudSyncState['streams'] = {};
    for (const stream of boot.streams) streams[stream.streamId] = { seq: stream.eventSeq, eventId: stream.lastEventId };
    const next: CloudSyncState = {
      ...state, streams,
      cloudVersion: boot.cloudVersion, cursor: boot.cursor,
      lastError: null,
    };
    await this.deps.repo.saveSyncState(next);
    return next;
  }

  async pullOnce(): Promise<SyncReport> {
    let state = await this.deps.repo.syncState();
    if (!state.cursor) {
      try {
        const boot = await this.bootstrap(state);
        if (!boot) return { pushed: 0, applied: 0, pending: 0, stopped: 'prefix', note: stopText.prefix };
        state = boot;
      } catch (error) {
        await this.fail(error instanceof Error ? error.message : '无法读取云端流状态');
        throw error;
      }
    }

    let applied = 0;
    let cursor = state.cursor!;
    for (let page = 0; page < 50; page++) {
      let response;
      try {
        response = await this.deps.api.pull(this.deps.workspaceId, cursor, CLOUD_LIMITS.listPageDefault);
      } catch (error) {
        if (error instanceof CloudFailure && error.code === 'CURSOR_EXPIRED') {
          const pending = (await this.deps.repo.pendingOutbox()).length;
          await this.fail(error.message);
          return {
            pushed: 0, applied, pending, stopped: 'cursor',
            note: pending
              ? `本机还有 ${pending} 条未同步事件：${stopText.cursor}`
              : stopText.cursor,
          };
        }
        await this.fail(error instanceof Error ? error.message : '拉取失败');
        throw error;
      }
      const streams: CloudSyncState['streams'] = { ...state.streams };
      for (const change of response.changes) {
        // 无论谁写的，服务端的流头都成为本机新的已确认前缀；
        // 否则重放别人的变更之后就再也接不上自己的推送。
        const last = change.events[change.events.length - 1];
        const known = streams[change.streamId];
        if (!known || change.toSeq > known.seq) {
          streams[change.streamId] = { seq: change.toSeq, eventId: last?.eventId ?? null };
        }
        if (change.deviceId === this.deps.deviceId) continue; // 本机自己写的事件，已经在本机
        const outcome = await this.applyChange(change);
        if (outcome !== 'applied' && outcome !== 'empty') {
          await this.deps.repo.saveSyncState({ ...(await this.deps.repo.syncState()), streams });
          await this.fail(stopText[outcome]);
          return { pushed: 0, applied, pending: (await this.deps.repo.pendingOutbox()).length, stopped: outcome, note: stopText[outcome] };
        }
        if (outcome === 'applied') applied++;
      }
      cursor = response.nextCursor;
      const fresh = await this.deps.repo.syncState();
      await this.deps.repo.saveSyncState({ ...fresh, cursor, streams, cloudVersion: response.cloudVersion, lastError: null });
      if (!response.hasMore) break;
    }
    return {
      pushed: 0, applied, pending: (await this.deps.repo.pendingOutbox()).length,
      stopped: null, note: applied ? `已应用 ${applied} 条云端变更` : '',
    };
  }

  /** 重放一条云端变更：逐条执行命令并对齐正文，任何不一致都停手，不写坏本机历史。 */
  private async applyChange(change: SyncChange): Promise<'applied' | 'empty' | 'prefix' | 'replay' | 'ticket'> {
    const stored = await this.deps.repo.load();
    if (!stored) return 'prefix';
    let workspace = stored;
    let applied = 0;
    for (const entry of change.events) {
      const branch = workspace.branches.find((candidate) => candidate.id === change.streamId);
      if (!branch) return applied ? 'replay' : 'prefix';
      if (branch.session.events.length !== entry.seq - 1) return applied ? 'replay' : 'prefix';
      let next: Workspace;
      try {
        next = applyPlayerCommand(this.deps.content, workspace, entry.command, new Date(entry.at));
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        return message.includes('生成任务进行中') ? 'ticket' : 'replay';
      }
      const last = next.branches.find((candidate) => candidate.id === change.streamId)?.session.events.at(-1);
      // 事件正文是权威：重放不出来就不是同一条历史，不能"大致相同"地接受
      if (!last || stableStringify(last) !== stableStringify(entry.event)) return applied ? 'replay' : 'prefix';
      workspace = next;
      applied++;
    }
    if (!applied) return 'empty';
    const writer = new SessionCommitter(this.deps.repo, stored.identity.repositoryRevision);
    const result = await writer.commit(workspace, {
      remote: { streamId: change.streamId, startSeq: change.fromSeq + 1, eventIds: change.events.map((entry) => entry.eventId) },
    });
    if (!result.ok) return 'replay';
    return 'applied';
  }

  async refreshConflicts(): Promise<SyncConflict[]> {
    const listed = await this.deps.api.conflicts(this.deps.workspaceId);
    const state = await this.deps.repo.syncState();
    await this.deps.repo.saveSyncState({
      ...state,
      conflicts: listed.conflicts.map((conflict) => ({
        id: conflict.id, streamId: conflict.streamId,
        baseSeq: conflict.baseSeq, cloudSeq: conflict.cloudSeq, createdAt: conflict.createdAt,
      })),
    });
    return listed.conflicts;
  }

  /** 明确放弃本机这批候选：云端保留另一台设备的版本，本机不再推送该分支。 */
  async discard(conflictId: string): Promise<void> {
    const resolved = await this.deps.api.resolveConflict(this.deps.workspaceId, conflictId, 'discard');
    await this.deps.repo.discardConflict(resolved.conflict.streamId, {
      seq: resolved.stream.eventSeq, eventId: resolved.stream.lastEventId,
    });
  }
}

/** 空状态在 UI 里也要能渲染：不把「还没开始」显示成「已同步」。 */
export const initialSyncStatus = (): SyncStatus => ({ pending: 0, state: emptySyncState() });
