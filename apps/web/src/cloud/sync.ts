import { stableStringify } from '@endless/esl';
import { applyPlayerCommand, parseWorkspace, switchBranch, type Content, type Workspace } from '@endless/content';
import { CLOUD_LIMITS, type ResolveConflictResponse, type SyncBootstrap, type SyncRecoveryRequest, type SyncChange, type SyncConflict, type SyncPushReceipt, type SyncPushRequest, type SyncStreamBinding } from '@endless/cloud-contracts';
import { SessionCommitter, type CommitOptions, type CommitOutcome } from '../session-writer.js';
import { preservedWorkspace, type PendingPreservation } from './conflict.js';
import { CloudFailure } from './client.js';
import { commandOfEvent, emptySyncState, outgoing, type CloudSyncState, type OutboxEntry } from './outbox.js';

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
  reanchorSync(expected: CloudSyncState, boot: SyncBootstrap): Promise<void>;
  acknowledgePush(receipt: SyncPushReceipt, keys: readonly string[]): Promise<void>;
  pendingPreservation(): Promise<PendingPreservation | null>;
  preparePreservation(conflict: SyncConflict, streamId: string | null): Promise<PendingPreservation>;
  releasePreservation(plan: PendingPreservation): Promise<void>;
  load(): Promise<Workspace | null>;
  commit(next: Workspace, options?: CommitOptions): Promise<void | CommitOutcome>;
}

export interface SyncApiPort {
  bootstrap(workspaceId: string): Promise<SyncBootstrap>;
  recoverSync(input: SyncRecoveryRequest): Promise<SyncBootstrap>;
  registerStream(input: { workspaceId: string; streamId: string; parentStreamId: string; forkAtSeq: number }): Promise<SyncStreamBinding>;
  push(input: SyncPushRequest): Promise<{ receipt: SyncPushReceipt }>;
  pull(workspaceId: string, cursor: string | null, limit?: number): Promise<{
    fromChangeSeq?: number; changeSeq?: number; changes: SyncChange[]; nextCursor: string; hasMore: boolean; cloudVersion: string;
  }>;
  conflicts(workspaceId: string): Promise<{ conflicts: SyncConflict[] }>;
  resolveConflict(workspaceId: string, conflictId: string, decision: 'discard' | 'keep-branch', preservation?: { streamId: string; baseEventId: string | null }): Promise<ResolveConflictResponse>;
}

export interface SyncDeps {
  repo: SyncRepository;
  api: SyncApiPort;
  content: Content;
  workspaceId: string;
  deviceId: string;
  digest(value: unknown): Promise<string>;
  revisions?: { prepare(): Promise<void>; through(seq: number): Promise<void> };
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
      const preservation = await this.deps.repo.pendingPreservation();
      if (preservation) await this.resolvePlan(preservation);
      const fresh = await this.deps.repo.syncState();
      if (fresh.conflicts.length) return {
        pushed: 0, applied: 0, pending: (await this.deps.repo.pendingOutbox()).length,
        stopped: 'conflict', note: stopText.conflict,
      };
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
    if (state.pendingPush) return this.submitPush(state.pendingPush);
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
    // 本机新建分支：先补注册云端事件流（只声明父流与分叉点，前缀由服务端复制）
    const registered = await this.registerOrphanStreams(pending, current);
    current = registered.state;
    const groups = outgoing(pending, current.streams)
      .filter((group) => !current.needsRebase.includes(group.streamId));
    if (!groups.length) {
      if (current.needsRebase.length) {
        return { pushed: 0, applied: 0, pending: pending.length, stopped: 'prefix', note: rebaseText };
      }
      // 有待推送事件却一条都排不上：不是「无事可做」，必须说清是哪种情况。
      const orphaned = pending.filter((entry) => !current.streams[entry.streamId]);
      return {
        pushed: 0, applied: 0, pending: pending.length,
        stopped: orphaned.length ? 'prefix' : null,
        note: orphaned.length
          ? [registered.note, '这些分支在云端还没有事件流：父流前缀还没推完，或本机分支缺少父流记录；事件已保留']
            .filter(Boolean).join('；')
          : '',
      };
    }

    let budget = CLOUD_LIMITS.eventsPerBatch;
    const streams: SyncPushRequest['streams'] = [];
    for (const group of groups) {
      if (budget <= 0 || streams.length === 8) break;
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
    }

    const input: SyncPushRequest = {
      workspaceId: this.deps.workspaceId, batchId: this.deps.newBatchId(),
      baseVersion: current.cloudVersion ?? '0', streams,
    };
    await this.deps.repo.saveSyncState({ ...current, pendingPush: input });
    return this.submitPush(input, registered);
  }

  private async submitPush(input: SyncPushRequest, registered?: { blocked: number; note: string }): Promise<SyncReport> {
    const keys = input.streams.flatMap((stream) => stream.events.map((entry) => `${stream.streamId}:${entry.seq}`));
    try {
      const { receipt } = await this.deps.api.push(input);
      if (receipt.batchId !== input.batchId || receipt.workspaceId !== input.workspaceId
        || input.streams.some((stream) => {
          const held = receipt.streams.find((entry) => entry.streamId === stream.streamId);
          const last = stream.events.at(-1)!;
          return !held || held.eventSeq !== last.seq || held.lastEventId !== last.eventId;
        })) throw new CloudFailure('INVALID_RESPONSE', 200, '推送回执与已保存批次不一致；本机事件保留，可恢复原请求');
      await this.deps.repo.acknowledgePush(receipt, keys);
      const left = (await this.deps.repo.pendingOutbox()).length;
      const note = [`已推送 ${receipt.applied} 条事件`];
      // 还有事件排不上：说清是「分支没有云端事件流」，不要只留下一个待推送数字
      if (registered?.blocked) note.push('另有分支还没有云端事件流（父流前缀未推完或缺少父流记录），事件已保留');
      if (registered?.note) note.push(registered.note);
      return { pushed: receipt.applied, applied: 0, pending: left, stopped: null, note: note.join('；') };
    } catch (error) {
      if (error instanceof CloudFailure && error.code === 'SYNC_CONFLICT') {
        const state0 = await this.deps.repo.syncState();
        await this.deps.repo.saveSyncState({
          ...state0,
          pendingPush: undefined,
          lastError: error.message,
          conflicts: [...state0.conflicts, {
            id: error.conflictId ?? 'unknown', streamId: input.streams[0]!.streamId,
            baseSeq: input.streams[0]!.baseSeq, cloudSeq: -1, createdAt: this.now().toISOString(),
          }],
        });
        return { pushed: 0, applied: 0, pending: (await this.deps.repo.pendingOutbox()).length, stopped: 'conflict', note: stopText.conflict };
      }
      await this.fail(error instanceof Error ? error.message : '推送失败');
      throw error;
    }
  }

  /**
   * 为待推送但云端还没有绑定的事件流补注册。
   *
   * 只认本机分支记录里的 `parentBranchId` + `forkAtEventCount`：根分支没有父流，
   * 说明这棵历史不是从云端导入的（或分支数据被改过），那就**不注册**，
   * 也绝不编造一段前缀去凑数。父流前缀还没推完时同样等下一轮。
   */
  private async registerOrphanStreams(pending: readonly OutboxEntry[], state: CloudSyncState):
    Promise<{ state: CloudSyncState; blocked: number; note: string }> {
    const unbound = [...new Set(pending.map((entry) => entry.streamId))]
      .filter((streamId) => !state.streams[streamId] && !state.needsRebase.includes(streamId));
    if (!unbound.length) return { state, blocked: 0, note: '' };
    const workspace = await this.deps.repo.load();
    if (!workspace) return { state, blocked: unbound.length, note: '读不到本机工作区，暂时不能注册新分支' };
    const byId = new Map(workspace.branches.map((branch) => [branch.id, branch]));
    let next = state;
    let blocked = 0;
    const notes: string[] = [];
    for (const streamId of unbound.sort()) {
      const branch = byId.get(streamId);
      if (!branch || !branch.parentBranchId || branch.forkAtEventCount === null) {
        blocked++;
        notes.push(`分支 ${streamId.slice(0, 8)} 没有父流记录，无法注册`);
        continue;
      }
      const parent = next.streams[branch.parentBranchId];
      if (!parent || parent.seq < branch.forkAtEventCount) { blocked++; continue; }
      try {
        const stream = await this.deps.api.registerStream({
          workspaceId: this.deps.workspaceId, streamId,
          parentStreamId: branch.parentBranchId, forkAtSeq: branch.forkAtEventCount,
        });
        next = {
          ...next,
          streams: { ...next.streams, [stream.streamId]: { seq: stream.eventSeq, eventId: stream.lastEventId } },
        };
        await this.deps.repo.saveSyncState(next);
      } catch (error) {
        blocked++;
        notes.push(error instanceof Error ? error.message : '注册新分支失败');
      }
    }
    return { state: next, blocked, note: notes.join('；') };
  }

  private async bootstrap(state: CloudSyncState): Promise<CloudSyncState | null> {
    const boot = await this.deps.api.bootstrap(this.deps.workspaceId);
    const streams: CloudSyncState['streams'] = {};
    for (const stream of boot.origin?.streams ?? boot.streams) streams[stream.streamId] = { seq: stream.eventSeq, eventId: stream.lastEventId };
    const next: CloudSyncState = {
      ...state, streams,
      cloudVersion: boot.cloudVersion, cursor: boot.origin?.cursor ?? boot.cursor,
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
    let rebootstrapped = false;
    for (let page = 0; page < 50; page++) {
      let response;
      try {
        response = await this.deps.api.pull(this.deps.workspaceId, cursor, CLOUD_LIMITS.listPageDefault);
      } catch (error) {
        if (error instanceof CloudFailure && error.code === 'CURSOR_EXPIRED') {
          const pending = (await this.deps.repo.pendingOutbox()).length;
          const fresh = await this.deps.repo.syncState();
          if (!rebootstrapped && !pending && !fresh.pendingPush && !fresh.conflicts.length && !fresh.needsRebase.length
            && fresh.cloudVersion !== null && Object.keys(fresh.streams).length) {
            try {
              const boot = await this.deps.api.recoverSync({
                workspaceId: this.deps.workspaceId,
                cloudVersion: fresh.cloudVersion,
                streams: Object.entries(fresh.streams).map(([id, head]) => ({
                  streamId: id as SyncStreamBinding['streamId'], branchId: id as SyncStreamBinding['branchId'],
                  eventSeq: head.seq, lastEventId: head.eventId,
                })),
              });
              await this.deps.repo.reanchorSync(fresh, boot);
              state = await this.deps.repo.syncState();
              cursor = state.cursor!;
              rebootstrapped = true;
              continue;
            } catch (cause) {
              await this.fail(cause instanceof Error ? cause.message : '重新引导失败');
              throw cause;
            }
          }
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
      // Fetch after the reading page: any adoption that produced one of its events must now be visible.
      if (this.deps.revisions) {
        await this.deps.revisions.prepare();
        const from = response.fromChangeSeq ?? (response.changes[0] ? response.changes[0].seq - 1 : undefined);
        if (from !== undefined) await this.deps.revisions.through(from);
      }
      const streams: CloudSyncState['streams'] = { ...state.streams };
      for (const change of response.changes) {
        await this.deps.revisions?.through(change.seq - 1);
        // 无论谁写的，服务端的流头都成为本机新的已确认前缀；
        // 否则重放别人的变更之后就再也接不上自己的推送。
        const last = change.events[change.events.length - 1];
        const known = streams[change.streamId];
        if (!known || change.toSeq > known.seq) {
          streams[change.streamId] = { seq: change.toSeq, eventId: last?.eventId ?? null };
        }
        // Also verify our own historical pages: deviceId is not proof of the local prefix.
        const outcome = await this.applyChange(change);
        if (outcome !== 'applied' && outcome !== 'empty') {
          await this.deps.repo.saveSyncState({ ...(await this.deps.repo.syncState()), streams });
          await this.fail(stopText[outcome]);
          return { pushed: 0, applied, pending: (await this.deps.repo.pendingOutbox()).length, stopped: outcome, note: stopText[outcome] };
        }
        if (outcome === 'applied') applied++;
        await this.deps.revisions?.through(change.seq);
      }
      if (response.changeSeq !== undefined) await this.deps.revisions?.through(response.changeSeq);
      cursor = response.nextCursor;
      const fresh = await this.deps.repo.syncState();
      const merged = { ...fresh.streams };
      for (const [id, head] of Object.entries(streams)) if (!merged[id] || merged[id]!.seq < head.seq) merged[id] = head;
      await this.deps.repo.saveSyncState({ ...fresh, cursor, streams: merged, cloudVersion: response.cloudVersion, lastError: null });
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
    if (!workspace.branches.some((branch) => branch.id === change.streamId)) {
      const manifest = change.branch;
      const prefix = manifest?.commonStreamId ? workspace.branches.find((branch) => branch.id === manifest.commonStreamId) : null;
      if (!manifest || !prefix || prefix.session.events.length < manifest.commonPrefixSeq
        || manifest.commonPrefixSeq !== change.fromSeq) return 'prefix';
      try {
        const first = workspace.revisions.find((revision) => revision.id === manifest.adopted[0]?.revisionId);
        if (!first) return 'replay';
        workspace = parseWorkspace({
          ...workspace,
          branches: [...workspace.branches, {
            id: manifest.streamId, label: manifest.label, parentBranchId: manifest.parentBranchId,
            forkAtEventCount: manifest.forkAtEventCount, adopted: manifest.adopted, createdAt: manifest.createdAt,
            session: {
              version: 1, catalog: manifest.catalog, current: first.episodeId, largeText: false, revision: 0,
              events: prefix.session.events.slice(0, manifest.commonPrefixSeq),
            },
          }],
        });
      } catch { return 'replay'; }
    }
    for (const entry of change.events) {
      const branch = workspace.branches.find((candidate) => candidate.id === change.streamId);
      if (!branch) return applied ? 'replay' : 'prefix';
      if (await this.deps.digest(entry.event) !== entry.digest || entry.at !== entry.event.at
        || stableStringify(entry.command) !== stableStringify(commandOfEvent(entry.event))) return 'replay';
      if (branch.session.events.length >= entry.seq) {
        if (stableStringify(branch.session.events[entry.seq - 1]) !== stableStringify(entry.event)) return 'prefix';
        continue;
      }
      if (branch.session.events.length !== entry.seq - 1) return applied ? 'replay' : 'prefix';
      let next: Workspace;
      try {
        const selected = applyPlayerCommand(this.deps.content, switchBranch(workspace, branch.id),
          { type: 'select', episode: entry.event.episode }, new Date(entry.at));
        next = applyPlayerCommand(this.deps.content, selected, entry.command, new Date(entry.at));
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
    workspace = {
      ...workspace, activeBranchId: stored.activeBranchId,
      branches: workspace.branches.map((branch) => {
        const held = stored.branches.find((before) => before.id === branch.id);
        return held ? { ...branch, session: { ...branch.session, current: held.session.current, largeText: held.session.largeText } } : branch;
      }),
    };
    const writer = new SessionCommitter(this.deps.repo, stored.identity.repositoryRevision);
    const result = await writer.commit(workspace, {
      remote: {
        streamId: change.streamId, startSeq: change.fromSeq + 1, eventIds: change.events.map((entry) => entry.eventId),
        ...(change.branch?.commonStreamId ? { prefixStreamId: change.branch.commonStreamId } : {}),
      },
    });
    if (!result.ok) return 'replay';
    return 'applied';
  }

  async refreshConflicts(): Promise<SyncConflict[]> {
    const listed = await this.deps.api.conflicts(this.deps.workspaceId);
    const state = await this.deps.repo.syncState();
    await this.deps.repo.saveSyncState({
      ...state,
      conflicts: listed.conflicts.filter((conflict) => conflict.status === 'open'
        && (conflict.deviceId === this.deps.deviceId || state.conflicts.some((held) => held.id === conflict.id))).map((conflict) => ({
        id: conflict.id, streamId: conflict.streamId,
        baseSeq: conflict.baseSeq, cloudSeq: conflict.cloudSeq, createdAt: conflict.createdAt,
      })),
    });
    return listed.conflicts;
  }

  async keep(conflictId: string): Promise<void> {
    let plan = await this.deps.repo.pendingPreservation();
    if (plan && (plan.conflict.id !== conflictId || plan.request.decision !== 'keep-branch')) throw new Error('请先恢复已经提交的同一份冲突处理请求，不能切换决定');
    if (!plan) {
      const listed = await this.deps.api.conflicts(this.deps.workspaceId);
      const conflict = listed.conflicts.find((entry) => entry.id === conflictId);
      if (!conflict) throw new Error('这台设备没有该冲突候选');
      plan = await this.deps.repo.preparePreservation(conflict, `brn_${this.deps.newBatchId()}`);
    }
    await this.resolvePlan(plan);
  }

  private async resolvePlan(plan: PendingPreservation): Promise<void> {
    let result: ResolveConflictResponse;
    const request = plan.request;
    try {
      result = await this.deps.api.resolveConflict(this.deps.workspaceId, plan.conflict.id, request.decision,
        request.decision === 'keep-branch' ? { streamId: request.streamId, baseEventId: request.baseEventId } : undefined);
    } catch (error) {
      if (error instanceof CloudFailure && (error.code === 'BAD_REQUEST' || error.code === 'STORAGE_QUOTA')) await this.deps.repo.releasePreservation(plan);
      throw error;
    }
    for (const [index, entry] of (result.history?.events ?? []).entries()) {
      if (entry.seq !== index + 1 || entry.at !== entry.event.at
        || await this.deps.digest(entry.event) !== entry.digest
        || stableStringify(entry.command) !== stableStringify(commandOfEvent(entry.event))) {
        throw new Error('云端恢复历史摘要、命令或顺序不一致，完整本机历史保留');
      }
    }
    const next = preservedWorkspace(plan, result, this.deps.content);
    const writer = new SessionCommitter(this.deps.repo, plan.workspace.identity.repositoryRevision);
    const outcome = await writer.commit(next, { preservation: { plan, result } });
    if (!outcome.ok) throw new Error(outcome.error);
  }

  /** 明确放弃这条离线候选：请求先持久化，验证后原子恢复云端历史，原候选留在 staging。 */
  async discard(conflictId: string): Promise<void> {
    let plan = await this.deps.repo.pendingPreservation();
    if (plan && (plan.conflict.id !== conflictId || plan.request.decision !== 'discard')) throw new Error('已有保留请求尚未完成，请用「立即同步」恢复同一请求，不能切换为放弃');
    if (!plan) {
      const listed = await this.deps.api.conflicts(this.deps.workspaceId);
      const state = await this.deps.repo.syncState();
      const conflict = listed.conflicts.find((entry) => entry.id === conflictId
        && (entry.deviceId === this.deps.deviceId || state.conflicts.some((held) => held.id === entry.id)));
      if (!conflict) throw new Error('这台设备没有该冲突候选');
      plan = await this.deps.repo.preparePreservation(conflict, null);
    }
    await this.resolvePlan(plan);
  }

  /** 显式恢复旧客户端已经 discard、但还停在 needsRebase 的原候选。未知替换历史不猜测。 */
  async rebase(streamId: string): Promise<void> {
    const state = await this.deps.repo.syncState();
    if (!state.needsRebase.includes(streamId)) throw new Error('该分支没有待恢复的已放弃历史');
    const { conflicts } = await this.deps.api.conflicts(this.deps.workspaceId);
    const candidates = conflicts.filter((c) => c.streamId === streamId && c.deviceId === this.deps.deviceId && c.status === 'discarded');
    if (candidates.length !== 1) throw new Error('无法唯一确认旧放弃候选，完整本机历史保留；不会截断或猜测恢复');
    await this.discard(candidates[0]!.id);
  }
}

/** 空状态在 UI 里也要能渲染：不把「还没开始」显示成「已同步」。 */
export const initialSyncStatus = (): SyncStatus => ({ pending: 0, state: emptySyncState() });
