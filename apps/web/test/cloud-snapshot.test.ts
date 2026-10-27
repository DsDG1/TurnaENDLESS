import { describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { adoptRevision, applyPlayerCommand, assertReadingObligationProgress, bridge, buildBackup, deriveReadingObligations, previewRevision, retainReadingCompletionTimes, updateDisplay, type ContentRevision, type Workspace } from '@endless/content';
import { deriveCloudCopy, rebuildCloudReading } from '@endless/content/cloud';
import type { CloudImportReceipt, ReadingSnapshot, RevisionRegistration } from '@endless/cloud-contracts';
import { getOptions, getScenes } from '@endless/player';
import { cloudTestContent as content, cloudTestTime, cloudTestWorkspace } from '../../../packages/content/test/cloud-fixture.js';
import { cloudDigest, cloudNamespace } from '../src/cloud/local.js';
import { commandOfEvent } from '../src/cloud/outbox.js';
import { CloudWorkspaceRepository as WorkspaceRepository } from '../src/cloud/repository.js';
import { WorkspaceRepository as GuestWorkspaceRepository } from '../src/storage.js';
import { SessionCommitter } from '../src/session-writer.js';
import { WorkspaceSync } from '../src/cloud/sync.js';
import { CloudFailure } from '../src/cloud/client.js';
import { RevisionSync } from '../src/cloud/revisions.js';

const time = new Date('2026-10-27T09:00:00.000Z');
function read(workspace: Workspace) {
  const revision = workspace.revisions.find((r) => r.origin === 'generated')!;
  workspace = applyPlayerCommand(content, workspace, { type: 'select', episode: revision.episodeId });
  const scene = getScenes(bridge(content, workspace).library.episodes.find((e) => e.id === revision.episodeId)!)[0]!;
  return applyPlayerCommand(content, workspace, { type: 'advance', scene: scene.id, skip: false }, time);
}
function finishGenerated(workspace: Workspace, skip = false, at = time) {
  const revision = workspace.revisions.find((r) => r.origin === 'generated')!;
  workspace = applyPlayerCommand(content, workspace, { type: 'select', episode: revision.episodeId });
  for (const scene of getScenes(bridge(content, workspace).library.episodes.find((e) => e.id === revision.episodeId)!)) {
    if (getOptions(scene).length) workspace = applyPlayerCommand(content, workspace,
      { type: 'answer', scene: scene.id, choice: getOptions(scene).findIndex((o) => o.correct) }, at);
    workspace = applyPlayerCommand(content, workspace, { type: 'advance', scene: scene.id, skip }, at);
  }
  return workspace;
}
async function fixture() {
  const workspaceId = crypto.randomUUID(), factory = new IDBFactory();
  const source = deriveCloudCopy(buildBackup(cloudTestWorkspace(true)), cloudTestTime, content);
  const namespace = cloudNamespace(crypto.randomUUID(), crypto.randomUUID(), workspaceId);
  const repo = new WorkspaceRepository(factory, namespace);
  const receipt: CloudImportReceipt = { id: crypto.randomUUID(), workspaceId, sourceLocalId: source.identity.workspaceId,
    sourceProfileId: source.profile.id, sourceRepositoryRevision: 0, sourceObjectId: crypto.randomUUID(), sourceDigest: 'a'.repeat(64),
    snapshotDigest: 'b'.repeat(64), copyDigest: await cloudDigest(source), copyCreatedAt: cloudTestTime,
    validationBinding: 'c'.repeat(64), copyPolicy: 'endless-cloud-copy/1', contentIds: source.entries.map((e) => e.id),
    revisionIds: source.revisions.map((r) => r.id), seedContentIds: source.entries.filter((e) => e.sourceKind === 'bundled').map((e) => e.id) };
  await repo.installCloudCopy(source, receipt, crypto.randomUUID());
  const ids: string[] = source.branches[0]!.session.events.map(() => crypto.randomUUID());
  async function snapshot(workspace = read(source), registrations: RevisionRegistration[] = []): Promise<ReadingSnapshot> {
    const histories = await Promise.all(workspace.branches.map(async (b) => {
      const inherited = registrations.find((r) => r.stream.streamId === b.id && r.artifact.mode === 'fork')?.prefixEventIds;
      const events = await Promise.all(b.session.events.map(async (event, i) => ({ seq: i + 1,
        eventId: inherited?.[i] ?? ids[i] ?? (ids[i] = crypto.randomUUID()), event, at: event.at, command: commandOfEvent(event), digest: await cloudDigest(event) })));
      return { stream: { streamId: b.id, branchId: b.id, eventSeq: events.length, lastEventId: events.at(-1)?.eventId ?? null },
        branch: { streamId: b.id, label: b.label, parentBranchId: b.parentBranchId, forkAtEventCount: b.forkAtEventCount,
          adopted: b.adopted, createdAt: b.createdAt, catalog: b.session.catalog, commonStreamId: b.parentBranchId, commonPrefixSeq: b.forkAtEventCount ?? 0 }, events };
    }));
    const body = { format: 'cloud-reading-snapshot/1' as const, workspaceId, source, sourceDigest: await cloudDigest(source),
      cloudVersion: '5', changeSeq: 3, cursor: 'snapshot-cut-3', histories,
      revisionCatalog: { workspaceId, version: registrations.length, registrations, digest: await cloudDigest(registrations) } };
    return { ...body, digest: await cloudDigest(body) };
  }
  async function revision(baseline: Workspace, version = 1, generationSource = source) {
    const entry = baseline.entries.find((e) => e.sourceKind === 'generated')!, old = baseline.revisions.find((r) => r.id === entry.headRevisionId) as ContentRevision;
    const p = previewRevision(content, baseline, entry, old.draft.replace(/@title .*/, `@title Snapshot ${version}`), time);
    if (!p.ok || !p.revision) throw new Error('fixture draft invalid');
    const candidate = adoptRevision(content, baseline, entry, p.revision, time);
    const branch = candidate.workspace.branches.find((b) => b.id === candidate.workspace.activeBranchId)!;
    const original = baseline.branches.find((b) => b.id === baseline.activeBranchId)!;
    const artifactBody = { compiler: 'cloud-revision-preview/1' as const, mode: candidate.mode,
      binding: { sourceDigest: await cloudDigest(generationSource), inventoryDigest: 'd'.repeat(64), streamId: original.id,
        baseRevisionId: old.id, eventCount: original.session.events.length, lastEventId: ids[original.session.events.length - 1] ?? null,
        displayVersion: version - 1, lifecycleVersion: 0, archiveVersion: 0 },
      revision: p.revision, revisionDigest: await cloudDigest(p.revision),
      branch: { streamId: branch.id, label: branch.label, parentBranchId: branch.parentBranchId, forkAtEventCount: branch.forkAtEventCount,
        adopted: branch.adopted, createdAt: branch.createdAt, catalog: branch.session.catalog,
        commonStreamId: branch.parentBranchId, commonPrefixSeq: branch.forkAtEventCount ?? 0 } };
    const e = candidate.workspace.entries.find((e) => e.id === entry.id)!;
    const count = candidate.mode === 'fork' ? branch.forkAtEventCount! : original.session.events.length;
    const registration: RevisionRegistration = { format: 'cloud-revision-registration/1', version, readingChangeSeq: 1,
      commandId: crypto.randomUUID(), previewRequestId: crypto.randomUUID(), artifact: { ...artifactBody, digest: await cloudDigest(artifactBody) },
      entry: { contentId: entry.id, revisionIds: e.revisionIds, headRevisionId: e.headRevisionId, updatedAt: e.updatedAt }, obligations: candidate.workspace.obligations,
      display: { contentId: entry.id, version, value: { title: p.revision.title, tags: [], note: '' }, updatedAt: time.toISOString() },
      stream: { streamId: branch.id, branchId: branch.id, eventSeq: count, lastEventId: ids[count - 1] ?? null },
      prefixEventIds: candidate.mode === 'fork' ? ids.slice(0, count) : [] };
    const expanded = { ...generationSource, revisions: [...generationSource.revisions, p.revision], obligations: registration.obligations,
      entries: generationSource.entries.map((e) => e.id === entry.id ? { ...e, revisionIds: registration.entry.revisionIds, headRevisionId: p.revision!.id, updatedAt: registration.entry.updatedAt } : e) };
    return { workspace: candidate.workspace, registration, expanded };
  }
  return { repo, source, snapshot, revision, ids, factory, namespace, workspaceId };
}
async function resign(s: ReadingSnapshot) { const { digest: _, ...body } = s; return { ...s, digest: await cloudDigest(body) }; }

describe('裁剪后完整阅读快照：原生重建与原子接收', () => {
  it('真实读完整集后允许快照恢复，已完成义务与原时间保留，不因导入时尚未完成而拒绝', async () => {
    const f = await fixture(), finished = finishGenerated(f.source);
    expect(finished.obligations[0]!.waivedAt).toBe(time.toISOString());
    expect((await new SessionCommitter(f.repo, 0).commit(finished)).ok).toBe(true);
    const queued = await f.repo.pendingOutbox();
    for (const e of queued) f.ids[e.seq - 1] = e.eventId;
    const snapshot = await f.snapshot(finished), head = snapshot.histories[0]!.stream;
    await f.repo.acknowledgePush({ batchId: crypto.randomUUID(), workspaceId: f.workspaceId, changeSeq: 3,
      cloudVersion: '5', applied: queued.length, duplicate: 0, streams: [head] }, queued.map((e) => `${e.streamId}:${e.seq}`));
    const before = (await f.repo.load())!;
    await f.repo.acceptReadingSnapshot(content, await f.repo.syncState(), snapshot);
    expect((await f.repo.load())!.obligations).toEqual(before.obligations);
    expect((await f.repo.load())!.branches[0]!.session.events).toEqual(before.branches[0]!.session.events);
    const earlier = finishGenerated(f.source, false, new Date(time.getTime() - 60_000));
    const both = { ...before, obligations: f.source.obligations, branches: [...before.branches,
      { ...earlier.branches[0]!, id: `brn_${crypto.randomUUID()}`, label: '另一合法阅读分支' }] };
    const derived = deriveReadingObligations(content, both);
    expect(deriveReadingObligations(content, { ...both, branches: [...both.branches].reverse() })).toEqual(derived);
    expect(derived).toEqual(earlier.obligations);
    expect(() => assertReadingObligationProgress(content, before, f.source.obligations)).not.toThrow();
    expect(retainReadingCompletionTimes(before.obligations, derived)).toEqual(before.obligations);
    await f.repo.close();
  });

  it('跳过推进到末尾不能伪造已完成义务；快照拒绝且原始记录完整保留', async () => {
    const f = await fixture(), snapshot = await f.snapshot(finishGenerated(f.source, true));
    const installation = await f.repo.cloudInstallation();
    const forged = { ...f.source, obligations: f.source.obligations.map((o) => ({ ...o, waivedAt: time.toISOString() })) };
    expect((await new SessionCommitter(f.repo, 0).commit(forged)).ok).toBe(true);
    const before = await f.repo.rawSnapshot();
    await expect(f.repo.acceptReadingSnapshot(content, await f.repo.syncState(), snapshot)).rejects.toThrow('真实完成阅读');
    expect(await f.repo.rawSnapshot()).toEqual(before); expect(await f.repo.cloudInstallation()).toEqual(installation);
    await f.repo.close();
  });

  it('读取带完整库存的修订时原子重建并续拉新截止点，不把旧页游标覆盖回去', async () => {
    const f = await fixture(), finished = finishGenerated(f.source), before = await f.snapshot(finished), revised = await f.revision(finished);
    const r = revised.registration;
    r.readingContext = { format: 'cloud-revision-reading-context/1', heads: before.histories.map((h) => h.stream) };
    r.artifact.binding.inventoryDigest = await cloudDigest(before.histories.map((h) => ({ manifest: h.branch,
      head: { count: h.stream.eventSeq, lastEventId: h.stream.lastEventId }, events: h.events.map((e) => ({ seq: e.seq, id: e.eventId, digest: e.digest })) })));
    const { digest: _, ...artifact } = r.artifact; r.artifact.digest = await cloudDigest(artifact);
    const snapshot = await f.snapshot(revised.workspace, [r]);
    const premature = structuredClone(snapshot), bad = premature.revisionCatalog.registrations[0]!;
    const head = bad.readingContext!.heads[0]!, h = premature.histories.find((h) => h.stream.streamId === head.streamId)!;
    head.eventSeq--; head.lastEventId = h.events[head.eventSeq - 1]!.eventId;
    bad.artifact.binding.eventCount = head.eventSeq; bad.artifact.binding.lastEventId = head.lastEventId;
    bad.artifact.binding.inventoryDigest = await cloudDigest([{ manifest: h.branch, head: { count: head.eventSeq, lastEventId: head.lastEventId },
      events: h.events.slice(0, head.eventSeq).map((e) => ({ seq: e.seq, id: e.eventId, digest: e.digest })) }]);
    const { digest: badDigest, ...badArtifact } = bad.artifact; bad.artifact.digest = await cloudDigest(badArtifact);
    premature.revisionCatalog.digest = await cloudDigest(premature.revisionCatalog.registrations);
    const original = await f.repo.rawSnapshot();
    await expect(f.repo.acceptReadingSnapshot(content, await f.repo.syncState(), await resign(premature))).rejects.toThrow();
    expect(await f.repo.rawSnapshot()).toEqual(original);
    const state = await f.repo.syncState();
    await f.repo.saveSyncState({ ...state, cursor: 'old-page', cloudVersion: '1', streams: { [f.source.activeBranchId]: {
      seq: f.source.branches[0]!.session.events.length, eventId: f.ids[f.source.branches[0]!.session.events.length - 1]! } } });
    const api = { readingSnapshot: vi.fn().mockResolvedValue(snapshot), recoverSync: vi.fn(), push: vi.fn(), registerStream: vi.fn(), conflicts: vi.fn(), resolveConflict: vi.fn(), bootstrap: vi.fn(),
      revisionPreview: vi.fn(), revisionAdopt: vi.fn(), revisionCatalog: async () => snapshot.revisionCatalog,
      pull: vi.fn().mockResolvedValueOnce({ fromChangeSeq: 0, changeSeq: 1, changes: [], nextCursor: 'old-page-1', hasMore: false, cloudVersion: '2' })
        .mockResolvedValue({ fromChangeSeq: 3, changeSeq: 3, changes: [], nextCursor: snapshot.cursor, hasMore: false, cloudVersion: '5' }) };
    const driver = new WorkspaceSync({ repo: f.repo, content, workspaceId: f.workspaceId, deviceId: crypto.randomUUID(), digest: cloudDigest,
      newBatchId: () => crypto.randomUUID(), api, revisions: new RevisionSync(f.repo, api, content, f.workspaceId) });
    expect((await driver.run()).stopped).toBeNull();
    expect(api.pull.mock.calls.map((args) => args[1])).toEqual(['old-page', snapshot.cursor]);
    expect((await f.repo.syncState()).cursor).toBe(snapshot.cursor);
    expect((await f.repo.load())!.obligations).toEqual(finished.obligations);
    expect((await f.repo.revisionState()).installed).toEqual([r]);
    await f.repo.close();
  });
  it('保留本机展示候选/偏好/义务，并在一次事务安装全部身份与快照截止点', async () => {
    const f = await fixture(), entry = f.source.entries.find((e) => e.sourceKind === 'generated')!;
    const writer = new SessionCommitter(f.repo, 0);
    expect((await writer.commit(updateDisplay(f.source, entry.id, { title: '本机未决标题', tags: ['local'], note: '保留' }, time))).ok).toBe(true);
    const before = await f.repo.load(), snapshot = await f.snapshot();
    await f.repo.acceptReadingSnapshot(content, await f.repo.syncState(), snapshot);
    const next = (await f.repo.load())!;
    expect(next.branches[0]!.session.events).toEqual(snapshot.histories[0]!.events.map((e) => e.event));
    expect(next.activeBranchId).toBe(before!.activeBranchId);
    expect(next.entries.find((e) => e.id === entry.id)!.display.title).toBe('本机未决标题');
    expect((await f.repo.metadataState()).pending[entry.id]).toBeDefined();
    expect(next.obligations).toEqual(before!.obligations);
    expect((await f.repo.syncState()).cursor).toBe(snapshot.cursor);
    expect((await f.repo.rawSnapshot() as any).eventIds).toHaveLength(snapshot.histories[0]!.events.length);
    const saved = (await f.repo.rawSnapshot() as any).staging;
    await f.repo.acceptReadingSnapshot(content, await f.repo.syncState(), snapshot);
    expect((await f.repo.rawSnapshot() as any).staging).toEqual(saved);
    await f.repo.close();
  });

  it('设备跨过多次修订离线后，从原始种子原生重建已读分叉及后续未读原位采用', async () => {
    const f = await fixture(), readSource = read(f.source);
    await f.snapshot(readSource); // Persist fixture prefix identities before creating the registration.
    const first = await f.revision(readSource);
    const second = await f.revision(first.workspace, 2, first.expanded);
    const snapshot = await f.snapshot(second.workspace, [first.registration, second.registration]);
    const rebuilt = await rebuildCloudReading(content, snapshot, cloudDigest);
    expect(rebuilt.branches.map((b) => b.adopted)).toEqual(second.workspace.branches.map((b) => b.adopted));
    await f.repo.acceptReadingSnapshot(content, await f.repo.syncState(), snapshot);
    const installed = (await f.repo.load())!;
    expect(new Map(installed.revisions.map((r) => [r.id, r]))).toEqual(new Map(second.workspace.revisions.map((r) => [r.id, r])));
    expect(installed.activeBranchId).toBe(f.source.activeBranchId);
    expect((await f.repo.revisionState()).installed).toEqual(snapshot.revisionCatalog.registrations);
    expect(installed.obligations).toEqual(second.workspace.obligations);
    await f.repo.close();
  });

  it('重算所有摘要也不能绕过原件、事件命令、前缀身份或原生修订验收', async () => {
    const f = await fixture(), snapshot = await f.snapshot(), before = await f.repo.rawSnapshot();
    const command = structuredClone(snapshot); command.histories[0]!.events.at(-1)!.command = { type: 'reveal', scene: 'forged' };
    const duplicate = structuredClone(snapshot), history = duplicate.histories[0]!;
    history.events.push({ ...history.events.at(-1)!, seq: history.events.length + 1, eventId: crypto.randomUUID() });
    history.stream.eventSeq++; history.stream.lastEventId = history.events.at(-1)!.eventId;
    const source = structuredClone(snapshot); (source.source as Workspace).profile.id = `pro_${crypto.randomUUID()}`;
    source.sourceDigest = await cloudDigest(source.source);
    for (const candidate of [command, duplicate, source]) {
      await expect(f.repo.acceptReadingSnapshot(content, await f.repo.syncState(), await resign(candidate))).rejects.toThrow();
      expect(await f.repo.rawSnapshot()).toEqual(before);
    }
    const native = await f.revision(f.source), tampered = await f.snapshot(native.workspace, [native.registration]);
    const revision = tampered.revisionCatalog.registrations[0]!.artifact.revision as ContentRevision;
    revision.title = '伪造重编译结果';
    const a = tampered.revisionCatalog.registrations[0]!.artifact, { digest: _, ...body } = a;
    a.revisionDigest = await cloudDigest(revision); a.digest = await cloudDigest({ ...body, revisionDigest: a.revisionDigest });
    tampered.revisionCatalog.digest = await cloudDigest(tampered.revisionCatalog.registrations);
    await expect(f.repo.acceptReadingSnapshot(content, await f.repo.syncState(), await resign(tampered))).rejects.toThrow();
    expect(await f.repo.rawSnapshot()).toEqual(before);
    await f.repo.close();
  });

  it('保留的独立根分支先补齐共同阅读前缀，再原生编译其上的修订分叉', async () => {
    const f = await fixture(), root = read(f.source).branches[0]!;
    const kept = { ...root, id: `brn_${crypto.randomUUID()}`, label: `${root.label} · 离线保留`, parentBranchId: null, forkAtEventCount: null };
    const workspace = { ...f.source, branches: [root, kept], activeBranchId: kept.id };
    await f.snapshot(workspace);
    const r = await f.revision(workspace), snapshot = await f.snapshot(r.workspace, [r.registration]);
    const manifest = snapshot.histories.find((h) => h.stream.streamId === kept.id)!.branch;
    manifest.commonStreamId = root.id; manifest.commonPrefixSeq = root.session.events.length;
    await f.repo.acceptReadingSnapshot(content, await f.repo.syncState(), await resign(snapshot));
    expect((await f.repo.load())!.branches).toHaveLength(3);
    await f.repo.close();
  });

  it('写入失败完整回滚；跨窗口追加和已在途 Outbox 均阻止覆盖', async () => {
    const f = await fixture(), snapshot = await f.snapshot(), before = await f.repo.rawSnapshot();
    const put = IDBObjectStore.prototype.put;
    const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      if (this.name === 'sync' && args[1] === 'sync') throw new Error('synthetic snapshot write failure');
      return put.apply(this, args);
    });
    await expect(f.repo.acceptReadingSnapshot(content, await f.repo.syncState(), snapshot)).rejects.toThrow();
    failure.mockRestore(); expect(await f.repo.rawSnapshot()).toEqual(before);
    const installation = await f.repo.cloudInstallation(), state = await f.repo.syncState();
    const hook = vi.spyOn(f.repo, 'cloudInstallation').mockImplementationOnce(async () => {
      expect((await new SessionCommitter(f.repo, 0).commit(read(f.source))).ok).toBe(true);
      return installation;
    });
    await expect(f.repo.acceptReadingSnapshot(content, state, snapshot)).rejects.toThrow('另一窗口'); hook.mockRestore();
    const raced = await f.repo.rawSnapshot(), ids = (await f.repo.pendingOutbox()).map((e) => e.eventId);
    await expect(f.repo.acceptReadingSnapshot(content, await f.repo.syncState(), snapshot)).rejects.toThrow('未同步事件');
    expect(await f.repo.rawSnapshot()).toEqual(raced); expect((await f.repo.pendingOutbox()).map((e) => e.eventId)).toEqual(ids);
    await f.repo.close();
  });

  it('未知 sidecar 和主同步状态的未来字段保留原样，不能通过空状态容错覆盖', async () => {
    for (const unknownMain of [false, true]) {
      const f = await fixture(), snapshot = await f.snapshot(), state = await f.repo.syncState();
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = f.factory.open(f.namespace, 2); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('sync', 'readwrite');
        tx.objectStore('sync').put(unknownMain ? { ...state, futureContract: 2 } : { format: 'future-sidecar/1' }, unknownMain ? 'sync' : 'unknown-feature');
        tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
      }); db.close();
      const before = await f.repo.rawSnapshot();
      await expect(f.repo.acceptReadingSnapshot(content, state, snapshot)).rejects.toThrow('未知');
      expect(await f.repo.rawSnapshot()).toEqual(before);
      if (unknownMain) {
        const driver = new WorkspaceSync({ repo: f.repo, content, workspaceId: f.workspaceId, deviceId: crypto.randomUUID(), digest: cloudDigest,
          newBatchId: () => crypto.randomUUID(), api: { readingSnapshot: async () => snapshot, recoverSync: vi.fn(), push: vi.fn(), registerStream: vi.fn(), conflicts: vi.fn(), resolveConflict: vi.fn(), pull: vi.fn(),
            bootstrap: async () => ({ workspaceId: f.workspaceId, cloudVersion: '5', changeSeq: 3, cursor: 'head', streams: [], retainedFrom: 2 }) } });
        await expect(driver.run()).rejects.toThrow('未知');
        expect(await f.repo.rawSnapshot()).toEqual(before);
      }
      await f.repo.close();
    }
  });

  it('新领取遇到裁剪基线时用快照；丢响应无写入，重试后从固定截止点续拉', async () => {
    const f = await fixture(), snapshot = await f.snapshot(), before = await f.repo.rawSnapshot();
    const readingSnapshot = vi.fn().mockRejectedValueOnce(new CloudFailure('NETWORK', 0, 'response lost')).mockResolvedValue(snapshot);
    const pull = vi.fn().mockResolvedValue({ fromChangeSeq: 3, changeSeq: 3, changes: [], nextCursor: snapshot.cursor, hasMore: false, cloudVersion: '5' });
    const driver = new WorkspaceSync({ repo: f.repo, content, workspaceId: f.workspaceId, deviceId: crypto.randomUUID(), digest: cloudDigest,
      newBatchId: () => crypto.randomUUID(), api: { readingSnapshot, recoverSync: vi.fn(), push: vi.fn(), registerStream: vi.fn(), conflicts: vi.fn(), resolveConflict: vi.fn(), pull,
        bootstrap: async () => ({ workspaceId: f.workspaceId, cloudVersion: '5', changeSeq: 3, cursor: 'head', streams: [], retainedFrom: 2 }) } });
    await expect(driver.run()).rejects.toThrow('response lost');
    expect((await f.repo.load())!.branches).toEqual((before as any).branches);
    expect((await driver.run()).stopped).toBeNull();
    expect(pull).toHaveBeenCalledWith(f.workspaceId, snapshot.cursor, expect.any(Number));
    expect((await f.repo.syncState()).cursor).toBe(snapshot.cursor);
    expect(readingSnapshot).toHaveBeenCalledTimes(2);
    await f.repo.close();
  });

  it('首次同步前已离线追加时只绑定导入前缀，保留排队身份并让原有 push 裁决分叉', async () => {
    const f = await fixture();
    expect((await new SessionCommitter(f.repo, 0).commit(read(f.source))).ok).toBe(true);
    const local = await f.repo.load(), queued = await f.repo.pendingOutbox(), snapshot = await f.snapshot();
    const conflictId = crypto.randomUUID(), push = vi.fn().mockRejectedValue(new CloudFailure('SYNC_CONFLICT', 409, '冲突', 'resolve_conflict', undefined, conflictId));
    const driver = new WorkspaceSync({ repo: f.repo, content, workspaceId: f.workspaceId, deviceId: crypto.randomUUID(), digest: cloudDigest,
      newBatchId: () => crypto.randomUUID(), api: { readingSnapshot: async () => snapshot, recoverSync: vi.fn(), push, registerStream: vi.fn(), conflicts: vi.fn(), resolveConflict: vi.fn(), pull: vi.fn(),
        bootstrap: async () => ({ workspaceId: f.workspaceId, cloudVersion: '5', changeSeq: 3, cursor: 'head', streams: [], retainedFrom: 2, origin: { cursor: 'old-origin', streams: [] } }) } });
    expect((await driver.run()).stopped).toBe('conflict');
    expect(await f.repo.load()).toEqual(local); expect(await f.repo.pendingOutbox()).toEqual(queued);
    expect(push.mock.calls[0]![0].streams[0]).toMatchObject({ baseSeq: f.source.branches[0]!.session.events.length,
      baseEventId: f.ids[f.source.branches[0]!.session.events.length - 1], events: [expect.objectContaining({ eventId: queued[0]!.eventId })] });
    expect((await f.repo.syncState()).cursor).toBe('old-origin');
    expect((await f.repo.revisionState()).installed).toEqual([]);
    await f.repo.close();
  });
});
