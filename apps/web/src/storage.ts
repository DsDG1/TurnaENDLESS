import {
  ContractError, describeUnsupportedSave, parseWorkspace,
  type Workspace, type WorkspaceIdentity,
} from '@endless/content';

/**
 * `endless-workspace` 本地仓库：多对象存储 + repositoryRevision CAS。
 * 一次命令 → 先在内存完成校验（content 包），再由这里一次事务原子提交。
 * 进行中生成任务（reserved/submitted）冻结其它写入口，直到它被提交或取消。
 * 不读取旧 `endless-player` 库，也不自动清理旧命名空间。
 */
export class WorkspaceRepository {
  private database: Promise<IDBDatabase>;

  constructor(factory: IDBFactory = globalThis.indexedDB) {
    this.database = new Promise((resolve, reject) => {
      if (!factory) {
        reject(new Error('当前浏览器无法使用本地存储，请使用普通模式的 Edge 或 Chrome'));
        return;
      }
      const request = factory.open('endless-workspace', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('meta');
        db.createObjectStore('revisions');
        db.createObjectStore('branches');
        db.createObjectStore('objects');
        db.createObjectStore('staging');
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(new Error('无法打开本地存档，请检查浏览器存储权限'));
      request.onblocked = () => reject(new Error('存档正在被其他窗口使用，请关闭旧窗口后重试'));
    });
  }

  /** 把 Workspace 拆成各 store 的行；返回 meta 行。 */
  private rows(workspace: Workspace) {
    return {
      meta: { key: 'workspace', identity: workspace.identity, profile: workspace.profile, entries: workspace.entries, obligations: workspace.obligations, activeBranchId: workspace.activeBranchId },
      revisions: workspace.revisions,
      branches: workspace.branches,
      objects: [
        ...workspace.volumes.map((v) => ({ kind: 'volume', ...v })),
        ...workspace.checkpoints.map((c) => ({ kind: 'checkpoint', ...c })),
        ...workspace.tickets.map((t) => ({ kind: 'ticket', ...t })),
      ],
      management: workspace.management,
    };
  }

  private assemble(meta: any, revisions: any[], branches: any[], objects: any[], management: any[]): Workspace {
    const workspace: Workspace = {
      identity: meta.identity,
      profile: meta.profile,
      entries: meta.entries,
      obligations: meta.obligations,
      activeBranchId: meta.activeBranchId,
      revisions,
      branches,
      volumes: objects.filter((o) => o.kind === 'volume'),
      checkpoints: objects.filter((o) => o.kind === 'checkpoint'),
      tickets: objects.filter((o) => o.kind === 'ticket'),
      management,
    };
    // 走完整契约校验：结构合法但引用闭包坏掉的存档不能进界面（否则渲染期才炸）
    return parseWorkspace(workspace);
  }

  async load(): Promise<Workspace | null> {
    const db = await this.database;
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
        } catch (error) {
          reject(error instanceof ContractError
            ? new Error(`${error.message}；原始数据已保留，可在错误提示里下载原始存档`)
            : new Error(describeUnsupportedSave(meta)));
        }
      };
      tx.onabort = () => reject(new Error('读取本地存档失败，已有数据未被修改'));
      tx.onerror = () => reject(new Error('读取本地存档失败，已有数据未被修改'));
    });
  }

  /** 原子提交：校验 repositoryRevision，并冻结进行中任务之外的写入。 */
  async commit(next: Workspace, options: { closingTicketId?: string } = {}): Promise<void> {
    const db = await this.database;
    const rows = this.rows(next);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'revisions', 'branches', 'objects', 'staging'], 'readwrite');
      let error = '保存失败，请检查可用空间后重试。本次操作尚未提交';
      const metaStore = tx.objectStore('meta');
      const getMeta = metaStore.get('workspace');
      getMeta.onsuccess = () => {
        const stored = getMeta.result as { identity?: WorkspaceIdentity; management?: unknown[] } | undefined;
        const storedRev = stored?.identity?.repositoryRevision ?? -1;
        const expected = next.identity.repositoryRevision - 1;
        if (stored && storedRev !== expected) {
          error = '另一个窗口已更新进度，请刷新后继续，避免覆盖已有记录';
          tx.abort();
          return;
        }
        if (!stored && next.identity.repositoryRevision !== 0) {
          error = '存档版本不匹配，请刷新后继续';
          tx.abort();
          return;
        }
        const openTickets = next.tickets.filter((t) => t.status === 'reserved' || t.status === 'submitted');
        if (openTickets.length > 1) {
          error = '存在多个进行中的生成任务，状态不一致';
          tx.abort();
          return;
        }
        const revStore = tx.objectStore('revisions');
        revStore.clear();
        for (const revision of rows.revisions) revStore.put(revision, revision.id);
        const branchStore = tx.objectStore('branches');
        branchStore.clear();
        for (const branch of rows.branches) branchStore.put(branch, branch.id);
        const objectStore = tx.objectStore('objects');
        objectStore.clear();
        for (const object of rows.objects) objectStore.put(object, object.id);
        metaStore.put({ ...rows.meta, management: rows.management }, 'workspace');
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error(error));
      tx.onerror = () => reject(new Error(error));
    });
  }

  /**
   * 原始快照：存档损坏时下载全部 store，不校验、不解释、不覆盖。
   * 只导 meta 会丢掉修订与分支，用户拿到的「原始数据」其实不完整。
   */
  async rawSnapshot(): Promise<unknown> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'revisions', 'branches', 'objects', 'staging'], 'readonly');
      const out: Record<string, unknown> = { meta: null, revisions: [], branches: [], objects: [], staging: [] };
      tx.objectStore('meta').get('workspace').onsuccess = (e) => { out.meta = (e.target as IDBRequest).result ?? null; };
      tx.objectStore('revisions').getAll().onsuccess = (e) => { out.revisions = (e.target as IDBRequest).result ?? []; };
      tx.objectStore('branches').getAll().onsuccess = (e) => { out.branches = (e.target as IDBRequest).result ?? []; };
      tx.objectStore('objects').getAll().onsuccess = (e) => { out.objects = (e.target as IDBRequest).result ?? []; };
      tx.objectStore('staging').getAll().onsuccess = (e) => { out.staging = (e.target as IDBRequest).result ?? []; };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(new Error('读取原始存档失败'));
    });
  }

  /** 原始 meta 行（不校验），保留给只需要顶层行的调用方。 */
  async rawMeta(): Promise<unknown> {
    return (await this.rawSnapshot() as { meta: unknown }).meta;
  }

  /** 导入暂存：大文件先在隔离区校验，确认后一次事务发布，不让暂存对象被当正式数据。 */
  async stage(key: string, value: unknown): Promise<void> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('staging', 'readwrite');
      tx.objectStore('staging').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('暂存导入对象失败'));
    });
  }

  async staged(key: string): Promise<unknown> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('staging', 'readonly');
      const req = tx.objectStore('staging').get(key);
      tx.oncomplete = () => resolve(req.result ?? null);
      tx.onerror = () => reject(new Error('读取暂存对象失败'));
    });
  }

  async clearStaging(): Promise<void> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
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

export function downloadSession(value: unknown, name = `endless-workspace-${new Date().toISOString().slice(0, 10)}.endless.json`): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
