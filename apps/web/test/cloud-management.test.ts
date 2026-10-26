import { describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { applyPlayerCommand, adoptRevision, previewRevision, attachVolume, bridge, buildBackup, buildVolume, deriveCloudCopy, restoreContent, trashContent, updateDisplay } from '@endless/content';
import { getScenes } from '@endless/player';
import type { ArchiveCommand, ArchiveReceipt, CloudImportReceipt, LifecycleCommand, LifecycleEntry, LifecycleReceipt, ManagementChange, MetadataCommand, MetadataEntry, MetadataReceipt, RevisionRegistration } from '@endless/cloud-contracts';
import { WorkspaceRepository } from '../src/storage.js';
import { SessionCommitter } from '../src/session-writer.js';
import { cloudDigest, cloudNamespace } from '../src/cloud/local.js';
import { CloudFailure } from '../src/cloud/client.js';
import { ManagementSync } from '../src/cloud/management-sync.js';
import { cloudTestContent as content, cloudTestTime, cloudTestWorkspace } from '../../../packages/content/test/cloud-fixture.js';

const source = cloudTestWorkspace(true);
async function fixture(archived = false) {
  let original = structuredClone(source);
  const contentId = original.entries.find((e) => e.sourceKind === 'generated')!.id;
  if (archived) original = attachVolume(original, buildVolume(original, bridge(content, original), [contentId]));
  const copy = deriveCloudCopy(buildBackup(original), cloudTestTime, content);
  const workspaceId = crypto.randomUUID(), namespace = cloudNamespace(crypto.randomUUID(), crypto.randomUUID(), workspaceId);
  const receipt: CloudImportReceipt = {
    id: crypto.randomUUID(), workspaceId, sourceLocalId: copy.identity.workspaceId, sourceProfileId: copy.profile.id,
    sourceRepositoryRevision: 0, sourceObjectId: crypto.randomUUID(), sourceDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64),
    copyDigest: await cloudDigest(copy), copyCreatedAt: cloudTestTime, validationBinding: 'c'.repeat(64),
    copyPolicy: 'endless-cloud-copy/1', contentIds: copy.entries.map((e) => e.id), revisionIds: copy.revisions.map((e) => e.id), seedContentIds: copy.entries.filter((e) => e.sourceKind === 'bundled').map((e) => e.id),
  };
  const display = new Map<string, MetadataEntry>(copy.entries.map((e) => [e.id, {
    contentId: e.id, version: 0, value: { title: e.display.title, tags: e.display.tags, note: e.display.note }, updatedAt: e.updatedAt,
  }]));
  const life = new Map<string, LifecycleEntry>(copy.entries.map((e) => [e.id, { contentId: e.id, sourceKind: e.sourceKind, version: 0,
    value: { lifecycle: e.lifecycle, trashedAt: e.trashedAt, archiveVolumeId: e.archiveVolumeId }, updatedAt: e.updatedAt }]));
  const changes: ManagementChange[] = [], calls: LifecycleCommand[] = [];
  const receipts = new Map<string, LifecycleReceipt | MetadataReceipt | ArchiveReceipt>();
  let archives = { version: 0, volumes: structuredClone(copy.volumes) };
  const archiveCalls: ArchiveCommand[] = [];
  let loseArchive = false;
  let boots = 0, expire = false, lose = false;
  // Protocol stub only. Database ordering and adjudication are tested with real PG in the API suite.
  const api = {
    async managementBootstrap() {
      boots++;
      return { workspaceId, cursor: String(changes.length), changeSeq: changes.length, display: structuredClone([...display.values()]), lifecycle: structuredClone([...life.values()]), archive: structuredClone(archives), archiveOrigin: structuredClone(copy.volumes) };
    },
    async managementPull(_workspaceId: string, cursor: string) {
      if (expire) { expire = false; throw new CloudFailure('CURSOR_EXPIRED', 409, 'expired'); }
      const start = Number(cursor), page = structuredClone(changes.slice(start, start + 2));
      return { workspaceId, fromCursor: cursor, nextCursor: String(start + page.length), hasMore: start + page.length < changes.length, changes: page };
    },
    async submitMetadata(input: MetadataCommand): Promise<MetadataReceipt> {
      if (receipts.has(input.commandId)) return structuredClone(receipts.get(input.commandId) as MetadataReceipt);
      let entry = display.get(input.contentId)!;
      const outcome = entry.version === input.baseVersion ? 'applied' : 'conflict';
      if (outcome === 'applied') {
        entry = { ...entry, version: entry.version + 1, value: input.value, updatedAt: '2026-10-26T10:00:00.000Z' };
        display.set(entry.contentId, entry); changes.push({ seq: changes.length + 1, type: 'display', entry: structuredClone(entry) });
      }
      const result: MetadataReceipt = { workspaceId, commandId: input.commandId, outcome, entry: structuredClone(entry) };
      receipts.set(input.commandId, result); return structuredClone(result);
    },
    async submitLifecycle(input: LifecycleCommand): Promise<LifecycleReceipt> {
      calls.push(structuredClone(input));
      if (receipts.has(input.commandId)) return structuredClone(receipts.get(input.commandId) as LifecycleReceipt);
      let entry = life.get(input.contentId)!;
      const outcome = entry.version === input.baseVersion ? 'applied' : 'conflict';
      if (outcome === 'applied') {
        entry = { ...entry, version: entry.version + 1, updatedAt: '2026-10-26T10:00:00.000Z', value: input.type === 'trash'
          ? { lifecycle: 'trashed', trashedAt: '2026-10-26T10:00:00.000Z', archiveVolumeId: null }
          : { lifecycle: 'active', trashedAt: null, archiveVolumeId: archives.volumes.find((v) => v.members.some((m) => m.contentId === input.contentId))?.id ?? null } };
        life.set(entry.contentId, entry); changes.push({ seq: changes.length + 1, type: 'lifecycle', entry: structuredClone(entry) });
      }
      const result: LifecycleReceipt = { workspaceId, commandId: input.commandId, outcome, entry: structuredClone(entry) };
      receipts.set(input.commandId, result);
      if (lose) { lose = false; throw new Error('lost response'); }
      return structuredClone(result);
    },
    async submitArchive(input: ArchiveCommand): Promise<ArchiveReceipt> {
      archiveCalls.push(structuredClone(input));
      if (receipts.has(input.commandId)) return structuredClone(receipts.get(input.commandId) as ArchiveReceipt);
      const outcome = input.baseVersion === archives.version && input.members.every((m) => life.get(m.contentId)!.version === m.lifecycleVersion
        && display.get(m.contentId)!.version === m.displayVersion) ? 'applied' : 'conflict';
      if (outcome === 'applied') {
        const workspace = { ...copy, entries: copy.entries.map((e) => ({ ...e, display: { ...e.display, ...display.get(e.id)!.value } })) };
        if (input.type === 'archive') {
          const volume = buildVolume(workspace, bridge(content, workspace), input.members.map((m) => m.contentId), input.title);
          archives = { version: archives.version + 1, volumes: [...archives.volumes, { ...volume, id: input.volumeId }] };
        } else archives = { version: archives.version + 1, volumes: archives.volumes.filter((v) => v.id !== input.volumeId) };
        for (const member of input.members) {
          const entry = life.get(member.contentId)!;
          life.set(member.contentId, { ...entry, version: entry.version + 1, updatedAt: '2026-10-26T10:10:00.000Z', value: { ...entry.value,
            archiveVolumeId: entry.value.lifecycle === 'active' ? archives.volumes.find((v) => v.members.some((m) => m.contentId === entry.contentId))?.id ?? null : null } });
        }
        changes.push({ seq: changes.length + 1, type: 'archive', snapshot: { state: structuredClone(archives), lifecycle: structuredClone([...life.values()]) } });
      }
      const result: ArchiveReceipt = { workspaceId, commandId: input.commandId, outcome,
        ...(outcome === 'conflict' ? { reason: 'precondition' as const } : {}),
        snapshot: { state: structuredClone(archives), lifecycle: structuredClone([...life.values()]) }, display: structuredClone(input.members.map((m) => display.get(m.contentId)!)) };
      receipts.set(input.commandId, result);
      if (loseArchive) { loseArchive = false; throw new Error('archive response lost'); }
      return structuredClone(result);
    },
  };
  const device = async () => {
    const factory = new IDBFactory(), repo = new WorkspaceRepository(factory, namespace);
    await repo.installCloudCopy(copy, receipt, crypto.randomUUID());
    return { repo, factory, sync: new ManagementSync(repo, api, workspaceId, content) };
  };
  const edit = async (repo: WorkspaceRepository, type: 'trash' | 'restore' | 'display') => {
    const ws = (await repo.load())!;
    const next = type === 'trash' ? trashContent(ws, contentId) : type === 'restore' ? restoreContent(ws, contentId)
      : updateDisplay(ws, contentId, { title: '共同管理流标题' });
    return new SessionCommitter(repo, ws.identity.repositoryRevision).commit(next);
  };
  const choose = async (repo: WorkspaceRepository, decision: 'local' | 'cloud') => {
    const s = await repo.lifecycleState();
    return repo.updateManagement({ contentId, decision, commandId: s.pending[contentId]!.request.commandId, version: s.known[contentId]!.version });
  };
  return { copy, contentId, workspaceId, namespace, api, calls, changes, display, life, device, edit, choose,
    archiveCalls, loseArchive: () => { loseArchive = true; },
    boots: () => boots, expire: () => { expire = true; }, lose: () => { lose = true; } };
}

describe('归档请求、确定性接收与恢复', () => {
  it('修订尚未接收时拒绝整页和引导，不推进游标、不覆盖本机历史与待提交命令', async () => {
    const f = await fixture(), device = await f.device(); await device.sync.run();
    await f.edit(device.repo, 'display');
    const entry = f.copy.entries.find((e) => e.id === f.contentId)!;
    const old = f.copy.revisions.find((r) => r.id === entry.headRevisionId)!;
    if (old.origin === 'bundled') throw new Error('fixture');
    const at = new Date('2026-10-26T11:00:00.000Z');
    const preview = previewRevision(content, f.copy, entry, old.draft.replace('Cloud fixture', 'New revision'), at);
    if (!preview.ok || !preview.revision) throw new Error('fixture');
    const candidate = adoptRevision(content, f.copy, entry, preview.revision, at).workspace;
    const branch = candidate.branches[0]!;
    const binding = { sourceDigest: '0'.repeat(64), inventoryDigest: '1'.repeat(64), streamId: branch.id, baseRevisionId: old.id,
      eventCount: branch.session.events.length, lastEventId: crypto.randomUUID(), displayVersion: 0, lifecycleVersion: 0, archiveVersion: 0 };
    const artifactBase = { compiler: 'cloud-revision-preview/1' as const, mode: 'in-place' as const, binding,
      revision: preview.revision, revisionDigest: await cloudDigest(preview.revision), branch: { streamId: branch.id, label: branch.label,
        parentBranchId: branch.parentBranchId, forkAtEventCount: branch.forkAtEventCount, adopted: branch.adopted,
        catalog: branch.session.catalog, createdAt: branch.createdAt, commonStreamId: null, commonPrefixSeq: 0 } };
    const registration: RevisionRegistration = { format: 'cloud-revision-registration/1', version: 1, readingChangeSeq: 0,
      commandId: crypto.randomUUID(), previewRequestId: crypto.randomUUID(), artifact: { ...artifactBase, digest: await cloudDigest(artifactBase) },
      entry: { contentId: entry.id, headRevisionId: preview.revision.id, revisionIds: [...entry.revisionIds, preview.revision.id], updatedAt: at.toISOString() },
      obligations: candidate.obligations, display: { ...f.display.get(entry.id)!, version: 1, value: { title: preview.revision.title, tags: [], note: '' } },
      stream: { streamId: branch.id, branchId: branch.id, eventSeq: binding.eventCount, lastEventId: binding.lastEventId } };
    const before = await device.repo.rawSnapshot(), state = await device.repo.lifecycleState();
    await expect(device.repo.updateManagement({ pull: { workspaceId: f.workspaceId, fromCursor: state.cursor!, nextCursor: '1', hasMore: false,
      changes: [{ seq: state.changeSeq + 1, type: 'revision', registration }] } })).rejects.toThrow('尚未完整接收');
    await expect(device.repo.updateManagement({ bootstrap: { ...await f.api.managementBootstrap(),
      revisionCatalog: { workspaceId: f.workspaceId, version: 1, registrations: [registration], digest: await cloudDigest([registration]) } } })).rejects.toThrow('尚未完整接收');
    expect(await device.repo.rawSnapshot()).toEqual(before);
    expect((await device.repo.metadataState()).pending[entry.id]).toBeDefined();
    await device.repo.close();
  });
  it('离线只保存请求，确认前不生成已完成卷；刷新同请求接受后保持原事件与义务', async () => {
    const f = await fixture(), a = await f.device(); await a.sync.run();
    await a.repo.queueArchive(content, { type: 'archive', memberContentIds: f.copy.entries.map((e) => e.id), title: '真实阅读归档' });
    expect((await a.repo.load())!.volumes).toEqual([]);
    const pending = (await a.repo.archiveState()).pending!;
    expect(pending.request.type).toBe('archive'); expect(f.archiveCalls).toHaveLength(0);
    await a.repo.close(); const repo = new WorkspaceRepository(a.factory, f.namespace);
    expect((await repo.archiveState()).pending).toEqual(pending);
    await new ManagementSync(repo, f.api, f.workspaceId, content).run();
    const ws = (await repo.load())!;
    expect(ws.volumes).toHaveLength(1); expect(ws.volumes[0]!.quotes.length).toBeGreaterThan(0);
    expect(ws.volumes[0]!.quotes.some((q) => q.contentId === f.contentId)).toBe(false);
    expect(ws.branches).toEqual(f.copy.branches); expect(ws.obligations).toEqual(f.copy.obligations);
    expect(ws.management.filter((m) => m.op === 'archive')).toHaveLength(1);
    expect((await repo.archiveState()).pending).toBeNull(); await repo.close();
  });

  it('请求落库失败不改 CAS 或业务状态，不发请求', async () => {
    const f = await fixture(), a = await f.device(), before = await a.repo.load();
    const put = IDBObjectStore.prototype.put, spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
      if (this.name === 'sync' && args[1] === 'archives') throw new DOMException('synthetic', 'QuotaExceededError');
      return put.apply(this, args);
    });
    try { await expect(a.repo.queueArchive(content, { type: 'archive', memberContentIds: [f.contentId], title: '未提交' })).rejects.toThrow(); } finally { spy.mockRestore(); }
    expect(await a.repo.load()).toEqual(before); expect((await a.repo.archiveState()).pending).toBeNull(); expect(f.archiveCalls).toHaveLength(0);
    await a.repo.close();
  });

  it('服务端已接受但丢响应，刷新恢复同 ID；卷落库失败原请求继续保留', async () => {
    const f = await fixture(), a = await f.device();
    await a.repo.queueArchive(content, { type: 'archive', memberContentIds: [f.contentId], title: '只归档一次' });
    const saved = (await a.repo.archiveState()).pending;
    f.loseArchive(); await expect(a.sync.run()).rejects.toThrow('archive response lost');
    expect((await a.repo.load())!.volumes).toEqual([]); expect((await a.repo.archiveState()).pending).toEqual(saved);
    await a.repo.close(); const repo = new WorkspaceRepository(a.factory, f.namespace), sync = new ManagementSync(repo, f.api, f.workspaceId, content);
    const before = await repo.load(), put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
      if (this.name === 'objects' && (args[0] as any).kind === 'volume') throw new DOMException('synthetic', 'QuotaExceededError');
      return put.apply(this, args);
    });
    try { await expect(sync.run()).rejects.toThrow(); } finally { spy.mockRestore(); }
    expect(await repo.load()).toEqual(before); expect((await repo.archiveState()).pending).toEqual(saved);
    await sync.run(); expect((await repo.load())!.volumes).toHaveLength(1);
    expect(f.archiveCalls).toHaveLength(3); for (const call of f.archiveCalls) expect(call).toEqual(f.archiveCalls[0]);
    await repo.close();
  });

  it('并发归档保留原候选，旧选择拒绝；显式重提使用新请求并沿用原阅读前缀', async () => {
    const f = await fixture(), a = await f.device(), b = await f.device(); await a.sync.run(); await b.sync.run();
    await a.repo.queueArchive(content, { type: 'archive', memberContentIds: [f.copy.entries[0]!.id], title: 'A卷' });
    await b.repo.queueArchive(content, { type: 'archive', memberContentIds: [f.copy.entries[1]!.id], title: 'B卷' });
    await a.sync.run(); await b.sync.run();
    const state = await b.repo.archiveState(), request = state.pending!.request;
    expect(state.pending!.resolution?.outcome).toBe('conflict'); expect((await b.repo.load())!.volumes).toHaveLength(1);
    await expect(b.repo.updateManagement({ archiveDecision: 'retry', commandId: request.commandId, version: 0 }, content)).rejects.toThrow('已变化');
    await b.repo.updateManagement({ archiveDecision: 'retry', commandId: request.commandId, version: state.known!.version }, content);
    const replacement = (await b.repo.archiveState()).pending!.request;
    expect(replacement.commandId).not.toBe(request.commandId);
    if (replacement.type === 'archive' && request.type === 'archive') expect(replacement.basis).toEqual(request.basis);
    await b.sync.run(); await a.sync.run();
    expect((await a.repo.load())!.volumes).toHaveLength(2);
    expect((await b.repo.rawSnapshot() as any).staging.some((e: any) => e.request?.commandId === request.commandId)).toBe(true);
    await Promise.all([a.repo.close(), b.repo.close()]);
  });

  it('伪造未读来源即使外层成员/版本匹配也不接受，原请求与原件保留', async () => {
    const f = await fixture(), a = await f.device();
    await a.repo.queueArchive(content, { type: 'archive', memberContentIds: [f.contentId], title: '未读卷' });
    const before = await a.repo.load(), state = await a.repo.archiveState();
    const forged = { ...f.api, async submitArchive(input: ArchiveCommand) {
      const result = await f.api.submitArchive(input), volume = result.snapshot.state.volumes[0] as typeof f.copy.volumes[number];
      volume.quotes.push({ contentId: f.contentId, revisionId: input.members[0]!.revisionId, sceneId: 's1', path: 'panels[0].caption', text: 'This was never read.' });
      return result;
    } };
    await expect(new ManagementSync(a.repo, forged, f.workspaceId, content).run()).rejects.toThrow();
    expect(await a.repo.load()).toEqual(before); expect(await a.repo.archiveState()).toEqual(state);
    await a.sync.run(); expect((await a.repo.load())!.volumes[0]!.quotes).toEqual([]); await a.repo.close();
  });

  it('归档页应用遇到配额时卷、成员与游标一起回滚，再拉同页一次应用', async () => {
    const f = await fixture(), a = await f.device(), b = await f.device(); await a.sync.run(); await b.sync.run();
    await a.repo.queueArchive(content, { type: 'archive', memberContentIds: [f.contentId], title: '整页归档' }); await a.sync.run();
    const before = await b.repo.load(), position = await b.repo.lifecycleState(), put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
      if (this.name === 'sync' && args[1] === 'archives') throw new DOMException('synthetic', 'QuotaExceededError');
      return put.apply(this, args);
    });
    try { await expect(b.sync.run()).rejects.toThrow(); } finally { spy.mockRestore(); }
    expect(await b.repo.load()).toEqual(before); expect(await b.repo.lifecycleState()).toEqual(position);
    await b.sync.run(); expect((await b.repo.load())!.volumes).toHaveLength(1); expect((await b.repo.lifecycleState()).changeSeq).toBe(1);
    await Promise.all([a.repo.close(), b.repo.close()]);
  });

  it('取消归档与本机未决恢复竞争，不保留悬空归档指针或丢掉原恢复请求', async () => {
    const f = await fixture(), a = await f.device(), b = await f.device();
    await a.repo.queueArchive(content, { type: 'archive', memberContentIds: [f.contentId], title: '竞争归档' }); await a.sync.run(); await b.sync.run();
    await f.edit(a.repo, 'trash'); await a.sync.run(); await b.sync.run(); await f.edit(b.repo, 'restore');
    await a.repo.queueArchive(content, { type: 'unarchive', volumeId: (await a.repo.load())!.volumes[0]!.id }); await a.sync.run(); await b.sync.run();
    expect((await b.repo.lifecycleState()).pending[f.contentId]!.conflict).toBeDefined();
    expect((await b.repo.load())!.volumes).toEqual([]);
    expect((await b.repo.load())!.entries.find((e) => e.id === f.contentId)!.archiveVolumeId).toBeNull();
    await f.choose(b.repo, 'local'); await b.sync.run(); await a.sync.run();
    expect((await a.repo.load())!.entries.find((e) => e.id === f.contentId)!.lifecycle).toBe('active');
    expect((await a.repo.load())!.volumes).toEqual([]);
    expect((await a.repo.load())!.branches).toEqual(f.copy.branches);
    await Promise.all([a.repo.close(), b.repo.close()]);
  });

  it('旧副本按原始基线升级；未知归档状态不重置，未决归档不夹带成员回收', async () => {
    const legacy = await fixture(), old = await legacy.device(), other = await legacy.device(); await old.sync.run();
    const oldDb = await new Promise<IDBDatabase>((resolve) => { const r = old.factory.open(legacy.namespace, 2); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>((resolve) => { const tx = oldDb.transaction('sync', 'readwrite'); tx.objectStore('sync').delete('archives'); tx.oncomplete = () => resolve(); }); oldDb.close();
    await other.repo.queueArchive(content, { type: 'archive', memberContentIds: [legacy.contentId], title: '升级后领取' }); await other.sync.run();
    const badBootstrap = { ...legacy.api, async managementBootstrap() {
      const boot = await legacy.api.managementBootstrap();
      boot.archive.volumes[0]!.quotes.push({ contentId: legacy.contentId, revisionId: legacy.copy.entries.find((e) => e.id === legacy.contentId)!.headRevisionId,
        sceneId: 's1', path: 'panels[0].caption', text: 'Not a read source.' });
      return boot;
    } };
    await expect(new ManagementSync(old.repo, badBootstrap, legacy.workspaceId, content).run()).rejects.toThrow();
    expect((await old.repo.load())!.volumes).toEqual([]);
    await old.sync.run(); expect((await old.repo.load())!.volumes).toHaveLength(1); expect((await old.repo.load())!.branches).toEqual(legacy.copy.branches);
    await Promise.all([old.repo.close(), other.repo.close()]);
    const f = await fixture(), a = await f.device(); await a.repo.queueArchive(content, { type: 'archive', memberContentIds: [f.contentId], title: '成员冻结' });
    expect((await f.edit(a.repo, 'trash')).ok).toBe(false);
    const db = await new Promise<IDBDatabase>((resolve) => { const r = a.factory.open(f.namespace, 2); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>((resolve) => { const tx = db.transaction('sync', 'readwrite'); tx.objectStore('sync').put({ format: 'archive-outbox/999', preserved: 'yes' }, 'archives'); tx.oncomplete = () => resolve(); });
    db.close(); const before = await a.repo.load();
    await expect(a.repo.archiveState()).rejects.toThrow('不受支持'); expect((await f.edit(a.repo, 'trash')).ok).toBe(false);
    expect(await a.repo.load()).toEqual(before);
    expect((await a.repo.rawSnapshot() as any).sync.find((e: any) => e.key === 'archives').value.preserved).toBe('yes'); await a.repo.close();
  });
});

describe('增量管理同步：真实 IndexedDB 事务与协议恢复', () => {
  it('首次快照后只增量读；展示与回收/恢复共用游标，两设备一致且没有学习事件回声', async () => {
    const f = await fixture(), a = await f.device(), b = await f.device();
    await a.sync.run(); await b.sync.run(); expect(f.boots()).toBe(2);
    await f.edit(a.repo, 'display'); await f.edit(a.repo, 'trash'); await a.sync.run();
    await f.edit(a.repo, 'restore'); await a.sync.run(); await b.sync.run();
    expect(f.boots()).toBe(2); expect((await b.repo.lifecycleState()).changeSeq).toBe(3);
    expect((await b.repo.load())!.entries.find((e) => e.id === f.contentId)).toMatchObject({ lifecycle: 'active', display: { title: '共同管理流标题' } });
    expect((await b.repo.load())!.branches).toEqual(f.copy.branches);
    expect((await b.repo.load())!.obligations).toEqual(f.copy.obligations);
    expect(await b.repo.pendingOutbox()).toEqual([]);
    await Promise.all([a.repo.close(), b.repo.close()]);
  });

  it('回收业务与命令同事务，命令写失败整批回滚', async () => {
    const f = await fixture(), a = await f.device(), before = await a.repo.load();
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
      if (this.name === 'sync' && args[1] === 'lifecycle') throw new DOMException('synthetic quota', 'QuotaExceededError');
      return put.apply(this, args);
    });
    try { expect((await f.edit(a.repo, 'trash')).ok).toBe(false); } finally { spy.mockRestore(); }
    expect(await a.repo.load()).toEqual(before); expect((await a.repo.lifecycleState()).pending).toEqual({});
    expect(f.calls).toHaveLength(0); await a.repo.close();
  });

  it('服务端成功但丢响应，刷新重用原回收命令，回执保存失败也不换身份', async () => {
    const f = await fixture(), a = await f.device();
    await a.sync.run(); await f.edit(a.repo, 'trash'); const pending = await a.repo.lifecycleState();
    f.lose(); await expect(a.sync.run()).rejects.toThrow('lost response');
    expect(await a.repo.lifecycleState()).toEqual(pending); await a.repo.close();
    const repo = new WorkspaceRepository(a.factory, f.namespace), sync = new ManagementSync(repo, f.api, f.workspaceId);
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
      if (this.name === 'sync' && args[1] === 'lifecycle') throw new DOMException('synthetic', 'QuotaExceededError');
      return put.apply(this, args);
    });
    try { await expect(sync.run()).rejects.toThrow(); } finally { spy.mockRestore(); }
    expect(await repo.lifecycleState()).toEqual(pending); await sync.run();
    expect(f.calls).toHaveLength(3); for (const call of f.calls) expect(call).toEqual(f.calls[0]);
    expect(f.life.get(f.contentId)!.version).toBe(1); await repo.close();
  });

  it('并发冲突明确保留候选；过期选择拒绝，新命令重新检查版本', async () => {
    const f = await fixture(), a = await f.device(), b = await f.device();
    await a.sync.run(); await b.sync.run();
    await f.edit(a.repo, 'trash'); await f.edit(b.repo, 'trash');
    await a.sync.run(); await b.sync.run();
    const pending = (await b.repo.lifecycleState()).pending[f.contentId]!;
    expect(pending.conflict?.outcome).toBe('conflict');
    await expect(b.repo.updateManagement({ contentId: f.contentId, decision: 'cloud', commandId: pending.request.commandId, version: 0 })).rejects.toThrow('已变化');
    await f.choose(b.repo, 'local');
    const replacement = (await b.repo.lifecycleState()).pending[f.contentId]!.request;
    expect(replacement.commandId).not.toBe(pending.request.commandId);
    await f.edit(a.repo, 'restore'); await a.sync.run(); await b.sync.run();
    expect((await b.repo.lifecycleState()).pending[f.contentId]!.conflict).toBeDefined();
    await f.choose(b.repo, 'cloud');
    expect((await b.repo.load())!.entries.find((e) => e.id === f.contentId)!.lifecycle).toBe('active');
    expect((await b.repo.rawSnapshot() as any).staging.some((e: any) => e.request?.commandId === replacement.commandId)).toBe(true);
    await Promise.all([a.repo.close(), b.repo.close()]);
  });

  it('管理游标过期只重新合并管理字段，保留冲突、本机真实事件和义务', async () => {
    const f = await fixture(), a = await f.device(), b = await f.device();
    await a.sync.run(); await b.sync.run();
    await f.edit(a.repo, 'trash'); await a.sync.run();
    const ws = (await b.repo.load())!, episode = bridge(content, ws).library.episodes.at(-1)!;
    const selected = applyPlayerCommand(content, ws, { type: 'select', episode: episode.id });
    const progressed = applyPlayerCommand(content, selected, { type: 'advance', scene: getScenes(episode)[0]!.id, skip: false });
    expect((await new SessionCommitter(b.repo, ws.identity.repositoryRevision).commit(progressed)).ok).toBe(true);
    await f.edit(b.repo, 'trash'); f.expire(); await b.sync.run();
    expect((await b.repo.lifecycleState()).pending[f.contentId]!.conflict).toBeDefined();
    expect((await b.repo.load())!.branches).toEqual(progressed.branches);
    expect((await b.repo.load())!.obligations).toEqual(progressed.obligations);
    expect((await b.repo.pendingOutbox()).length).toBeGreaterThan(0);
    expect(f.boots()).toBe(3); await Promise.all([a.repo.close(), b.repo.close()]);
  });

  it('管理页落库失败，展示/生命周期/游标一起回滚；重拉同页后一次应用', async () => {
    const f = await fixture(), a = await f.device(), b = await f.device();
    await a.sync.run(); await b.sync.run();
    const before = await b.repo.load(), state = await b.repo.lifecycleState();
    await f.edit(a.repo, 'display'); await f.edit(a.repo, 'trash'); await a.sync.run();
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
      if (this.name === 'sync' && args[1] === 'lifecycle') throw new DOMException('synthetic', 'QuotaExceededError');
      return put.apply(this, args);
    });
    try { await expect(b.sync.run()).rejects.toThrow(); } finally { spy.mockRestore(); }
    expect(await b.repo.load()).toEqual(before); expect(await b.repo.lifecycleState()).toEqual(state);
    await b.sync.run(); expect((await b.repo.lifecycleState()).changeSeq).toBe(2);
    expect((await b.repo.load())!.entries.find((e) => e.id === f.contentId)!.lifecycle).toBe('trashed');
    await Promise.all([a.repo.close(), b.repo.close()]);
  });

  it('回收后恢复已归档内容保持原引用闭包；不移除原卷或阅读义务', async () => {
    const f = await fixture(true), a = await f.device(), b = await f.device();
    await a.sync.run(); await b.sync.run(); await f.edit(a.repo, 'trash'); await a.sync.run(); await b.sync.run();
    expect((await b.repo.load())!.entries.find((e) => e.id === f.contentId)!.archiveVolumeId).toBeNull();
    await f.edit(b.repo, 'restore'); await b.sync.run(); await a.sync.run();
    const ws = (await a.repo.load())!;
    expect(ws.entries.find((e) => e.id === f.contentId)!.archiveVolumeId).toBe(f.copy.volumes[0]!.id);
    expect(ws.volumes).toEqual(f.copy.volumes); expect(ws.obligations).toEqual(f.copy.obligations);
    await Promise.all([a.repo.close(), b.repo.close()]);
  });

  it('不连续页、跨工作区响应和未知生命周期格式拒绝且不重置', async () => {
    const f = await fixture(), a = await f.device(); await a.sync.run();
    const before = await a.repo.lifecycleState();
    await expect(a.repo.updateManagement({ pull: { workspaceId: f.workspaceId, fromCursor: before.cursor!, nextCursor: 'bad', hasMore: false,
      changes: [{ type: 'lifecycle', seq: 99, entry: f.life.get(f.contentId)! }] } })).rejects.toThrow('不连续');
    await expect(a.repo.updateManagement({ bootstrap: { ...await f.api.managementBootstrap(), workspaceId: crypto.randomUUID() } })).rejects.toThrow('其他工作区');
    expect(await a.repo.lifecycleState()).toEqual(before);
    const db = await new Promise<IDBDatabase>((resolve) => { const request = a.factory.open(f.namespace, 2); request.onsuccess = () => resolve(request.result); });
    await new Promise<void>((resolve) => { const tx = db.transaction('sync', 'readwrite'); tx.objectStore('sync').put({ format: 'lifecycle-outbox/999' }, 'lifecycle'); tx.oncomplete = () => resolve(); });
    db.close(); await expect(a.repo.lifecycleState()).rejects.toThrow('不受支持');
    expect((await f.edit(a.repo, 'trash')).ok).toBe(false);
    expect((await a.repo.rawSnapshot() as any).sync.find((e: any) => e.key === 'lifecycle').value.format).toBe('lifecycle-outbox/999');
    await a.repo.close();
  });
});
