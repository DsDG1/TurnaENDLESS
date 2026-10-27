import { describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { applyPlayerCommand, bridge, buildBackup, parseWorkspace, type Workspace } from '@endless/content';
import { deriveCloudCopy } from '@endless/content/cloud';
import { getOptions, getScenes, projectSession } from '@endless/player';
import type {
  CloudImportReceipt, ResolveConflictResponse, SyncBootstrap, SyncRecoveryRequest, SyncChange, SyncConflict, SyncPushReceipt, SyncPushRequest, SyncStreamBinding,
} from '@endless/cloud-contracts';
import { CloudFailure } from '../src/cloud/client.js';
import { cloudDigest, cloudNamespace } from '../src/cloud/local.js';
import { planOutbox, outgoing, parseSyncState, sidecarKey, type OutboxEntry } from '../src/cloud/outbox.js';
import { WorkspaceSync } from '../src/cloud/sync.js';
import { SessionCommitter } from '../src/session-writer.js';
import { CloudWorkspaceRepository as WorkspaceRepository } from '../src/cloud/repository.js';
import { WorkspaceRepository as GuestWorkspaceRepository } from '../src/storage.js';
import { cloudTestContent as content, cloudTestTime, cloudTestWorkspace } from '../../../packages/content/test/cloud-fixture.js';

/**
 * 客户端同步测试：真实 fake-indexeddb + 内存云端。
 *
 * 内存云端只复述**协议必需**的规则（流前缀 CAS、变更有序、"哪个设备推的"），
 * 业务规则本身的权威测试在 apps/api 的真 PostgreSQL 套件里。
 */

const deployment = crypto.randomUUID();
const account = crypto.randomUUID();
const DEVICE_A = crypto.randomUUID(), DEVICE_B = crypto.randomUUID();
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
  async readingSnapshot(_input: unknown): Promise<import('@endless/cloud-contracts').ReadingSnapshot> {
    throw new CloudFailure('UNSUPPORTED_CONTRACT', 409, '该协议夹具未提供快照');
  }
  discardReceipts = new Map<string, ResolveConflictResponse>();
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
  pusher = DEVICE_A;

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

  async recoverSync(input: SyncRecoveryRequest): Promise<SyncBootstrap> {
    if (BigInt(input.cloudVersion) > BigInt(this.version)) throw new CloudFailure('BASIS_CHANGED', 409, '云端版本回滚');
    for (const prefix of input.streams) {
      const head = this.streams.get(prefix.streamId);
      const id = prefix.eventSeq ? this.eventIds.get(prefix.streamId)?.[prefix.eventSeq - 1] : null;
      if (!head || head.seq < prefix.eventSeq || id !== prefix.lastEventId) throw new CloudFailure('BASIS_CHANGED', 409, '历史前缀不一致');
    }
    return this.bootstrap(input.workspaceId);
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

  async conflicts() { return { conflicts: [...this.conflictRecords.values()] }; }

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
    const cached = this.discardReceipts.get(conflictId);
    if (cached) return structuredClone(cached);
    conflict.status = 'discarded';
    conflict.resolvedAt = new Date().toISOString();
    const head = this.streams.get(conflict.streamId)!;
    const stream: SyncStreamBinding = { streamId: conflict.streamId, branchId: conflict.streamId, eventSeq: head.seq, lastEventId: head.lastEventId };
    const source = copy.branches[0]!;
    const result: ResolveConflictResponse = {
      conflict: structuredClone(conflict),
      stream: {
        streamId: conflict.streamId, branchId: conflict.streamId, eventSeq: head.seq, lastEventId: head.lastEventId,
      } as SyncStreamBinding,
      history: { stream, branch: { streamId: source.id, label: source.label, parentBranchId: null, forkAtEventCount: null,
        adopted: source.adopted, catalog: source.session.catalog, createdAt: source.createdAt, commonStreamId: null, commonPrefixSeq: 0 },
        events: this.changes.filter((c) => c.streamId === conflict.streamId).flatMap((c) => c.events) },
    };
    this.discardReceipts.set(conflictId, structuredClone(result));
    return result;
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
    const a = engine(deviceA, workspaceId, DEVICE_A, api);
    const b = engine(deviceB, workspaceId, DEVICE_B, api);
    await a.sync.run();
    await b.sync.run();
    const left = await play(deviceA, 1, 0);
    const right = await play(deviceB, 2, 1, 500);
    api.pusher = DEVICE_A;
    await a.sync.run();
    api.pusher = DEVICE_B;
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
    api.pusher = DEVICE_A;
    expect((await a.sync.run()).stopped).toBeNull();
    expect((await deviceA.load())!.branches.find((branch) => branch.id === retained.id)?.session.events).toEqual(events(right));
  });

  it('保留响应丢失后刷新沿用同一请求，期间冻结写入；落库失败原历史与请求一起保留', async () => {
    const workspaceId = crypto.randomUUID();
    const factory = new IDBFactory();
    const repository = await device(factory, workspaceId);
    const api = new CloudSim();
    api.seed(seed());
    const { sync } = engine(repository, workspaceId, DEVICE_B, api);
    await sync.run();
    const right = await play(repository, 1, 1, 500);
    const left = step(copy, 0, 0);
    api.pusher = DEVICE_A;
    const leftEvents = await Promise.all(events(left).map(async (event, index) => ({
      eventId: crypto.randomUUID(), seq: index + 1, at: event.at, event: event as never,
      command: { type: event.type, scene: event.scene, ...(event.type === 'advance' ? { skip: event.skip } : event.type === 'answer' ? { choice: event.choice } : {}) } as never,
      digest: await cloudDigest(event),
    })));
    await api.push({ workspaceId, batchId: crypto.randomUUID(), baseVersion: '1', streams: [{ streamId, baseSeq: 0, baseEventId: null, events: leftEvents }] });
    api.pusher = DEVICE_B;
    await sync.run();
    const id = (await repository.syncState()).conflicts[0]!.id;
    const original = api.resolveConflict.bind(api);
    api.resolveConflict = async (...args) => {
      await original(...args);
      throw new CloudFailure('NETWORK', 0, '响应丢失');
    };
    await expect(sync.keep(id)).rejects.toThrow('响应丢失');
    const pending = (await repository.pendingPreservation())!;
    if (pending.request.decision !== 'keep-branch') throw new Error('expected keep request');
    expect(pending.request.streamId).toMatch(/^brn_/);
    await expect(sync.discard(id)).rejects.toThrow('不能切换为放弃');
    const blocked = await new SessionCommitter(repository, right.identity.repositoryRevision).commit(step(right, 0, 600));
    expect(blocked.ok).toBe(false);
    expect(events((await repository.load())!)).toEqual(events(right));
    await repository.close();
    const reopened = new WorkspaceRepository(factory, cloudNamespace(deployment, account, workspaceId));
    api.resolveConflict = original;
    const recovered = engine(reopened, workspaceId, DEVICE_B, api);
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
    expect((await reopened.load())!.branches.some((branch) => branch.id === (pending.request.decision === 'keep-branch' ? pending.request.streamId : null))).toBe(true);
    expect(api.preservationReceipts.size).toBe(1);
    expect(await reopened.pendingPreservation()).toBeNull();
  });

  it('推送成功但响应丢失，刷新后恢复持久化批次，不会把成功变成新冲突', async () => {
    const workspaceId = crypto.randomUUID();
    const factory = new IDBFactory();
    const repository = await device(factory, workspaceId);
    const api = new CloudSim();
    api.seed(seed());
    const { sync } = engine(repository, workspaceId, DEVICE_A, api);
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
    const recovered = engine(reopened, workspaceId, DEVICE_A, api);
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
      id, workspaceId, streamId, deviceId: DEVICE_A, reason: 'stream-head-changed',
      status: 'open', baseSeq: 0, cloudSeq: 1, createdAt: cloudTestTime, resolvedAt: null,
      events: await Promise.all(pending.map(async (entry) => ({ ...entry, digest: await cloudDigest(entry.event) }))),
    });
    const { sync } = engine(repository, workspaceId, DEVICE_A, api);
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
      id, workspaceId, streamId, deviceId: DEVICE_A, reason: 'stream-head-changed',
      status: 'open', baseSeq: 0, cloudSeq: 1, createdAt: cloudTestTime, resolvedAt: null,
      events: await Promise.all(pending.map(async (entry) => ({ ...entry, digest: await cloudDigest(entry.event) }))),
    });
    api.resolveConflict = async () => { throw new CloudFailure('STORAGE_QUOTA', 409, '云端分支容量不足'); };
    const { sync } = engine(repository, workspaceId, DEVICE_A, api);
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
  it('正文相同但命令不再产生新事件时明确拒绝，不把未落库事件算进已确认流头', async () => {
    const workspaceId = crypto.randomUUID(), api = new CloudSim(); api.seed(seed());
    const a = await device(new IDBFactory(), workspaceId), b = await device(new IDBFactory(), workspaceId);
    const left = engine(a, workspaceId, DEVICE_A, api), right = engine(b, workspaceId, DEVICE_B, api);
    await left.sync.run(); await right.sync.run();
    await play(a, 1, 0); await left.sync.run(); await right.sync.run();
    const before = await b.load(), ids = (await b.rawSnapshot() as any).eventIds, state = await b.syncState();
    const previous = api.changes.at(-1)!, entry = previous.events.at(-1)!;
    const repeated = { ...entry, seq: entry.seq + 1, eventId: crypto.randomUUID() };
    api.changes.push({ ...previous, seq: previous.seq + 1, batchId: crypto.randomUUID(), fromSeq: previous.toSeq,
      toSeq: previous.toSeq + 1, events: [repeated] });
    api.streams.set(streamId, { seq: repeated.seq, lastEventId: repeated.eventId }); api.version++;
    expect((await right.sync.run()).stopped).toBe('replay');
    expect(await b.load()).toEqual(before);
    expect((await b.syncState()).streams).toEqual(state.streams);
    expect((await b.syncState()).cursor).toBe(state.cursor);
    expect((await b.rawSnapshot() as any).eventIds).toEqual(ids);
    api.changes[api.changes.length - 1] = { ...api.changes.at(-1)!, fromSeq: 0, toSeq: entry.seq,
      events: [{ ...entry, eventId: crypto.randomUUID() }] };
    expect((await right.sync.run()).stopped).toBe('prefix');
    expect(await b.load()).toEqual(before);
    expect((await b.syncState()).streams).toEqual(state.streams);
    expect((await b.syncState()).cursor).toBe(state.cursor);
    expect((await b.rawSnapshot() as any).eventIds).toEqual(ids);
    api.changes[api.changes.length - 1] = { ...api.changes.at(-1)!, fromSeq: 0, toSeq: entry.seq + 1, events: [entry] };
    expect((await right.sync.run()).stopped).toBe('replay');
    expect(await b.load()).toEqual(before);
    expect((await b.syncState()).streams).toEqual(state.streams);
    expect((await b.syncState()).cursor).toBe(state.cursor);
    expect((await b.rawSnapshot() as any).eventIds).toEqual(ids);
    await a.close(); await b.close();
  });
  it('另一设备已有云端进度后才首次打开副本，仍从导入基线拉取，不跳到当前游标', async () => {
    const workspaceId = crypto.randomUUID();
    const api = new CloudSim();
    api.seed(seed());
    const repositoryA = await device(new IDBFactory(), workspaceId);
    const a = engine(repositoryA, workspaceId, DEVICE_A, api);
    await a.sync.run();
    const played = await play(repositoryA, 1, 0);
    api.pusher = DEVICE_A;
    await a.sync.run();
    const repositoryB = await device(new IDBFactory(), workspaceId);
    const b = engine(repositoryB, workspaceId, DEVICE_B, api);
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
    const a = engine(deviceA, workspaceId, DEVICE_A, api);
    const b = engine(deviceB, workspaceId, DEVICE_B, api);

    // 两台设备先各自建立云端绑定（游标 0），再离线阅读
    await a.sync.run();
    await b.sync.run();
    const playedA = await play(deviceA, 1, 0);
    api.pusher = DEVICE_A;
    const pushedA = await a.sync.run();
    expect(pushedA.stopped).toBeNull();
    expect(pushedA.pushed).toBe(events(playedA).length);
    expect(await deviceA.pendingOutbox()).toEqual([]);

    api.pusher = DEVICE_B;
    const pulledB = await b.sync.run();
    expect(pulledB.applied).toBe(1);
    expect(events((await deviceB.load())!)).toEqual(events(playedA));
    expect(await deviceB.pendingOutbox()).toEqual([]);
    // 阅读器要能直接打开应用后的存档：不只是字节一致，还要能投影成界面状态
    const reopened = bridge(content, (await deviceB.load())!);
    expect(projectSession(reopened.session, reopened.library).episodes[reopened.session.current]!.cursor).toBeGreaterThan(0);

    const playedB = await play(deviceB, 1, 1, 100);
    api.pusher = DEVICE_B;
    expect((await b.sync.run()).stopped).toBeNull();
    expect(await deviceB.pendingOutbox()).toEqual([]);

    api.pusher = DEVICE_A;
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
    const a = engine(deviceA, workspaceId, DEVICE_A, api);
    const b = engine(deviceB, workspaceId, DEVICE_B, api);
    // 两台设备先各自建立云端绑定（前缀 0），然后离线阅读
    await a.sync.run();
    await b.sync.run();
    const left = await play(deviceA, 1, 0, 0);
    const right = await play(deviceB, 1, 1, 500);
    expect(events(left)[0]!.at).not.toBe(events(right)[0]!.at);

    api.pusher = DEVICE_A;
    expect((await a.sync.run()).stopped).toBeNull();
    api.pusher = DEVICE_B;
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
    expect((await deviceB.syncState()).needsRebase).toEqual([]);
    expect(events((await deviceB.load())!)).toEqual(events(left));
    const snapshot = await deviceB.rawSnapshot() as any;
    const retained = snapshot.staging.find((value: any) => value.plan?.request.decision === 'discard');
    expect(retained.plan.workspace).toEqual(right);
    expect(retained.plan.identities.filter(Boolean).length).toBe(events(right).length);
    expect(JSON.stringify(snapshot)).toContain(JSON.stringify(events(right)[0]!.at));
    const next = await b.sync.run();
    expect(next.stopped).toBeNull();
    expect(events((await deviceB.load())!)).toEqual(events(left));
  });

  it('暂停时只排队不推送；恢复后按原身份补发', async () => {
    const repository = await device(new IDBFactory(), crypto.randomUUID());
    const api = new CloudSim();
    api.seed(seed());
    const { sync } = engine(repository, crypto.randomUUID(), DEVICE_A, api);
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
    const { sync } = engine(repository, workspaceId, DEVICE_A, api);
    await sync.run();
    const played = await play(repository, 1, 0);
    const state = await repository.syncState();
    await repository.saveSyncState({ ...state, cursor: '999' });

    const { sync: expiring } = engine(repository, workspaceId, DEVICE_A, new ExpiringCloud());
    const report = await expiring.pullOnce();
    expect(report.stopped).toBe('cursor');
    expect(report.pending).toBeGreaterThan(0);
    expect(report.note).toContain('未同步');
    expect((await repository.pendingOutbox()).length).toBe(report.pending);
    // 本机历史原样保留：没有被"重新引导"抹掉
    expect(events((await repository.load())!)).toEqual(events(played));
  });

  it('游标换代后保留已确认身份与业务历史，重读旧页并继续另一设备的事件', async () => {
    const workspaceId = crypto.randomUUID();
    const repo = await device(new IDBFactory(), workspaceId);
    const api = new CloudSim(); api.seed(seed());
    const { sync } = engine(repo, workspaceId, DEVICE_A, api);
    await sync.run();
    await play(repo, 1, 0);
    await sync.run();
    const before = (await repo.load())!, confirmed = await repo.syncState();
    const remote = await device(new IDBFactory(), workspaceId);
    const other = engine(remote, workspaceId, DEVICE_B, api).sync;
    await other.run(); await play(remote, 1, 0, 100);
    api.pusher = DEVICE_B; await other.run();
    await repo.saveSyncState({ ...confirmed, cursor: 'expired' });
    const pull = api.pull.bind(api);
    vi.spyOn(api, 'pull').mockImplementation((id, cursor, limit) => {
      if (cursor === 'expired') return Promise.reject(new CloudFailure('CURSOR_EXPIRED', 409, '换代'));
      return pull(id, cursor, limit);
    });
    expect((await sync.run()).stopped).toBeNull();
    const after = (await repo.load())!;
    expect(events(after)).toEqual(events((await remote.load())!));
    expect(events(after).slice(0, events(before).length)).toEqual(events(before));
    expect((await repo.syncState()).streams[streamId]!.seq).toBe(events(after).length);
    expect(await repo.pendingOutbox()).toEqual([]);
  });

  it('恢复重定位 CAS 拒绝并发离线追加、状态竞争与落库失败，原游标不变', async () => {
    const workspaceId = crypto.randomUUID();
    const repo = await device(new IDBFactory(), workspaceId);
    const api = new CloudSim(); api.seed(seed());
    const { sync } = engine(repo, workspaceId, DEVICE_A, api); await sync.run();
    const state = await repo.syncState(), boot = await api.bootstrap(workspaceId);
    const put = IDBObjectStore.prototype.put;
    const fail = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'sync' && key === 'sync') { this.transaction.abort(); throw new Error('synthetic'); }
      return put.call(this, value, key!);
    });
    await expect(repo.reanchorSync(state, boot)).rejects.toThrow(); fail.mockRestore();
    expect(await repo.syncState()).toEqual(state);
    await repo.saveSyncState({ ...state, paused: true });
    await expect(repo.reanchorSync(state, boot)).rejects.toThrow('另一窗口');
    const fresh = await repo.syncState(); await play(repo, 1, 0);
    await expect(repo.reanchorSync(fresh, boot)).rejects.toThrow('未同步事件');
    expect((await repo.pendingOutbox()).length).toBeGreaterThan(0);
  });

  it('云端不能证明已确认前缀时不重定位；自己的旧页也必须逐条验证', async () => {
    const workspaceId = crypto.randomUUID();
    const repo = await device(new IDBFactory(), workspaceId);
    const api = new CloudSim(); api.seed(seed());
    const { sync } = engine(repo, workspaceId, DEVICE_A, api);
    await sync.run(); await play(repo, 1, 0); await sync.run();
    const before = (await repo.load())!;
    await repo.saveSyncState({ ...(await repo.syncState()), cursor: 'expired' });
    const pull = api.pull.bind(api);
    vi.spyOn(api, 'pull').mockImplementation((id, cursor, limit) => cursor === 'expired'
      ? Promise.reject(new CloudFailure('CURSOR_EXPIRED', 409, '换代')) : pull(id, cursor, limit));
    const recover = vi.spyOn(api, 'recoverSync').mockRejectedValue(new CloudFailure('BASIS_CHANGED', 409, '历史回滚'));
    await expect(sync.run()).rejects.toThrow('历史回滚');
    expect((await repo.syncState()).cursor).toBe('expired');
    expect(await repo.load()).toEqual(before);
    recover.mockRestore();
    api.changes[0]!.events[0]!.digest = '0'.repeat(64);
    expect((await sync.run()).stopped).toBe('replay');
    expect(await repo.load()).toEqual(before);
  });
});

describe('显式采用云端历史：discard 恢复', () => {
  async function conflicting() {
    const workspaceId = crypto.randomUUID(), factory = new IDBFactory();
    const a = await device(new IDBFactory(), workspaceId), b = await device(factory, workspaceId);
    const api = new CloudSim(); api.seed(seed());
    const leftSync = engine(a, workspaceId, DEVICE_A, api).sync, sync = engine(b, workspaceId, DEVICE_B, api).sync;
    await leftSync.run(); await sync.run();
    const left = await play(a, 1, 0), right = await play(b, 2, 1, 500);
    api.pusher = DEVICE_A; await leftSync.run();
    api.pusher = DEVICE_B; expect((await sync.run()).stopped).toBe('conflict');
    const id = (await b.syncState()).conflicts[0]!.id;
    return { a, b, api, sync, id, workspaceId, factory, left, right };
  }

  it('丢响应后刷新恢复同一决定；写入失败不丢候选，成功后保留全部原身份并可继续阅读推送', async () => {
    const f = await conflicting();
    const old = await play(f.b, 1, 1, 700), pending = await f.b.pendingOutbox();
    const original = f.api.resolveConflict.bind(f.api), calls: unknown[] = [];
    f.api.resolveConflict = async (...args) => { calls.push(args); await original(...args); throw new CloudFailure('NETWORK', 0, '丢失放弃响应'); };
    await expect(f.sync.discard(f.id)).rejects.toThrow('丢失放弃响应');
    const plan = (await f.b.pendingPreservation())!;
    expect(plan.request.decision).toBe('discard');
    expect(await f.b.pendingOutbox()).toEqual(pending);
    expect(await f.b.load()).toEqual(old);
    expect((await new SessionCommitter(f.b, old.identity.repositoryRevision).commit(
      applyPlayerCommand(content, old, { type: 'select', episode: 'pilot-2' }, at(800)))).ok).toBe(false);
    await expect(f.sync.keep(f.id)).rejects.toThrow('不能切换决定');
    await f.b.close();
    const reopened = new WorkspaceRepository(f.factory, cloudNamespace(deployment, account, f.workspaceId));
    const sync = engine(reopened, f.workspaceId, DEVICE_B, f.api).sync;
    f.api.resolveConflict = async (...args) => { calls.push(args); return original(...args); };
    const put = IDBObjectStore.prototype.put;
    const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'sync' && key === 'sync') throw new DOMException('synthetic quota', 'QuotaExceededError');
      return put.call(this, value, key!);
    });
    try { await expect(sync.run()).rejects.toThrow('保存失败'); } finally { failure.mockRestore(); }
    expect(await reopened.load()).toEqual(old); expect(await reopened.pendingOutbox()).toEqual(pending);
    expect(await reopened.pendingPreservation()).toEqual(plan);
    expect((await sync.run()).stopped).toBeNull();
    expect(calls).toEqual([calls[0], calls[0], calls[0]]);
    expect(events((await reopened.load())!)).toEqual(events(f.left));
    const raw = await reopened.rawSnapshot() as any;
    const backup = raw.staging.find((v: any) => v.plan?.request.decision === 'discard');
    expect(backup.plan.workspace).toEqual(old); expect(backup.plan.identities.map((v: any) => v.eventId)).toEqual(pending.map((v) => v.eventId));
    expect(raw.staging.filter((v: any) => v.value?.streamId === streamId).map((v: any) => v.value).sort((a: any, b: any) => a.seq - b.seq)).toEqual(pending);
    expect(await reopened.pendingPreservation()).toBeNull(); expect(await reopened.pendingOutbox()).toEqual([]);
    await play(reopened, 1, 0, 900);
    expect((await reopened.pendingOutbox()).every((v) => !pending.some((p) => p.eventId === v.eventId))).toBe(true);
    expect((await sync.run()).stopped).toBeNull(); expect(await reopened.pendingOutbox()).toEqual([]);
  });

  it('正文即使摘要自洽也需通过原生重放；未知恢复 sidecar 保留且停止，不清理原历史', async () => {
    const f = await conflicting(), before = await f.b.load(), pending = await f.b.pendingOutbox();
    const original = f.api.resolveConflict.bind(f.api);
    const changed = vi.spyOn(f.api, 'resolveConflict').mockImplementationOnce(async (...args) => {
      const result = structuredClone(await original(...args)), first = result.history!.events[0]!;
      first.event.scene = 'forged-scene'; first.command.scene = 'forged-scene'; first.digest = await cloudDigest(first.event);
      return result;
    });
    await expect(f.sync.discard(f.id)).rejects.toThrow(); changed.mockRestore();
    expect(await f.b.load()).toEqual(before); expect(await f.b.pendingOutbox()).toEqual(pending);
    const held = (await f.b.pendingPreservation())!;
    const db = await new Promise<IDBDatabase>((resolve) => { const r = f.factory.open(f.b.namespace, 2); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>((resolve) => { const tx = db.transaction('sync', 'readwrite');
      tx.objectStore('sync').put({ ...held, request: { ...held.request, protocol: 'unknown' } }, 'preservation'); tx.oncomplete = () => resolve(); });
    const raw = await f.b.rawSnapshot();
    await expect(f.sync.run()).rejects.toThrow('不受支持'); expect(await f.b.rawSnapshot()).toEqual(raw);
    db.close();
  });

  it('两个标签页不能为同一候选持久化不同决定，竞争失败不替换原请求', async () => {
    const f = await conflicting();
    const other = new WorkspaceRepository(f.factory, f.b.namespace), conflict = f.api.conflictRecords.get(f.id)!;
    const attempts = await Promise.allSettled([f.b.preparePreservation(conflict, null), other.preparePreservation(conflict, `brn_${crypto.randomUUID()}`)]);
    expect(attempts.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((v) => v.status === 'rejected')).toHaveLength(1);
    expect(f.api.discardReceipts.size).toBe(0); expect(f.api.preservationReceipts.size).toBe(0);
    expect(await f.b.load()).toEqual(f.right);
    await other.close();
  });

  it('未知推送先恢复原批次；已保留冲突决定时不能再排入一个竞争推送', async () => {
    const f = await conflicting(), state = await f.b.syncState(), conflict = f.api.conflictRecords.get(f.id)!;
    const batch: SyncPushRequest = { workspaceId: f.workspaceId, batchId: crypto.randomUUID(), baseVersion: '1',
      streams: [{ streamId, baseSeq: 0, baseEventId: null, events: conflict.events }] };
    await f.b.saveSyncState({ ...state, pendingPush: batch });
    await expect(f.sync.discard(f.id)).rejects.toThrow('结果未知的推送');
    expect(await f.b.pendingPreservation()).toBeNull(); expect(f.api.discardReceipts.size).toBe(0);
    await f.b.saveSyncState(state); await f.b.preparePreservation(conflict, null);
    const before = await f.b.rawSnapshot();
    await expect(f.b.saveSyncState({ ...state, pendingPush: batch })).rejects.toThrow('尚未保存');
    expect(await f.b.rawSnapshot()).toEqual(before);
  });

  it('有后续分支依赖时在发请求前拒绝放弃，完整候选与事件身份保留', async () => {
    const f = await conflicting(); await forkAt(f.b, 1);
    const before = await f.b.load(), pending = await f.b.pendingOutbox();
    await expect(f.sync.discard(f.id)).rejects.toThrow('仍引用候选历史');
    expect(f.api.discardReceipts.size).toBe(0); expect(await f.b.load()).toEqual(before); expect(await f.b.pendingOutbox()).toEqual(pending);
    expect(await f.b.pendingPreservation()).toBeNull();
  });

  it('重新登录的设备可处理本机已知旧候选，不能据此选择其他设备的未知候选', async () => {
    const f = await conflicting(), renewed = engine(f.b, f.workspaceId, crypto.randomUUID(), f.api).sync;
    const foreign = { ...f.api.conflictRecords.get(f.id)!, id: crypto.randomUUID(), deviceId: crypto.randomUUID() };
    f.api.conflictRecords.set(foreign.id, foreign);
    const before = await f.b.rawSnapshot();
    await expect(renewed.discard(foreign.id)).rejects.toThrow('没有该冲突候选');
    expect(await f.b.rawSnapshot()).toEqual(before);
    await renewed.discard(f.id);
    expect(events((await f.b.load())!)).toEqual(events(f.left));
    expect(await f.b.pendingOutbox()).toEqual([]);
  });

  it('旧 discard/needsRebase 只在可唯一验证原候选时显式恢复，未知替换历史不截断', async () => {
    const f = await conflicting(), conflict = f.api.conflictRecords.get(f.id)!;
    conflict.status = 'discarded'; conflict.resolvedAt = new Date().toISOString();
    const db = await new Promise<IDBDatabase>((resolve) => { const r = f.factory.open(f.b.namespace, 2); r.onsuccess = () => resolve(r.result); });
    const oldState = await f.b.syncState();
    await new Promise<void>((resolve) => { const tx = db.transaction(['sync', 'outbox'], 'readwrite'); tx.objectStore('outbox').clear();
      tx.objectStore('sync').put({ ...oldState, conflicts: [], needsRebase: [streamId] }, 'sync'); tx.oncomplete = () => resolve(); });
    await f.sync.rebase(streamId);
    expect(events((await f.b.load())!)).toEqual(events(f.left)); expect((await f.b.syncState()).needsRebase).toEqual([]);
    await f.b.saveSyncState({ ...(await f.b.syncState()), needsRebase: ['unknown-stream'] });
    const raw = await f.b.rawSnapshot(); await expect(f.sync.rebase('unknown-stream')).rejects.toThrow('无法唯一确认');
    expect(await f.b.rawSnapshot()).toEqual(raw); db.close();
  });
});

describe('同步状态可见性', () => {
  it('同步面板的状态来自本机存储，不伪造「已同步」', async () => {
    const workspaceId = crypto.randomUUID();
    const repository = await device(new IDBFactory(), workspaceId);
    const { sync } = engine(repository, workspaceId, DEVICE_A);
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
    const driver = engine(repository, workspaceId, DEVICE_A, api);

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
    const driver = engine(repository, workspaceId, DEVICE_A, api);

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
    const driver = engine(repository, workspaceId, DEVICE_A, api);

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
