import {
  ContractError, describeUnsupportedSave, parseWorkspace,
  type Workspace, type WorkspaceIdentity,
} from '@endless/content';
import type { CloudImportReceipt, WorkspaceInstallation } from '@endless/cloud-contracts';
import { cloudDigest, isCloudNamespace, parseCloudInstallation, type CloudLocalInstallation } from './cloud/local.js';

/**
 * `endless-workspace` 本地仓库：多对象存储 + repositoryRevision CAS。
 * 一次命令 → 先在内存完成校验（content 包），再由这里一次事务原子提交。
 * 进行中生成任务（reserved/submitted）冻结其它写入口，直到它被提交或取消。
 * 不读取旧 `endless-player` 库，也不自动清理旧命名空间。
 */
export class WorkspaceRepository {
  private database: Promise<IDBDatabase>;
  private closed = false;

  constructor(factory: IDBFactory = globalThis.indexedDB, readonly namespace = 'endless-workspace') {
    if (namespace !== 'endless-workspace' && !isCloudNamespace(namespace)) throw new Error('本地库命名空间无效');
    this.database = new Promise((resolve, reject) => {
      if (!factory) {
        reject(new Error('当前浏览器无法使用本地存储，请使用普通模式的 Edge 或 Chrome'));
        return;
      }
      const request = factory.open(namespace, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('meta');
        db.createObjectStore('revisions');
        db.createObjectStore('branches');
        db.createObjectStore('objects');
        db.createObjectStore('staging');
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

  /** 已关闭连接不再使用：旧实例继续操作会得到可操作的错误，而不是 InvalidStateError。 */
  private async db(): Promise<IDBDatabase> {
    if (this.closed) throw new Error('本地存档连接已因版本变更或显式关闭而失效，请刷新页面；原始数据未被修改');
    return this.database;
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

  async installCloudCopy(workspace: Workspace, receipt: CloudImportReceipt, deviceId: string) {
    if (!isCloudNamespace(this.namespace) || !this.namespace.endsWith(`:${receipt.workspaceId}`)) throw new Error('云副本不能写入游客库或其他工作区');
    parseWorkspace(workspace);
    if (workspace.identity.repositoryRevision !== 0 || await cloudDigest(workspace) !== receipt.copyDigest) throw new Error('云副本摘要不匹配，已有数据未修改');
    const initial = parseCloudInstallation({ receipt, acknowledgements: [{ deviceId, key: globalThis.crypto.randomUUID() }] });
    const db = await this.db();
    const rows = this.rows(workspace);
    return new Promise<{ existing: boolean; installation: CloudLocalInstallation }>((resolve, reject) => {
      const tx = db.transaction(['meta', 'revisions', 'branches', 'objects', 'staging'], 'readwrite');
      const meta = tx.objectStore('meta');
      const request = meta.get('cloud-installation');
      let result = { existing: false, installation: initial };
      let error = '云副本安装失败，原有数据未修改';
      request.onsuccess = () => {
        try {
          if (request.result) {
            const held = parseCloudInstallation(request.result);
            if (held.receipt.id !== receipt.id || held.receipt.copyDigest !== receipt.copyDigest) throw new Error('本机已有不同云副本，不能覆盖未同步进度');
            if (!held.acknowledgements.some((entry) => entry.deviceId === deviceId)) held.acknowledgements.push(initial.acknowledgements[0]!);
            meta.put(held, 'cloud-installation');
            result = { existing: true, installation: held };
            return;
          }
          const stores = ['revisions', 'branches', 'objects', 'staging'] as const;
          let pending = stores.length + 1;
          let occupied = false;
          const checked = () => {
            if (--pending) return;
            if (occupied) { error = '命名空间已有未识别数据，不会覆盖或重置'; tx.abort(); return; }
            meta.put({ ...rows.meta, management: rows.management }, 'workspace');
            meta.put(initial, 'cloud-installation');
            for (const [name, values] of [['revisions', rows.revisions], ['branches', rows.branches], ['objects', rows.objects]] as const) {
              for (const value of values) tx.objectStore(name).put(value, value.id);
            }
          };
          meta.get('workspace').onsuccess = (event) => { occupied ||= !!(event.target as IDBRequest).result; checked(); };
          for (const name of stores) tx.objectStore(name).count().onsuccess = (event) => { occupied ||= (event.target as IDBRequest<number>).result > 0; checked(); };
        } catch (cause) {
          error = cause instanceof Error ? cause.message : error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(new Error(error));
    });
  }

  async cloudInstallation(): Promise<CloudLocalInstallation | null> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readonly');
      const request = tx.objectStore('meta').get('cloud-installation');
      tx.oncomplete = () => {
        try { resolve(request.result ? parseCloudInstallation(request.result) : null); }
        catch (error) { reject(error); }
      };
      tx.onabort = tx.onerror = () => reject(new Error('无法读取云副本安装记录'));
    });
  }

  async acknowledgeCloudInstallation(receipt: WorkspaceInstallation): Promise<void> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      const store = tx.objectStore('meta');
      const request = store.get('cloud-installation');
      request.onsuccess = () => {
        try {
          const held = parseCloudInstallation(request.result);
          const pending = held.acknowledgements.find((entry) => entry.deviceId === receipt.deviceId);
          if (!pending || held.receipt.id !== receipt.importId || held.receipt.copyDigest !== receipt.copyDigest
            || held.receipt.workspaceId !== receipt.workspaceId) throw new Error('安装回执与本机副本不一致');
          pending.receipt = receipt;
          store.put(held, 'cloud-installation');
        } catch { tx.abort(); }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error('安装回执尚未保存，可沿原请求恢复'));
    });
  }

  /**
   * 原子提交：校验 repositoryRevision，并在同一事务内验证票据状态转换。
   * 进行中票据（reserved/submitted）把写锁绑定到票据 ID：
   * - 保持开票只允许 reserved → submitted（其余字段与全库不变）；
   * - 关闭为 succeeded/failed/cancelled 必须由 closingTicketId 指向同一票据；
   * - failed/cancelled 不得夹带无关内容或事件变更；succeeded 允许绑定该票据的结果、
   *   修订、条目与采用变更（含结果选择）。
   * 删除、替换或改写进行中票据一律拒绝。
   */
  async commit(next: Workspace, options: { closingTicketId?: string } = {}): Promise<void> {
    const db = await this.db();
    const rows = this.rows(next);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'revisions', 'branches', 'objects', 'staging'], 'readwrite');
      let error = '保存失败，请检查可用空间后重试。本次操作尚未提交';
      type MetaRow = {
        key: string; identity: WorkspaceIdentity; profile: unknown; entries: unknown;
        obligations: unknown; activeBranchId: unknown; management?: unknown[];
      };
      let meta: MetaRow | undefined;
      let revisions: unknown[] = [];
      let branches: unknown[] = [];
      let objects: Record<string, unknown>[] = [];
      let pending = 4;
      const metaStore = tx.objectStore('meta');
      metaStore.get('workspace').onsuccess = (e) => { meta = (e.target as IDBRequest).result; step(); };
      tx.objectStore('revisions').getAll().onsuccess = (e) => { revisions = (e.target as IDBRequest).result ?? []; step(); };
      tx.objectStore('branches').getAll().onsuccess = (e) => { branches = (e.target as IDBRequest).result ?? []; step(); };
      tx.objectStore('objects').getAll().onsuccess = (e) => { objects = (e.target as IDBRequest).result ?? []; step(); };

      const canonical = (value: unknown): unknown => Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.keys(value as object).sort()
            .map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
          : value;
      const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
      // 「票据之外」的快照：meta 不含 repositoryRevision，objects 不含 ticket 行
      const snapshot = (
        metaRow: MetaRow | undefined, revs: unknown[], brs: unknown[], objs: Record<string, unknown>[],
      ) => ({
        meta: metaRow && {
          identity: { ...metaRow.identity, repositoryRevision: -1 },
          profile: metaRow.profile, entries: metaRow.entries,
          obligations: metaRow.obligations, activeBranchId: metaRow.activeBranchId,
          management: metaRow.management ?? [],
        },
        revisions: revs, branches: brs, objects: objs.filter((o) => o.kind !== 'ticket'),
      });
      // 状态转换会合法地改写这些字段；其余票据字段（分支、依据、时间）必须一致
      const ticketBody = (ticket: Record<string, unknown>) => {
        const {
          kind: _kind, status: _status, updatedAt: _updatedAt,
          failureCategory: _failureCategory, resultContentId: _resultContentId, ...body
        } = ticket;
        return body;
      };

      const step = () => {
        if (--pending !== 0) return;
        const storedRev = meta?.identity?.repositoryRevision ?? -1;
        const expected = next.identity.repositoryRevision - 1;
        if (meta && storedRev !== expected) {
          error = '另一个窗口已更新进度，请刷新后继续，避免覆盖已有记录';
          tx.abort();
          return;
        }
        if (!meta && next.identity.repositoryRevision !== 0) {
          error = '存档版本不匹配，请刷新后继续';
          tx.abort();
          return;
        }
        const open = (ticket: { status: string }) => ticket.status === 'reserved' || ticket.status === 'submitted';
        const storedOpen = objects.filter((o) => o.kind === 'ticket' && open(o as { status: string }));
        const nextOpen = next.tickets.filter(open);
        if (nextOpen.length > 1) {
          error = '存在多个进行中的生成任务，状态不一致';
          tx.abort();
          return;
        }
        const restSame = () => same(
          snapshot(meta, revisions, branches, objects),
          snapshot({ ...rows.meta, management: rows.management } as MetaRow,
            rows.revisions, rows.branches, rows.objects),
        );
        // 成功关闭允许夹带「该票据结果」的新增：条目/修订/义务/对象只许追加，
        // 既有行不得删改（展示信息只允许同步为采用修订的展示字段）；
        // 票据分支允许采用结果并推进会话，其余分支原样。
        const succeededDelta = (held: Record<string, unknown>, nextTicket: Record<string, unknown>) => {
          if (!meta || !same(ticketBody(held), ticketBody(nextTicket))) return false;
          const storedEntries = (meta!.entries ?? []) as { id: string }[];
          const nextEntryMap = new Map(next.entries.map((e) => [e.id, e]));
          for (const before of storedEntries) {
            const after = nextEntryMap.get(before.id);
            if (!after) return false;
            const { display: _d, ...afterRest } = after as { display?: unknown };
            const { display: _bd, ...beforeRest } = before as { display?: unknown };
            if (!same(afterRest, beforeRest)) return false;
          }
          const nextRevisionMap = new Map(rows.revisions.map((r) => [(r as { id: string }).id, r]));
          for (const before of revisions as { id: string }[]) {
            const after = nextRevisionMap.get(before.id);
            if (!after || !same(after, before)) return false;
          }
          const nextBranchMap = new Map(rows.branches.map((b) => [(b as { id: string }).id, b]));
          for (const before of branches as { id: string }[]) {
            const after = nextBranchMap.get(before.id);
            if (!after || (before.id !== held.branchId && !same(after, before))) return false;
          }
          const storedObjects = objects.filter((o) => o.kind !== 'ticket');
          const nextObjectMap = new Map(
            (rows.objects.filter((o) => o.kind !== 'ticket') as Record<string, unknown>[]).map((o) => [o.id as string, o]),
          );
          // 结果提交不产生归档卷/检查点：非票据对象必须与存储态完全一致，不许增删改
          if (nextObjectMap.size !== storedObjects.length) return false;
          for (const before of storedObjects) {
            const after = nextObjectMap.get(before.id as string);
            if (!after || !same(after, before)) return false;
          }
          const storedObligations = (meta!.obligations ?? []) as { contentId: string }[];
          for (const before of storedObligations) {
            const after = next.obligations.find((o) => o.contentId === before.contentId);
            if (!after || !same(after, before)) return false;
          }
          const storedManagement = (meta!.management ?? []) as unknown[];
          if (rows.management.length < storedManagement.length) return false;
          for (let i = 0; i < storedManagement.length; i++) {
            if (!same(storedManagement[i], rows.management[i])) return false;
          }
          if (next.activeBranchId !== meta!.activeBranchId) return false;
          if (!same(next.profile, meta!.profile)) return false;
          return same(
            { ...next.identity, repositoryRevision: -1 },
            { ...meta!.identity, repositoryRevision: -1 },
          );
        };
        for (const held of storedOpen) {
          const heldId = held.id as string;
          const nextTicket = next.tickets.find((t) => t.id === heldId);
          if (!nextTicket) {
            error = '进行中的生成任务不能被移除或替换，只能显式关闭';
            tx.abort();
            return;
          }
          if (open(nextTicket)) {
            if (held.status === 'submitted' && nextTicket.status === 'reserved') {
              error = '生成任务状态不能回退';
              tx.abort();
              return;
            }
            if (!same(ticketBody(held), ticketBody(nextTicket as unknown as Record<string, unknown>)) || !restSame()) {
              error = '生成任务进行中，不能改写票据或夹带其他写入';
              tx.abort();
              return;
            }
            continue;
          }
          if (options.closingTicketId !== heldId) {
            error = '生成任务只能由持有本次操作的写入方关闭';
            tx.abort();
            return;
          }
          if (nextTicket.status === 'succeeded' && succeededDelta(held, nextTicket as unknown as Record<string, unknown>)) continue;
          if ((nextTicket.status === 'failed' || nextTicket.status === 'cancelled')
            && same(ticketBody(held), ticketBody(nextTicket as unknown as Record<string, unknown>)) && restSame()) continue;
          error = nextTicket.status === 'succeeded'
            ? '生成结果提交不得删改已有内容，只能追加任务结果'
            : nextTicket.status === 'failed' || nextTicket.status === 'cancelled'
              ? '取消或失败不能夹带无关的内容或事件变更'
              : '生成任务只能关闭为成功、失败或取消';
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
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'revisions', 'branches', 'objects', 'staging'], 'readonly');
      const out: Record<string, unknown> = { meta: null, revisions: [], branches: [], objects: [], staging: [] };
      tx.objectStore('meta').get('workspace').onsuccess = (e) => { out.meta = (e.target as IDBRequest).result ?? null; };
      tx.objectStore('revisions').getAll().onsuccess = (e) => { out.revisions = (e.target as IDBRequest).result ?? []; };
      tx.objectStore('branches').getAll().onsuccess = (e) => { out.branches = (e.target as IDBRequest).result ?? []; };
      tx.objectStore('objects').getAll().onsuccess = (e) => { out.objects = (e.target as IDBRequest).result ?? []; };
      tx.objectStore('staging').getAll().onsuccess = (e) => { out.staging = (e.target as IDBRequest).result ?? []; };
      tx.oncomplete = () => resolve(out);
      tx.onabort = () => reject(new Error('读取原始存档失败'));
      tx.onerror = () => reject(new Error('读取原始存档失败'));
    });
  }

  /** 原始 meta 行（不校验），保留给只需要顶层行的调用方。 */
  async rawMeta(): Promise<unknown> {
    return (await this.rawSnapshot() as { meta: unknown }).meta;
  }

  /** 导入暂存：大文件先在隔离区校验，确认后一次事务发布，不让暂存对象被当正式数据。 */
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
    if (this.closed) return;
    this.closed = true;
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
