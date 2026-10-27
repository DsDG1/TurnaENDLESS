import { describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { adoptRevision, applyPlayerCommand, bridge, buildBackup, previewRevision, updateDisplay, type ContentRevision, type Workspace } from '@endless/content';
import { deriveCloudCopy } from '@endless/content/cloud';
import { getScenes } from '@endless/player';
import type { CloudImportReceipt, RevisionAdoptionCommand, RevisionAdoptionReceipt, RevisionCatalog,
  RevisionPreviewReceipt, RevisionPreviewRequest, RevisionRegistration, SyncChange } from '@endless/cloud-contracts';
import { CloudWorkspaceRepository as WorkspaceRepository } from '../src/cloud/repository.js';
import { WorkspaceRepository as GuestWorkspaceRepository } from '../src/storage.js';
import { SessionCommitter } from '../src/session-writer.js';
import { RevisionSync } from '../src/cloud/revisions.js';
import { WorkspaceSync } from '../src/cloud/sync.js';
import { cloudDigest, cloudNamespace } from '../src/cloud/local.js';
import { CloudFailure } from '../src/cloud/client.js';
import { commandOfEvent, sidecarKey } from '../src/cloud/outbox.js';
import { cloudTestContent as content, cloudTestTime, cloudTestWorkspace } from '../../../packages/content/test/cloud-fixture.js';

const at = new Date('2026-10-27T08:00:00.000Z');
const source = cloudTestWorkspace(true);
function readGenerated(ws: Workspace) {
  const revision = ws.revisions.find((r) => r.origin !== 'bundled')! as ContentRevision;
  const selected = applyPlayerCommand(content, ws, { type: 'select', episode: revision.episodeId }, at);
  return applyPlayerCommand(content, selected, { type: 'advance', scene: getScenes(bridge(content, selected).library.episodes.at(-1)!)[0]!.id, skip: false }, at);
}

/** A protocol fixture; real PostgreSQL tests own server adjudication and concurrency. */
async function fixture(read = false) {
  const copy = deriveCloudCopy(buildBackup(read ? readGenerated(structuredClone(source)) : source), cloudTestTime, content);
  const entry = copy.entries.find((e) => e.sourceKind === 'generated')!;
  const old = copy.revisions.find((r) => r.id === entry.headRevisionId)! as ContentRevision;
  const workspaceId = crypto.randomUUID(), deviceId = crypto.randomUUID();
  const namespace = cloudNamespace(crypto.randomUUID(), crypto.randomUUID(), workspaceId);
  const eventIds = copy.branches[0]!.session.events.map(() => crypto.randomUUID());
  const previews = new Map<string, RevisionPreviewReceipt>(), receipts = new Map<string, RevisionAdoptionReceipt>();
  const previewCalls: RevisionPreviewRequest[] = [], adoptCalls: RevisionAdoptionCommand[] = [];
  const registrations: RevisionRegistration[] = [];
  let losePreview = false, loseAdopt = false, conflict = false;
  const receipt: CloudImportReceipt = { id: crypto.randomUUID(), workspaceId, sourceLocalId: copy.identity.workspaceId,
    sourceProfileId: copy.profile.id, sourceRepositoryRevision: 0, sourceObjectId: crypto.randomUUID(), sourceDigest: 'a'.repeat(64),
    snapshotDigest: 'b'.repeat(64), copyDigest: await cloudDigest(copy), copyCreatedAt: cloudTestTime, validationBinding: 'c'.repeat(64),
    copyPolicy: 'endless-cloud-copy/1', contentIds: copy.entries.map((e) => e.id), revisionIds: copy.revisions.map((r) => r.id),
    seedContentIds: copy.entries.filter((e) => e.sourceKind === 'bundled').map((e) => e.id) };
  const display = copy.entries.map((e) => ({ contentId: e.id, version: 0,
    value: { title: e.display.title, tags: e.display.tags, note: e.display.note }, updatedAt: e.updatedAt }));
  async function preview(request: RevisionPreviewRequest, baseline = copy): Promise<Extract<RevisionPreviewReceipt, { outcome: 'ready' }>> {
    const p = previewRevision(content, baseline, entry, request.draft, at);
    if (!p.ok || !p.revision) throw new Error('fixture compilation');
    const candidate = adoptRevision(content, baseline, entry, p.revision, at, `brn_${crypto.randomUUID()}`);
    const branch = candidate.workspace.branches.find((b) => b.id === candidate.workspace.activeBranchId)!;
    const artifact = { compiler: 'cloud-revision-preview/1' as const, mode: candidate.mode,
      binding: { sourceDigest: await cloudDigest(copy), inventoryDigest: 'd'.repeat(64), streamId: request.streamId,
        baseRevisionId: request.baseRevisionId, eventCount: request.baseSeq, lastEventId: request.baseEventId,
        displayVersion: request.displayVersion, lifecycleVersion: request.lifecycleVersion, archiveVersion: request.archiveVersion },
      revision: p.revision, revisionDigest: await cloudDigest(p.revision),
      branch: { streamId: branch.id, label: branch.label, parentBranchId: branch.parentBranchId, forkAtEventCount: branch.forkAtEventCount,
        adopted: branch.adopted, catalog: branch.session.catalog, createdAt: branch.createdAt,
        commonStreamId: branch.parentBranchId, commonPrefixSeq: branch.forkAtEventCount ?? 0 } };
    return { workspaceId, requestId: request.requestId, outcome: 'ready', adoptionAvailable: false,
      artifact: { ...artifact, digest: await cloudDigest(artifact) } };
  }
  async function registration(p: Extract<RevisionPreviewReceipt, { outcome: 'ready' }>, commandId: string = crypto.randomUUID(), baseline = copy, barrier = 0) {
    const revision = p.artifact.revision as ContentRevision;
    const next = adoptRevision(content, baseline, entry, revision, at, p.artifact.branch.streamId).workspace;
    const e = next.entries.find((e) => e.id === entry.id)!;
    const count = p.artifact.mode === 'fork' ? p.artifact.branch.commonPrefixSeq : p.artifact.binding.eventCount;
    return { format: 'cloud-revision-registration/1' as const, version: registrations.length + 1, readingChangeSeq: barrier,
      commandId, previewRequestId: p.requestId, artifact: p.artifact,
      entry: { contentId: e.id, revisionIds: e.revisionIds, headRevisionId: e.headRevisionId, updatedAt: e.updatedAt },
      obligations: next.obligations, display: { contentId: e.id, version: p.artifact.binding.displayVersion + 1,
        value: { title: revision.title, tags: [], note: '' }, updatedAt: at.toISOString() },
      prefixEventIds: p.artifact.mode === 'fork' ? eventIds.slice(0, count) : [],
      stream: { streamId: p.artifact.branch.streamId, branchId: p.artifact.branch.streamId, eventSeq: count,
        lastEventId: count ? eventIds[count - 1]! : null } } satisfies RevisionRegistration;
  }
  const api = {
    async revisionCatalog(): Promise<RevisionCatalog> { return { workspaceId, version: registrations.length,
      registrations: structuredClone(registrations), digest: await cloudDigest(registrations) }; },
    async revisionPreview(request: RevisionPreviewRequest) {
      previewCalls.push(structuredClone(request));
      if (!previews.has(request.requestId)) previews.set(request.requestId, await preview(request));
      if (losePreview) { losePreview = false; throw new Error('preview response lost'); }
      return structuredClone(previews.get(request.requestId)!);
    },
    async revisionAdopt(command: RevisionAdoptionCommand) {
      adoptCalls.push(structuredClone(command));
      if (!receipts.has(command.commandId)) {
        const p = previews.get(command.previewRequestId)!;
        if (p.outcome !== 'ready') throw new Error('fixture');
        const r = await registration(p, command.commandId);
        if (!conflict) registrations.push(r);
        receipts.set(command.commandId, conflict ? { workspaceId, commandId: command.commandId, outcome: 'conflict', reason: 'precondition' }
          : { workspaceId, commandId: command.commandId, outcome: 'applied', registration: r });
      }
      if (loseAdopt) { loseAdopt = false; throw new Error('adoption response lost'); }
      return structuredClone(receipts.get(command.commandId)!);
    },
  };
  async function device(factory = new IDBFactory()) {
    const repo = new WorkspaceRepository(factory, namespace);
    if (!(await repo.load())) {
      await repo.installCloudCopy(copy, receipt, deviceId);
      await repo.saveSyncState({ ...await repo.syncState(), cursor: '0', streams: { [copy.activeBranchId]: {
        seq: eventIds.length, eventId: eventIds.at(-1) ?? null } } });
      await repo.updateManagement({ bootstrap: { workspaceId, cursor: '0', changeSeq: 0, display,
        lifecycle: copy.entries.map((e) => ({ contentId: e.id, sourceKind: e.sourceKind, version: 0, updatedAt: e.updatedAt,
          value: { lifecycle: e.lifecycle, trashedAt: e.trashedAt, archiveVolumeId: e.archiveVolumeId } })),
        archive: { version: 0, volumes: [] }, archiveOrigin: [] } }, content);
    }
    return { repo, factory, sync: new RevisionSync(repo, api, content, workspaceId) };
  }
  const queue = (repo: WorkspaceRepository) => repo.revisionAction(content, { queue: { contentId: entry.id,
    draft: old.draft.replace('Cloud fixture', 'Revised clue') } });
  async function confirm(repo: WorkspaceRepository) {
    const held = (await repo.revisionState()).pending!;
    if (held.preview?.outcome !== 'ready') throw new Error('fixture');
    await repo.revisionAction(content, { confirm: { requestId: held.request.requestId, digest: held.preview.artifact.digest } });
  }
  return { copy, entry, old, namespace, workspaceId, deviceId, eventIds, api, device, queue, confirm, preview, registration,
    registrations, previewCalls, adoptCalls, conflict: () => { conflict = true; },
    losePreview: () => { losePreview = true; }, loseAdopt: () => { loseAdopt = true; } };
}

describe('云端修订：持久预览、显式采用与原子接收', () => {
  it('预览只保存候选，显式确认后原位采用；重复登记不重复管理记录', async () => {
    const f = await fixture(), a = await f.device(), before = (await a.repo.load())!;
    await f.queue(a.repo);
    expect(f.previewCalls).toHaveLength(0);
    await a.sync.resume();
    expect((await a.repo.revisionState()).pending?.preview?.adoptionAvailable).toBe(false);
    expect((await a.repo.load())!.revisions).toEqual(before.revisions);
    expect(f.adoptCalls).toHaveLength(0);
    await f.confirm(a.repo); await a.sync.resume();
    expect((await a.repo.load())!.revisions).toEqual(before.revisions);
    await a.sync.prepare(); await a.sync.through(0);
    const ws = (await a.repo.load())!;
    expect(ws.revisions).toHaveLength(before.revisions.length + 1);
    expect(ws.branches).toHaveLength(1); expect(ws.branches[0]!.session).toEqual(before.branches[0]!.session);
    expect(ws.entries.find((e) => e.id === f.entry.id)!.display.title).toBe('Revised clue');
    expect(ws.obligations.find((o) => o.contentId === f.entry.id)!.revisionId).toBe(f.registrations[0]!.entry.headRevisionId);
    expect((await a.repo.revisionState()).pending).toBeNull(); expect(await a.repo.pendingOutbox()).toEqual([]);
    const raw = await a.repo.rawSnapshot(); await a.sync.through(0); expect(await a.repo.rawSnapshot()).toEqual(raw);
    expect((await new SessionCommitter(a.repo, ws.identity.repositoryRevision).commit(readGenerated(ws))).ok).toBe(true);
    expect((await a.repo.pendingOutbox()).map((e) => e.event.revisionId)).toEqual([f.registrations[0]!.entry.headRevisionId]);
    await a.repo.close();
  });

  it('已读内容建立稳定分支，只共享生成边界前身份；另一设备接收保留其当前分支', async () => {
    const f = await fixture(true), a = await f.device(), b = await f.device();
    await f.queue(a.repo); await a.sync.resume(); await f.confirm(a.repo); await a.sync.resume();
    for (const d of [a, b]) { await d.sync.prepare(); await d.sync.through(0); }
    const ws = (await a.repo.load())!, other = (await b.repo.load())!, r = f.registrations[0]!;
    expect(r.artifact.mode).toBe('fork'); expect(ws.branches).toHaveLength(2);
    expect(ws.branches.find((b) => b.id === f.copy.activeBranchId)).toEqual(f.copy.branches[0]);
    expect(ws.activeBranchId).toBe(r.stream.streamId); expect(other.activeBranchId).toBe(f.copy.activeBranchId);
    expect(ws.obligations).toEqual(f.copy.obligations);
    expect(other.revisions).toEqual(ws.revisions);
    const ids = (await a.repo.rawSnapshot() as any).eventIds;
    for (let i = 0; i < r.stream.eventSeq; i++) {
      expect(ids.find((row: any) => row.key === sidecarKey(r.stream.streamId, i + 1)).value.eventId).toBe(f.eventIds[i]);
    }
    expect(ws.branches.find((b) => b.id === r.stream.streamId)!.session.events).toEqual(f.copy.branches[0]!.session.events.slice(0, r.stream.eventSeq));
    expect(await b.repo.pendingOutbox()).toEqual([]);
    await a.repo.close(); await b.repo.close();
  });

  it('预览与确认丢响应，刷新恢复同一请求；确认未知时禁止写入和换请求', async () => {
    const f = await fixture(), a = await f.device(); await f.queue(a.repo);
    f.losePreview(); await expect(a.sync.resume()).rejects.toThrow('preview response lost');
    await a.repo.close(); const b = await f.device(a.factory); await b.sync.resume();
    expect(f.previewCalls[1]).toEqual(f.previewCalls[0]);
    await f.confirm(b.repo); f.loseAdopt(); await expect(b.sync.resume()).rejects.toThrow('adoption response lost');
    const saved = (await b.repo.revisionState()).pending!;
    const ws = (await b.repo.load())!;
    expect((await new SessionCommitter(b.repo, ws.identity.repositoryRevision).commit(updateDisplay(ws, f.entry.id, { title: 'Blocked' }))).ok).toBe(false);
    await expect(b.repo.queueArchive(content, { type: 'archive', memberContentIds: [f.entry.id] })).rejects.toThrow('确认结果尚未确定');
    await expect(b.repo.revisionAction(content, { discard: saved.request.requestId })).rejects.toThrow('必须恢复同一请求');
    await b.repo.close(); const c = await f.device(a.factory); await c.sync.resume(); await c.sync.prepare(); await c.sync.through(0);
    expect(f.adoptCalls[1]).toEqual(f.adoptCalls[0]); expect(f.registrations).toHaveLength(1);
    expect((await c.repo.revisionState()).pending).toBeNull(); await c.repo.close();
  });

  it('请求和修订写入失败整事务回滚，原请求、正文、身份与管理游标完整保留', async () => {
    const f = await fixture(), a = await f.device();
    const failWrites = (store: string, key?: string) => {
      const put = IDBObjectStore.prototype.put;
      return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
        if (this.name === store && (key === undefined || args[1] === key)) throw new DOMException('synthetic', 'QuotaExceededError');
        return put.apply(this, args);
      });
    };
    const initial = await a.repo.rawSnapshot(), queued = failWrites('sync', 'revisions');
    try { await expect(f.queue(a.repo)).rejects.toThrow(); } finally { queued.mockRestore(); }
    expect(await a.repo.rawSnapshot()).toEqual(initial); expect(f.previewCalls).toHaveLength(0);
    await f.queue(a.repo); await a.sync.resume(); await f.confirm(a.repo);
    const beforeResult = await a.repo.rawSnapshot(), result = failWrites('sync', 'revisions');
    try { await expect(a.sync.resume()).rejects.toThrow(); } finally { result.mockRestore(); }
    expect(await a.repo.rawSnapshot()).toEqual(beforeResult);
    await a.sync.resume(); await a.sync.prepare();
    const beforeInstall = await a.repo.rawSnapshot(), install = failWrites('revisions');
    try { await expect(a.sync.through(0)).rejects.toThrow(); } finally { install.mockRestore(); }
    expect(await a.repo.rawSnapshot()).toEqual(beforeInstall);
    await a.sync.through(0); expect((await a.repo.revisionState()).pending).toBeNull();
    expect(f.adoptCalls[1]).toEqual(f.adoptCalls[0]); await a.repo.close();
  });

  it('预览后本机继续阅读使旧确认失效；原预览保存在 staging 后才能重新编辑', async () => {
    const f = await fixture(), a = await f.device(); await f.queue(a.repo); await a.sync.resume();
    const held = (await a.repo.revisionState()).pending!, ws = (await a.repo.load())!;
    expect((await new SessionCommitter(a.repo, ws.identity.repositoryRevision).commit(readGenerated(ws))).ok).toBe(true);
    await expect(f.confirm(a.repo)).rejects.toThrow('请先完成阅读'); expect(f.adoptCalls).toHaveLength(0);
    await a.repo.revisionAction(content, { discard: held.request.requestId });
    expect((await a.repo.rawSnapshot() as any).staging).toContainEqual(held);
    expect((await a.repo.load())!.branches[0]!.session.events).toHaveLength(ws.branches[0]!.session.events.length + 1);
    await a.repo.close();
  });

  it('服务端明确冲突解除冻结并保留候选，不把冲突转换成采用', async () => {
    const f = await fixture(), a = await f.device(); await f.queue(a.repo); await a.sync.resume(); await f.confirm(a.repo);
    f.conflict(); await a.sync.resume();
    expect((await a.repo.revisionState()).pending?.result?.outcome).toBe('conflict');
    const ws = (await a.repo.load())!;
    expect((await new SessionCommitter(a.repo, ws.identity.repositoryRevision).commit(updateDisplay(ws, f.entry.id, { title: 'Allowed' }))).ok).toBe(true);
    expect([...ws.revisions].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...f.copy.revisions].sort((a, b) => a.id.localeCompare(b.id)));
    expect(f.registrations).toEqual([]); await a.repo.close();
  });

  it('接收另一设备修订保留本机未决展示候选、原命令和阅读历史', async () => {
    const f = await fixture(), a = await f.device(), b = await f.device();
    const ws = (await b.repo.load())!;
    expect((await new SessionCommitter(b.repo, ws.identity.repositoryRevision).commit(updateDisplay(ws, f.entry.id,
      { title: 'Local title', tags: ['local'], note: 'Unsent note' }))).ok).toBe(true);
    const pending = (await b.repo.metadataState()).pending;
    await f.queue(a.repo); await a.sync.resume(); await f.confirm(a.repo); await a.sync.resume();
    await b.sync.prepare(); await b.sync.through(0);
    expect((await b.repo.metadataState()).pending).toEqual(pending);
    expect((await b.repo.metadataState()).known[f.entry.id]!.value.title).toBe('Revised clue');
    expect((await b.repo.load())!.entries.find((e) => e.id === f.entry.id)!.display).toMatchObject({ title: 'Local title', tags: ['local'], note: 'Unsent note' });
    expect((await b.repo.load())!.branches[0]!.session.events).toEqual(ws.branches[0]!.session.events);
    expect(await b.repo.pendingOutbox()).toEqual([]); await a.repo.close(); await b.repo.close();
  });

  it('另一标签页在读取后提交时 CAS 拒绝修订，不覆盖新展示命令', async () => {
    const f = await fixture(), a = await f.device(), b = await f.device(a.factory);
    const raw = a.repo.rawSnapshot.bind(a.repo);
    const snapshot = vi.spyOn(a.repo, 'rawSnapshot').mockImplementationOnce(async () => {
      const result = await raw(), ws = (await b.repo.load())!;
      expect((await new SessionCommitter(b.repo, ws.identity.repositoryRevision).commit(updateDisplay(ws, f.entry.id, { title: 'Other tab' }))).ok).toBe(true);
      return result;
    });
    try { await expect(f.queue(a.repo)).rejects.toThrow('另一个窗口'); } finally { snapshot.mockRestore(); }
    expect((await a.repo.revisionState()).pending).toBeNull();
    expect((await a.repo.metadataState()).pending[f.entry.id]!.request.value.title).toBe('Other tab');
    expect(f.previewCalls).toHaveLength(0); await a.repo.close(); await b.repo.close();
  });

  it('登记不能越过阅读屏障；先重放远端阅读再接收分叉，管理页落库失败可重复恢复', async () => {
    const f = await fixture(), a = await f.device(), baseline = readGenerated(f.copy);
    const event = baseline.branches[0]!.session.events.at(-1)!, eventId = crypto.randomUUID();
    f.eventIds.push(eventId);
    const request: RevisionPreviewRequest = { workspaceId: f.workspaceId, requestId: crypto.randomUUID(), streamId: baseline.activeBranchId,
      contentId: f.entry.id, baseRevisionId: f.old.id, baseSeq: f.eventIds.length, baseEventId: eventId,
      displayVersion: 0, lifecycleVersion: 0, archiveVersion: 0, draft: f.old.draft.replace('Cloud fixture', 'Revised clue') };
    const p = await f.preview(request, baseline), r = await f.registration(p, crypto.randomUUID(), baseline, 1);
    f.registrations.push(r); await a.sync.prepare(); const before = await a.repo.rawSnapshot();
    await a.sync.through(0); expect(await a.repo.rawSnapshot()).toEqual(before);
    await expect(a.repo.revisionAction(content, { install: r, readingSeq: 0 })).rejects.toThrow('屏障');
    const change: SyncChange = { seq: 1, batchId: crypto.randomUUID(), deviceId: crypto.randomUUID(), streamId: baseline.activeBranchId,
      fromSeq: request.baseSeq - 1, toSeq: request.baseSeq, createdAt: at.toISOString(),
      events: [{ seq: request.baseSeq, eventId, event, digest: await cloudDigest(event), at: event.at, command: commandOfEvent(event) }] };
    const reading = new WorkspaceSync({ repo: a.repo, content, workspaceId: f.workspaceId, deviceId: f.deviceId,
      digest: cloudDigest, newBatchId: () => crypto.randomUUID(), revisions: a.sync,
      api: { bootstrap: vi.fn(), recoverSync: vi.fn(), readingSnapshot: vi.fn(), push: vi.fn(), registerStream: vi.fn(), conflicts: async () => ({ conflicts: [] }), resolveConflict: vi.fn(),
        pull: async (_id, cursor) => ({ fromChangeSeq: Number(cursor), changeSeq: 1, changes: cursor === '0' ? [change] : [],
          nextCursor: '1', hasMore: false, cloudVersion: '1' }) } });
    const save = a.repo.saveSyncState.bind(a.repo);
    const cursorFailure = vi.spyOn(a.repo, 'saveSyncState').mockImplementationOnce(async (state) => {
      if (state.cursor === '1') throw new Error('cursor write failed'); await save(state);
    });
    try { await expect(reading.run()).rejects.toThrow('cursor write failed'); } finally { cursorFailure.mockRestore(); }
    expect((await a.repo.syncState()).cursor).toBe('0');
    expect((await a.repo.revisionState()).installed).toEqual([r]);
    const acceptedManagement = (await a.repo.load())!.management;
    expect((await reading.run()).stopped).toBeNull();
    expect((await a.repo.load())!.management).toEqual(acceptedManagement);
    expect((await a.repo.revisionState()).installed).toEqual([r]);
    expect((await a.repo.load())!.branches.find((b) => b.id === baseline.activeBranchId)!.session.events).toEqual(baseline.branches[0]!.session.events);
    const page = { workspaceId: f.workspaceId, fromCursor: '0', nextCursor: '1', hasMore: false,
      changes: [{ seq: 1, type: 'revision' as const, registration: r }] };
    const put = IDBObjectStore.prototype.put, spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
      if (this.name === 'sync' && args[1] === 'lifecycle') throw new Error('synthetic'); return put.apply(this, args);
    });
    const installed = await a.repo.rawSnapshot();
    try { await expect(a.repo.updateManagement({ pull: page }, content)).rejects.toThrow(); } finally { spy.mockRestore(); }
    expect(await a.repo.rawSnapshot()).toEqual(installed);
    await a.repo.updateManagement({ pull: page }, content); expect((await a.repo.lifecycleState()).cursor).toBe('1');
    const management = (await a.repo.load())!.management; await reading.run();
    expect((await a.repo.load())!.management).toEqual(management); expect(await a.repo.pendingOutbox()).toEqual([]); await a.repo.close();
  });

  it('自洽哈希不能代替本机编译；篡改正文、义务、流头和目录都保留原件', async () => {
    const f = await fixture(), a = await f.device(); await f.queue(a.repo); await a.sync.resume();
    await f.confirm(a.repo); await a.sync.resume(); const initial = await a.repo.rawSnapshot(), r = f.registrations[0]!;
    const forged = structuredClone(r);
    (forged.artifact.revision as ContentRevision).title = 'Forged title';
    forged.artifact.revisionDigest = await cloudDigest(forged.artifact.revision);
    const { digest: _digest, ...body } = forged.artifact; forged.artifact.digest = await cloudDigest(body);
    for (const bad of [forged, { ...r, obligations: [] }, { ...r, stream: { ...r.stream, lastEventId: crypto.randomUUID() } },
      { ...r, display: { ...r.display, contentId: f.copy.entries[0]!.id } }]) {
      await expect(a.repo.revisionAction(content, { install: bad, readingSeq: 0 })).rejects.toThrow();
      expect(await a.repo.rawSnapshot()).toEqual(initial);
    }
    const catalog = await f.api.revisionCatalog(); catalog.digest = 'e'.repeat(64);
    const badSync = new RevisionSync(a.repo, { ...f.api, revisionCatalog: async () => catalog }, content, f.workspaceId);
    await expect(badSync.prepare()).rejects.toThrow('目录摘要'); expect(await a.repo.rawSnapshot()).toEqual(initial);
    await a.repo.close();
  });

  it('暂停同步不提交已保存的预览，旧服务 404 仅在没有修订状态时回退，鉴权失败不伪装为无能力', async () => {
    const f = await fixture(), a = await f.device(); await f.queue(a.repo);
    await a.repo.saveSyncState({ ...await a.repo.syncState(), paused: true });
    await a.sync.resume(); expect(f.previewCalls).toEqual([]);
    const missing = new RevisionSync(a.repo, { ...f.api, revisionCatalog: async () => { throw new CloudFailure('INVALID_RESPONSE', 404, 'missing'); } }, content, f.workspaceId);
    await expect(missing.prepare()).rejects.toThrow('missing');
    await a.repo.revisionAction(content, { discard: (await a.repo.revisionState()).pending!.request.requestId });
    await missing.prepare(); expect(missing.available).toBe(false);
    const denied = new RevisionSync(a.repo, { ...f.api, revisionCatalog: async () => { throw new CloudFailure('INVALID_RESPONSE', 401, 'login required'); } }, content, f.workspaceId);
    await expect(denied.prepare()).rejects.toThrow('login required'); await a.repo.close();
  });

  it('已接收的目录不能回退、换文或跨工作区；未知本机 sidecar 原样保留', async () => {
    const f = await fixture(), a = await f.device(); await f.queue(a.repo); await a.sync.resume(); await f.confirm(a.repo); await a.sync.resume();
    await a.sync.prepare(); await a.sync.through(0);
    const initial = await a.repo.rawSnapshot(), catalog = await f.api.revisionCatalog();
    const changed = structuredClone(catalog); changed.registrations[0]!.commandId = crypto.randomUUID(); changed.digest = await cloudDigest(changed.registrations);
    for (const bad of [{ ...catalog, version: 0, registrations: [], digest: await cloudDigest([]) }, changed, { ...catalog, workspaceId: crypto.randomUUID() }]) {
      const engine = new RevisionSync(a.repo, { ...f.api, revisionCatalog: async () => bad }, content, f.workspaceId);
      await expect(engine.prepare()).rejects.toThrow(); expect(await a.repo.rawSnapshot()).toEqual(initial);
    }
    await a.repo.close();
    const db = await new Promise<IDBDatabase>((resolve) => { const r = a.factory.open(f.namespace, 2); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>((resolve) => { const tx = db.transaction('sync', 'readwrite'); tx.objectStore('sync').put({ format: 'revision-outbox/999', preserved: true }, 'revisions'); tx.oncomplete = () => resolve(); });
    db.close(); const b = new WorkspaceRepository(a.factory, f.namespace), unknown = await b.rawSnapshot();
    await expect(b.revisionState()).rejects.toThrow('不受支持');
    await expect(f.queue(b)).rejects.toThrow(); expect(await b.rawSnapshot()).toEqual(unknown); await b.close();
  });
});
