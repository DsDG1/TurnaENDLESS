import { describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { buildBackup, deriveCloudCopy, updateDisplay } from '@endless/content';
import type { CloudImportReceipt, MetadataCommand, MetadataEntry, MetadataReceipt } from '@endless/cloud-contracts';
import { WorkspaceRepository } from '../src/storage.js';
import { SessionCommitter } from '../src/session-writer.js';
import { cloudDigest, cloudNamespace } from '../src/cloud/local.js';
import { MetadataSync } from '../src/cloud/metadata-sync.js';
import { cloudTestTime, cloudTestWorkspace } from '../../../packages/content/test/cloud-fixture.js';

async function writeSidecar(factory: IDBFactory, namespace: string, value?: unknown) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(namespace, 2);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('sync', 'readwrite');
      if (value === undefined) tx.objectStore('sync').delete('metadata');
      else tx.objectStore('sync').put(value, 'metadata');
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

/** The stub tests client protocol recovery only. Real concurrency/RLS adjudication is tested in apps/api/test/cloud/sync.test.ts. */
async function fixture() {
  const copy = deriveCloudCopy(buildBackup(cloudTestWorkspace()), cloudTestTime);
  const workspaceId = crypto.randomUUID();
  const namespace = cloudNamespace(crypto.randomUUID(), crypto.randomUUID(), workspaceId);
  const receipt: CloudImportReceipt = {
    id: crypto.randomUUID(), workspaceId, sourceLocalId: copy.identity.workspaceId, sourceProfileId: copy.profile.id,
    sourceRepositoryRevision: 0, sourceObjectId: crypto.randomUUID(), sourceDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64),
    copyDigest: await cloudDigest(copy), copyCreatedAt: cloudTestTime, validationBinding: 'c'.repeat(64),
    copyPolicy: 'endless-cloud-copy/1', contentIds: copy.entries.map((e) => e.id),
    revisionIds: copy.revisions.map((e) => e.id), seedContentIds: copy.entries.map((e) => e.id),
  };
  const entries = new Map<string, MetadataEntry>(copy.entries.map((e) => [e.id, {
    contentId: e.id, version: 0, value: { title: e.display.title, tags: e.display.tags, note: e.display.note }, updatedAt: e.updatedAt,
  }]));
  const receipts = new Map<string, MetadataReceipt>();
  const calls: MetadataCommand[] = [];
  const api = {
    async metadata() { return { workspaceId, entries: structuredClone([...entries.values()]) }; },
    async submitMetadata(input: MetadataCommand): Promise<MetadataReceipt> {
      calls.push(structuredClone(input));
      if (receipts.has(input.commandId)) return structuredClone(receipts.get(input.commandId)!);
      let entry = entries.get(input.contentId)!;
      const outcome = entry.version === input.baseVersion ? 'applied' : 'conflict';
      if (outcome === 'applied') {
        entry = { ...entry, version: entry.version + 1, value: input.value, updatedAt: '2026-10-26T09:00:00.000Z' };
        entries.set(entry.contentId, entry);
      }
      const result: MetadataReceipt = { workspaceId, commandId: input.commandId, outcome, entry: structuredClone(entry) };
      receipts.set(input.commandId, result);
      return structuredClone(result);
    },
  };
  const device = async () => {
    const factory = new IDBFactory();
    const repo = new WorkspaceRepository(factory, namespace);
    await repo.installCloudCopy(copy, receipt, crypto.randomUUID());
    return { factory, repo, sync: new MetadataSync(repo, api, workspaceId) };
  };
  const edit = async (repo: WorkspaceRepository, title: string) => {
    const held = (await repo.load())!;
    const writer = new SessionCommitter(repo, held.identity.repositoryRevision);
    return writer.commit(updateDisplay(held, held.entries[0]!.id, { title, tags: ['标签'], note: `${title}备注` }));
  };
  const choose = async (repo: WorkspaceRepository, decision: 'local' | 'cloud') => {
    const state = await repo.metadataState(), contentId = copy.entries[0]!.id;
    return repo.updateMetadata({ contentId, decision, commandId: state.pending[contentId]!.request.commandId, version: state.known[contentId]!.version });
  };
  return { copy, workspaceId, namespace, api, entries, receipts, calls, device, edit, choose, contentId: copy.entries[0]!.id };
}

describe('展示信息命令：事务、双设备、丢响应和显式冲突', () => {
  it('旧客户端没有基线但已有本机改名时保留原文并要求显式选择', async () => {
    const f = await fixture(); const a = await f.device();
    await f.edit(a.repo, '旧客户端本机名称');
    await writeSidecar(a.factory, f.namespace);
    await a.sync.run();
    const state = await a.repo.metadataState();
    expect(state.pending[f.contentId]!.conflict).toBeDefined();
    expect((await a.repo.load())!.entries[0]!.display.title).toBe('旧客户端本机名称');
    expect(f.calls).toHaveLength(0);
    await a.repo.close();
  });

  it('未知同步状态不重置；读取与业务写入都拒绝，完整原件仍可下载', async () => {
    const f = await fixture(); const a = await f.device();
    const before = await a.repo.load();
    await writeSidecar(a.factory, f.namespace, { format: 'metadata-outbox/999', unknown: 'preserved' });
    await expect(a.repo.metadataState()).rejects.toThrow('不受支持');
    expect((await f.edit(a.repo, '不能提交')).ok).toBe(false);
    expect(await a.repo.load()).toEqual(before);
    expect((await a.repo.rawSnapshot() as any).sync.find((e: any) => e.key === 'metadata').value).toEqual({ format: 'metadata-outbox/999', unknown: 'preserved' });
    await a.repo.close();
  });

  it('业务修改与命令同事务落库；重开不换命令身份，绝不生成学习事件', async () => {
    const f = await fixture(); const a = await f.device();
    expect((await f.edit(a.repo, '新标题')).ok).toBe(true);
    const state = await a.repo.metadataState();
    expect(state.pending[f.contentId]!.request).toMatchObject({ baseVersion: 0, value: { title: '新标题' } });
    expect(await a.repo.pendingOutbox()).toEqual([]);
    expect((await a.repo.load())!.branches).toEqual(f.copy.branches);
    await a.repo.close();
    const reopened = new WorkspaceRepository(a.factory, f.namespace);
    expect(await reopened.metadataState()).toEqual(state);
    await new MetadataSync(reopened, f.api, f.workspaceId).run();
    expect((await reopened.metadataState()).pending).toEqual({});
    expect((await reopened.load())!.revisions).toEqual(expect.arrayContaining(f.copy.revisions));
    await reopened.close();
  });

  it('命令写入遇到配额失败：标题、日志和同步状态全部回滚，下一次可以正常提交', async () => {
    const f = await fixture(); const a = await f.device();
    const before = await a.repo.load(); const state = await a.repo.metadataState();
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
      if (this.name === 'sync' && args[1] === 'metadata') throw new DOMException('synthetic', 'QuotaExceededError');
      return put.apply(this, args);
    });
    try { expect((await f.edit(a.repo, '未保存')).ok).toBe(false); } finally { spy.mockRestore(); }
    expect(await a.repo.load()).toEqual(before);
    expect(await a.repo.metadataState()).toEqual(state);
    expect(f.calls).toHaveLength(0);
    expect((await f.edit(a.repo, '重试')).ok).toBe(true);
    await a.repo.close();
  });

  it('服务端成功但丢响应：刷新后重用原命令，版本只增加一次', async () => {
    const f = await fixture(); const a = await f.device();
    await f.edit(a.repo, '只提交一次');
    const saved = await a.repo.metadataState();
    const flaky = { ...f.api, async submitMetadata(input: MetadataCommand) { await f.api.submitMetadata(input); throw new Error('lost response'); } };
    await expect(new MetadataSync(a.repo, flaky, f.workspaceId).run()).rejects.toThrow('lost response');
    expect(await a.repo.metadataState()).toEqual(saved);
    await a.repo.close();
    const reopened = new WorkspaceRepository(a.factory, f.namespace);
    await new MetadataSync(reopened, f.api, f.workspaceId).run();
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]).toEqual(f.calls[1]);
    expect(f.entries.get(f.contentId)!.version).toBe(1);
    await reopened.close();
  });

  it('接收回执时落库失败同样保留原命令，不重复执行已接受的修改', async () => {
    const f = await fixture(); const a = await f.device();
    await f.edit(a.repo, '回执待保存');
    const state = await a.repo.metadataState();
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
      if (this.name === 'sync') throw new DOMException('synthetic', 'QuotaExceededError');
      return put.apply(this, args);
    });
    try { await expect(a.sync.run()).rejects.toThrow(); } finally { spy.mockRestore(); }
    expect(await a.repo.metadataState()).toEqual(state);
    await a.sync.run();
    expect(f.calls[0]).toEqual(f.calls[1]);
    expect(f.entries.get(f.contentId)!.version).toBe(1);
    await a.repo.close();
  });

  it('双设备离线修改保留两份候选；选择本机创建新命令，再次并发仍会冲突', async () => {
    const f = await fixture(); const a = await f.device(); const b = await f.device();
    await f.edit(a.repo, '设备A'); await f.edit(b.repo, '设备B');
    await a.sync.run(); await b.sync.run();
    expect((await b.repo.load())!.entries[0]!.display.title).toBe('设备B');
    const held = (await b.repo.metadataState()).pending[f.contentId]!;
    expect(held.conflict?.entry.value.title).toBe('设备A');
    await f.choose(b.repo, 'local');
    const replacement = (await b.repo.metadataState()).pending[f.contentId]!.request;
    expect(replacement.commandId).not.toBe(held.request.commandId);
    expect(replacement.baseVersion).toBe(1);
    await f.edit(a.repo, '设备A再次修改'); await a.sync.run();
    await b.sync.run();
    expect((await b.repo.metadataState()).pending[f.contentId]!.conflict?.outcome).toBe('conflict');
    expect(f.entries.get(f.contentId)!.value.title).toBe('设备A再次修改');
    await expect(b.repo.updateMetadata({ contentId: f.contentId, decision: 'cloud', commandId: replacement.commandId, version: 1 })).rejects.toThrow('已变化');
    await f.choose(b.repo, 'cloud');
    expect((await b.repo.load())!.entries[0]!.display.title).toBe('设备A再次修改');
    expect((await b.repo.rawSnapshot() as any).staging.some((e: any) => e.request?.commandId === replacement.commandId)).toBe(true);
    expect((await b.repo.load())!.branches).toEqual(f.copy.branches);
    await Promise.all([a.repo.close(), b.repo.close()]);
  });

  it('选择保留本机后成功提交，两设备读取相同标题；接收远端不会产生回声命令', async () => {
    const f = await fixture(); const a = await f.device(); const b = await f.device();
    await f.edit(a.repo, 'A'); await f.edit(b.repo, 'B');
    await a.sync.run(); await b.sync.run();
    await f.choose(b.repo, 'local');
    await b.sync.run(); await a.sync.run();
    expect((await a.repo.load())!.entries[0]!.display.title).toBe('B');
    expect((await a.repo.metadataState()).pending).toEqual({});
    expect((await b.repo.metadataState()).pending).toEqual({});
    expect(f.entries.get(f.contentId)!.version).toBe(2);
    await Promise.all([a.repo.close(), b.repo.close()]);
  });

  it('远端拉取不覆盖本机待提交内容；再次编辑被拒绝，原请求完整保留', async () => {
    const f = await fixture(); const a = await f.device();
    await f.edit(a.repo, '离线修改');
    const before = await a.repo.metadataState();
    await a.repo.updateMetadata({ snapshot: await f.api.metadata() });
    expect((await a.repo.load())!.entries[0]!.display.title).toBe('离线修改');
    expect((await f.edit(a.repo, '第二次编辑')).ok).toBe(false);
    expect(await a.repo.metadataState()).toEqual(before);
    const stored = (await a.repo.load())!;
    const writer = new SessionCommitter(a.repo, stored.identity.repositoryRevision);
    const unsupported = await writer.commit(updateDisplay(stored, f.contentId, { subtitle: '尚未支持同步的副标题' }));
    expect(unsupported).toMatchObject({ ok: false, error: expect.stringContaining('只同步标题') });
    expect(await a.repo.load()).toEqual(stored);
    await a.repo.close();
  });

  it('暂停不发送命令；身份失效不清理 outbox 或本机标题', async () => {
    const f = await fixture(); const a = await f.device();
    await f.edit(a.repo, '待登录');
    await a.repo.saveSyncState({ ...await a.repo.syncState(), paused: true });
    await a.sync.run(); expect(f.calls).toHaveLength(0);
    await a.repo.saveSyncState({ ...await a.repo.syncState(), paused: false });
    const saved = await a.repo.metadataState();
    await expect(new MetadataSync(a.repo, { ...f.api, async submitMetadata() { throw new Error('401'); } }, f.workspaceId).run()).rejects.toThrow('401');
    expect(await a.repo.metadataState()).toEqual(saved);
    expect((await a.repo.load())!.entries[0]!.display.title).toBe('待登录');
    await a.repo.close();
  });

  it('不匹配回执、版本回退、同版本异文和跨工作区快照一律拒绝并保留请求', async () => {
    const f = await fixture(); const a = await f.device();
    await f.edit(a.repo, '待确认');
    const state = await a.repo.metadataState();
    const receipt = await f.api.submitMetadata(state.pending[f.contentId]!.request);
    await expect(a.repo.updateMetadata({ receipt: { ...receipt, commandId: crypto.randomUUID() } })).rejects.toThrow('不一致');
    expect(await a.repo.metadataState()).toEqual(state);
    await a.repo.updateMetadata({ receipt });
    const snapshot = await f.api.metadata();
    await expect(a.repo.updateMetadata({ snapshot: { ...snapshot, entries: [] } })).rejects.toThrow('不完整');
    await expect(a.repo.updateMetadata({ snapshot: { ...snapshot, entries: snapshot.entries.map((e) => e.contentId === f.contentId ? { ...e, version: 0 } : e) } })).rejects.toThrow('回退');
    await expect(a.repo.updateMetadata({ snapshot: { ...snapshot, entries: snapshot.entries.map((e) => e.contentId === f.contentId ? { ...e, value: { ...e.value, title: '篡改' } } : e) } })).rejects.toThrow('正文不同');
    await expect(a.repo.updateMetadata({ snapshot: { ...await f.api.metadata(), workspaceId: crypto.randomUUID() } })).rejects.toThrow('其他工作区');
    await a.repo.close();
  });
});
