import { useEffect, useMemo, useRef, useState } from 'react';
import { episodeCompletion, getScenes, projectSession, type PlayerCommand, type PlayerView } from '@endless/player';
import {
  adoptRevision, applyPlayerCommand, assertNoSecrets, attachVolume, bridge, buildBackup, buildGenerationContext,
  memoryCatalogCache, openCloudCatalog,
  type CloudCatalogCache,
  buildVolume, cancelTicket, commitTicketResult, createWorkspace, detachVolume, markTicketFailed,
  markTicketSubmitted, parseBackup, previewRevision, purgeContent, purgePreview, reserveTicket,
  restoreContent, suggestVolumes, switchBranch, trashContent, updateDisplay, waiveObligation,
  type ApiStatus, type ArchiveVolume, type ContentEntry, type ContentRevision, type GenerationRequest,
  type ImportPreview, type RevisionPreview, type Workspace, type GenerationTicket,
} from '@endless/content';
import { content } from './content/catalog.js';
import { WorkspaceRepository } from './storage.js';
import { SessionCommitter } from './session-writer.js';
import { apiStatus, generateEpisode } from './api.js';
import { CloudApi } from './cloud/client.js';
import { cloudDigest } from './cloud/local.js';
import { WorkspaceSync, type SyncReport } from './cloud/sync.js';
import { ManagementSync } from './cloud/management-sync.js';
import type { LifecycleState } from './cloud/lifecycle.js';
import type { ArchiveView } from './cloud/archives.js';
import type { MetadataState } from './cloud/metadata.js';
import { editableMetadata, sameMetadata } from './cloud/metadata.js';

/**
 * 打开云副本时的最小参数：命名空间已经由三个云端 ID 推出，这里只认「哪个库、哪个工作区」。
 * 不传表示本机游客存档——行为与之前完全一致。
 */
export interface CloudPlayerOptions {
  namespace: string;
  workspaceId: string;
}

export interface CloudReadView {
  metadataPending?: number;
  metadataConflicts?: number;
  lifecyclePending?: number;
  lifecycleConflicts?: number;
  archivePending?: boolean;
  pending: number;
  paused: boolean;
  lastSyncedAt: string | null;
  cloudVersion: string | null;
  conflicts: number;
  needsRebase: number;
  stopped: 'conflict' | 'cursor' | 'replay' | 'ticket' | 'prefix' | null;
  note: string;
}

export function usePlayer(cloud?: CloudPlayerOptions) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState('');
  const [raw, setRaw] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [phase, setPhase] = useState('');
  const [api, setApi] = useState<ApiStatus | null>(null);
  const [apiError, setApiError] = useState('');
  const [apiKey, setApiKey] = useState('');
  const repository = useRef<WorkspaceRepository | null>(null);
  const writer = useRef<SessionCommitter | null>(null);
  const current = useRef<Workspace | null>(null);
  const pending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const currentTicket = useRef<GenerationTicket | null>(null);
  const [cloudView, setCloudView] = useState<CloudReadView | null>(null);
  const [cloudSyncing, setCloudSyncing] = useState(false);
  const [cloudMetadata, setCloudMetadata] = useState<MetadataState | null>(null);
  const [cloudLifecycle, setCloudLifecycle] = useState<LifecycleState | null>(null);
  const [cloudArchives, setCloudArchives] = useState<ArchiveView | null>(null);
  const syncEngine = useRef<WorkspaceSync | null>(null);
  const syncBusy = useRef(false);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    const storage = new WorkspaceRepository(globalThis.indexedDB, cloud?.namespace);
    repository.current = storage;
    writer.current = new SessionCommitter(storage, -1);
    void storage.load().then(async (stored) => {
      if (!active) return;
      if (cloud) {
        // 云副本必须同时有存档和安装记录：只有其一都说明这个库不该被当作可读副本
        const installation = await storage.cloudInstallation().catch(() => null);
        if (!active) return;
        if (!stored || !installation) {
          setFailure('这台设备还没有这份云副本。请先在「云端副本」页领取，再打开阅读；游客存档不受影响。');
          return;
        }
        if (installation.receipt.workspaceId !== cloud.workspaceId) {
          setFailure('本机安装记录与要打开的工作区不一致，已停止打开；本机数据未被修改。');
          return;
        }
        const deviceId = installation.acknowledgements[0]?.deviceId;
        if (!deviceId) {
          setFailure('云副本缺少本机设备记录，暂时无法同步；本机数据未被修改。');
          return;
        }
        writer.current = new SessionCommitter(storage, stored.identity.repositoryRevision);
        current.current = stored;
        setWorkspace(stored);
        syncEngine.current = new WorkspaceSync({
          repo: storage, api: new CloudApi(), content, workspaceId: cloud.workspaceId, deviceId,
          digest: (value) => cloudDigest(value),
          newBatchId: () => globalThis.crypto.randomUUID(),
        });
        void syncNow();
        return;
      }
      writer.current = new SessionCommitter(storage, stored?.identity.repositoryRevision ?? -1);
      const workspace = stored ?? createWorkspace(content);
      if (!stored) {
        // 首次建库：提交失败必须显示可重试错误，不能让界面假装已经保存
        const written = await writer.current.commit(workspace);
        if (!written.ok) {
          setFailure(written.error);
          return;
        }
        current.current = written.workspace;
        setWorkspace(written.workspace);
      } else {
        current.current = workspace;
        setWorkspace(workspace);
      }
      const open = (stored ?? workspace).tickets.find((t) => t.status === 'reserved' || t.status === 'submitted');
      if (open) {
        currentTicket.current = open;
        setPhase('上次生成任务已保留，可恢复等待，不会创建重复任务');
      }
    }).catch((error: unknown) => {
      if (active) {
        setFailure(error instanceof Error ? error.message : '无法恢复本地进度，原始存档已保留');
        void storage.rawSnapshot().then((snapshot) => { if (active && snapshot != null) setRaw(snapshot); }).catch(() => {});
      }
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
      controller.current?.abort();
      if (syncTimer.current) clearTimeout(syncTimer.current);
      void storage.close().catch(() => {});
    };
  }, []);

  useEffect(() => { void refreshApi(); }, []);

  useEffect(() => {
    const clearKey = () => {
      setApiKey('');
      for (const input of document.querySelectorAll<HTMLInputElement>('[data-session-provider-key]')) input.value = '';
    };
    const restorePage = (event: PageTransitionEvent) => { if (event.persisted) clearKey(); };
    window.addEventListener('pagehide', clearKey);
    window.addEventListener('pageshow', restorePage);
    return () => {
      window.removeEventListener('pagehide', clearKey);
      window.removeEventListener('pageshow', restorePage);
    };
  }, []);

  // 调用方每次渲染都会新建 cloud 参数对象。只认命名空间，避免目录跟着渲染重建。
  // 编译结果按修订哈希留在这次页面里；换一个云副本才换缓存。
  const cloudNamespace = cloud?.namespace;
  const catalogCache = useRef<{ namespace: string; cache: CloudCatalogCache } | null>(null);
  const cloudCatalog = useMemo(() => {
    if (!cloudNamespace || !workspace) return null;
    if (!catalogCache.current || catalogCache.current.namespace !== cloudNamespace) {
      catalogCache.current = { namespace: cloudNamespace, cache: memoryCatalogCache() };
    }
    return openCloudCatalog(content, workspace, catalogCache.current.cache);
  }, [cloudNamespace, workspace]);
  const runtime = useMemo(() => {
    if (!workspace) return null;
    if (!cloudCatalog) return bridge(content, workspace);
    const active = workspace.branches.find((branch) => branch.id === workspace.activeBranchId);
    if (!active) return null;
    // 只编译事件和当前集碰到的内容。更晚、尚未打开的生成集留在目录里。
    cloudCatalog.prepare(active.session);
    return cloudCatalog.runtime(workspace);
  }, [workspace, cloudCatalog]);
  const session = runtime?.session ?? null;
  const library = runtime?.library ?? content.pilot;
  const view: PlayerView | null = useMemo(
    () => runtime ? projectSession(runtime.session, runtime.library) : null,
    [runtime],
  );

  async function refreshApi() {
    try {
      setApi(await apiStatus());
      setApiError('');
    } catch (error) {
      setApi(null);
      setApiError(error instanceof Error ? error.message : '本机 AI 服务未连接');
    }
  }

  /**
   * 云副本的同步往返：先推送本机事件，再拉取云端变更。
   *
   * 三条纪律：
   * 1. 有事件正在提交（pending）或有进行中生成任务时不并发跑同步，
   *    否则会用服务端刚读到的旧版本覆盖内存里的新状态；
   * 2. 同步结束后**从仓库重新读取**，不把驱动层的内存副本当成界面状态；
   * 3. 失败只更新可见状态，不隐藏本机存档，也不把失败写成「已同步」。
   */
  async function syncNow(): Promise<void> {
    const engine = syncEngine.current;
    const repo = repository.current;
    if (!engine || !repo || syncBusy.current || pending.current || currentTicket.current) return;
    syncBusy.current = true;
    setCloudSyncing(true);
    let report: SyncReport | undefined;
    let message = '';
    try {
      report = await engine.run();
      if (cloud && !(await repo.syncState()).paused) await new ManagementSync(repo, new CloudApi(), cloud.workspaceId, content).run();
    } catch (error) {
      message = error instanceof Error ? error.message : '云端同步失败；本机进度已保留';
    } finally {
      // A request may have committed before a later request failed. Always reload the durable baseline.
      try {
        const [stored, status, metadata, lifecycle, archives] = await Promise.all([repo.load(), engine.status(), repo.metadataState(), repo.lifecycleState(), repo.archiveState()]);
        if (stored) {
          current.current = stored;
          setWorkspace(stored);
          writer.current = new SessionCommitter(repo, stored.identity.repositoryRevision);
        }
        setCloudMetadata(metadata);
        setCloudLifecycle(lifecycle);
        setCloudArchives(archives);
        setCloudView({
          metadataPending: Object.keys(metadata.pending).length,
          metadataConflicts: Object.values(metadata.pending).filter((entry) => entry.conflict).length,
          lifecyclePending: Object.keys(lifecycle.pending).length,
          archivePending: !!archives.pending,
          lifecycleConflicts: Object.values(lifecycle.pending).filter((entry) => entry.conflict).length,
          pending: status.pending, paused: status.state.paused, lastSyncedAt: status.state.lastSyncedAt,
          cloudVersion: status.state.cloudVersion, conflicts: status.state.conflicts.length,
          needsRebase: status.state.needsRebase.length, stopped: report?.stopped ?? null, note: message || report?.note || '',
        });
      } catch (error) { setNotice(error instanceof Error ? error.message : '读取同步结果失败，原件保留'); }
      syncBusy.current = false;
      setCloudSyncing(false);
    }
  }

  /** 每次本地提交后延迟同步：连续点「继续」只发一批，而不是每个片段一趟往返。 */
  function scheduleSync() {
    if (!syncEngine.current) return;
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      syncTimer.current = null;
      void syncNow();
    }, 700);
  }

  /** 同步正在写同一个仓库时先让它落地：两边都写会撞版本校验，等一会儿比重试更容易解释。 */
  async function awaitSyncIdle(): Promise<void> {
    for (let tick = 0; tick < 100 && syncBusy.current; tick++) await new Promise((resolve) => setTimeout(resolve, 30));
    if (syncBusy.current) throw new Error('同步尚未完成，请稍后重试本次操作');
  }

  /** 统一提交：内存命令 → 递增版本 → 事务提交 → 更新状态；失败时保留原状态。 */
  async function commit(next: Workspace, options: { closingTicketId?: string } = {}): Promise<boolean> {
    await awaitSyncIdle();
    const committer = writer.current;
    if (!committer) return false;
    const result = await committer.commit(next, options);
    if (!result.ok) {
      setNotice(result.error);
      return false;
    }
    current.current = result.workspace;
    setWorkspace(result.workspace);
    if (cloud && repository.current) {
      try {
        const [display, lifecycle] = await Promise.all([repository.current.metadataState(), repository.current.lifecycleState()]);
        setCloudMetadata(display); setCloudLifecycle(lifecycle);
        setCloudView((held) => held && ({ ...held,
          metadataPending: Object.keys(display.pending).length,
          metadataConflicts: Object.values(display.pending).filter((entry) => entry.conflict).length,
          lifecyclePending: Object.keys(lifecycle.pending).length,
          lifecycleConflicts: Object.values(lifecycle.pending).filter((entry) => entry.conflict).length,
        }));
      } catch { setNotice('操作已保存，但同步状态尚未读取，请重试同步'); }
    }
    scheduleSync();
    return true;
  }

  async function dispatch(command: PlayerCommand): Promise<boolean> {
    if (!current.current || pending.current || currentTicket.current) return false;
    pending.current = true;
    setSaving(true);
    setNotice('');
    try {
      await awaitSyncIdle();
      const active = current.current.branches.find((branch) => branch.id === current.current?.activeBranchId);
      if (cloudCatalog && active) cloudCatalog.prepare(active.session, command);
      const next = applyPlayerCommand(
        content, current.current, command, new Date(),
        cloudCatalog ? cloudCatalog.runtime(current.current) : undefined,
      );
      if (next === current.current) return true;
      return await commit(next);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '操作未保存，请重试');
      return false;
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  /** 管理命令（不影响学习事件）。 */
  async function manage(fn: (workspace: Workspace) => Workspace, cloudAllowed = false): Promise<boolean> {
    if (!current.current || pending.current || currentTicket.current) return false;
    if (cloud && !cloudAllowed) { setNotice('云端暂未接入这类内容管理命令'); return false; }
    pending.current = true;
    setSaving(true);
    setNotice('');
    try {
      await awaitSyncIdle();
      // 管理命令只执行一次；在任何持久化前先过临时 Key 护栏，再提交
      const next = fn(current.current);
      assertNoSecrets(next, [apiKey]);
      return await commit(next);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '操作未保存，请重试');
      return false;
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  async function generate(): Promise<boolean> {
    if (!current.current || !writer.current || pending.current) return false;
    pending.current = true;
    setGenerating(true);
    setNotice('');
    const abort = new AbortController();
    controller.current = abort;
    try {
      const isResume = !!currentTicket.current;
      let ticket = currentTicket.current;
      let request: GenerationRequest | null = null;
      if (!ticket) {
        const { workspace: reserved, ticket: created } = reserveTicket(current.current);
        const rt = bridge(content, reserved);
        const context = buildGenerationContext(reserved, rt);
        const requestId = created.id.slice(4);
        request = { requestId, save: context.save, archives: context.archives };
        // 预留任务必须先落库，再发请求；历史绑定存于任务依据
        const reservedWrite = await writer.current.commit(reserved);
        if (!reservedWrite.ok) {
          setNotice(reservedWrite.error);
          return false;
        }
        const committed = reservedWrite.workspace;
        current.current = committed;
        setWorkspace(committed);
        ticket = committed.tickets.find((t) => t.id === created.id)!;
        // 预留已落库：立刻持有引用，后面任何一次提交失败都还能取消/重试
        currentTicket.current = ticket;
        const submitted = markTicketSubmitted(committed, ticket.id);
        if (!(await commit(submitted))) return false;
        // 预留路径已提交：引用必须刷新为落库后的票据，否则下面的共享检查会重复提交
        ticket = current.current!.tickets.find((t) => t.id === ticket!.id)!;
      } else {
        const rt = bridge(content, current.current, ticket.branchId);
        const context = buildGenerationContext(current.current, rt);
        request = { requestId: ticket.id.slice(4), save: context.save, archives: context.archives };
      }
      // 库内恢复的 reserved 票据必须先流转 submitted，再发出请求
      if (ticket.status === 'reserved') {
        const submitted = markTicketSubmitted(current.current!, ticket.id);
        if (!(await commit(submitted))) return false;
        ticket = current.current!.tickets.find((t) => t.id === ticket!.id)!;
      }
      currentTicket.current = ticket;
      setPhase('正在连接本机 AI 服务…');
      const result = await generateEpisode(request, setPhase, abort.signal, apiKey, isResume);
      if (abort.signal.aborted) return false;
      if (result.failed) {
        const failedWs = markTicketFailed(current.current!, ticket.id, result.failure?.category ?? 'unknown');
        // 失败状态没能落库时保留引用：用户仍可取消或重试，不会永久卡在预留态
        if (await commit(failedWs, { closingTicketId: ticket.id })) currentTicket.current = null;
        setNotice(result.message);
        setPhase(result.message);
        void refreshApi();
        return false;
      }
      const next = commitTicketResult(content, current.current!, ticket.id, result.document);
      const failedTicket = next.tickets.find((t) => t.id === ticket.id);
      if (failedTicket?.status === 'failed') {
        if (await commit(next, { closingTicketId: ticket.id })) currentTicket.current = null;
        setNotice('生成结果与当前历史不匹配，已保留结果但未写入分支。请检查分支状态');
        return false;
      }
      // 结果采用与选中新内容在同一事务提交，不留「已采用但未选中」的中间态
      const adopted = next.branches.find((b) => b.id === next.activeBranchId)!;
      const episodeId = next.revisions.find((r) => r.id === adopted.adopted.at(-1)!.revisionId)!.episodeId;
      const selected = applyPlayerCommand(content, next, { type: 'select', episode: episodeId });
      if (!(await commit(selected, { closingTicketId: ticket.id }))) return false;
      currentTicket.current = null;
      setPhase('新一集已校验并保存到此设备');
      void refreshApi();
      return true;
    } catch (error) {
      if (!abort.signal.aborted) {
        setNotice(error instanceof Error ? error.message : '生成未完成。任务已保留，可恢复原任务');
        setPhase('任务已保留；恢复时会使用相同任务 ID，避免重复调用');
      }
      return false;
    } finally {
      if (controller.current === abort) {
        pending.current = false;
        setGenerating(false);
      }
    }
  }

  async function cancelGeneration() {
    const ticket = currentTicket.current;
    if (!ticket || !current.current) return;
    controller.current?.abort();
    const cancelled = cancelTicket(current.current, ticket.id);
    if (await commit(cancelled, { closingTicketId: ticket.id })) {
      currentTicket.current = null;
      setPhase('已停止本地等待。服务端可能仍在生成；相同进度再次请求会复用已有任务');
    }
  }

  // ---------- 内容管理 ----------

  const editDisplay = (entry: ContentEntry, patch: Partial<ContentEntry['display']>) =>
    manage((ws) => {
      const held = ws.entries.find((candidate) => candidate.id === entry.id);
      if (cloud && (!held || held.updatedAt !== entry.updatedAt || !sameMetadata(editableMetadata(held.display), editableMetadata(entry.display)))) {
        throw new Error('展示信息在编辑期间已变化，请重新打开编辑器；本次输入尚未保存');
      }
      return updateDisplay(ws, entry.id, patch);
    }, true);

  async function resolveMetadata(contentId: string, decision: 'local' | 'cloud', commandId: string, version: number): Promise<void> {
    if (!cloud || !repository.current || pending.current || syncBusy.current) return;
    pending.current = true;
    setSaving(true);
    try {
      const repo = repository.current;
      await repo.updateMetadata({ contentId, decision, commandId, version });
      const stored = await repo.load();
      if (stored) {
        current.current = stored; setWorkspace(stored);
        writer.current = new SessionCommitter(repo, stored.identity.repositoryRevision);
      }
      setCloudMetadata(await repo.metadataState());
      scheduleSync();
    } catch (error) { setNotice(error instanceof Error ? error.message : '冲突处理未保存'); }
    finally { pending.current = false; setSaving(false); }
  }
  const trash = (entry: ContentEntry, waive = false) =>
    manage((ws) => {
      if (cloud && waive) throw new Error('云端回收暂不支持撤销阅读义务，原义务保留');
      return trashContent(ws, entry.id, new Date(), waive);
    }, true);
  const restore = (entry: ContentEntry, reobligate = false) =>
    manage((ws) => {
      if (cloud && reobligate) throw new Error('云端恢复暂不支持新增阅读义务');
      return restoreContent(ws, entry.id, new Date(), reobligate);
    }, true);

  async function resolveLifecycle(contentId: string, decision: 'local' | 'cloud', commandId: string, version: number): Promise<void> {
    if (!cloud || !repository.current || pending.current || syncBusy.current) return;
    pending.current = true; setSaving(true);
    try {
      const repo = repository.current;
      await repo.updateManagement({ contentId, decision, commandId, version });
      const stored = await repo.load();
      if (stored) { current.current = stored; setWorkspace(stored); writer.current = new SessionCommitter(repo, stored.identity.repositoryRevision); }
      setCloudLifecycle(await repo.lifecycleState()); scheduleSync();
    } catch (error) { setNotice(error instanceof Error ? error.message : '回收站冲突未处理'); }
    finally { pending.current = false; setSaving(false); }
  }
  const waive = (entry: ContentEntry) => manage((ws) => waiveObligation(ws, entry.id));
  const purge = (entry: ContentEntry) => manage((ws) => purgeContent(ws, entry.id));
  const purgeInfo = (entry: ContentEntry) => current.current ? purgePreview(current.current, entry.id) : null;
  const previewEdit = (entry: ContentEntry, draft: string): RevisionPreview | null =>
    current.current ? previewRevision(content, current.current, entry, draft) : null;
  const adoptEdit = (entry: ContentEntry, revision: ContentRevision) =>
    manage((ws) => adoptRevision(content, ws, entry, revision).workspace);
  async function cloudArchiveAction(action: { type: 'archive'; memberContentIds: string[]; title?: string } | { type: 'unarchive'; volumeId: string }
    | { decision: 'retry' | 'cloud'; commandId: string; version: number }): Promise<boolean> {
    if (!cloud || !repository.current || pending.current || currentTicket.current) return false;
    pending.current = true; setSaving(true); setNotice('');
    try {
      await awaitSyncIdle();
      const repo = repository.current;
      if ('decision' in action) await repo.updateManagement({ archiveDecision: action.decision, commandId: action.commandId, version: action.version }, content);
      else { assertNoSecrets(action, [apiKey]); await repo.queueArchive(content, action); }
      const stored = await repo.load();
      if (stored) { current.current = stored; setWorkspace(stored); writer.current = new SessionCommitter(repo, stored.identity.repositoryRevision); }
      setCloudArchives(await repo.archiveState());
      setNotice('decision' in action && action.decision === 'cloud' ? '已采用云端归档状态，原请求留存在本机恢复记录中' : '');
      scheduleSync(); return true;
    } catch (error) { setNotice(error instanceof Error ? error.message : '归档请求未保存'); return false; }
    finally { pending.current = false; setSaving(false); }
  }
  const archive = (memberContentIds: string[], title?: string) => cloud
    ? cloudArchiveAction({ type: 'archive', memberContentIds, title })
    : manage((ws) => attachVolume(ws, buildVolume(ws, bridge(content, ws), memberContentIds, title)));
  const unarchive = (volume: ArchiveVolume) => cloud ? cloudArchiveAction({ type: 'unarchive', volumeId: volume.id }) : manage((ws) => detachVolume(ws, volume.id));
  const resolveArchive = (decision: 'retry' | 'cloud', commandId: string, version: number) => cloudArchiveAction({ decision, commandId, version });

  const suggestions = useMemo(
    () => (workspace && runtime && !cloudNamespace ? suggestVolumes(workspace, runtime) : []),
    [workspace, runtime, cloudNamespace],
  );
  const backup = () => {
    if (!current.current) return null;
    try {
      // 用户可能把 Key 粘进备注或草稿：导出前拦住，避免密钥离开页面
      assertNoSecrets(current.current, [apiKey]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '导出被拒绝：存档里可能含有临时 Key');
      return null;
    }
    return buildBackup(current.current);
  };
  const previewImport = (raw: unknown): ImportPreview => parseBackup(raw, current.current);
  const importBackup = async (preview: ImportPreview): Promise<boolean> => {
    const repo = repository.current;
    if (!repo || pending.current || currentTicket.current) return false;
    pending.current = true;
    setSaving(true);
    const key = 'pending-import';
    try {
      // 含已知 Key 的对象进入 staging 也属于落库：在 repo.stage 前拒绝
      assertNoSecrets(preview.backup.workspace.data, [apiKey]);
      // 先落到隔离暂存区，再对暂存副本校验，最后单事务发布；失败也不会留下半份数据
      await repo.stage(key, preview.backup);
      const staged = await repo.staged(key);
      if (!staged) throw new Error('导入暂存读取失败，请重试');
      const verified = parseBackup(staged, current.current);
      if (!(await commit(verified.backup.workspace.data))) return false;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '导入未提交，请重试');
      return false;
    } finally {
      pending.current = false;
      setSaving(false);
      await repo.clearStaging().catch(() => {});
    }
    const open = current.current?.tickets.find((t) => t.status === 'reserved' || t.status === 'submitted');
    currentTicket.current = open ?? null;
    return true;
  };

  const obligations = workspace?.obligations.filter((o) => !o.waivedAt) ?? [];
  const readyForGeneration = !!view && !obligations.length && (cloudCatalog
    ? cloudCatalog.entries.every((entry) => episodeCompletion(view.episodes[entry.episodeId], entry.sceneCount).read)
    : library.episodes.every((episode) => episodeCompletion(view.episodes[episode.id], getScenes(episode).length).read));
  const canUseModel = !!api && (api.configured || (api.acceptsUserKey && !!apiKey.trim()));
  const learningNotes = useMemo(() => session ? content.learningNotes(session, library) : [], [session, library]);
  const nextWords = useMemo(() => {
    if (!session || !readyForGeneration) return [];
    try {
      return content.planCreative(session, library).brief.introduce.map((item) => ({ item, ...library.glossary[item] }));
    } catch {
      return [];
    }
  }, [session, library, readyForGeneration]);
  return {
    workspace, session, view, library, loading, failure, notice, saving, dispatch,
    api, apiError, refreshApi, generate, generating, phase, ticket: currentTicket.current,
    cancelGeneration, readyForGeneration, apiKey, setApiKey, canUseModel,
    learningNotes, nextWords, runtime, obligations,
    entries: workspace?.entries ?? [],
    branches: workspace?.branches ?? [],
    volumes: workspace?.volumes ?? [],
    switchBranchTo: (id: string) => manage((ws) => switchBranch(ws, id), true),
    editDisplay, resolveMetadata, cloudMetadata, resolveLifecycle, cloudLifecycle, cloudArchives, resolveArchive, trash, restore, waive, purge, purgeInfo, previewEdit, adoptEdit,
    archive, unarchive, suggestions, backup, previewImport, importBackup,
    busy: saving || generating || cloudSyncing || !!currentTicket.current,
    cloudMode: !!cloud, cloudCatalog: cloudCatalog?.entries ?? null, cloudView, cloudSyncing, syncNow,
    raw,
  };
}
