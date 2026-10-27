import { writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { stableStringify } from '@endless/esl';
import { getScenes } from '@endless/player';
import { buildBackup, checked, newId, parseWorkspace, type Content, type ContentRevision, type Workspace } from '@endless/content';
import { deriveCloudCopy, type ReaderIndex } from '@endless/content/cloud';
import type { CloudImportReceipt } from '@endless/cloud-contracts';
import { CloudWorkspaceRepository as WorkspaceRepository } from '../src/cloud/repository.js';
import { WorkspaceRepository as GuestWorkspaceRepository } from '../src/storage.js';
import { cloudDigest, cloudNamespace } from '../src/cloud/local.js';
import { cloudTestContent as content, cloudTestTime, cloudTestWorkspace } from '../../../packages/content/test/cloud-fixture.js';

const laterEpisodeId = 'later-episode';

function sequel(): { workspace: Workspace; first: ContentRevision; later: ContentRevision } {
  const ws = structuredClone(cloudTestWorkspace(true));
  const revision = ws.revisions.find((item) => item.origin !== 'bundled') as ContentRevision;
  const entry = ws.entries.find((item) => item.id === revision.contentId)!;
  const sequelRevision = structuredClone(revision);
  const sequelEntry = structuredClone(entry);
  sequelEntry.id = newId('content');
  sequelRevision.id = newId('revision');
  sequelRevision.contentId = sequelEntry.id;
  sequelRevision.episodeId = laterEpisodeId;
  sequelEntry.revisionIds = [sequelRevision.id];
  sequelEntry.headRevisionId = sequelRevision.id;
  ws.entries.push(sequelEntry);
  ws.revisions.push(sequelRevision);
  ws.branches[0]!.adopted.push({ contentId: sequelEntry.id, revisionId: sequelRevision.id });
  const ready = checked(ws);
  ready.branches[0]!.session = { ...ready.branches[0]!.session, current: revision.episodeId };
  return { workspace: ready, first: revision, later: sequelRevision };
}

const seeded = sequel();
const copy = deriveCloudCopy(buildBackup(seeded.workspace), cloudTestTime, content);
const first = copy.revisions.find((item) => item.id === seeded.first.id) as ContentRevision;
const later = copy.revisions.find((item) => item.id === seeded.later.id) as ContentRevision;

function measure(reading: { reads: { key: string; bytes: number }[]; memoryBytes: number; catalogBytes: number }) {
  return { reads: reading.reads, memoryBytes: reading.memoryBytes, catalogBytes: reading.catalogBytes };
}

async function receiptFor(workspaceId: string): Promise<CloudImportReceipt> {
  return {
    id: crypto.randomUUID(), workspaceId, sourceLocalId: copy.identity.workspaceId, sourceProfileId: copy.profile.id,
    sourceRepositoryRevision: 0, sourceObjectId: crypto.randomUUID(), sourceDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64),
    copyDigest: await cloudDigest(copy), copyCreatedAt: cloudTestTime, validationBinding: 'c'.repeat(64),
    copyPolicy: 'endless-cloud-copy/1', contentIds: copy.entries.map((entry) => entry.id),
    revisionIds: copy.revisions.map((entry) => entry.id),
    seedContentIds: copy.entries.filter((entry) => entry.sourceKind === 'bundled').map((entry) => entry.id),
  };
}

async function installed(reader: Content = content) {
  const factory = new IDBFactory();
  const workspaceId = crypto.randomUUID();
  const namespace = cloudNamespace(crypto.randomUUID(), crypto.randomUUID(), workspaceId);
  const repo = new WorkspaceRepository(factory, namespace, reader);
  await repo.installCloudCopy(copy, await receiptFor(workspaceId), crypto.randomUUID());
  return { factory, namespace, workspaceId, repo };
}

function watchRevisions() {
  const gets: { key: string; bytes: number }[] = [];
  const getAlls: number[] = [];
  const originalGet = IDBObjectStore.prototype.get;
  const originalGetAll = IDBObjectStore.prototype.getAll;
  const getSpy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, query) {
    const request = originalGet.call(this, query);
    if (this.name === 'revisions') {
      request.addEventListener('success', () => {
        const body = request.result;
        gets.push({
          key: String(query),
          bytes: body == null ? 0 : new TextEncoder().encode(stableStringify(body)).length,
        });
      });
    }
    return request;
  });
  const getAllSpy = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === 'revisions') getAlls.push(1);
    return originalGetAll.apply(this, args);
  });
  return {
    gets,
    getAlls,
    take() {
      const hits = gets.splice(0, gets.length);
      const all = getAlls.splice(0, getAlls.length);
      return { hits, all };
    },
    restore() {
      getSpy.mockRestore();
      getAllSpy.mockRestore();
    },
  };
}

function request<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const read = tx.objectStore(store).get(key);
    tx.oncomplete = () => resolve(read.result as T);
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('读取失败'));
  });
}

function writeRow(db: IDBDatabase, store: string, key: IDBValidKey, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('写入失败'));
  });
}

async function withDatabase<T>(factory: IDBFactory, name: string, run: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(name);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try { return await run(db); }
  finally { db.close(); }
}

async function repositoryRevision(factory: IDBFactory, name: string): Promise<number> {
  return withDatabase(factory, name, (db) => request<{ identity: { repositoryRevision: number } }>(db, 'meta', 'workspace'))
    .then((row) => row.identity.repositoryRevision);
}

async function editIndex(factory: IDBFactory, name: string, edit: (index: ReaderIndex) => void): Promise<void> {
  await withDatabase(factory, name, async (db) => {
    const index = await request<ReaderIndex>(db, 'meta', 'cloud-reader-index');
    edit(index);
    index.digest = await cloudDigest({ revisions: index.revisions, contentRevisions: index.contentRevisions, segments: index.segments });
    await writeRow(db, 'meta', 'cloud-reader-index', index);
  });
}

describe('云阅读按目录取正文叶', () => {
  it('打开、空管理页、同步后重载和离线冷启动只读取当前需要的正文', async () => {
    const restores: unknown[] = [];
    const watching: Content = {
      ...content,
      restore(raw: unknown) {
        restores.push(raw);
        return content.restore(raw);
      },
    };
    const { factory, namespace, workspaceId, repo } = await installed(watching);
    const watch = watchRevisions();
    try {
      watch.take();
      const opened = await repo.prepareCloudReading();
      const ordinaryHits = watch.take();
      expect(ordinaryHits.all).toEqual([]);
      expect(ordinaryHits.hits.map((hit) => hit.key)).toEqual([first.id]);
      expect(opened.reads.map((hit) => hit.key)).toEqual([first.id]);
      expect(opened.catalogue.map((entry) => entry.episodeId)).toContain(laterEpisodeId);
      expect(opened.view.revisions.every((revision) => !('draft' in revision) && !('batch' in revision))).toBe(true);
      expect(opened.view.contentRevisions.every((revision) => revision.contract === 'cloud-content-revision/1')).toBe(true);
      expect(opened.view.segments.every((segment) => segment.contract === 'cloud-event-segment/1' && !('events' in segment))).toBe(true);
      expect(() => parseWorkspace(opened.view)).toThrow(/不是完整工作区/);
      const openedPrefix = restores.at(-1) as { session: { events: unknown[] }; generated: { hash: string; generatedAt: string; basedOn: { eventCount: number; hash: string } }[] };
      expect(openedPrefix.generated.map((document) => document.hash)).toEqual([first.hash]);
      expect(openedPrefix.generated[0]!.generatedAt).toBe(first.plannedAt);
      expect(openedPrefix.generated[0]!.basedOn).toEqual({ eventCount: first.basis.eventCount, hash: first.basis.eventHash });
      expect(openedPrefix.session.events.length).toBeGreaterThanOrEqual(first.basis.eventCount);

      const empty = await repo.readManagementCatalog();
      const emptyHits = watch.take();
      expect(emptyHits.hits).toEqual([]);
      expect(emptyHits.all).toEqual([]);
      expect(empty.reads).toEqual([]);
      expect(empty.memoryBytes).toBe(0);
      expect(empty.catalogue.map((entry) => entry.episodeId)).toContain(laterEpisodeId);
      const display = copy.entries.map((entry) => ({
        contentId: entry.id, version: 0,
        value: { title: entry.display.title, tags: entry.display.tags, note: entry.display.note }, updatedAt: entry.updatedAt,
      }));
      const lifecycle = copy.entries.map((entry) => ({
        contentId: entry.id, sourceKind: entry.sourceKind, version: 0, updatedAt: entry.updatedAt,
        value: { lifecycle: entry.lifecycle, trashedAt: entry.trashedAt, archiveVolumeId: entry.archiveVolumeId },
      }));
      await repo.updateManagement({
        bootstrap: { workspaceId, cursor: '0', changeSeq: 0, display, lifecycle, archive: { version: 0, volumes: [] }, archiveOrigin: [] },
      }, watching);
      const managementHits = watch.take();
      expect(managementHits.all).toEqual([]);
      expect(managementHits.hits.map((hit) => hit.key)).not.toContain(later.id);

      const reloaded = await repo.reloadCloudReading();
      const reloadHits = watch.take();
      expect(reloadHits.all).toEqual([]);
      expect(reloaded.reads.map((hit) => hit.key)).toEqual([first.id]);
      expect(reloadHits.hits.map((hit) => hit.key)).toEqual([first.id]);
      expect(reloaded.catalogue.map((entry) => entry.episodeId)).toContain(laterEpisodeId);

      const current = await repo.prepareCloudReading({ type: 'select', episode: first.episodeId });
      const currentHits = watch.take();
      expect(currentHits.all).toEqual([]);
      expect(current.reads.map((hit) => hit.key)).toEqual([first.id]);
      let laterRejected = false;
      try {
        await repo.prepareCloudReading({ type: 'select', episode: laterEpisodeId });
      } catch (error) {
        laterRejected = error instanceof Error && /重复/.test(error.message);
      }
      const laterHits = watch.take();
      expect(laterRejected).toBe(true);
      expect(laterHits.all).toEqual([]);
      expect(laterHits.hits.map((hit) => hit.key)).toEqual([first.id, later.id]);

      await repo.close();
      const coldRepo = new WorkspaceRepository(factory, namespace, watching);
      const cold = await coldRepo.prepareCloudReading();
      const coldHits = watch.take();
      expect(coldHits.all).toEqual([]);
      expect(cold.reads.map((hit) => hit.key)).toEqual([first.id]);
      expect(coldHits.hits.map((hit) => hit.key)).not.toContain(later.id);
      expect(cold.catalogue.map((entry) => entry.episodeId)).toContain(laterEpisodeId);

      const evidence = {
        ordinaryOpen: measure(opened),
        emptySyncPage: measure(empty),
        currentVersusLater: {
          current: measure(current),
          later: {
            reads: laterHits.hits,
            memoryBytes: laterHits.hits.reduce((sum, hit) => sum + hit.bytes, 0),
            catalogBytes: current.catalogBytes,
          },
        },
        offlineColdStart: measure(cold),
      };
      const text = `${JSON.stringify(evidence, null, 2)}\n`;
      console.log(text);
      if (process.env.ENDLESS_READER_EVIDENCE) writeFileSync(process.env.ENDLESS_READER_EVIDENCE, text);
      expect(evidence.ordinaryOpen.reads.map((hit) => hit.key)).toEqual([first.id]);
      expect(evidence.emptySyncPage.reads).toEqual([]);
      expect(evidence.emptySyncPage.memoryBytes).toBe(0);
      expect(evidence.currentVersusLater.current.reads.map((hit) => hit.key)).toEqual([first.id]);
      expect(evidence.currentVersusLater.later.reads.map((hit) => hit.key)).toEqual([first.id, later.id]);
      expect(evidence.offlineColdStart.reads.map((hit) => hit.key)).toEqual([first.id]);
      expect(evidence.ordinaryOpen.memoryBytes).toBeGreaterThan(0);
      expect(evidence.ordinaryOpen.catalogBytes).toBeGreaterThan(0);

      const comic = first.batch.scenes.find((scene) => scene.type === 'comic')!;
      const lines = await coldRepo.lookupCloudSource(first.id, comic.id);
      expect(lines.some((line) => line.includes('is here'))).toBe(true);
      expect(watch.take().hits.map((hit) => hit.key)).not.toContain(later.id);
      const sourcePrefix = restores.at(-1) as { session: { events: unknown[] }; generated: { hash: string; generatedAt: string; basedOn: { eventCount: number; hash: string } }[] };
      expect(sourcePrefix.session.events).toHaveLength(first.basis.eventCount);
      expect(sourcePrefix.generated.some((document) => document.hash === first.hash && document.generatedAt === first.plannedAt
        && document.basedOn.eventCount === first.basis.eventCount && document.basedOn.hash === first.basis.eventHash)).toBe(true);

      const cursorBefore = (await coldRepo.syncState()).cursor;
      const outboxBefore = await coldRepo.pendingOutbox();
      const scene = getScenes(cold.library.episodes.find((episode) => episode.id === first.episodeId)!)[0]!;
      const played = await coldRepo.playCloudReading({ type: 'advance', scene: scene.id, skip: false }, new Date(cloudTestTime));
      const playHits = watch.take();
      const outboxAfter = await coldRepo.pendingOutbox();
      expect(playHits.all).toEqual([]);
      expect(playHits.hits.map((hit) => hit.key)).not.toContain(later.id);
      expect(outboxAfter.length).toBeGreaterThan(outboxBefore.length);
      expect(outboxBefore.every((entry) => outboxAfter.some((item) => item.eventId === entry.eventId))).toBe(true);
      expect((await coldRepo.syncState()).cursor).toBe(cursorBefore);
      expect(played.repositoryRevision).toBe(cold.repositoryRevision + 1);
      const stored = await coldRepo.load();
      expect(stored!.revisions.find((revision) => revision.id === first.id)).toMatchObject({ draft: first.draft, batch: first.batch });
      expect(stored!.identity.repositoryRevision).toBe(played.repositoryRevision);
      await coldRepo.close();
    } finally {
      watch.restore();
      await repo.close().catch(() => {});
    }
  });

  it('坏摘要、缺叶、未知契约和错误引用不推进游标，也不丢掉已有 Outbox', async () => {
    const comic = first.batch.scenes.find((item) => item.type === 'comic')!;
    for (const mode of ['digest', 'missing', 'contract', 'reference'] as const) {
      const { factory, namespace, repo } = await installed();
      const played = await repo.playCloudReading({ type: 'advance', scene: comic.id, skip: false }, new Date(cloudTestTime));
      const cursor = (await repo.syncState()).cursor;
      const outbox = await repo.pendingOutbox();
      const revision = await repositoryRevision(factory, namespace);
      expect(revision).toBe(played.repositoryRevision);
      expect(outbox.length).toBeGreaterThan(0);
      if (mode === 'digest') {
        await editIndex(factory, namespace, (index) => {
          for (const header of index.revisions) {
            if (header.origin !== 'bundled' && header.id === first.id) header.leaf = { ...header.leaf, sha256: '0'.repeat(64) };
          }
          for (const linked of index.contentRevisions) {
            if (linked.revisionId === first.id) linked.leaf = { ...linked.leaf, sha256: '0'.repeat(64) };
          }
        });
      } else if (mode === 'missing') {
        await withDatabase(factory, namespace, (db) => new Promise<void>((resolve, reject) => {
          const tx = db.transaction('revisions', 'readwrite');
          tx.objectStore('revisions').delete(first.id);
          tx.oncomplete = () => resolve();
          tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('删除失败'));
        }));
      } else if (mode === 'contract') {
        await withDatabase(factory, namespace, async (db) => {
          const body = await request<Record<string, unknown>>(db, 'revisions', first.id);
          await writeRow(db, 'revisions', first.id, { ...body, contract: 'foreign/1' });
        });
      } else {
        const objectId = crypto.randomUUID();
        await editIndex(factory, namespace, (index) => {
          for (const header of index.revisions) {
            if (header.origin !== 'bundled' && header.id === first.id) header.leaf = { ...header.leaf, objectId };
          }
          for (const linked of index.contentRevisions) {
            if (linked.revisionId === first.id) linked.leaf = { ...linked.leaf, objectId };
          }
        });
      }
      const pattern = mode === 'digest' ? /摘要/ : mode === 'missing' ? /缺少正文/ : mode === 'contract' ? /未知契约/ : /身份/;
      await expect(repo.prepareCloudReading()).rejects.toThrow(pattern);
      expect((await repo.syncState()).cursor).toBe(cursor);
      expect(await repo.pendingOutbox()).toEqual(outbox);
      expect(await repositoryRevision(factory, namespace)).toBe(revision);
      await repo.close();
    }
  });

  it('读取正文期间另一窗口写入时不返回这片叶', async () => {
    const { factory, namespace, repo } = await installed();
    const opened = await repo.prepareCloudReading();
    const stamp = { token: opened.view.cacheToken, revision: opened.repositoryRevision };
    const cursor = (await repo.syncState()).cursor;
    const outbox = await repo.pendingOutbox();
    const originalGet = IDBObjectStore.prototype.get;
    let armed = true;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, query) {
      const request = originalGet.call(this, query);
      if (armed && this.name === 'revisions' && String(query) === first.id) {
        request.addEventListener('success', () => {
          armed = false;
          const db = request.transaction?.db;
          if (!db) return;
          const tx = db.transaction('meta', 'readwrite');
          const row = tx.objectStore('meta').get('cloud-reader-index');
          row.onsuccess = () => {
            const index = row.result;
            if (!index) return;
            index.token = crypto.randomUUID();
            tx.objectStore('meta').put(index, 'cloud-reader-index');
          };
        });
      }
      return request;
    });
    try {
      await expect(repo.readCloudLeaf(first.id, stamp)).rejects.toThrow(/另一个窗口/);
    } finally {
      spy.mockRestore();
    }
    expect(armed).toBe(false);
    expect((await repo.syncState()).cursor).toBe(cursor);
    expect(await repo.pendingOutbox()).toEqual(outbox);
    expect(await repositoryRevision(factory, namespace)).toBe(opened.repositoryRevision);
    await repo.close();
  });

  it('另一窗口已提交后，旧的正文戳记不能取回叶', async () => {
    const { factory, namespace, repo } = await installed();
    const opened = await repo.prepareCloudReading();
    const stamp = { token: opened.view.cacheToken, revision: opened.repositoryRevision };
    const cursor = (await repo.syncState()).cursor;
    const outbox = await repo.pendingOutbox();
    const other = new WorkspaceRepository(factory, namespace, content);
    const held = await other.load();
    await other.commit({ ...held!, identity: { ...held!.identity, repositoryRevision: held!.identity.repositoryRevision + 1 } });
    await expect(repo.readCloudLeaf(first.id, stamp)).rejects.toThrow(/另一个窗口/);
    expect((await repo.syncState()).cursor).toBe(cursor);
    expect(await repo.pendingOutbox()).toEqual(outbox);
    expect(await repositoryRevision(factory, namespace)).toBe(held!.identity.repositoryRevision + 1);
    const still = await other.load();
    expect(still!.revisions.find((revision) => revision.id === first.id)).toMatchObject({ draft: first.draft });
    expect(still!.revisions.find((revision) => revision.id === later.id)).toMatchObject({ draft: later.draft });
    await Promise.all([repo.close(), other.close()]);
  });

  it('游客库里的 endless-workspace 文档仍按原样读取', async () => {
    const factory = new IDBFactory();
    const source = cloudTestWorkspace();
    const guest = new GuestWorkspaceRepository(factory);
    await guest.commit(source);
    const loaded = await guest.load();
    const byId = (workspace: Workspace) => ({
      ...workspace,
      revisions: [...workspace.revisions].sort((a, b) => a.id.localeCompare(b.id)),
      branches: [...workspace.branches].sort((a, b) => a.id.localeCompare(b.id)),
    });
    expect(byId(loaded!)).toEqual(byId(source));
    expect(loaded!.revisions.every((revision) => 'hash' in revision)).toBe(true);
    await guest.close();
  });
});
