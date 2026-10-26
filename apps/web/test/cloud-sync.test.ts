import { describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import {
  applyPlayerCommand, bridge, buildBackup, deriveCloudCopy, parseWorkspace, type Workspace,
} from '@endless/content';
import { getOptions, getScenes, projectSession } from '@endless/player';
import type {
  CloudImportReceipt, ResolveConflictResponse, SyncBootstrap, SyncChange, SyncConflict, SyncPushReceipt, SyncPushRequest, SyncStreamBinding,
} from '@endless/cloud-contracts';
import { CloudFailure } from '../src/cloud/client.js';
import { cloudDigest, cloudNamespace } from '../src/cloud/local.js';
import { planOutbox, outgoing, parseSyncState, sidecarKey, type OutboxEntry } from '../src/cloud/outbox.js';
import { WorkspaceSync } from '../src/cloud/sync.js';
import { SessionCommitter } from '../src/session-writer.js';
import { WorkspaceRepository } from '../src/storage.js';
import { cloudTestContent as content, cloudTestTime, cloudTestWorkspace } from '../../../packages/content/test/cloud-fixture.js';

/**
 * 客户端同步测试：真实 fake-indexeddb + 内存云端。
 *
 * 内存云端只复述**协议必需**的规则（流前缀 CAS、变更有序、"哪个设备推的"），
 * 业务规则本身的权威测试在 apps/api 的真 PostgreSQL 套件里。
 */

const deployment = crypto.randomUUID();
const account = crypto.randomUUID();
const at = (offset: number) => new Date(Date.parse(cloudTestTime) + offset * 1000);

/** 在当前场景做一步真实交互（有选项先答，再推进），返回新工作区。 */
function step(workspace: Workspace, choice: number, offset: number): Workspace {
  const runtime = bridge(content, workspace);
  const progress = projectSession(runtime.session, runtime.library).episodes[runtime.session.current]!;
  const episode = runtime.library.episodes.find((entry) => entry.id === runtime.session.current)!;
  const scene = getScenes(episode)[progress.cursor];
  if (!scene) throw new Error('当前集已读完，测试夹具需要更长的内容');
  let next = workspace;
  if (getOptions(scene).length) next = applyPlayerCommand(content, next, { type: 'answer', scene: scene.id, choice }, at(offset));
  return applyPlayerCommand(content, next, { type: 'advance', scene: scene.id, skip: false }, at(offset + 1));
}

interface Recorded {
  seq: number; batchId: string; deviceId: string; streamId: string;
  fromSeq: number; toSeq: number; events: SyncPushRequest['streams'][number]['events']; createdAt: string;
  branch?: SyncChange['branch'];
}

/** 内存云端：只实现协议，不做学习重放。 */
class CloudSim {
  preservationReceipts = new Map<string, ResolveConflictResponse>();
  receipts = new Map<string, { receipt: SyncPushReceipt }>();
  origins: SyncStreamBinding[] = [];
  streams = new Map<string, { seq: number; lastEventId: string | null }>();
  /** 每条流的事件 ID 序列：注册分叉流时要从父流前缀里取最后一个事件 ID。 */
  eventIds = new Map<string, string[]>();
  forks = new Map<string, { parentStreamId: string; forkAtSeq: number }>();
  /** 注册请求的审计：测试要区分「没尝试注册」和「尝试后被拒」。 */
  registerAttempts: string[] = [];
  changes: Recorded[] = [];
  conflictRecords = new Map<string, SyncConflict>();
  version = 1;
  /** 谁在推：真实服务端从会话取设备，这里由测试显式指定。 */
  pusher = 'device-a';

  seed(streams: SyncStreamBinding[]) {
    this.origins = structuredClone(streams);
    for (const stream of streams) this.streams.set(stream.streamId, { seq: stream.eventSeq, lastEventId: stream.lastEventId });
  }

  private bindings(): SyncStreamBinding[] {
    return [...this.streams.entries()].map(([streamId, head]) => ({
      streamId: streamId as SyncStreamBinding['streamId'], branchId: streamId as SyncStreamBinding['branchId'],
      eventSeq: head.seq, lastEventId: head.lastEventId,
    }));
  }

  async bootstrap(workspaceId: string): Promise<SyncBootstrap> {
    return {
      workspaceId, cloudVersion: String(this.version), changeSeq: this.changes.length,
      cursor: String(this.changes.length), streams: this.bindings(),
      origin: { cursor: '0', streams: this.origins },
    };
  }

  async push(input: SyncPushRequest) {
    const held = this.receipts.get(input.batchId);
    if (held) return held;
    for (const stream of input.streams) {
      const head = this.streams.get(stream.streamId);
      if (!head) throw new CloudFailure('UNSUPPORTED_CONTRACT', 409, '未知流', 'contact_support');
      if (stream.baseSeq !== head.seq || (stream.baseEventId ?? null) !== head.lastEventId) {
        const id = crypto.randomUUID();
        this.conflictRecords.set(id, {
          id, workspaceId: input.workspaceId, streamId: stream.streamId, deviceId: this.pusher as never,
          reason: 'stream-head-changed', status: 'open', baseSeq: stream.baseSeq, cloudSeq: head.seq,
          createdAt: new Date().toISOString(), resolvedAt: null, events: stream.events,
        });
        throw new CloudFailure('SYNC_CONFLICT', 409, '云端前缀与本机提交不一致', 'resolve_conflict', 'corr-12345678', id);
      }
    }
    for (const stream of input.streams) {
      const last = stream.events[stream.events.length - 1]!;
      this.changes.push({
        seq: this.changes.length + 1, batchId: input.batchId, deviceId: this.pusher,
        streamId: stream.streamId, fromSeq: stream.baseSeq, toSeq: last.seq,
        events: stream.events, createdAt: new Date().toISOString(),
      });
      this.streams.set(stream.streamId, { seq: last.seq, lastEventId: last.eventId });
      const ids = this.eventIds.get(stream.streamId) ?? [];
      ids.push(...stream.events.map((entry) => entry.eventId as string));
      this.eventIds.set(stream.streamId, ids);
    }
    this.version++;
    const receipt: SyncPushReceipt = {
      batchId: input.batchId, workspaceId: input.workspaceId, changeSeq: this.changes.length,
      cloudVersion: String(this.version), applied: input.streams.reduce((count, stream) => count + stream.events.length, 0),
      duplicate: 0, streams: this.bindings().filter((entry) => input.streams.some((stream) => stream.streamId === entry.streamId)),
    };
    const response = { receipt };
    this.receipts.set(input.batchId, response);
    return response;
  }

  /** 只实现协议：父流前缀由服务端复制，分叉点不能超过父流已有历史。 */
  async registerStream(input: { workspaceId: string; streamId: string; parentStreamId: string; forkAtSeq: number }) {
    this.registerAttempts.push(input.streamId);
    const held = this.streams.get(input.streamId);
    if (held) {
      const fork = this.forks.get(input.streamId);
      if (!fork || fork.parentStreamId !== input.parentStreamId || fork.forkAtSeq !== input.forkAtSeq) {
        throw new CloudFailure('BAD_REQUEST', 400, '该事件流已绑定到另一个分叉点，不能改绑');
      }
      return { streamId: input.streamId, branchId: input.streamId, eventSeq: held.seq, lastEventId: held.lastEventId } as SyncStreamBinding;
    }
    const parent = this.streams.get(input.parentStreamId);
    if (!parent) throw new CloudFailure('NOT_FOUND', 404, '父事件流不存在');
    if (input.forkAtSeq > parent.seq) throw new CloudFailure('BAD_REQUEST', 400, '分叉点超出父流历史');
    const ids = this.eventIds.get(input.parentStreamId);
    const lastEventId = input.forkAtSeq === 0 ? null
      : input.forkAtSeq === parent.seq ? parent.lastEventId
      : ids?.[input.forkAtSeq - 1] ?? null;
    this.streams.set(input.streamId, { seq: input.forkAtSeq, lastEventId });
    this.forks.set(input.streamId, { parentStreamId: input.parentStreamId, forkAtSeq: input.forkAtSeq });
    if (ids) this.eventIds.set(input.streamId, ids.slice(0, input.forkAtSeq));
    this.version++;
    return { streamId: input.streamId, branchId: input.streamId, eventSeq: input.forkAtSeq, lastEventId } as SyncStreamBinding;
  }

  async pull(_workspaceId: string, cursor: string | null, limit = 50) {
    const from = cursor ? Number(cursor) : 0;
    const changes: SyncChange[] = this.changes.slice(from, from + limit).map((change) => ({
      seq: change.seq, batchId: change.batchId, deviceId: change.deviceId as never,
      streamId: change.streamId as SyncChange['streamId'],
      fromSeq: change.fromSeq, toSeq: change.toSeq, createdAt: change.createdAt, events: change.events,
      ...(change.branch ? { branch: change.branch } : {}),
    }));
    return {
      changes, nextCursor: String(from + changes.length),
      hasMore: this.changes.length > from + changes.length, cloudVersion: String(this.version),
    };
  }

  async conflicts() { return { conflicts: [...this.conflictRecords.values()].filter((conflict) => conflict.status === 'open') }; }

  async resolveConflict(_workspaceId: string, conflictId: string, decision: 'discard' | 'keep-branch' = 'discard', preservation?: { streamId: string; baseEventId: string | null }): Promise<ResolveConflictResponse> {
    const conflict = this.conflictRecords.get(conflictId)!;
    if (decision === 'keep-branch') {
      const held = this.preservationReceipts.get(conflictId);
      if (held) return held;
      const streamId = preservation!.streamId;
      const history = this.changes.filter((change) => change.streamId === conflict.streamId).flatMap((change) => change.events);
      const source = copy.branches[0]!;
      const head = this.streams.get(conflict.streamId)!;
      const manifest = {
        streamId: conflict.streamId, label: source.label, parentBranchId: null, forkAtEventCount: null,
        adopted: source.adopted, catalog: source.session.catalog, createdAt: source.createdAt,
        commonStreamId: null, commonPrefixSeq: 0,
      };
      this.streams.set(streamId, { seq: conflict.baseSeq, lastEventId: preservation!.baseEventId });
      const result = await this.push({
        workspaceId: conflict.workspaceId, batchId: crypto.randomUUID(), baseVersion: String(this.version),
        streams: [{ streamId, baseSeq: conflict.baseSeq, baseEventId: preservation!.baseEventId, events: conflict.events }],
      });
      Object.assign(this.changes.at(-1)!, { branch: {
        ...manifest, streamId, commonStreamId: conflict.streamId, commonPrefixSeq: conflict.baseSeq,
      } });
      const response: ResolveConflictResponse = {
        conflict: { ...conflict, status: 'preserved', resolvedAt: new Date().toISOString() },
        stream: { streamId: conflict.streamId, branchId: conflict.streamId, eventSeq: head.seq, lastEventId: head.lastEventId },
        preserved: result.receipt.streams[0]!,
        history: {
          stream: { streamId: conflict.streamId, branchId: conflict.streamId, eventSeq: head.seq, lastEventId: head.lastEventId },
          branch: manifest, events: history,
        },
      };
      this.preservationReceipts.set(conflictId, response);
      this.conflictRecords.set(conflictId, response.conflict);
      return response;
    }
    conflict.status = 'discarded';
    conflict.resolvedAt = new Date().toISOString();
    const head = this.streams.get(conflict.streamId)!;
    return {
      conflict,
      stream: {
        streamId: conflict.streamId, branchId: conflict.streamId, eventSeq: head.seq, lastEventId: head.lastEventId,
      } as SyncStreamBinding,
    };
  }
}

class ExpiringCloud extends CloudSim {
  override async pull(): Promise<never> {
    throw new CloudFailure('CURSOR_EXPIRED', 409, '同步游标已过期', 'retry_read');
  }
}

const copy = deriveCloudCopy(buildBackup(cloudTestWorkspace()), cloudTestTime, content);
const streamId = copy.branches[0]!.id;
const seed = (): SyncStreamBinding[] => [{ streamId: streamId as never, branchId: streamId as never, eventSeq: 0, lastEventId: null }];

let cachedReceipt: CloudImportReceipt | null = null;
async function seedReceipt(workspaceId: string): Promise<CloudImportReceipt> {
  cachedReceipt ??= {
    id: crypto.randomUUID(), workspaceId,
    sourceLocalId: copy.identity.workspaceId, sourceProfileId: copy.profile.id, sourceRepositoryRevision: 0,
    sourceObjectId: crypto.randomUUID(), sourceDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64),
    copyDigest: await cloudDigest(copy), copyCreatedAt: cloudTestTime, validationBinding: 'c'.repeat(64),
    copyPolicy: 'endless-cloud-copy/1', contentIds: copy.entries.map((entry) => entry.id),
    revisionIds: copy.revisions.map((entry) => entry.id), seedContentIds: copy.entries.map((entry) => entry.id),
  };
  return { ...cachedReceipt, workspaceId };
}

async function device(factory: IDBFactory, workspaceId: string, deviceId = crypto.randomUUID()) {
  const repository = new WorkspaceRepository(factory, cloudNamespace(deployment, account, workspaceId));
  await repository.installCloudCopy(copy, await seedReceipt(workspaceId), deviceId);
  return repository;
}

function engine(repository: WorkspaceRepository, workspaceId: string, deviceId: string, api: CloudSim = new CloudSim()) {
  return { api, sync: new WorkspaceSync({
    repo: repository, api: api as never, content, workspaceId, deviceId,
    digest: (value) => cloudDigest(value), newBatchId: () => crypto.randomUUID(),
  }) };
}

/** 用真实的提交链路推进剧情：Outbox 必须在同一事务里跟着落库。 */
async function play(repository: WorkspaceRepository, steps: number, choice: number, base = 0): Promise<Workspace> {
  let workspace = (await repository.load())!;
  for (let index = 0; index < steps; index++) {
    const committer = new SessionCommitter(repository, workspace.identity.repositoryRevision);
    const result = await committer.commit(step(workspace, choice, base + index * 10));
    if (!result.ok) throw new Error(result.error);
    workspace = result.workspace;
  }
  return workspace;
}

const events = (workspace: Workspace) => workspace.branches[0]!.session.events;

describe('事务内 Outbox：身份与前缀', () => {
  it('追加事件在提交同一事务里分配 eventId 并排队；后续提交不改动已分配的身份', async () => {
    const repository = await device(new IDBFactory(), crypto.randomUUID());
    expect(await repository.pendingOutbox()).toEqual([]);
    const after = await play(repository, 1, 0);
    expect(events(after).length).toBeGreaterThan(0);
    const pending = await repository.pendingOutbox();
    expect(pending).toHaveLength(events(after).length);
    expect(pending.map((entry) => entry.seq)).toEqual(pending.map((_, index) => index + 1));
    const first = pending.map((entry) => entry.eventId);
    expect(new Set(first).size).toBe(first.length);

    await play(repository, 1, 0);
    const later = await repository.pendingOutbox();
    expect(later.slice(0, first.length).map((entry) => entry.eventId)).toEqual(first);
  });

  it('冲突保留完整本机历史、恢复原分支，并能在另一设备接收独立根分支', async () => {
    const workspaceId = crypto.randomUUID();
    const deviceA = await device(new IDBFactory(), workspaceId);
    const deviceB = await device(new IDBFactory(), workspaceId);
    const api = new CloudSim();
    api.seed(seed());
    const a = engine(deviceA, workspaceId, 'device-a', api);
    const b = engine(deviceB, workspaceId, 'device-b', api);
    await a.sync.run();
    await b.sync.run();
    const left = await play(deviceA, 1, 0);
    const right = await play(deviceB, 2, 1, 500);
    api.pusher = 'device-a';
    await a.sync.run();
    api.pusher = 'device-b';
    expect((await b.sync.run()).stopped).toBe('conflict');
    const conflict = (await deviceB.syncState()).conflicts[0]!;
    api.conflictRecords.get(conflict.id)!.events = api.conflictRecords.get(conflict.id)!.events.slice(0, 1);
    const localIds = (await deviceB.pendingOutbox()).map((entry) => entry.eventId);
    await b.sync.keep(conflict.id);
    const restored = (await deviceB.load())!;
    expect(restored.branches.find((branch) => branch.id === streamId)!.session.events).toEqual(events(left));
    const retained = restored.branches.find((branch) => branch.id !== streamId)!;
    expect(retained.parentBranchId).toBeNull();
    expect(retained.forkAtEventCount).toBeNull();
    expect(retained.session.events).toEqual(events(right));
    expect(restored.activeBranchId).toBe(retained.id);
    expect((await deviceB.syncState()).needsRebase).toEqual([]);
    expect(await deviceB.pendingPreservation()).toBeNull();
    expect((await deviceB.pendingOutbox()).map((entry) => entry.eventId)).toEqual(localIds.slice(1));
    expect((await b.sync.run()).stopped).toBeNull();
    expect(await deviceB.pendingOutbox()).toEqual([]);
    api.pusher = 'device-a';
    expect((await a.sync.run()).stopped).toBeNull();
    expect((await deviceA.load())!.branches.find((branch) => branch.id === retained.id)?.session.events).toEqual(events(right));
  });

  it('保留响应丢失后刷新沿用同一请求，期间冻结写入；落库失败原历史与请求一起保留', async () => {
    const workspaceId = crypto.randomUUID();
    const factory = new IDBFactory();
    const repository = await device(factory, workspaceId);
    const api = new CloudSim();
    api.seed(seed());
    const { sync } = engine(repository, workspaceId, 'device-b', api);
    await sync.run();
    const right = await play(repository, 1, 1, 500);
    const left = step(copy, 0, 0);
    api.pusher = 'device-a';
    const leftEvents = await Promise.all(events(left).map(async (event, index) => ({
      eventId: crypto.randomUUID(), seq: index + 1, at: event.at, event: event as never,
      command: { type: event.type, scene: event.scene, ...(event.type === 'advance' ? { skip: event.skip } : event.type === 'answer' ? { choice: event.choice } : {}) } as never,
      digest: await cloudDigest(event),
    })));
    await api.push({ workspaceId, batchId: crypto.randomUUID(), baseVersion: '1', streams: [{ streamId, baseSeq: 0, baseEventId: null, events: leftEvents }] });
    api.pusher = 'device-b';
    await sync.run();
    const id = (await repository.syncState()).conflicts[0]!.id;
    const original = api.resolveConflict.bind(api);
    api.resolveConflict = async (...args) => {
      await original(...args);
      throw new CloudFailure('NETWORK', 0, '响应丢失');
    };
    await expect(sync.keep(id)).rejects.toThrow('响应丢失');
    const pending = (await repository.pendingPreservation())!;
    expect(pending.request.streamId).toMatch(/^brn_/);
    await expect(sync.discard(id)).rejects.toThrow('不能切换为放弃');
    const blocked = await new SessionCommitter(repository, right.identity.repositoryRevision).commit(step(right, 0, 600));
    expect(blocked.ok).toBe(false);
    expect(events((await repository.load())!)).toEqual(events(right));
    await repository.close();
    const reopened = new WorkspaceRepository(factory, cloudNamespace(deployment, account, workspaceId));
    api.resolveConflict = original;
    const recovered = engine(reopened, workspaceId, 'device-b', api);
    const before = await reopened.load();
    const outbox = await reopened.pendingOutbox();
    const put = IDBObjectStore.prototype.put;
    const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'sync' && key === 'sync') throw new DOMException('synthetic quota failure', 'QuotaExceededError');
      return put.call(this, value, key);
    });
    try {
      await expect(recovered.sync.keep(id)).rejects.toThrow('保存失败');
    } finally {
      failure.mockRestore();
    }
    expect(await reopened.load()).toEqual(before);
    expect(await reopened.pendingOutbox()).toEqual(outbox);
    expect(await reopened.pendingPreservation()).toEqual(pending);
    expect((await recovered.sync.run()).stopped).toBeNull();
    expect((await reopened.load())!.branches).toHaveLength(2);
    expect((await reopened.load())!.branches.some((branch) => branch.id === pending.request.streamId)).toBe(true);
    expect(api.preservationReceipts.size).toBe(1);
    expect(await reopened.pendingPreservation()).toBeNull();
  });

  it('推送成功但响应丢失，刷新后恢复持久化批次，不会把成功变成新冲突', async () => {
    const workspaceId = crypto.randomUUID();
    const factory = new IDBFactory();
    const repository = await device(factory, workspaceId);
    const api = new CloudSim();
    api.seed(seed());
    const { sync } = engine(repository, workspaceId, 'device-a', api);
    await sync.run();
    await play(repository, 1, 0);
    const ids = (await repository.pendingOutbox()).map((entry) => entry.eventId);
    const original = api.push.bind(api);
    api.push = async (input) => {
      await original(input);
      throw new CloudFailure('NETWORK', 0, '推送响应丢失');
    };
    await expect(sync.run()).rejects.toThrow('推送响应丢失');
    const pending = (await repository.syncState()).pendingPush!;
    expect(pending.streams[0]!.events.map((entry) => entry.eventId)).toEqual(ids);
    await repository.close();
    const reopened = new WorkspaceRepository(factory, cloudNamespace(deployment, account, workspaceId));
    const sent: SyncPushRequest[] = [];
    api.push = async (input) => { sent.push(input); return original(input); };
    const recovered = engine(reopened, workspaceId, 'device-a', api);
    expect((await recovered.sync.run()).stopped).toBeNull();
    expect(sent).toEqual([pending]);
    expect(api.changes).toHaveLength(1);
    expect(await reopened.pendingOutbox()).toEqual([]);
    expect((await reopened.syncState()).pendingPush).toBeUndefined();
    expect((await reopened.syncState()).conflicts).toEqual([]);
  });

  it('分支容量不足时隔离完整冲突包，保留全部历史与事件身份，不发保留请求', async () => {
    const workspaceId = crypto.randomUUID();
    const repository = await device(new IDBFactory(), workspaceId);
    const original = await play(repository, 1, 0);
    const full = {
      ...original, branches: original.branches.concat(Array.from({ length: 63 }, () => ({
        ...copy.branches[0]!, id: `brn_${crypto.randomUUID()}`,
      }))),
    };
    const written = await new SessionCommitter(repository, original.identity.repositoryRevision).commit(full);
    expect(written.ok).toBe(true);
    const pending = await repository.pendingOutbox();
    const id = crypto.randomUUID();
    const api = new CloudSim();
    api.conflictRecords.set(id, {
      id, workspaceId, streamId, deviceId: 'device-a', reason: 'stream-head-changed',
      status: 'open', baseSeq: 0, cloudSeq: 1, createdAt: cloudTestTime, resolvedAt: null,
      events: await Promise.all(pending.map(async (entry) => ({ ...entry, digest: await cloudDigest(entry.event) }))),
    });
    const { sync } = engine(repository, workspaceId, 'device-a', api);
    const before = await repository.load();
    await expect(sync.keep(id)).rejects.toThrow('容量');
    expect(await repository.load()).toEqual(before);
    expect(await repository.pendingOutbox()).toEqual(pending);
    expect(api.preservationReceipts.size).toBe(0);
    const raw = await repository.rawSnapshot() as { staging: unknown[]; eventIds: unknown[]; outbox: unknown[] };
    expect(raw.staging).toHaveLength(1);
    expect(raw.eventIds).toHaveLength(pending.length);
    expect(raw.outbox).toHaveLength(pending.length);
    expect(await repository.pendingPreservation()).toBeNull();
  });

  it('服务端明确拒绝容量时保留恢复包并解除本机冻结，网络未知结果则不解除', async () => {
    const workspaceId = crypto.randomUUID();
    const repository = await device(new IDBFactory(), workspaceId);
    await play(repository, 1, 0);
    const pending = await repository.pendingOutbox();
    const before = (await repository.load())!;
    const id = crypto.randomUUID();
    const api = new CloudSim();
    api.conflictRecords.set(id, {
      id, workspaceId, streamId, deviceId: 'device-a', reason: 'stream-head-changed',
      status: 'open', baseSeq: 0, cloudSeq: 1, createdAt: cloudTestTime, resolvedAt: null,
      events: await Promise.all(pending.map(async (entry) => ({ ...entry, digest: await cloudDigest(entry.event) }))),
    });
    api.resolveConflict = async () => { throw new CloudFailure('STORAGE_QUOTA', 409, '云端分支容量不足'); };
    const { sync } = engine(repository, workspaceId, 'device-a', api);
    await expect(sync.keep(id)).rejects.toThrow('容量不足');
    expect(await repository.load()).toEqual(before);
    expect(await repository.pendingOutbox()).toEqual(pending);
    expect(await repository.pendingPreservation()).toBeNull();
    expect((await repository.rawSnapshot() as { staging: unknown[] }).staging).toHaveLength(2);
    expect((await new SessionCommitter(repository, before.identity.repositoryRevision).commit(step(before, 0, 600))).ok).toBe(true);
  });

  it('业务提交失败时 Outbox 与事件身份同样不落地', async () => {
    const repository = await device(new IDBFactory(), crypto.randomUUID());
    const stored = (await repository.load())!;
    const next = step(stored, 0, 0);
    const stale = new SessionCommitter(repository, stored.identity.repositoryRevision + 5);
    expect((await stale.commit(next)).ok).toBe(false);
    expect(await repository.pendingOutbox()).toEqual([]);
    expect(events((await repository.load())!)).toEqual([]);
    const fresh = new SessionCommitter(repository, stored.identity.repositoryRevision);
    expect((await fresh.commit(next)).ok).toBe(true);
    expect((await repository.pendingOutbox()).length).toBeGreaterThan(0);
  });

  it('本机历史被整体替换时标记 replaced，而不是把旧历史当成追加', async () => {
    const repository = await device(new IDBFactory(), crypto.randomUUID());
    await play(repository, 2, 0);
    const stored = (await repository.load())!;
    const replaced: Workspace = {
      ...stored,
      branches: stored.branches.map((branch) => ({
        ...branch, session: { ...branch.session, events: branch.session.events.slice(1) },
      })),
      identity: { ...stored.identity, repositoryRevision: stored.identity.repositoryRevision + 1 },
    };
    const outcome = await repository.commit(replaced);
    expect(outcome.replaced).toEqual([streamId]);
    expect((await repository.syncState()).needsRebase).toContain(streamId);
  });

  it('远端身份直接写 sidecar 且不入队：重放云端变更不会回声', () => {
    const event = { type: 'advance', episode: 'e', scene: 's', at: cloudTestTime, skip: false };
    const plan = planOutbox({
      stored: [], next: [{ id: streamId, parentBranchId: null, forkAtEventCount: null, events: [event] }],
      sidecar: new Map(), remote: { streamId, startSeq: 1, eventIds: [crypto.randomUUID()] },
      newId: () => crypto.randomUUID(),
    });
    expect(plan.enqueue).toEqual([]);
    expect(plan.sidecar).toHaveLength(1);
    expect(plan.sidecar[0]!.key).toBe(sidecarKey(streamId, 1));
  });

  it('新分支复制父前缀时沿用父流身份，只为真正的新事件分配 ID', () => {
    const parent = `brn_${crypto.randomUUID()}`;
    const child = `brn_${crypto.randomUUID()}`;
    const prefix = [{ type: 'advance', episode: 'e', scene: 'a', at: cloudTestTime, skip: false }];
    const inherited = crypto.randomUUID();
    const plan = planOutbox({
      stored: [{ id: parent, parentBranchId: null, forkAtEventCount: null, events: prefix }],
      next: [
        { id: parent, parentBranchId: null, forkAtEventCount: null, events: prefix },
        { id: child, parentBranchId: parent, forkAtEventCount: 1, events: [...prefix, { type: 'reveal', episode: 'e', scene: 'b', at: cloudTestTime }] },
      ],
      sidecar: new Map([[sidecarKey(parent, 1), { eventId: inherited, event: prefix[0] as never }]]),
      newId: () => crypto.randomUUID(),
    });
    expect(plan.sidecar.find((entry) => entry.key === sidecarKey(child, 1))!.value.eventId).toBe(inherited);
    expect(plan.enqueue).toHaveLength(1);
    expect(plan.enqueue[0]!.eventId).not.toBe(inherited);
  });

  it('待推送只接在已确认前缀之后：有空洞就停，没有绑定就不猜起点', () => {
    const entry = (seq: number): OutboxEntry => ({
      streamId, seq, eventId: crypto.randomUUID(), at: cloudTestTime,
      event: { type: 'reveal', episode: 'e', scene: 's', at: cloudTestTime }, command: { type: 'reveal', scene: 's' },
    });
    expect(outgoing([entry(1)], {})).toEqual([]);
    expect(outgoing([entry(1), entry(3)], { [streamId]: { seq: 0, eventId: null } })[0]!.events.map((item) => item.seq)).toEqual([1]);
    expect(outgoing([entry(2), entry(3)], { [streamId]: { seq: 0, eventId: null } })).toEqual([]);
  });

  it('损坏的同步状态按空状态读取，不因此清空业务数据', () => {
    expect(parseSyncState(null)).toMatchObject({ cursor: null, streams: {}, paused: false });
    expect(parseSyncState({ streams: { x: { seq: -1 } }, conflicts: 'nope' })).toMatchObject({ streams: {}, conflicts: [] });
  });
});

describe('同步驱动：双设备往返', () => {
  it('另一设备已有云端进度后才首次打开副本，仍从导入基线拉取，不跳到当前游标', async () => {
    const workspaceId = crypto.randomUUID();
    const api = new CloudSim();
    api.seed(seed());
    const repositoryA = await device(new IDBFactory(), workspaceId);
    const a = engine(repositoryA, workspaceId, 'device-a', api);
    await a.sync.run();
    const played = await play(repositoryA, 1, 0);
    api.pusher = 'device-a';
    await a.sync.run();
    const repositoryB = await device(new IDBFactory(), workspaceId);
    const b = engine(repositoryB, workspaceId, 'device-b', api);
    expect((await b.sync.run()).stopped).toBeNull();
    expect(events((await repositoryB.load())!)).toEqual(events(played));
    expect(await repositoryB.pendingOutbox()).toEqual([]);
  });

  it('A 推送 → B 拉取应用 → B 追加 → A 拉取应用，两端历史一致且无回声', async () => {
    const workspaceId = crypto.randomUUID();
    // 两台设备各自的 IndexedDB：共用 factory 会变成同一份库，测不出跨设备
    const deviceA = await device(new IDBFactory(), workspaceId);
    const deviceB = await device(new IDBFactory(), workspaceId);
    const api = new CloudSim();
    api.seed(seed());
    const a = engine(deviceA, workspaceId, 'device-a', api);
    const b = engine(deviceB, workspaceId, 'device-b', api);

    // 两台设备先各自建立云端绑定（游标 0），再离线阅读
    await a.sync.run();
    await b.sync.run();
    const playedA = await play(deviceA, 1, 0);
    api.pusher = 'device-a';
    const pushedA = await a.sync.run();
    expect(pushedA.stopped).toBeNull();
    expect(pushedA.pushed).toBe(events(playedA).length);
    expect(await deviceA.pendingOutbox()).toEqual([]);

    api.pusher = 'device-b';
    const pulledB = await b.sync.run();
    expect(pulledB.applied).toBe(1);
    expect(events((await deviceB.load())!)).toEqual(events(playedA));
    expect(await deviceB.pendingOutbox()).toEqual([]);
    // 阅读器要能直接打开应用后的存档：不只是字节一致，还要能投影成界面状态
    const reopened = bridge(content, (await deviceB.load())!);
    expect(projectSession(reopened.session, reopened.library).episodes[reopened.session.current]!.cursor).toBeGreaterThan(0);

    const playedB = await play(deviceB, 1, 1, 100);
    api.pusher = 'device-b';
    expect((await b.sync.run()).stopped).toBeNull();
    expect(await deviceB.pendingOutbox()).toEqual([]);

    api.pusher = 'device-a';
    const pulledA = await a.sync.run();
    expect(pulledA.applied).toBe(1);
    expect(events((await deviceA.load())!)).toEqual(events(playedB));
    expect(await deviceA.pendingOutbox()).toEqual([]);
  });

  it('两设备离线相反选择：后到的推送被整批拒绝，候选保留且不拼接', async () => {
    const workspaceId = crypto.randomUUID();
    const deviceA = await device(new IDBFactory(), workspaceId);
    const deviceB = await device(new IDBFactory(), workspaceId);
    const api = new CloudSim();
    api.seed(seed());
    const a = engine(deviceA, workspaceId, 'device-a', api);
    const b = engine(deviceB, workspaceId, 'device-b', api);
    // 两台设备先各自建立云端绑定（前缀 0），然后离线阅读
    await a.sync.run();
    await b.sync.run();
    const left = await play(deviceA, 1, 0, 0);
    const right = await play(deviceB, 1, 1, 500);
    expect(events(left)[0]!.at).not.toBe(events(right)[0]!.at);

    api.pusher = 'device-a';
    expect((await a.sync.run()).stopped).toBeNull();
    api.pusher = 'device-b';
    const rejected = await b.sync.run();
    expect(rejected.stopped).toBe('conflict');
    expect(rejected.pushed).toBe(0);
    expect((await deviceB.pendingOutbox()).length).toBeGreaterThan(0);
    const state = await deviceB.syncState();
    expect(state.conflicts).toHaveLength(1);
    expect(state.lastError).toContain('前缀');

    // 云端只有 A 的历史：B 的事件一条都没混进去
    expect(api.changes.flatMap((change) => change.events).map((entry) => entry.event)).toEqual(events(left));

    // 显式放弃：B 不再推送该分支，本机内容保留
    await b.sync.discard(state.conflicts[0]!.id);
    expect(await deviceB.pendingOutbox()).toEqual([]);
    expect((await deviceB.syncState()).needsRebase).toContain(streamId);
    expect(events((await deviceB.load())!)).toEqual(events(right));
    const next = await b.sync.run();
    expect(next.stopped).toBe('prefix');
    expect(next.note).toContain('停止推送');
  });

  it('暂停时只排队不推送；恢复后按原身份补发', async () => {
    const repository = await device(new IDBFactory(), crypto.randomUUID());
    const api = new CloudSim();
    api.seed(seed());
    const { sync } = engine(repository, crypto.randomUUID(), 'device-a', api);
    await sync.run();
    await sync.setPaused(true);
    await play(repository, 1, 0);
    const paused = await sync.run();
    expect(paused.pushed).toBe(0);
    expect(paused.note).toContain('暂停');
    const before = (await repository.pendingOutbox()).map((entry) => entry.eventId);
    expect(before.length).toBeGreaterThan(0);
    await sync.setPaused(false);
    const resumed = await sync.run();
    expect(resumed.pushed).toBe(before.length);
    expect(await repository.pendingOutbox()).toEqual([]);
    expect((await repository.syncState()).streams[streamId]!.seq).toBe(before.length);
  });

  it('游标过期时先报出本机未同步条数，绝不静默覆盖', async () => {
    const workspaceId = crypto.randomUUID();
    const repository = await device(new IDBFactory(), workspaceId);
    const api = new CloudSim();
    api.seed(seed());
    const { sync } = engine(repository, workspaceId, 'device-a', api);
    await sync.run();
    const played = await play(repository, 1, 0);
    const state = await repository.syncState();
    await repository.saveSyncState({ ...state, cursor: '999' });

    const { sync: expiring } = engine(repository, workspaceId, 'device-a', new ExpiringCloud());
    const report = await expiring.pullOnce();
    expect(report.stopped).toBe('cursor');
    expect(report.pending).toBeGreaterThan(0);
    expect(report.note).toContain('未同步');
    expect((await repository.pendingOutbox()).length).toBe(report.pending);
    // 本机历史原样保留：没有被"重新引导"抹掉
    expect(events((await repository.load())!)).toEqual(events(played));
  });
});

describe('同步状态可见性', () => {
  it('同步面板的状态来自本机存储，不伪造「已同步」', async () => {
    const workspaceId = crypto.randomUUID();
    const repository = await device(new IDBFactory(), workspaceId);
    const { sync } = engine(repository, workspaceId, 'device-a');
    const fresh = await sync.status();
    expect(fresh).toMatchObject({ pending: 0 });
    expect(fresh.state.lastSyncedAt).toBeNull();
    expect(fresh.state.cursor).toBeNull();
  });

  it('安装的云副本仍可被本地存档解析（没有把副本写成另一种格式）', () => {
    expect(() => parseWorkspace(copy)).not.toThrow();
  });
});

/** 在本机造一条分叉分支：前缀逐字节复制父分支，分叉点之后才是它自己的事件。 */
async function forkAt(repository: WorkspaceRepository, at: number) {
  const stored = (await repository.load())!;
  const parent = stored.branches.find((branch) => branch.id === stored.activeBranchId)!;
  const id = `brn_${crypto.randomUUID()}`;
  const branch = {
    ...parent, id, label: '分叉线', parentBranchId: parent.id, forkAtEventCount: at,
    session: { ...parent.session, events: parent.session.events.slice(0, at) },
  };
  const committer = new SessionCommitter(repository, stored.identity.repositoryRevision);
  const result = await committer.commit({ ...stored, branches: [...stored.branches, branch], activeBranchId: id });
  if (!result.ok) throw new Error(result.error);
  return { branchId: id, parentId: parent.id };
}

describe('分叉流注册：本机新建分支', () => {
  it('先注册分叉流再推送：事件接在分叉点之后，父流前缀不重复上传', async () => {
    const workspaceId = crypto.randomUUID();
    const repository = await device(new IDBFactory(), workspaceId);
    const api = new CloudSim();
    api.seed(seed());
    const driver = engine(repository, workspaceId, 'device-a', api);

    await driver.sync.run();
    const root = await play(repository, 2, 0);
    const count = root.branches[0]!.session.events.length;
    await driver.sync.run();
    expect(await repository.pendingOutbox()).toEqual([]);

    const { branchId, parentId } = await forkAt(repository, count);
    await play(repository, 1, 0, 100);
    const pending = await repository.pendingOutbox();
    expect(pending.every((entry) => entry.streamId === branchId)).toBe(true);
    expect(pending[0]!.seq).toBe(count + 1);
    const added = pending.length;

    const report = await driver.sync.run();
    expect(report.stopped).toBeNull();
    expect(await repository.pendingOutbox()).toEqual([]);
    expect(api.forks.get(branchId)).toEqual({ parentStreamId: parentId, forkAtSeq: count });
    expect(api.streams.get(branchId)).toMatchObject({ seq: count + added });
    // 云端头部仍是父流那条，分叉流是独立的一条
    expect(api.streams.get(streamId)!.seq).toBe(count);
  });

  it('父流前缀还没推完时不注册分叉流，说清原因；下一轮补上', async () => {
    const workspaceId = crypto.randomUUID();
    const repository = await device(new IDBFactory(), workspaceId);
    const api = new CloudSim();
    api.seed(seed());
    const driver = engine(repository, workspaceId, 'device-a', api);

    await driver.sync.run();
    const root = await play(repository, 2, 0);
    const count = root.branches[0]!.session.events.length;
    const { branchId } = await forkAt(repository, count);
    await play(repository, 1, 0, 100);

    const first = await driver.sync.run();
    // 父流这一轮被推上去，但分叉流不能在这一轮注册（分叉点超出父流当时的历史）
    expect(api.streams.get(streamId)!.seq).toBe(count);
    expect(api.forks.has(branchId)).toBe(false);
    // 父流前缀没推完时**根本不发注册请求**，而不是发了被服务端拒掉
    expect(api.registerAttempts).not.toContain(branchId);
    expect(first.pending).toBeGreaterThan(0);
    expect(first.note).toContain('还没有云端事件流');

    const second = await driver.sync.run();
    expect(second.stopped).toBeNull();
    expect(api.registerAttempts).toContain(branchId);
    expect(api.forks.get(branchId)).toMatchObject({ forkAtSeq: count });
    expect(await repository.pendingOutbox()).toEqual([]);
  });

  it('没有父流记录的分支不注册，也不编造前缀', async () => {
    const workspaceId = crypto.randomUUID();
    const repository = await device(new IDBFactory(), workspaceId);
    const api = new CloudSim();
    api.seed(seed());
    const driver = engine(repository, workspaceId, 'device-a', api);

    await driver.sync.run();
    await play(repository, 1, 0);
    await driver.sync.run();
    expect(await repository.pendingOutbox()).toEqual([]);

    const stored = (await repository.load())!;
    const parent = stored.branches.find((branch) => branch.id === stored.activeBranchId)!;
    const id = `brn_${crypto.randomUUID()}`;
    const branch = { ...parent, id, label: '无父线', parentBranchId: null, forkAtEventCount: null };
    const committer = new SessionCommitter(repository, stored.identity.repositoryRevision);
    const committed = await committer.commit({ ...stored, branches: [...stored.branches, branch], activeBranchId: id });
    expect(committed.ok).toBe(true);
    await play(repository, 1, 0, 30);

    const report = await driver.sync.run();
    expect(api.streams.has(id)).toBe(false);
    expect(report.note).toContain('没有父流记录');
    // 事件仍在队列里，不会被悄悄丢弃
    expect((await repository.pendingOutbox()).some((entry) => entry.streamId === id)).toBe(true);
  });
});
