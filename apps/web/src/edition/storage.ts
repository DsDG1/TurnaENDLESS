/**
 * `endless-editions` 伴随仓库（设计文档 §13.2、§13.3）。
 *
 * 与 `endless-workspace` 完全独立：不解析、不迁移、不重置旧 ENDLESS 存档；
 * 这里出错只影响 Edition 的安装与阅读。
 *
 * 每个命令先在内存完成纯函数校验（`@endless/content` 的 edition 命名空间），
 * 再在**一个** IDB 事务里：校验 repositoryRevision 与 Run 事件前缀 → 写不可变对象 /
 * 事件与采用关系 → 更新根引用 → repositoryRevision + 1。
 * 摘要、网络、模型与大编译都在事务外完成，避免异步等待让事务失活。
 */
import { edition } from '@endless/content';
import { prepareReaderRestore } from './backup-restore.js';

const DB_NAME = 'endless-editions';
const DB_VERSION = 1;
const CHUNK_SIZE = 128;

export interface InstalledIssue {
  releaseId: string;
  issueId: string;
  editionId: string;
  editorialRevisionId: string;
  cefr: string;
  packageDigest: string;
  installedAt: string;
  supersededBy: string | null;
}

export interface EditionStore {
  revision: number;
  installs: InstalledIssue[];
  packages: edition.EditionPublicationPackage[];
  runs: edition.EditionRun[];
  reviews: edition.ReviewRevision[];
  management: ManagementRow[];
}

export type ManagementRow = edition.ReaderManagement;

interface RootRow { key: 'root'; revision: number; editions: string[] }

const chunkKey = (runId: string, index: number) => `${runId}:${String(index).padStart(6, '0')}`;

export class EditionRepository {
  private database: Promise<IDBDatabase>;

  constructor(factory: IDBFactory = globalThis.indexedDB) {
    this.database = new Promise((resolve, reject) => {
      if (!factory) {
        reject(new Error('当前浏览器无法使用本地存储，Edition 阅读已禁用；原有 ENDLESS 离线体验不受影响'));
        return;
      }
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('objects')) db.createObjectStore('objects');
        if (!db.objectStoreNames.contains('references')) db.createObjectStore('references');
        if (!db.objectStoreNames.contains('installs')) db.createObjectStore('installs');
        if (!db.objectStoreNames.contains('runs')) db.createObjectStore('runs');
        if (!db.objectStoreNames.contains('eventChunks')) db.createObjectStore('eventChunks');
        if (!db.objectStoreNames.contains('projections')) db.createObjectStore('projections');
        if (!db.objectStoreNames.contains('reviews')) db.createObjectStore('reviews');
        if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs');
        if (!db.objectStoreNames.contains('staging')) db.createObjectStore('staging');
        if (!db.objectStoreNames.contains('management')) db.createObjectStore('management');
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(new Error('无法打开 Edition 本地存储；不会重置或删除已有内容'));
      request.onblocked = () => reject(new Error('Edition 存储正被其他窗口占用；请关闭旧窗口后再试'));
    });
  }

  async load(): Promise<EditionStore> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'installs', 'objects', 'runs', 'reviews', 'eventChunks', 'management'], 'readonly');
      let root: RootRow | null = null;
      let installs: InstalledIssue[] = [];
      let rows: (edition.EditionRun & { eventCount?: number; prefixHash?: string })[] = [];
      let reviews: edition.ReviewRevision[] = [];
      let management: ManagementRow[] = [];
      const objects = new Map<string, { digest: string; body: edition.EditionPublicationPackage }>();
      const chunks = new Map<string, edition.EvidenceEvent[]>();
      tx.objectStore('meta').get('root').onsuccess = (event) => { root = (event.target as IDBRequest).result ?? null; };
      tx.objectStore('installs').getAll().onsuccess = (event) => { installs = (event.target as IDBRequest).result ?? []; };
      tx.objectStore('runs').getAll().onsuccess = (event) => { rows = (event.target as IDBRequest).result ?? []; };
      tx.objectStore('reviews').getAll().onsuccess = (event) => { reviews = (event.target as IDBRequest).result ?? []; };
      tx.objectStore('management').getAll().onsuccess = (event) => { management = (event.target as IDBRequest).result ?? []; };
      tx.objectStore('objects').getAll().onsuccess = (event) => {
        for (const row of (event.target as IDBRequest).result as { type: string; id: string; digest: string; body: edition.EditionPublicationPackage }[]) {
          if (row.type === 'package') objects.set(row.id, row);
        }
      };
      tx.objectStore('eventChunks').getAll().onsuccess = (event) => {
        for (const chunk of (event.target as IDBRequest).result as { runId: string; index: number; events: edition.EvidenceEvent[] }[]) {
          chunks.set(chunk.runId, [...(chunks.get(chunk.runId) ?? []), ...chunk.events]);
        }
      };
      tx.oncomplete = () => {
        try {
          const runs = rows.map((row) => {
            const stored = chunks.get(row.id) ?? [];
            const events = stored.length ? stored : row.events;
            if (row.eventCount !== undefined && row.eventCount !== events.length) {
              throw new Error(`Run ${row.id} 的事件数与保存记录不一致；原始数据未被修改`);
            }
            const run = edition.readerRun({ ...row, events } as edition.EditionRun);
            if (row.prefixHash && edition.eventPrefixHash(run) !== row.prefixHash) {
              throw new Error(`Run ${row.id} 的事件前缀摘要不一致；原始数据未被修改`);
            }
            return run;
          });
          const packages = installs.map((install) => {
            const object = objects.get(install.releaseId);
            if (!object || object.digest !== install.packageDigest || edition.publicationIssues(object.body).length) {
              throw new Error(`发行 ${install.releaseId} 的安装数据缺失或不兼容；原始数据未被修改`);
            }
            return object.body;
          });
          resolve({
            revision: root?.revision ?? 0, installs, packages,
            runs, reviews,
            management: management.sort((a, b) => a.at.localeCompare(b.at)),
          });
        } catch (error) {
          reject(error);
        }
      };
      tx.onerror = () => reject(new Error('读取 Edition 存档失败；原始数据未被修改'));
      tx.onabort = () => reject(new Error('读取 Edition 存档被中断；原始数据未被修改'));
    });
  }

  /**
   * 安装（或更正）一期：先校验 manifest、单元摘要与引用闭包，再单事务激活。
   * staging 未完成的内容永远不会出现在可读目录里。
   */
  async activateInstall(pkg: edition.EditionPublicationPackage, expectedRevision: number, now = new Date()): Promise<EditionStore> {
    const issues = edition.publicationIssues(pkg);
    if (issues.length) throw new Error(issues.map((entry) => `${entry.code}：${entry.message}`).join('；'));
    const release = pkg.release;
    const db = await this.database;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['meta', 'installs', 'objects', 'references', 'management'], 'readwrite');
      let error = 'Edition 安装失败；原有已安装内容与阅读记录保持不变';
      const meta = tx.objectStore('meta');
      const getRoot = meta.get('root');
      getRoot.onsuccess = () => {
        const root = (getRoot.result as RootRow | undefined) ?? { key: 'root', revision: 0, editions: [] };
        if (root.revision !== expectedRevision) {
          error = '另一个窗口已更新 Edition 内容，请刷新后继续，避免覆盖已有安装';
          tx.abort();
          return;
        }
        const installs = tx.objectStore('installs');
        const existing = installs.get(release.id);
        existing.onsuccess = () => {
          const previous = existing.result as InstalledIssue | undefined;
          if (previous && previous.packageDigest !== pkg.digest) {
            error = `发行 ${release.id} 已被另一份内容占用，不能静默覆盖`;
            tx.abort();
            return;
          }
          const at = now.toISOString();
          const row: InstalledIssue = {
            releaseId: release.id,
            issueId: release.issueId,
            editionId: release.editionId,
            editorialRevisionId: release.editorialRevisionId,
            cefr: release.cefr,
            packageDigest: pkg.digest,
            installedAt: previous?.installedAt ?? at,
            supersededBy: release.supersededBy,
          };
          installs.put(row, release.id);
          // 补正关系要双向可见：安装一份 supersedes 旧版的发行时，旧行要记下被谁取代
          const supersedes = release.supersedes;
          if (supersedes) {
            const previousInstall = installs.get(supersedes);
            previousInstall.onsuccess = () => {
              const old = previousInstall.result as InstalledIssue | undefined;
              if (old && old.supersededBy !== release.id) {
                installs.put({ ...old, supersededBy: release.id }, supersedes);
              }
            };
          }
          const putImmutable = (key: string, type: string, id: string, digest: string, body: unknown) => {
            const objects = tx.objectStore('objects');
            const stored = objects.get(key);
            stored.onsuccess = () => {
              const previous = stored.result as { digest: string; body: unknown } | undefined;
              if (previous && (previous.digest !== digest || edition.digestOf(previous.body) !== edition.digestOf(body))) {
                error = `对象 ${id} 已存在且内容不同，不能覆盖其他期刊的依据`;
                tx.abort();
                return;
              }
              objects.put({ key, type, id, digest, body }, key);
            };
          };
          // 安装读取用完整包；导出与引用检查用不可变的 Release 本体
          putImmutable(`package:${release.id}`, 'package', release.id, pkg.digest, pkg);
          putImmutable(`release:${release.id}`, 'release', release.id, release.digest, release);
          putImmutable(`pack:${pkg.pack.id}`, 'pack', pkg.pack.id, pkg.pack.digest, pkg.pack);
          for (const unit of pkg.units) {
            const digest = edition.digestOf(unit.batch);
            putImmutable(`unit:${unit.revisionId}`, 'unit', unit.revisionId, digest, unit);
            tx.objectStore('references').put({ key: `${release.id}:${unit.revisionId}`, releaseId: release.id, unitId: unit.revisionId, digest }, `${release.id}:${unit.revisionId}`);
          }
          tx.objectStore('management').put({
            id: `mge_${release.id}_${at}`, at, op: 'install', targets: [release.id, release.issueId],
            detail: `${release.cefr} · ${pkg.units.length} 单元`,
          }, `mge_${release.id}_${at}`);
          meta.put({ key: 'root', revision: root.revision + 1, editions: [...new Set([...root.editions, release.editionId])] } satisfies RootRow, 'root');
        };
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error(error));
      tx.onerror = () => reject(new Error(error));
    });
    return this.load();
  }

  /**
   * 提交一次 Run（含本次新增的复习修订）。
   * 事务内复核：repositoryRevision、事件前缀、eventId 去重。
   */
  async commitRun(
    run: edition.EditionRun,
    expectedRevision: number,
    options: { reviews?: readonly edition.ReviewRevision[]; projection?: unknown } = {},
  ): Promise<void> {
    run = edition.readerRun(run);
    for (const review of options.reviews ?? []) {
      if (review.runId !== run.id) throw new Error('复习修订不属于该 Run');
      edition.ReviewRevisionSchema.parse(review);
      if (review.digest !== edition.reviewDigest(review)) throw new Error('复习修订摘要不一致');
    }
    const snapshot = await this.load();
    if (snapshot.revision !== expectedRevision) throw new Error('另一个窗口已更新 Edition 进度，请刷新后继续');
    const previousRun = snapshot.runs.find((entry) => entry.id === run.id);
    if (previousRun) edition.assertReaderRunExtension(previousRun, run);
    const reviewMap = new Map(snapshot.reviews.map((entry) => [entry.id, entry]));
    for (const review of options.reviews ?? []) {
      const previous = reviewMap.get(review.id);
      if (previous && edition.digestOf(previous) !== edition.digestOf(review)) throw new Error('复习修订已存在且内容不同，不能覆盖历史');
      reviewMap.set(review.id, review);
    }
    edition.assertReaderState(snapshot.packages,
      [...snapshot.runs.filter((entry) => entry.id !== run.id), run], [...reviewMap.values()]);
    const db = await this.database;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['meta', 'runs', 'eventChunks', 'reviews', 'projections', 'management'], 'readwrite');
      let error = 'Edition 进度保存失败；本次操作尚未提交';
      const meta = tx.objectStore('meta');
      const getRoot = meta.get('root');
      getRoot.onsuccess = () => {
        const root = (getRoot.result as RootRow | undefined) ?? { key: 'root', revision: 0, editions: [] };
        if (root.revision !== expectedRevision) {
          error = '另一个窗口已更新 Edition 进度，请刷新后继续，避免覆盖已读记录';
          tx.abort();
          return;
        }
        const runs = tx.objectStore('runs');
        const stored = runs.get(run.id);
        stored.onsuccess = () => {
          const previous = stored.result as (edition.EditionRun & { eventCount?: number; prefixHash?: string }) | undefined;
          const storedCount = previous?.eventCount ?? 0;
          if (previous) {
            if (storedCount > run.events.length) {
              error = '已保存的事件比提交的更多，拒绝回退历史';
              tx.abort();
              return;
            }
            const prefix = edition.eventPrefixHash({ ...run, events: run.events.slice(0, storedCount) });
            if (previous.prefixHash && prefix !== previous.prefixHash) {
              error = '已发生的事件被改写或删除，拒绝提交';
              tx.abort();
              return;
            }
          }
          const from = storedCount;
          if (run.events.length > from) {
            for (let start = Math.floor(from / CHUNK_SIZE) * CHUNK_SIZE; start < run.events.length; start += CHUNK_SIZE) {
              const index = start / CHUNK_SIZE;
              const events = run.events.slice(start, start + CHUNK_SIZE);
              tx.objectStore('eventChunks').put({ key: chunkKey(run.id, index), runId: run.id, index, events }, chunkKey(run.id, index));
            }
          }
          // 事件正文只在 chunk 里；runs 行只保存计数与前缀摘要，用于 CAS 与恢复
          runs.put({ ...run, events: [], eventCount: run.events.length, prefixHash: edition.eventPrefixHash(run) }, run.id);
          if (options.projection !== undefined) {
            tx.objectStore('projections').put({
              key: run.id, runId: run.id, eventHash: run.events.at(-1)?.hash ?? 'genesis',
              eventCount: run.events.length, state: options.projection,
            }, run.id);
          }
          for (const review of options.reviews ?? []) {
            const reviews = tx.objectStore('reviews');
            const existing = reviews.get(review.id);
            existing.onsuccess = () => {
              if (existing.result && edition.digestOf(existing.result) !== edition.digestOf(review)) {
                error = '复习修订已存在且内容不同，不能覆盖历史';
                tx.abort();
                return;
              }
              reviews.put(review, review.id);
            };
          }
          tx.objectStore('management').put({
            id: `mge_run_${run.id}_${run.revision}`, at: new Date().toISOString(), op: 'run',
            targets: [run.id], detail: `${run.events.length} 事件`,
          }, `mge_run_${run.id}_${run.revision}`);
          meta.put({ key: 'root', revision: root.revision + 1, editions: [...new Set([...root.editions, run.editionId])] } satisfies RootRow, 'root');
        };
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error(error));
      tx.onerror = () => reject(new Error(error));
    });
  }

  /** 导出：容器只包含不可变对象与 Run，不含 Key、任务响应或服务器配置。 */
  async exportBackup(now = new Date()): Promise<string> {
    const store = await this.load();
    if (!store.packages.length) throw new Error('没有可导出的 Edition 内容');
    const container = edition.buildBackupContainer({
      pack: store.packages[0]!.pack,
      installs: store.packages,
      runs: store.runs,
      reviews: store.reviews,
      management: store.management,
      repositoryRevision: store.revision,
      createdAt: now.toISOString(),
      cutoff: null,
    });
    return edition.serializeContainer(container);
  }

  /** Validate outside IDB, then activate the entire reader backup in one CAS transaction. */
  async importBackup(text: string, options: { trustReviewed?: boolean } = {}): Promise<{ installs: number; runs: number; skipped: number; ignored: string[] }> {
    const current = await this.load();
    const plan = prepareReaderRestore(current, text, options.trustReviewed === true);
    if (!plan.writes.length) return plan.result;
    const db = await this.database;
    await new Promise<void>((resolve, reject) => {
      const stores = ['meta', ...new Set(plan.writes.map((write) => write.store))];
      const tx = db.transaction(stores, 'readwrite');
      let error = '阅读备份恢复失败，原有安装与阅读记录保持不变';
      const meta = tx.objectStore('meta');
      const root = meta.get('root');
      root.onsuccess = () => {
        const previous = root.result as RootRow | undefined;
        if ((previous?.revision ?? 0) !== plan.expectedRevision) {
          error = '另一个窗口已更新 Edition 内容，请刷新后重新导入；没有激活任何内容';
          tx.abort();
          return;
        }
        try {
          for (const write of plan.writes) tx.objectStore(write.store).put(write.value, write.key);
          meta.put({
            key: 'root', revision: plan.expectedRevision + 1,
            editions: [...new Set([...(previous?.editions ?? []), ...plan.editions])],
          } satisfies RootRow, 'root');
        } catch {
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error(error));
      tx.onerror = () => reject(new Error(error));
    });
    return plan.result;
  }

  async stage(key: string, value: unknown): Promise<void> {
    const db = await this.database;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('staging', 'readwrite');
      tx.objectStore('staging').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('暂存 Edition 对象失败；没有激活任何内容'));
    });
  }

  async staged<T>(key: string): Promise<T | null> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('staging', 'readonly');
      const request = tx.objectStore('staging').get(key);
      tx.oncomplete = () => resolve((request.result as T) ?? null);
      tx.onerror = () => reject(new Error('读取暂存对象失败'));
    });
  }

  async clearStaging(): Promise<void> {
    const db = await this.database;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('staging', 'readwrite');
      tx.objectStore('staging').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('清理暂存对象失败'));
    });
  }

  async close(): Promise<void> {
    (await this.database).close();
  }
}

/** 跨标签页提示：BroadcastChannel 只是提醒刷新，不能替代事务与 CAS。 */
export function watchEditionChanges(onChange: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel('endless-editions');
  channel.onmessage = () => onChange();
  return () => channel.close();
}

export function notifyEditionChange(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel('endless-editions');
  channel.postMessage({ at: new Date().toISOString() });
  channel.close();
}
