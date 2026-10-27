import { ContractError, describeUnsupportedSave, type Workspace } from '@endless/content';
import { assembleWorkspace, workspaceRows } from './records.js';
/** Shared IDB layout and native rows only. Adapters own namespace validation and transactions. */
export abstract class WorkspaceDatabase {
  private database: Promise<IDBDatabase>;
  private closed = false;
  constructor(factory: IDBFactory = globalThis.indexedDB, readonly namespace: string, private readonly extraSnapshotStores: readonly string[] = []) {
    this.database = new Promise((resolve, reject) => {
      if (!factory) {
        reject(new Error('当前浏览器无法使用本地存储，请使用普通模式的 Edge 或 Chrome'));
        return;
      }
      // 版本 2 只新增 store，不动既有结构与数据：旧库原地升级，不重建、不清空。
      const request = factory.open(namespace, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of ['meta', 'revisions', 'branches', 'objects', 'staging', 'outbox', 'eventIds', 'sync']) {
          if (!db.objectStoreNames.contains(name))
            db.createObjectStore(name);
        }
      };
      request.onsuccess = () => {
        // 外部升级库版本：关闭连接并标记，此后本实例只读失败提示可操作错误，
        // 不在未知结构上继续写；库内容不被删改。
        request.result.onversionchange = () => { request.result.close(); this.closed = true; };
        resolve(request.result);
      };
      request.onerror = () => reject(new Error('无法打开本地存档，请检查浏览器存储权限'));
      request.onblocked = () => reject(new Error('存档正在被其他窗口使用，请关闭旧窗口后重试'));
    });
  }
  protected async db(): Promise<IDBDatabase> {
    if (this.closed)
      throw new Error('本地存档连接已因版本变更或显式关闭而失效，请刷新页面；原始数据未被修改');
    return this.database;
  }
  protected rows(workspace: Workspace) { return workspaceRows(workspace); }
  protected assemble(...args: Parameters<typeof assembleWorkspace>) { return assembleWorkspace(...args); }
  async load(): Promise<Workspace | null> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'revisions', 'branches', 'objects'], 'readonly');
      const out = { revisions: [] as any[], branches: [] as any[], objects: [] as any[] };
      let meta: any = null;
      tx.objectStore('meta').get('workspace').onsuccess = (e) => { meta = (e.target as IDBRequest).result ?? null; };
      tx.objectStore('revisions').getAll().onsuccess = (e) => { out.revisions = (e.target as IDBRequest).result ?? []; };
      tx.objectStore('branches').getAll().onsuccess = (e) => { out.branches = (e.target as IDBRequest).result ?? []; };
      tx.objectStore('objects').getAll().onsuccess = (e) => { out.objects = (e.target as IDBRequest).result ?? []; };
      tx.oncomplete = () => {
        try {
          if (!meta) {
            // meta 丢了但其它 store 还有数据：按损坏存档报错，不能当成「首次使用」把数据清掉
            if (out.revisions.length || out.branches.length || out.objects.length) {
              reject(new Error('本地存档缺少 meta 行但仍有修订或分支数据；已按损坏存档处理，原始数据未被修改'));
              return;
            }
            resolve(null);
            return;
          }
          resolve(this.assemble(meta, out.revisions, out.branches, out.objects, meta.management ?? []));
        }
        catch (error) {
          reject(error instanceof ContractError
            ? new Error(`${error.message}；原始数据已保留，可在错误提示里下载原始存档`)
            : new Error(describeUnsupportedSave(meta)));
        }
      };
      tx.onabort = () => reject(new Error('读取本地存档失败，已有数据未被修改'));
      tx.onerror = () => reject(new Error('读取本地存档失败，已有数据未被修改'));
    });
  }
  async rawSnapshot(): Promise<unknown> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const extras = this.extraSnapshotStores;
      const tx = db.transaction(['meta', 'revisions', 'branches', 'objects', 'staging', ...extras], 'readonly');
      const out: Record<string, unknown> = { meta: null, revisions: [], branches: [], objects: [], staging: [] };
      tx.objectStore('meta').get('workspace').onsuccess = (e) => { out.meta = (e.target as IDBRequest).result ?? null; };
      tx.objectStore('revisions').getAll().onsuccess = (e) => { out.revisions = (e.target as IDBRequest).result ?? []; };
      tx.objectStore('branches').getAll().onsuccess = (e) => { out.branches = (e.target as IDBRequest).result ?? []; };
      tx.objectStore('objects').getAll().onsuccess = (e) => { out.objects = (e.target as IDBRequest).result ?? []; };
      tx.objectStore('staging').getAll().onsuccess = (e) => { out.staging = (e.target as IDBRequest).result ?? []; };
      for (const name of extras) {
        const rows: {
          key: IDBValidKey;
          value: unknown;
        }[] = [];
        out[name] = rows;
        const request = tx.objectStore(name).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor)
            return;
          rows.push({ key: cursor.key, value: cursor.value });
          cursor.continue();
        };
      }
      tx.oncomplete = () => resolve(out);
      tx.onabort = () => reject(new Error('读取原始存档失败'));
      tx.onerror = () => reject(new Error('读取原始存档失败'));
    });
  }
  async rawMeta(): Promise<unknown> {
    return (await this.rawSnapshot() as {
      meta: unknown;
    }).meta;
  }
  async stage(key: string, value: unknown): Promise<void> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('staging', 'readwrite');
      tx.objectStore('staging').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error('暂存导入对象失败'));
      tx.onerror = () => reject(new Error('暂存导入对象失败'));
    });
  }
  async staged(key: string): Promise<unknown> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('staging', 'readonly');
      const req = tx.objectStore('staging').get(key);
      tx.oncomplete = () => resolve(req.result ?? null);
      tx.onabort = () => reject(new Error('读取暂存对象失败'));
      tx.onerror = () => reject(new Error('读取暂存对象失败'));
    });
  }
  async clearStaging(): Promise<void> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('staging', 'readwrite');
      tx.objectStore('staging').clear();
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error('清理暂存对象失败'));
      tx.onerror = () => reject(new Error('清理暂存对象失败'));
    });
  }
  async close(): Promise<void> {
    if (this.closed)
      return;
    this.closed = true;
    (await this.database).close();
  }
}
