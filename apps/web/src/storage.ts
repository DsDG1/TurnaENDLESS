import { candidateFor, emptyRevisions, parseRevisions, revisionFrozen, validatePreview, type RevisionState } from './cloud/revisions.js';
import { RevisionAdoptionReceiptSchema, RevisionPreviewRequestSchema, RevisionRegistrationSchema, type RevisionPreviewReceipt, type RevisionAdoptionReceipt, type RevisionRegistration } from '@endless/cloud-contracts';
import {
  ContentRevisionSchema, ContractError, describeUnsupportedSave, parseWorkspace,
  assertReadingObligationProgress, retainReadingCompletionTimes,
  buildVolume, bridge, rebuildCloudReading, validateArchiveProjection, type Content, type Workspace, type WorkspaceIdentity,
} from '@endless/content';
import { MetadataReceiptSchema, MetadataSnapshotSchema, ResolveConflictRequestSchema, SyncBootstrapSchema, type SyncBootstrap, type MetadataReceipt, type MetadataSnapshot, type CloudImportReceipt, type ResolveConflictResponse, type SyncConflict, type SyncPushReceipt, type WorkspaceInstallation } from '@endless/cloud-contracts';
import { stableStringify } from '@endless/esl';
import { CLOUD_LIMITS, ReadingSnapshotSchema, SyncPlayerEventSchema, UuidSchema, type ReadingSnapshot } from '@endless/cloud-contracts';
import { ArchiveCommandSchema, ArchiveReceiptSchema, type ArchiveCommand, type ArchiveReceipt } from '@endless/cloud-contracts';
import { acceptArchiveReceipt, archivePositions, emptyArchives, initialArchives, nativeArchiveState, parseArchives, rememberArchives, type ArchiveView } from './cloud/archives.js';
import { LifecycleReceiptSchema, ManagementBootstrapSchema, ManagementPullSchema, type LifecycleReceipt, type ManagementBootstrap, type ManagementPull } from '@endless/cloud-contracts';
import { emptyMetadata, enqueueMetadata, initialMetadata, mergeDisplayChanges, mergeMetadata, metadataEntries, parseMetadata, receiveMetadata, sameMetadata, type MetadataState } from './cloud/metadata.js';
import { emptyLifecycle, enqueueLifecycle, initialLifecycle, lifecycleEntries, mergeLifecycle, parseLifecycle, receiveLifecycle, type LifecycleState } from './cloud/lifecycle.js';
import { checkPreservation, readPreservation, type PendingPreservation } from './cloud/conflict.js';
import { cloudDigest, isCloudNamespace, parseCloudInstallation, type CloudLocalInstallation } from './cloud/local.js';
import {
  emptySyncState, parseSyncState, planOutbox, sidecarKey,
  type BranchSlice, type CloudSyncState, type OutboxEntry, type SidecarEntry,
} from './cloud/outbox.js';

/**
 * `endless-workspace` 本地仓库：多对象存储 + repositoryRevision CAS。
 * 一次命令 → 先在内存完成校验（content 包），再由这里一次事务原子提交。
 * 进行中生成任务（reserved/submitted）冻结其它写入口，直到它被提交或取消。
 * 不读取旧 `endless-player` 库，也不自动清理旧命名空间。
 *
 * 云副本命名空间额外维护同步身份：`eventIds` 是 (流, 序号) → eventId 的 sidecar，
 * `outbox` 是待推送事件，`sync` 是游标与已确认前缀。三者与业务写入**同一事务**：
 * 业务提交成功而身份丢失（或反过来）都不会发生。
 */

const SYNC_STORES = ['outbox', 'eventIds', 'sync'] as const;

/** Tolerant parsing is useful for display, but persisted unknown fields are never authority to overwrite. */
const storedSync = (raw: unknown): CloudSyncState => {
  const state = parseSyncState(raw);
  const canonical = { ...(raw as Record<string, unknown>) };
  // Existing writers explicitly clear this known optional field with undefined; IDB preserves that property.
  if (canonical.pendingPush === undefined) delete canonical.pendingPush;
  if (raw !== undefined && !sameMetadata(canonical, state)) throw new Error('未知或损坏的同步状态保留，不能覆盖');
  return state;
};

/** 把工作区分支裁剪成纯规划输入：只要身份相关字段，避免把整份存档塞进闭包。 */
const slices = (branches: readonly { id: string; parentBranchId: string | null; forkAtEventCount: number | null; session: { events: readonly unknown[] } }[]): BranchSlice[] =>
  branches.map((branch) => ({
    id: branch.id, parentBranchId: branch.parentBranchId,
    forkAtEventCount: branch.forkAtEventCount, events: branch.session.events,
  }));
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
      // 版本 2 只新增 store，不动既有结构与数据：旧库原地升级，不重建、不清空。
      const request = factory.open(namespace, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of ['meta', 'revisions', 'branches', 'objects', 'staging', ...SYNC_STORES]) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
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
      const tx = db.transaction(['meta', 'revisions', 'branches', 'objects', 'staging', 'sync'], 'readwrite');
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
            tx.objectStore('sync').put(emptySyncState(), 'sync');
            tx.objectStore('sync').put(initialMetadata(workspace), 'metadata');
            tx.objectStore('sync').put(initialLifecycle(workspace), 'lifecycle');
            tx.objectStore('sync').put(initialArchives(workspace), 'archives');
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
  async commit(
    next: Workspace,
    options: {
      closingTicketId?: string;
      /** 远端已确认的事件身份：重放云端变更时不再产生 Outbox 回环。 */
      remote?: { streamId: string; startSeq: number; eventIds: readonly string[]; prefixStreamId?: string };
      preservation?: { plan: PendingPreservation; result: ResolveConflictResponse };
    } = {},
  ): Promise<{ enqueued: number; replaced: string[] }> {
    const db = await this.db();
    const rows = this.rows(next);
    const syncing = isCloudNamespace(this.namespace);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'revisions', 'branches', 'objects', 'staging', ...SYNC_STORES], 'readwrite');
      let error = '保存失败，请检查可用空间后重试。本次操作尚未提交';
      type MetaRow = {
        key: string; identity: WorkspaceIdentity; profile: unknown; entries: unknown;
        obligations: unknown; activeBranchId: unknown; management?: unknown[];
      };
      let meta: MetaRow | undefined;
      let revisions: unknown[] = [];
      let branches: unknown[] = [];
      let objects: Record<string, unknown>[] = [];
      let sidecar = new Map<string, SidecarEntry>();
      let syncState: CloudSyncState = emptySyncState();
      let metadataState: MetadataState = emptyMetadata();
      let lifecycleState: LifecycleState = emptyLifecycle();
      let archiveState: ArchiveView = emptyArchives();
      let preservation: PendingPreservation | null = null;
      let result = { enqueued: 0, replaced: [] as string[] };
      let pending = 11;
      const metaStore = tx.objectStore('meta');
      metaStore.get('workspace').onsuccess = (e) => { meta = (e.target as IDBRequest).result; step(); };
      tx.objectStore('revisions').getAll().onsuccess = (e) => { revisions = (e.target as IDBRequest).result ?? []; step(); };
      tx.objectStore('branches').getAll().onsuccess = (e) => { branches = (e.target as IDBRequest).result ?? []; step(); };
      tx.objectStore('objects').getAll().onsuccess = (e) => { objects = (e.target as IDBRequest).result ?? []; step(); };
      // 用游标一次读完 sidecar：避免在事务回调里再发请求，事务生命周期更好推理。
      const sidecarCursor = tx.objectStore('eventIds').openCursor();
      sidecarCursor.onsuccess = () => {
        const cursor = sidecarCursor.result;
        if (cursor) {
          const value = cursor.value as SidecarEntry | undefined;
          if (value && typeof value.eventId === 'string') sidecar.set(String(cursor.key), value);
          cursor.continue();
          return;
        }
        step();
      };
      tx.objectStore('sync').get('sync').onsuccess = (e) => {
        try { syncState = storedSync((e.target as IDBRequest).result); step(); }
        catch { error = '未知或损坏的同步状态保留，不能提交'; tx.abort(); }
      };
      tx.objectStore('sync').get('preservation').onsuccess = (e) => { preservation = (e.target as IDBRequest).result ?? null; step(); };
      tx.objectStore('sync').get('metadata').onsuccess = (e) => {
        try { metadataState = parseMetadata((e.target as IDBRequest).result, syncing ? this.namespace.split(':')[3] : undefined); step(); }
        catch { error = '展示信息同步状态不受支持，原件已保留'; tx.abort(); }
      };
      tx.objectStore('sync').get('lifecycle').onsuccess = (e) => {
        try { lifecycleState = parseLifecycle((e.target as IDBRequest).result, this.namespace.split(':')[3] ?? ''); step(); }
        catch { error = '生命周期同步状态不受支持，原件已保留'; tx.abort(); }
      };
      tx.objectStore('sync').get('archives').onsuccess = (e) => {
        try { archiveState = parseArchives((e.target as IDBRequest).result, this.namespace.split(':')[3] ?? ''); step(); }
        catch { error = '归档同步状态不受支持，原件保留'; tx.abort(); }
      };

      let revisionsPending = emptyRevisions();
      tx.objectStore('sync').get('revisions').onsuccess = (e) => {
        try { revisionsPending = parseRevisions((e.target as IDBRequest).result, this.namespace.split(':')[3] ?? ''); step(); }
        catch { error = '修订同步状态不受支持，原件保留'; tx.abort(); }
      };
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
        try { write(); } catch { tx.abort(); }
      };
      const write = () => {
        if (syncing && revisionFrozen(revisionsPending) && !options.remote) { error = '修订确认结果尚未确定，请先恢复同一请求；本机历史保留'; tx.abort(); return; }
        if (preservation && !options.preservation) {
          error = '冲突保留请求尚未完成，请先恢复同一请求；本机完整历史已保留';
          tx.abort();
          return;
        }
        if (options.preservation && (!preservation || preservation.conflict.id !== options.preservation.plan.conflict.id
          || !same(preservation.request, options.preservation.plan.request))) {
          error = '冲突恢复请求与已保存请求不一致，未修改本机历史';
          tx.abort();
          return;
        }
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

        if (syncing) {
          if (meta && !same(meta.entries, next.entries) && archiveState.pending?.request.members.some((m) => {
            const before = (meta!.entries as Workspace['entries']).find((e) => e.id === m.contentId), after = next.entries.find((e) => e.id === m.contentId);
            return !before || !after || before.lifecycle !== after.lifecycle || before.archiveVolumeId !== after.archiveVolumeId;
          })) { error = '归档请求尚未完成，请先恢复或处理该请求后再变更成员的回收站状态'; tx.abort(); return; }
          let nextMetadata: MetadataState;
          try { nextMetadata = enqueueMetadata(metadataState, (meta?.entries ?? []) as Workspace['entries'], next.entries, this.namespace.split(':')[3]!); }
          catch (cause) { error = cause instanceof Error ? cause.message : '展示信息命令未保存'; throw cause; }
          tx.objectStore('sync').put(nextMetadata, 'metadata');
          try {
            tx.objectStore('sync').put(enqueueLifecycle(lifecycleState, (meta?.entries ?? []) as Workspace['entries'], next.entries, this.namespace.split(':')[3]!), 'lifecycle');
          } catch (cause) { error = cause instanceof Error ? cause.message : '回收站命令未保存'; throw cause; }
          // 事件身份与 Outbox 在同一事务内落库：业务提交成功而身份丢失不可能发生。
          const plan = planOutbox({
            stored: slices(branches as Parameters<typeof slices>[0]).filter((branch) => !options.preservation
              || ![options.preservation.plan.conflict.streamId, options.preservation.plan.request.decision === 'keep-branch' ? options.preservation.plan.request.streamId : null].includes(branch.id)),
            next: slices(rows.branches).filter((branch) => !options.preservation
              || ![options.preservation.plan.conflict.streamId, options.preservation.plan.request.decision === 'keep-branch' ? options.preservation.plan.request.streamId : null].includes(branch.id)),
            sidecar, remote: options.remote,
            newId: () => globalThis.crypto.randomUUID(),
          });
          const outboxStore = tx.objectStore('outbox');
          for (const entry of plan.enqueue) outboxStore.put(entry, `${entry.streamId}:${entry.seq}`);
          const idStore = tx.objectStore('eventIds');
          for (const item of plan.sidecar) idStore.put(item.value, item.key);
          if (plan.replaced.length) {
            const needsRebase = [...new Set([...syncState.needsRebase, ...plan.replaced])];
            tx.objectStore('sync').put({ ...syncState, needsRebase }, 'sync');
          }
          if (options.preservation) {
            const { plan: saved, result: resolved } = options.preservation;
            const history = resolved.history!;
            const kept = resolved.preserved!;
            const sourceId = saved.conflict.streamId;
            tx.objectStore('staging').put({ plan: saved, result: resolved, sync: syncState }, `sync-resolution:${saved.conflict.id}`);
            for (const key of sidecar.keys()) if (key.startsWith(`${sourceId}:`)) {
              const original = outboxStore.get(key);
              original.onsuccess = () => {
                if (original.result !== undefined) tx.objectStore('staging').put({ key, value: original.result }, `sync-resolution-outbox:${saved.conflict.id}:${key}`);
              };
              idStore.delete(key);
              outboxStore.delete(key);
            }
            for (const entry of history.events) idStore.put({ eventId: entry.eventId, event: entry.event }, sidecarKey(sourceId, entry.seq));
            const oldBranch = saved.workspace.branches.find((branch) => branch.id === sourceId)!;
            for (let index = 0; saved.request.decision === 'keep-branch' && index < oldBranch.session.events.length; index++) {
              const identity = index < saved.conflict.baseSeq
                ? { eventId: history.events[index]!.eventId, event: history.events[index]!.event }
                : saved.identities[index]!;
              idStore.put(identity, sidecarKey(kept.streamId, index + 1));
              if (index + 1 > kept.eventSeq) {
                const event = identity.event;
                outboxStore.put({
                  streamId: kept.streamId, seq: index + 1, eventId: identity.eventId,
                  at: event.at, event,
                  command: event.type === 'answer' ? { type: 'answer', scene: event.scene, choice: event.choice }
                    : event.type === 'advance' ? { type: 'advance', scene: event.scene, skip: event.skip } : { type: 'reveal', scene: event.scene },
                } satisfies OutboxEntry, sidecarKey(kept.streamId, index + 1));
              }
            }
            tx.objectStore('sync').put({
              ...syncState,
              pendingPush: undefined,
              streams: {
                ...syncState.streams,
                [sourceId]: { seq: history.stream.eventSeq, eventId: history.stream.lastEventId },
                ...(saved.request.decision === 'keep-branch' ? { [kept.streamId]: { seq: kept.eventSeq, eventId: kept.lastEventId } } : {}),
              },
              conflicts: syncState.conflicts.filter((entry) => entry.streamId !== sourceId),
              needsRebase: syncState.needsRebase.filter((id) => id !== sourceId),
              lastError: null,
            }, 'sync');
            tx.objectStore('sync').delete('preservation');
          }
          result = { enqueued: plan.enqueue.length, replaced: plan.replaced };
        }
      };
      tx.oncomplete = () => resolve(result);
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
      const syncing = isCloudNamespace(this.namespace);
      const tx = db.transaction(['meta', 'revisions', 'branches', 'objects', 'staging', ...(syncing ? SYNC_STORES : [])], 'readonly');
      const out: Record<string, unknown> = { meta: null, revisions: [], branches: [], objects: [], staging: [] };
      tx.objectStore('meta').get('workspace').onsuccess = (e) => { out.meta = (e.target as IDBRequest).result ?? null; };
      tx.objectStore('revisions').getAll().onsuccess = (e) => { out.revisions = (e.target as IDBRequest).result ?? []; };
      tx.objectStore('branches').getAll().onsuccess = (e) => { out.branches = (e.target as IDBRequest).result ?? []; };
      tx.objectStore('objects').getAll().onsuccess = (e) => { out.objects = (e.target as IDBRequest).result ?? []; };
      tx.objectStore('staging').getAll().onsuccess = (e) => { out.staging = (e.target as IDBRequest).result ?? []; };
      if (syncing) for (const name of SYNC_STORES) {
        const rows: { key: IDBValidKey; value: unknown }[] = [];
        out[name] = rows;
        const request = tx.objectStore(name).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          rows.push({ key: cursor.key, value: cursor.value });
          cursor.continue();
        };
      }
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

  // ---------- 同步状态（仅云副本命名空间） ----------

  private requireSync(): void {
    if (!isCloudNamespace(this.namespace)) throw new Error('只有云副本命名空间参与增量同步');
  }

  async archiveState(): Promise<ArchiveView> {
    this.requireSync(); const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync', 'readonly'), request = tx.objectStore('sync').get('archives');
      tx.oncomplete = () => { try { resolve(parseArchives(request.result, this.namespace.split(':')[3]!)); } catch { reject(new Error('归档同步状态不受支持，原件保留')); } };
      tx.onabort = tx.onerror = () => reject(new Error('读取归档状态失败'));
    });
  }

  /** Persists an intent, never an unverified completed volume. Offline UI must say queued until the server receipt is accepted. */
  async queueArchive(content: Content, intent: { type: 'archive'; memberContentIds: string[]; title?: string } | { type: 'unarchive'; volumeId: string }): Promise<void> {
    this.requireSync();
    const workspace = await this.load(); if (!workspace) throw new Error('本机云副本不存在');
    const volume = intent.type === 'archive' ? buildVolume(workspace, bridge(content, workspace), intent.memberContentIds, intent.title)
      : workspace.volumes.find((v) => v.id === intent.volumeId);
    if (!volume) throw new Error('归档卷不存在');
    const db = await this.db(), workspaceId = this.namespace.split(':')[3]!;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'sync', 'objects'], 'readwrite');
      const sync = tx.objectStore('sync'), requests = { meta: tx.objectStore('meta').get('workspace'), archive: sync.get('archives'),
        display: sync.get('metadata'), life: sync.get('lifecycle'), preservation: sync.get('preservation'), revisions: sync.get('revisions'), objects: tx.objectStore('objects').getAll() };
      let left = Object.keys(requests).length, error = '归档请求未保存，尚未发出网络请求';
      const step = () => {
        if (--left) return;
        try {
          const meta = requests.meta.result;
          if (meta?.identity.repositoryRevision !== workspace.identity.repositoryRevision) throw new Error('另一个窗口已更新工作区，请刷新后归档');
          if (revisionFrozen(parseRevisions(requests.revisions.result, workspaceId))) throw new Error('修订确认结果尚未确定，请先恢复同一请求');
          if (requests.preservation.result || requests.objects.result.some((o) => o.kind === 'ticket' && ['reserved', 'submitted'].includes(o.status))) throw new Error('进行中的任务尚未完成，暂不能归档');
          const archive = parseArchives(requests.archive.result, workspaceId), display = parseMetadata(requests.display.result, workspaceId), life = parseLifecycle(requests.life.result, workspaceId);
          if (!archive.known) throw new Error('请先同步，取得可验证的归档基线');
          if (archive.pending) throw new Error('已有归档请求待恢复或处理');
          const members = volume.members.map((m) => {
            if (!life.known[m.contentId] || !display.known[m.contentId] || life.pending[m.contentId] || display.pending[m.contentId]) throw new Error('归档成员有未同步命令或缺少基线，请先同步');
            return { contentId: m.contentId, revisionId: m.revisionId, lifecycleVersion: life.known[m.contentId]!.version, displayVersion: display.known[m.contentId]!.version };
          });
          const common = { workspaceId, commandId: crypto.randomUUID(), volumeId: volume.id, baseVersion: archive.known.version, members };
          const request: ArchiveCommand = ArchiveCommandSchema.parse(intent.type === 'archive'
            ? { ...common, type: 'archive', title: volume.title, basis: { streamId: volume.derivedFrom.branchId, eventCount: volume.derivedFrom.eventCount, eventHash: volume.derivedFrom.eventHash } }
            : { ...common, type: 'unarchive' });
          sync.put({ ...archive, pending: { request } }, 'archives');
          tx.objectStore('meta').put({ ...meta, identity: { ...meta.identity, repositoryRevision: meta.identity.repositoryRevision + 1 } }, 'workspace');
        } catch (cause) { error = cause instanceof Error ? cause.message : error; tx.abort(); }
      };
      for (const request of Object.values(requests)) request.onsuccess = step;
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(new Error(error));
    });
  }

  async lifecycleState(): Promise<LifecycleState> {
    this.requireSync();
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync', 'readonly'), request = tx.objectStore('sync').get('lifecycle');
      tx.oncomplete = () => { try { resolve(parseLifecycle(request.result, this.namespace.split(':')[3]!)); } catch { reject(new Error('生命周期同步状态不受支持，原件已保留')); } };
      tx.onabort = tx.onerror = () => reject(new Error('读取生命周期同步状态失败'));
    });
  }

  async revisionState(): Promise<RevisionState> {
    this.requireSync();
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync', 'readonly'), request = tx.objectStore('sync').get('revisions');
      tx.oncomplete = () => { try { resolve(parseRevisions(request.result, this.namespace.split(':')[3]!)); } catch { reject(new Error('修订同步状态不受支持，原件保留')); } };
      tx.onabort = tx.onerror = () => reject(new Error('读取修订请求失败，原件保留'));
    });
  }

  /** Expensive native compilation runs before IDB. The write compares the complete read set, including sidecars,
   * then commits workspace, registration, receipt acknowledgement and shared prefix identities atomically. */
  async revisionAction(content: Content, action: { queue: { contentId: string; draft: string } }
    | { confirm: { requestId: string; digest: string } } | { discard: string }
    | { preview: RevisionPreviewReceipt } | { result: RevisionAdoptionReceipt } | { install: RevisionRegistration; readingSeq: number }): Promise<void> {
    this.requireSync();
    const workspaceId = this.namespace.split(':')[3]!;
    const before = await this.rawSnapshot() as any;
    const value = (key: string) => before.sync.find((row: any) => row.key === key)?.value;
    const original = this.assemble(before.meta, before.revisions, before.branches, before.objects, before.meta?.management ?? []);
    let workspace = original, state = parseRevisions(value('revisions'), workspaceId);
    let display = parseMetadata(value('metadata'), workspaceId), sync = storedSync(value('sync'));
    const life = parseLifecycle(value('lifecycle'), workspaceId), archive = parseArchives(value('archives'), workspaceId);
    if (value('preservation') || original.tickets.some((t) => ['reserved', 'submitted'].includes(t.status))) throw new Error('进行中的任务尚未完成，修订请求保留');
    const stage: { key: string; value: unknown }[] = [], identities: { key: string; value: SidecarEntry }[] = [];
    const idle = () => {
      if (before.outbox.length || sync.pendingPush || sync.conflicts.length || sync.needsRebase.length
        || Object.keys(display.pending).length || Object.keys(life.pending).length || archive.pending || !archive.known) throw new Error('请先完成阅读和内容管理同步，再请求修订预览或确认');
    };
    if ('queue' in action) {
      if (state.pending) throw new Error('已有待处理修订，请先恢复或保留原请求后重新编辑');
      idle();
      const branch = workspace.branches.find((b) => b.id === workspace.activeBranchId)!;
      const entry = workspace.entries.find((e) => e.id === action.queue.contentId);
      const adopted = branch.adopted.find((a) => a.contentId === entry?.id), head = sync.streams[branch.id];
      if (!entry || entry.sourceKind !== 'generated' || entry.lifecycle !== 'active' || !adopted || !head
        || head.seq !== branch.session.events.length || workspace.volumes.some((v) => v.members.some((m) => m.contentId === entry.id))
        || !display.known[entry.id] || !life.known[entry.id]) throw new Error('此内容或阅读前缀尚不满足云端修订条件');
      const request = RevisionPreviewRequestSchema.parse({ workspaceId, requestId: crypto.randomUUID(), streamId: branch.id, contentId: entry.id,
        baseRevisionId: adopted.revisionId, baseSeq: head.seq, baseEventId: head.eventId,
        displayVersion: display.known[entry.id]!.version, lifecycleVersion: life.known[entry.id]!.version,
        archiveVersion: archive.known!.version, draft: action.queue.draft });
      state = { ...state, pending: { request, baseline: original } };
    } else if ('preview' in action) {
      const receipt = await validatePreview(content, state, action.preview);
      if (state.pending!.preview && !sameMetadata(state.pending!.preview, receipt)) throw new Error('原预览裁决不可改写');
      state = { ...state, pending: { ...state.pending!, preview: receipt } };
    } else if ('confirm' in action) {
      idle();
      const held = state.pending;
      if (!held || held.request.requestId !== action.confirm.requestId || held.preview?.outcome !== 'ready'
        || held.preview.artifact.digest !== action.confirm.digest || held.confirmation) throw new Error('预览已变化，请重新查看后确认');
      const request = held.request, branch = original.branches.find((b) => b.id === request.streamId);
      const head = sync.streams[request.streamId];
      if (original.activeBranchId !== request.streamId || !branch || branch.session.events.length !== request.baseSeq
        || !head || head.seq !== request.baseSeq || head.eventId !== request.baseEventId
        || display.known[request.contentId]?.version !== request.displayVersion || life.known[request.contentId]?.version !== request.lifecycleVersion
        || archive.known!.version !== request.archiveVersion) throw new Error('阅读或内容版本已变化，请保留原预览后重新编译');
      state = { ...state, pending: { ...held, confirmation: { protocol: 'cloud-revision-adoption/1', workspaceId, commandId: crypto.randomUUID(),
        previewRequestId: request.requestId, artifactDigest: action.confirm.digest } } };
    } else if ('result' in action) {
      const receipt = RevisionAdoptionReceiptSchema.parse(action.result), held = state.pending;
      if (!held?.confirmation || receipt.workspaceId !== workspaceId || receipt.commandId !== held.confirmation.commandId
        || (receipt.outcome === 'applied' && (receipt.registration.commandId !== receipt.commandId
          || receipt.registration.previewRequestId !== held.request.requestId || held.preview?.outcome !== 'ready'
          || !sameMetadata(receipt.registration.artifact, held.preview.artifact)))) throw new Error('确认回执与本机原请求不一致，原请求保留');
      if (held.result && !sameMetadata(held.result, receipt)) throw new Error('原确认裁决不可改写');
      state = { ...state, pending: { ...held, result: receipt } };
    } else if ('discard' in action) {
      if (!state.pending || state.pending.request.requestId !== action.discard || revisionFrozen(state)) throw new Error('确认结果未知，必须恢复同一请求后再编辑');
      stage.push({ key: `revision-request:${state.pending.request.requestId}`, value: state.pending });
      state = { ...state, pending: null };
    } else {
      const registration = RevisionRegistrationSchema.parse(action.install), old = state.installed[registration.version - 1];
      if (old) { if (!sameMetadata(old, registration)) throw new Error('同一登记版本正文不同，原件保留'); return; }
      if (registration.version !== state.installed.length + 1) throw new Error('修订登记不连续，原件保留');
      if (!Number.isSafeInteger(action.readingSeq) || action.readingSeq < registration.readingChangeSeq) throw new Error('修订所需阅读同步屏障尚未到达，原件保留');
      const binding = registration.artifact.binding;
      if (sync.pendingPush || sync.needsRebase.includes(binding.streamId) || sync.conflicts.some((c) => c.streamId === binding.streamId)
        || before.outbox.some((e: any) => e.value.streamId === binding.streamId)) throw new Error('原分支仍有未确认事件，不能采用云端修订；原历史保留');
      const boundHead = sync.streams[binding.streamId];
      const boundIdentity = before.eventIds.find((r: any) => r.key === sidecarKey(binding.streamId, binding.eventCount))?.value;
      if ((boundIdentity?.eventId ?? (boundHead?.seq === binding.eventCount ? boundHead.eventId : undefined)) !== binding.lastEventId
        && binding.eventCount !== 0) throw new Error('修订所需阅读前缀身份尚未到达或不一致，原件保留');
      workspace = await candidateFor(content, original, registration.artifact);
      const entry = workspace.entries.find((e) => e.id === registration.entry.contentId)!;
      if (!entry || !sameMetadata(entry.revisionIds, registration.entry.revisionIds) || entry.headRevisionId !== registration.entry.headRevisionId
        || entry.updatedAt !== registration.entry.updatedAt || registration.display.contentId !== entry.id
        || registration.display.version !== binding.displayVersion + 1 || registration.display.value.title !== entry.display.title
        || !sameMetadata(workspace.obligations, registration.obligations)) throw new Error('修订条目或义务与本机原生规则不同');
      const own = state.pending?.confirmation?.commandId === registration.commandId;
      if (own && (state.pending!.request.requestId !== registration.previewRequestId || state.pending!.preview?.outcome !== 'ready'
        || !sameMetadata(state.pending!.preview.artifact, registration.artifact)
        || (state.pending!.result && (state.pending!.result.outcome !== 'applied' || !sameMetadata(state.pending!.result.registration, registration))))) throw new Error('修订登记与原确认请求不一致');
      workspace = { ...workspace, activeBranchId: own ? workspace.activeBranchId : original.activeBranchId };
      const { stream, artifact } = registration;
      const count = artifact.mode === 'fork' ? artifact.branch.commonPrefixSeq : artifact.binding.eventCount;
      if (stream.streamId !== artifact.branch.streamId || stream.branchId !== stream.streamId || stream.eventSeq !== count
        || (count === 0) !== (stream.lastEventId === null) || (artifact.mode === 'in-place' && stream.lastEventId !== artifact.binding.lastEventId)) throw new Error('采用流头身份不一致');
      if (artifact.mode === 'fork') {
        const parent = original.branches.find((b) => b.id === artifact.binding.streamId)!;
        const ids = registration.prefixEventIds ?? parent.session.events.slice(0, count).map((_e, i) => before.eventIds.find((r: any) => r.key === sidecarKey(parent.id, i + 1))?.value.eventId);
        if (ids.length !== count || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string') || (ids.at(-1) ?? null) !== stream.lastEventId) throw new Error('修订分支缺少完整前缀身份，原件保留');
        ids.forEach((id, i) => {
          for (const target of [parent.id, stream.streamId]) {
            const key = sidecarKey(target, i + 1), held = before.eventIds.find((r: any) => r.key === key)?.value;
            const value = { eventId: id, event: parent.session.events[i]! } as SidecarEntry;
            if (held && !sameMetadata(held, value)) throw new Error('前缀事件身份不同，原历史保留');
            identities.push({ key, value });
          }
        });
      }
      const confirmed = sync.streams[stream.streamId];
      if (confirmed?.seq === count && confirmed.eventId !== stream.lastEventId) throw new Error('已确认流头身份不同');
      sync = { ...sync, streams: { ...sync.streams, [stream.streamId]: confirmed && confirmed.seq > count ? confirmed : { seq: count, eventId: stream.lastEventId } } };
      display = mergeDisplayChanges(display, [registration.display], workspace.entries);
      // Native adoption updates the title; an unresolved local display command still owns its visible candidate.
      const entries = workspace.entries.map((e) => display.pending[e.id]
        ? { ...e, display: { ...e.display, ...display.pending[e.id]!.request.value } } : e);
      workspace = { ...workspace, entries: metadataEntries(entries, display) };
      state = { ...state, installed: [...state.installed, registration] };
      if (own) { stage.push({ key: `revision-result:${registration.commandId}`, value: state.pending }); state = { ...state, pending: null }; }
    }
    parseRevisions(state, workspaceId);
    workspace = parseWorkspace({ ...workspace, identity: { ...workspace.identity, repositoryRevision: original.identity.repositoryRevision + 1 } });
    const db = await this.db(), rows = this.rows(workspace);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'revisions', 'branches', 'objects', 'staging', ...SYNC_STORES], 'readwrite');
      const actual: any = {}, names = ['revisions', 'branches', 'objects', 'staging', ...SYNC_STORES];
      let remaining = names.length + 1, error = '修订保存失败，原请求与原文保留，可重试';
      const done = () => {
        if (--remaining) return;
        try {
          if (!sameMetadata(actual, before)) throw new Error('另一个窗口或同步已更新存档，修订未提交，请重新读取后重试');
          tx.objectStore('meta').put({ ...rows.meta, management: rows.management }, 'workspace');
          for (const revision of rows.revisions) tx.objectStore('revisions').put(revision, revision.id);
          for (const branch of rows.branches) tx.objectStore('branches').put(branch, branch.id);
          tx.objectStore('sync').put(state, 'revisions'); tx.objectStore('sync').put(sync, 'sync'); tx.objectStore('sync').put(display, 'metadata');
          for (const row of identities) tx.objectStore('eventIds').put(row.value, row.key);
          for (const row of stage) tx.objectStore('staging').put(row.value, row.key);
        } catch (cause) { error = cause instanceof Error ? cause.message : error; tx.abort(); }
      };
      const meta = tx.objectStore('meta').get('workspace'); meta.onsuccess = () => { actual.meta = meta.result ?? null; done(); };
      for (const name of names) {
        if ((SYNC_STORES as readonly string[]).includes(name)) {
          const cursor = tx.objectStore(name).openCursor(), values: any[] = []; actual[name] = values;
          cursor.onsuccess = () => { const row = cursor.result; if (row) { values.push({ key: row.key, value: row.value }); row.continue(); } else done(); };
        } else { const request = tx.objectStore(name).getAll(); request.onsuccess = () => { actual[name] = request.result; done(); }; }
      }
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(new Error(error));
    });
  }

  /** Management page effects, command acknowledgements and cursor advance are a single atomic commit. */
  async updateManagement(action: { bootstrap: ManagementBootstrap } | { pull: ManagementPull } | { receipt: LifecycleReceipt }
    | { contentId: string; decision: 'local' | 'cloud'; commandId: string; version: number }
    | { archiveReceipt: ArchiveReceipt } | { archiveDecision: 'retry' | 'cloud'; commandId: string; version: number }, content?: Content): Promise<void> {
    this.requireSync();
    const workspaceId = this.namespace.split(':')[3]!;
    if ('bootstrap' in action) ManagementBootstrapSchema.parse(action.bootstrap);
    if ('pull' in action) ManagementPullSchema.parse(action.pull);
    if ('receipt' in action) LifecycleReceiptSchema.parse(action.receipt);
    if ('archiveReceipt' in action) ArchiveReceiptSchema.parse(action.archiveReceipt);
    const remote = 'bootstrap' in action ? action.bootstrap : 'pull' in action ? action.pull : 'receipt' in action ? action.receipt : 'archiveReceipt' in action ? action.archiveReceipt : null;
    if (remote && remote.workspaceId !== workspaceId) throw new Error('管理变更来自其他工作区');
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'sync', 'revisions', 'branches', 'objects', 'staging'], 'readwrite');
      const sync = tx.objectStore('sync');
      const requests = {
        meta: tx.objectStore('meta').get('workspace'), display: sync.get('metadata'), life: sync.get('lifecycle'),
        sync: sync.get('sync'), preservation: sync.get('preservation'),
        archive: sync.get('archives'), revisionState: sync.get('revisions'),
        revisions: tx.objectStore('revisions').getAll(), branches: tx.objectStore('branches').getAll(), objects: tx.objectStore('objects').getAll(),
      };
      let remaining = Object.keys(requests).length;
      let error = '管理变更未保存，原请求和游标保留，可重试';
      const step = () => {
        if (--remaining) return;
        try {
          const held = requests.meta.result;
          if (!held) throw new Error('本机云副本不存在');
          if (requests.preservation.result || requests.objects.result.some((o) => o.kind === 'ticket' && ['reserved', 'submitted'].includes(o.status))) throw new Error('进行中的任务尚未完成，暂不应用管理变更');
          const revisionState = parseRevisions(requests.revisionState.result, workspaceId);
          if (revisionFrozen(revisionState)) throw new Error('修订确认尚未完成，暂不应用管理变更');
          if ('bootstrap' in action && action.bootstrap.revisionCatalog &&
            !sameMetadata(revisionState.installed, action.bootstrap.revisionCatalog.registrations)) throw new Error('管理引导所需修订尚未完整接收，原游标保留');
          if ('pull' in action && action.pull.changes.some((change) => change.type === 'revision' &&
            !sameMetadata(revisionState.installed[change.registration.version - 1], change.registration))) throw new Error('管理页所需修订尚未完整接收，原游标保留');
          let display = parseMetadata(requests.display.result, workspaceId);
          let life = parseLifecycle(requests.life.result, workspaceId);
          let archive = parseArchives(requests.archive.result, workspaceId);
          const completedArchive = 'archiveReceipt' in action && action.archiveReceipt.outcome === 'applied' ? archive.pending?.request : undefined;
          const archiveBefore = archive.known;
          const original = this.assemble(held, requests.revisions.result, requests.branches.result, requests.objects.result, held.management ?? []);
          const remember = (state: NonNullable<ManagementBootstrap['archive']>, historical: boolean) => { archive = rememberArchives(archive, state, original, historical); };
          const entries = held.entries as Workspace['entries'];
          if ('bootstrap' in action) {
            display = mergeMetadata(display, action.bootstrap.display, entries, workspaceId);
            life = mergeLifecycle(life, action.bootstrap.lifecycle, entries, workspaceId);
            if (action.bootstrap.archive) {
              if (!archive.known && action.bootstrap.archiveOrigin) archive = rememberArchives(archive, { version: 0, volumes: action.bootstrap.archiveOrigin }, original);
              remember(action.bootstrap.archive, false);
            }
            life.cursor = action.bootstrap.cursor; life.changeSeq = action.bootstrap.changeSeq;
          } else if ('pull' in action) {
            const page = action.pull;
            if (page.fromCursor !== life.cursor || page.changes.some((change, index) => change.seq !== life.changeSeq + index + 1)
              || (page.changes.length && page.nextCursor === page.fromCursor)
              || (!page.changes.length && (page.hasMore || page.nextCursor !== page.fromCursor))) throw new Error('管理变更页与已保存游标不连续，原件保留');
            for (const change of page.changes) {
              if (change.type === 'display') display = mergeDisplayChanges(display, [change.entry], entries);
              else if (change.type === 'lifecycle') life = mergeLifecycle(life, [change.entry], entries, workspaceId, true);
              else if (change.type === 'archive') {
                life = mergeLifecycle(life, change.snapshot.lifecycle, entries, workspaceId, true);
                remember(change.snapshot.state, true);
              }
            }
            life.cursor = page.nextCursor;
            life.changeSeq = page.changes.at(-1)?.seq ?? life.changeSeq;
          } else if ('receipt' in action) life = receiveLifecycle(life, action.receipt);
          else if ('archiveReceipt' in action) {
            acceptArchiveReceipt(archive, action.archiveReceipt);
            life = mergeLifecycle(life, action.archiveReceipt.snapshot.lifecycle, entries, workspaceId, true);
            display = mergeDisplayChanges(display, action.archiveReceipt.display, entries);
            remember(action.archiveReceipt.snapshot.state, true);
            archive = { ...archive, pending: action.archiveReceipt.outcome === 'applied' ? null : { ...archive.pending!, resolution: action.archiveReceipt } };
          } else if ('archiveDecision' in action) {
            const pending = archive.pending;
            if (!pending?.resolution || !archive.known || pending.request.commandId !== action.commandId || archive.known.version !== action.version) throw new Error('归档裁决已变化，请重新查看后处理');
            tx.objectStore('staging').put(pending, `archive-conflict:${pending.request.commandId}`);
            archive = { ...archive, pending: action.archiveDecision === 'cloud' ? null : { request: ArchiveCommandSchema.parse({
              ...pending.request, commandId: crypto.randomUUID(), baseVersion: archive.known.version,
              members: pending.request.members.map((m) => ({ ...m, lifecycleVersion: life.known[m.contentId]!.version, displayVersion: display.known[m.contentId]!.version })),
            }) } };
          }
          else {
            const pending = life.pending[action.contentId], known = life.known[action.contentId];
            if (!pending?.conflict || !known || pending.request.commandId !== action.commandId || known.version !== action.version) throw new Error('回收站冲突已变化，请重新查看后选择');
            tx.objectStore('staging').put(pending, `lifecycle-conflict:${pending.request.commandId}`);
            if (action.decision === 'cloud') delete life.pending[action.contentId];
            else life.pending[action.contentId] = { request: { ...pending.request, commandId: crypto.randomUUID(), baseVersion: known.version } };
          }
          const volumes = archive.known?.volumes ?? original.volumes;
          const graphChanged = !sameMetadata(archiveBefore, archive.known);
          const nextEntries = graphChanged ? archivePositions(lifecycleEntries(metadataEntries(entries, display), life), volumes) : lifecycleEntries(metadataEntries(entries, display), life);
          const objects = [...requests.objects.result.filter((o) => o.kind !== 'volume'), ...volumes.map((v) => ({ kind: 'volume', ...v }))];
          const management = [...(held.management ?? [])];
          if (completedArchive && !management.some((e) => e.id === `mge_${completedArchive.commandId}`)) management.push({
            id: `mge_${completedArchive.commandId}`, sequence: management.length, at: new Date().toISOString(),
            op: completedArchive.type === 'archive' ? 'archive' : 'unarchive', branchId: completedArchive.type === 'archive' ? completedArchive.basis.streamId : null,
            targets: [completedArchive.volumeId],
          });
          const candidate = this.assemble({ ...held, entries: nextEntries }, requests.revisions.result, requests.branches.result, objects, management);
          if (!sameMetadata(original.volumes, volumes)) {
            if (!content) throw new Error('缺少归档内容验证上下文，原件与游标保留');
            for (const volume of volumes) validateArchiveProjection(content, candidate, volume);
          }
          if (!sameMetadata(nextEntries, entries) || !sameMetadata(original.volumes, volumes) || !sameMetadata(management, held.management ?? [])) {
            const meta = { ...held, entries: nextEntries, management, identity: { ...held.identity, repositoryRevision: held.identity.repositoryRevision + 1 } };
            tx.objectStore('meta').put(meta, 'workspace');
            const store = tx.objectStore('objects');
            for (const previous of original.volumes) if (!volumes.some((v) => v.id === previous.id)) store.delete(previous.id);
            for (const volume of volumes) store.put({ kind: 'volume', ...volume }, volume.id);
          }
          sync.put(display, 'metadata'); sync.put(life, 'lifecycle'); sync.put(archive, 'archives');
          if ('pull' in action || 'bootstrap' in action) sync.put({ ...storedSync(requests.sync.result), lastSyncedAt: new Date().toISOString() }, 'sync');
        } catch (cause) { error = cause instanceof Error ? cause.message : error; tx.abort(); }
      };
      for (const request of Object.values(requests)) request.onsuccess = step;
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(new Error(error));
    });
  }

  async metadataState(): Promise<MetadataState> {
    this.requireSync();
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync', 'readonly');
      const request = tx.objectStore('sync').get('metadata');
      tx.oncomplete = () => { try { resolve(parseMetadata(request.result, this.namespace.split(':')[3])); } catch { reject(new Error('展示信息同步状态不受支持，原件保留')); } };
      tx.onabort = tx.onerror = () => reject(new Error('读取展示信息同步状态失败'));
    });
  }

  /** Remote display values, versions and command acknowledgements commit together under the same repository revision. */
  async updateMetadata(action: { snapshot: MetadataSnapshot } | { receipt: MetadataReceipt } | {
    contentId: string; decision: 'local' | 'cloud'; commandId: string; version: number;
  }): Promise<void> {
    this.requireSync();
    const workspaceId = this.namespace.split(':')[3]!;
    if ('snapshot' in action) {
      MetadataSnapshotSchema.parse(action.snapshot);
      if (action.snapshot.workspaceId !== workspaceId) throw new Error('展示信息来自其他工作区');
    }
    if ('receipt' in action) MetadataReceiptSchema.parse(action.receipt);
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'sync', 'objects', 'staging'], 'readwrite');
      const store = tx.objectStore('sync');
      const metadata = store.get('metadata');
      const meta = tx.objectStore('meta').get('workspace');
      const preservation = store.get('preservation');
      const sync = store.get('sync');
      const revision = store.get('revisions');
      const objects = tx.objectStore('objects').getAll();
      let error = '展示信息未保存，原请求保留，可重试';
      let remaining = 6;
      const step = () => {
        if (--remaining) return;
        try {
          if (!meta.result) throw new Error('本机云副本不存在');
          if (revisionFrozen(parseRevisions(revision.result, workspaceId))) throw new Error('修订确认尚未完成，暂不应用展示信息');
          if (preservation.result || objects.result.some((o) => o.kind === 'ticket' && ['reserved', 'submitted'].includes(o.status))) {
            throw new Error('进行中的任务尚未完成，暂不应用展示信息');
          }
          let state = parseMetadata(metadata.result, workspaceId);
          const entries = meta.result.entries as Workspace['entries'];
          if ('snapshot' in action) state = mergeMetadata(state, action.snapshot.entries, entries, workspaceId);
          else if ('receipt' in action) state = receiveMetadata(state, action.receipt);
          else {
            const held = state.pending[action.contentId];
            const known = state.known[action.contentId];
            if (!held?.conflict || !known) throw new Error('这条展示信息没有待处理冲突');
            if (held.request.commandId !== action.commandId || known.version !== action.version) {
              throw new Error('展示信息冲突已变化，请重新查看两份内容后选择');
            }
            tx.objectStore('staging').put(held, `metadata-conflict:${held.request.commandId}`);
            if (action.decision === 'cloud') delete state.pending[action.contentId];
            else state.pending[action.contentId] = { request: {
              ...held.request, commandId: globalThis.crypto.randomUUID(), baseVersion: known.version,
            } };
          }
          const nextEntries = metadataEntries(entries, state);
          if (!sameMetadata(entries, nextEntries)) tx.objectStore('meta').put({
            ...meta.result, entries: nextEntries,
            identity: { ...meta.result.identity, repositoryRevision: meta.result.identity.repositoryRevision + 1 },
          }, 'workspace');
          store.put(state, 'metadata');
          if ('snapshot' in action) store.put({ ...storedSync(sync.result), lastSyncedAt: new Date().toISOString() }, 'sync');
        } catch (cause) { error = cause instanceof Error ? cause.message : error; tx.abort(); }
      };
      metadata.onsuccess = meta.onsuccess = preservation.onsuccess = objects.onsuccess = sync.onsuccess = revision.onsuccess = step;
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error(error));
    });
  }

  async syncState(): Promise<CloudSyncState> {
    this.requireSync();
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync', 'readonly');
      const request = tx.objectStore('sync').get('sync');
      tx.oncomplete = () => { try { resolve(storedSync(request.result)); } catch (cause) { reject(cause); } };
      tx.onabort = tx.onerror = () => reject(new Error('无法读取同步状态；本机存档未被修改'));
    });
  }

  async pendingOutbox(): Promise<OutboxEntry[]> {
    this.requireSync();
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('outbox', 'readonly');
      const request = tx.objectStore('outbox').getAll();
      tx.oncomplete = () => resolve((request.result ?? []) as OutboxEntry[]);
      tx.onabort = tx.onerror = () => reject(new Error('无法读取待同步事件；本机存档未被修改'));
    });
  }

  async pendingPreservation(): Promise<PendingPreservation | null> {
    this.requireSync();
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync', 'readonly');
      const request = tx.objectStore('sync').get('preservation');
      tx.oncomplete = () => {
        try { resolve(readPreservation(request.result, this.namespace.split(':')[3]!)); }
        catch (cause) { reject(cause); }
      };
      tx.onabort = tx.onerror = () => reject(new Error('无法读取冲突恢复请求；完整历史保留'));
    });
  }

  async preparePreservation(conflict: SyncConflict, streamId: string | null): Promise<PendingPreservation> {
    this.requireSync();
    if (conflict.workspaceId !== this.namespace.split(':')[3]) throw new Error('冲突不属于本机云工作区');
    const workspace = await this.load();
    if (!workspace) throw new Error('本机云副本不存在');
    if (workspace.branches.some((branch) => branch.id === streamId)) throw new Error('新分支身份已经存在，未发送保留请求');
    await this.stage(`sync-conflict:${conflict.id}`, { conflict, workspace });
    checkPreservation(workspace, conflict, streamId === null);
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'eventIds', 'sync'], 'readwrite');
      let result: PendingPreservation;
      let error = '冲突恢复请求尚未保存；未发出云端请求';
      const meta = tx.objectStore('meta').get('workspace');
      const pending = tx.objectStore('sync').get('preservation');
      const sync = tx.objectStore('sync').get('sync');
      const revision = tx.objectStore('sync').get('revisions');
      const identities: (SidecarEntry | null)[] = [];
      const branch = workspace.branches.find((entry) => entry.id === conflict.streamId)!;
      let left = branch.session.events.length + 4;
      const step = () => {
        if (--left) return;
        try {
          if (pending.result) {
            const held = readPreservation(pending.result, this.namespace.split(':')[3]!)!;
            if (held.conflict.id !== conflict.id) throw new Error('另一份冲突恢复尚未完成，请先恢复同一请求');
            if (held.request.decision !== (streamId === null ? 'discard' : 'keep-branch')) throw new Error('另一窗口已保存不同的冲突决定，请先恢复同一请求');
            result = held;
            return;
          }
          if (meta.result?.identity.repositoryRevision !== workspace.identity.repositoryRevision) throw new Error('另一个窗口已更新进度，请刷新后处理冲突');
          if (storedSync(sync.result).pendingPush) throw new Error('仍有结果未知的推送，请先恢复同一批次，不能改换冲突历史');
          if (revisionFrozen(parseRevisions(revision.result, this.namespace.split(':')[3]!))) throw new Error('修订确认尚未完成，请先恢复同一请求，不能改换冲突历史');
          for (let index = conflict.baseSeq; index < branch.session.events.length; index++) {
            if (!identities[index] || stableStringify(identities[index]!.event) !== stableStringify(branch.session.events[index])) {
              throw new Error('本机事件身份不完整，冲突包已保留；不能重新分配历史身份');
            }
          }
          if (conflict.events.some((entry) => identities[entry.seq - 1]?.eventId !== entry.eventId)) {
            throw new Error('冲突候选的事件身份与本机不一致，完整冲突包已保留');
          }
          const confirmed = storedSync(sync.result).streams[branch.id];
          const baseEventId = conflict.baseSeq
            ? identities[conflict.baseSeq - 1]?.eventId ?? (confirmed?.seq === conflict.baseSeq ? confirmed.eventId : null)
            : null;
          if (streamId !== null && conflict.baseSeq && !baseEventId) throw new Error('共同前缀缺少事件身份，完整冲突包已保留');
          result = { conflict, request: streamId === null
            ? { workspaceId: this.namespace.split(':')[3]!, decision: 'discard' }
            : { workspaceId: this.namespace.split(':')[3]!, decision: 'keep-branch', streamId, baseEventId: baseEventId ?? null }, workspace, identities };
          ResolveConflictRequestSchema.parse(result.request);
          tx.objectStore('sync').put(result, 'preservation');
        } catch (cause) {
          error = cause instanceof Error ? cause.message : error;
          tx.abort();
        }
      };
      meta.onsuccess = pending.onsuccess = sync.onsuccess = revision.onsuccess = step;
      branch.session.events.forEach((_event, index) => {
        const request = tx.objectStore('eventIds').get(sidecarKey(branch.id, index + 1));
        request.onsuccess = () => { identities[index] = request.result ?? null; step(); };
      });
      tx.oncomplete = () => resolve(result!);
      tx.onabort = tx.onerror = () => reject(new Error(error));
    });
  }

  async saveSyncState(state: CloudSyncState): Promise<void> {
    this.requireSync();
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync', 'readwrite');
      const store = tx.objectStore('sync');
      const current = store.get('sync'), pending = store.get('preservation');
      let left = 2, error = '同步状态尚未保存';
      const done = () => {
        if (--left) return;
        try {
          storedSync(current.result);
          if (state.pendingPush && pending.result) throw new Error('同步状态尚未保存：冲突处理尚未完成，不能创建竞争推送');
          store.put(state, 'sync');
        } catch (cause) { error = cause instanceof Error ? cause.message : error; tx.abort(); }
      };
      current.onsuccess = pending.onsuccess = done;
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error(error));
    });
  }

  /** Bounded identity lookup also verifies already-present historical pages; equal text is not identity. */
  async eventIdentities(streamId: string, startSeq: number, count: number): Promise<(SidecarEntry | null)[]> {
    this.requireSync();
    if (!Number.isSafeInteger(startSeq) || startSeq < 1 || !Number.isSafeInteger(count) || count < 0 || count > CLOUD_LIMITS.eventsPerBatch) throw new Error('事件身份读取范围无效');
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('eventIds', 'readonly');
      const requests = Array.from({ length: count }, (_, i) => tx.objectStore('eventIds').get(sidecarKey(streamId, startSeq + i)));
      tx.oncomplete = () => {
        try {
          resolve(requests.map((r) => {
            if (r.result === undefined) return null;
            const row = r.result as SidecarEntry;
            if (!row || Object.keys(row).sort().join() !== 'event,eventId' || !UuidSchema.safeParse(row.eventId).success
              || !sameMetadata(SyncPlayerEventSchema.parse(row.event), row.event)) throw new Error('未知事件身份保留，不能覆盖');
            return row;
          }));
        } catch (cause) { reject(cause); }
      };
      tx.onabort = tx.onerror = () => reject(new Error('事件身份读取失败，原记录保留'));
    });
  }

  /** Re-anchor the cursor without replacing business rows, identities, commands or acknowledged heads. */
  async reanchorSync(expected: CloudSyncState, raw: SyncBootstrap): Promise<void> {
    this.requireSync();
    const boot = SyncBootstrapSchema.parse(raw);
    if (boot.workspaceId !== this.namespace.split(':')[3] || !boot.origin
      || (expected.cloudVersion !== null && BigInt(boot.cloudVersion) < BigInt(expected.cloudVersion))
      || Object.entries(expected.streams).some(([id, head]) => {
        const current = boot.streams.find((s) => s.streamId === id);
        return !current || current.eventSeq < head.seq || (current.eventSeq === head.seq && current.lastEventId !== head.eventId);
      })) throw new Error('恢复引导与本机已确认前缀不一致，原游标与完整历史保留');
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['sync', 'outbox'], 'readwrite');
      const store = tx.objectStore('sync');
      const state = store.get('sync'), outbox = tx.objectStore('outbox').count(), pending = store.get('preservation');
      let left = 3, error = '恢复游标尚未保存，原数据保留';
      const step = () => {
        if (--left) return;
        try {
          const current = storedSync(state.result);
          if (stableStringify(current) !== stableStringify(expected)) throw new Error('另一窗口已更新同步状态，请重试恢复');
          if (outbox.result || current.pendingPush || current.conflicts.length || current.needsRebase.length || pending.result) {
            throw new Error('仍有未同步事件或冲突请求，不能重新定位阅读游标');
          }
          store.put({ ...current, cursor: boot.origin!.cursor, lastError: null }, 'sync');
        } catch (cause) { error = cause instanceof Error ? cause.message : error; tx.abort(); }
      };
      state.onsuccess = outbox.onsuccess = pending.onsuccess = step;
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error(error));
    });
  }

  /** Reconstruct before opening a transaction, then atomically CAS the complete read set and snapshot cut. */
  async acceptReadingSnapshot(content: Content, expected: CloudSyncState, raw: ReadingSnapshot, seedCursor?: string): Promise<void> {
    this.requireSync();
    const snapshot = ReadingSnapshotSchema.parse(raw), workspaceId = this.namespace.split(':')[3]!;
    const before = await this.rawSnapshot() as any;
    const installation = await this.cloudInstallation();
    const value = (key: string) => before.sync.find((r: any) => r.key === key)?.value;
    const sync = storedSync(value('sync'));
    const original = this.assemble(before.meta, before.revisions, before.branches, before.objects, before.meta?.management ?? []);
    let revisions = parseRevisions(value('revisions'), workspaceId), display = parseMetadata(value('metadata'), workspaceId);
    parseLifecycle(value('lifecycle'), workspaceId); parseArchives(value('archives'), workspaceId);
    if (!installation || snapshot.workspaceId !== workspaceId || snapshot.sourceDigest !== installation.receipt.copyDigest
      || new TextEncoder().encode(JSON.stringify(snapshot)).length > CLOUD_LIMITS.uploadObjectBytes - 4096
      || !sameMetadata(expected, sync) || (sync.cloudVersion !== null && BigInt(snapshot.cloudVersion) < BigInt(sync.cloudVersion))) throw new Error('阅读快照与安装回执或已确认版本不一致，原数据保留');
    const seedOnly = !!seedCursor && before.outbox.length > 0 && sync.cloudVersion === null && Object.keys(sync.streams).length === 0 && !revisions.installed.length;
    if ((before.outbox.length && !seedOnly) || sync.pendingPush || sync.conflicts.length || sync.needsRebase.length || value('preservation')
      || original.tickets.some((t) => ['reserved', 'submitted'].includes(t.status))) throw new Error('仍有未同步事件、冲突或未知任务，不能用快照替换阅读状态');
    if (before.sync.some((r: any) => !['sync', 'metadata', 'lifecycle', 'archives', 'revisions', 'preservation'].includes(r.key))) throw new Error('未知同步 sidecar 保留，不能猜测快照恢复');
    const remote = await rebuildCloudReading(content, snapshot, cloudDigest);
    const catalog = snapshot.revisionCatalog.registrations;
    if (catalog.length < revisions.installed.length || revisions.installed.some((r, i) => !sameMetadata(r, catalog[i]))) throw new Error('快照修订登记早于或不同于已安装记录');
    const byId = new Map(snapshot.histories.map((h) => [h.stream.streamId, h]));
    if (seedOnly) {
      const seed = parseWorkspace(snapshot.source), identities: { key: string; value: SidecarEntry }[] = [];
      if (revisionFrozen(revisions) || original.revisions.length !== seed.revisions.length
        || original.revisions.some((r) => !seed.revisions.some((s) => s.id === r.id && sameMetadata(r, s)))) throw new Error('本机不再是该导入种子的追加，不能猜测初始同步绑定');
      const streams: CloudSyncState['streams'] = {};
      for (const b of seed.branches) {
        const local = original.branches.find((v) => v.id === b.id), h = byId.get(b.id)!;
        if (!local || !sameMetadata(local.adopted, b.adopted) || b.session.events.some((e, i) => !sameMetadata(e, local.session.events[i]))) throw new Error('本机导入前缀不同，不能建立初始同步绑定');
        streams[b.id] = { seq: b.session.events.length, eventId: h.events[b.session.events.length - 1]?.eventId ?? null };
        b.session.events.forEach((event, i) => {
          const key = sidecarKey(b.id, i + 1), held = before.eventIds.find((r: any) => r.key === key)?.value;
          const value = { eventId: h.events[i]!.eventId, event };
          if (held && !sameMetadata(held, value)) throw new Error('初始前缀事件身份不同，原记录保留');
          identities.push({ key, value });
        });
        for (let i = b.session.events.length; i < local.session.events.length; i++) {
          const queued = before.outbox.find((r: any) => r.value.streamId === b.id && r.value.seq === i + 1)?.value;
          const held = before.eventIds.find((r: any) => r.key === sidecarKey(b.id, i + 1))?.value;
          if (!queued || !held || queued.eventId !== held.eventId || !sameMetadata(queued.event, local.session.events[i]) || !sameMetadata(held.event, queued.event)) throw new Error('本机待提交事件缺少完整排队身份，不能建立初始绑定');
        }
      }
      // This is only an import-prefix binding. No snapshot event, revision, cursor cut or queue ack is installed.
      return this.commitReadingRecovery(before, installation, (tx) => {
        tx.objectStore('sync').put({ ...sync, cloudVersion: snapshot.cloudVersion, streams, cursor: seedCursor, lastError: null }, 'sync');
        for (const row of identities) tx.objectStore('eventIds').put(row.value, row.key);
      });
    }
    for (const [id, head] of Object.entries(sync.streams)) {
      const h = byId.get(id);
      if (!h || h.events.length < head.seq || (h.events[head.seq - 1]?.eventId ?? null) !== head.eventId) throw new Error('快照缺少本机已确认前缀，原数据保留');
    }
    for (const b of original.branches) {
      const h = byId.get(b.id);
      if (!h) { if (sync.streams[b.id]) throw new Error('快照缺少已绑定分支'); continue; }
      if (b.session.events.some((e, i) => !sameMetadata(e, h.events[i]?.event))) throw new Error('快照会覆盖本机历史，必须先显式处理分叉');
    }
    for (const r of original.revisions) if (!remote.revisions.some((p) => p.id === r.id && sameMetadata(p, r))) throw new Error('快照会替换原始修订，原件保留');
    for (const r of before.eventIds) {
      const split = String(r.key).lastIndexOf(':'), id = String(r.key).slice(0, split), seq = Number(String(r.key).slice(split + 1));
      const h = byId.get(id);
      if (h && (!Number.isInteger(seq) || seq < 1 || r.value.eventId !== h.events[seq - 1]?.eventId || !sameMetadata(r.value.event, h.events[seq - 1]?.event))) throw new Error('快照事件身份与本机记录不同，原件保留');
    }
    const seed = parseWorkspace(snapshot.source), previously = revisions.installed.at(-1)?.obligations ?? seed.obligations;
    assertReadingObligationProgress(content, original, previously);
    const additions = catalog.slice(revisions.installed.length);
    const pending = revisions.pending;
    const own = pending?.confirmation ? additions.find((r) => r.commandId === pending.confirmation!.commandId) : undefined;
    if (revisionFrozen(revisions) && !own) throw new Error('修订确认结果未知，先恢复同一请求');
    if (own && (!pending || own.previewRequestId !== pending.request.requestId || pending.preview?.outcome !== 'ready'
      || !sameMetadata(own.artifact, pending.preview.artifact)
      || (pending.result && (pending.result.outcome !== 'applied' || !sameMetadata(pending.result.registration, own))))) throw new Error('快照修订与原确认请求不一致');
    for (const r of additions) display = mergeDisplayChanges(display, [r.display], original.entries);
    const entries = original.entries.map((e) => {
      const r = remote.entries.find((r) => r.id === e.id)!;
      if (!r) throw new Error('快照缺少原条目');
      const changed = e.headRevisionId !== r.headRevisionId;
      return { ...e, revisionIds: r.revisionIds, headRevisionId: r.headRevisionId,
        ...(changed ? { updatedAt: r.updatedAt, display: { ...e.display, title: r.display.title, subtitle: r.display.subtitle, description: r.display.description } } : {}) };
    });
    const management = [...original.management];
    for (const r of additions) if (!management.some((m) => m.id === `mge_${r.commandId}`)) management.push({
      id: `mge_${r.commandId}`, sequence: management.length, op: 'adopt-revision', at: ContentRevisionSchema.parse(r.artifact.revision).authoredAt,
      branchId: r.artifact.binding.streamId, targets: [r.entry.contentId, r.entry.headRevisionId],
    });
    const branches = remote.branches.map((b) => {
      const held = original.branches.find((old) => old.id === b.id);
      return held ? { ...b, session: { ...b.session, revision: held.session.revision + 1, current: held.session.current, largeText: held.session.largeText } } : b;
    }).concat(original.branches.filter((b) => !byId.has(b.id)));
    const workspace = parseWorkspace({ ...original, activeBranchId: own?.stream.streamId ?? original.activeBranchId,
      entries: metadataEntries(entries, display), revisions: remote.revisions, obligations: retainReadingCompletionTimes(original.obligations, remote.obligations),
      branches, management, identity: { ...original.identity, repositoryRevision: original.identity.repositoryRevision + 1 } });
    for (const b of workspace.branches) bridge(content, workspace, b.id);
    revisions = { ...revisions, installed: catalog, pending: own ? null : pending };
    const nextSync = { ...sync, cursor: snapshot.cursor, cloudVersion: snapshot.cloudVersion, lastError: null,
      streams: Object.fromEntries(snapshot.histories.map((h) => [h.stream.streamId, { seq: h.stream.eventSeq, eventId: h.stream.lastEventId }])), lastSyncedAt: new Date().toISOString() };
    const rows = this.rows(workspace);
    return this.commitReadingRecovery(before, installation, (tx) => {
      tx.objectStore('meta').put({ ...rows.meta, management: rows.management }, 'workspace');
      for (const r of rows.revisions) tx.objectStore('revisions').put(r, r.id);
      for (const b of rows.branches) tx.objectStore('branches').put(b, b.id);
      tx.objectStore('sync').put(nextSync, 'sync'); tx.objectStore('sync').put(revisions, 'revisions'); tx.objectStore('sync').put(display, 'metadata');
      for (const h of snapshot.histories) for (const e of h.events) tx.objectStore('eventIds').put({ eventId: e.eventId, event: e.event }, sidecarKey(h.stream.streamId, e.seq));
      // Existing staging rows remain untouched; do not recursively embed earlier recovery packages.
      const recoveryKey = `reading-snapshot:${snapshot.digest}`, saved = tx.objectStore('staging').get(recoveryKey);
      saved.onsuccess = () => { if (!saved.result) tx.objectStore('staging').put({ format: 'reading-snapshot-recovery/1', snapshotDigest: snapshot.digest,
        previous: { ...before, staging: [] }, retainedStagingCount: before.staging.length }, recoveryKey); };
      if (own) tx.objectStore('staging').put(pending, `revision-result:${own.commandId}`);
    });
  }

  private async commitReadingRecovery(before: any, installation: CloudLocalInstallation, write: (tx: IDBTransaction) => void): Promise<void> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'revisions', 'branches', 'objects', 'staging', ...SYNC_STORES], 'readwrite');
      const actual: any = {}, names = ['revisions', 'branches', 'objects', 'staging', ...SYNC_STORES];
      let left = names.length + 2, error = '快照接收失败，原数据与游标保留，可重新读取';
      const install = tx.objectStore('meta').get('cloud-installation');
      const done = () => {
        if (--left) return;
        try {
          if (!sameMetadata(actual, before) || !sameMetadata(install.result, installation)) throw new Error('另一窗口或同步已更新存档，快照未接收');
          write(tx);
        } catch (cause) { error = cause instanceof Error ? cause.message : error; tx.abort(); }
      };
      install.onsuccess = done;
      const meta = tx.objectStore('meta').get('workspace'); meta.onsuccess = () => { actual.meta = meta.result ?? null; done(); };
      for (const name of names) {
        if ((SYNC_STORES as readonly string[]).includes(name)) {
          const cursor = tx.objectStore(name).openCursor(), values: any[] = []; actual[name] = values;
          cursor.onsuccess = () => { const row = cursor.result; if (row) { values.push({ key: row.key, value: row.value }); row.continue(); } else done(); };
        } else { const req = tx.objectStore(name).getAll(); req.onsuccess = () => { actual[name] = req.result; done(); }; }
      }
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(new Error(error));
    });
  }

  async releasePreservation(plan: PendingPreservation): Promise<void> {
    this.requireSync();
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['sync', 'staging'], 'readwrite');
      const store = tx.objectStore('sync');
      const request = store.get('preservation');
      request.onsuccess = () => {
        if (!request.result) return;
        if (stableStringify(request.result.request) !== stableStringify(plan.request)) { tx.abort(); return; }
        tx.objectStore('staging').put(plan, `sync-preservation:${plan.conflict.id}`);
        store.delete('preservation');
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error('云端拒绝记录尚未保存；恢复请求与完整历史仍保留'));
    });
  }

  /** 推送成功：删除已确认事件并推进云端前缀，全部在同一事务。 */
  async acknowledgePush(receipt: SyncPushReceipt, keys: readonly string[]): Promise<void> {
    this.requireSync();
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['outbox', 'sync'], 'readwrite');
      const outbox = tx.objectStore('outbox');
      for (const key of keys) outbox.delete(key);
      const store = tx.objectStore('sync');
      const request = store.get('sync');
      request.onsuccess = () => {
        try {
          const state = storedSync(request.result);
          const streams = { ...state.streams };
          for (const stream of receipt.streams) streams[stream.streamId] = { seq: stream.eventSeq, eventId: stream.lastEventId };
          store.put({
            ...state, streams, cloudVersion: receipt.cloudVersion,
            pendingPush: undefined,
            lastError: null, lastSyncedAt: new Date().toISOString(),
          }, 'sync');
        } catch { tx.abort(); }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error('推送回执尚未保存，可沿原批次重试'));
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
