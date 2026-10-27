import { useEffect, useMemo, useRef, useState } from 'react';
import { projectSession, type PlayerCommand, type PlayerView } from '@endless/player';
import { assertNoSecrets, restoreContent, switchBranch, trashContent, updateDisplay, type ArchiveVolume, type ContentEntry, type ImportPreview, type Workspace, type WorkspaceRuntime, type GenerationTicket } from '@endless/content';
import { content } from '../content/catalog.js';
import { CloudWorkspaceRepository as WorkspaceRepository, type CloudReading } from './repository.js';
import { SessionCommitter } from '../session-writer.js';
import { CloudApi } from './client.js';
import { cloudDigest } from './local.js';
import { WorkspaceSync, type SyncReport } from './sync.js';
import { RevisionSync, revisionFrozen, type RevisionState } from './revisions.js';
import { ManagementSync } from './management-sync.js';
import type { LifecycleState } from './lifecycle.js';
import type { ArchiveView } from './archives.js';
import type { MetadataState } from './metadata.js';
import { editableMetadata, sameMetadata } from './metadata.js';
import type { WorkspaceGraphRevision } from '@endless/content';
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
type ReadingRuntime = Pick<WorkspaceRuntime, 'session' | 'library' | 'branch'> & {
  owners: Map<string, {
    entry: ContentEntry;
    revision: WorkspaceGraphRevision;
  }>;
};
/** Cloud reading/management only; never imports the local generation API or guest repository. */
export function useCloudPlayer(cloud: CloudPlayerOptions) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState('');
  const [raw, setRaw] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const repository = useRef<WorkspaceRepository | null>(null);
  const writer = useRef<SessionCommitter | null>(null);
  const current = useRef<Workspace | null>(null);
  const pending = useRef(false);
  const currentTicket = useRef<GenerationTicket | null>(null);
  const [cloudView, setCloudView] = useState<CloudReadView | null>(null);
  const [cloudSyncing, setCloudSyncing] = useState(false);
  const [cloudMetadata, setCloudMetadata] = useState<MetadataState | null>(null);
  const [cloudLifecycle, setCloudLifecycle] = useState<LifecycleState | null>(null);
  const [cloudArchives, setCloudArchives] = useState<ArchiveView | null>(null);
  const [cloudRevisionAvailable, setCloudRevisionAvailable] = useState(false);
  const [cloudRevisions, setCloudRevisions] = useState<RevisionState | null>(null);
  const [play, setPlay] = useState<CloudReading | null>(null);
  const revisionEngine = useRef<RevisionSync | null>(null);
  const syncEngine = useRef<WorkspaceSync | null>(null);
  const syncBusy = useRef(false);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let active = true;
    const storage = new WorkspaceRepository(globalThis.indexedDB, cloud.namespace, content);
    repository.current = storage;
    writer.current = new SessionCommitter(storage, -1);
    void (async () => {
      try {
        const installation = await storage.cloudInstallation().catch(() => null);
        if (!active)
          return;
        if (!installation) {
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
        const opened = await storage.reloadCloudReading();
        if (!active)
          return;
        writer.current = new SessionCommitter(storage, opened.repositoryRevision);
        setPlay(opened);
        revisionEngine.current = new RevisionSync(storage, new CloudApi(), content, cloud.workspaceId);
        syncEngine.current = new WorkspaceSync({
          revisions: revisionEngine.current,
          repo: storage, api: new CloudApi(), content, workspaceId: cloud.workspaceId, deviceId,
          digest: (value) => cloudDigest(value),
          newBatchId: () => globalThis.crypto.randomUUID(),
        });
        void syncNow();
        return;
      }
      catch (error) {
        if (active) {
          setFailure(error instanceof Error ? error.message : '无法恢复云副本，原始存档保留');
          void storage.rawSnapshot().then(snapshot => { if (active && snapshot != null)
            setRaw(snapshot); }).catch(() => { });
        }
      }
      finally {
        if (active)
          setLoading(false);
      }
    })();
    return () => { active = false; if (syncTimer.current)
      clearTimeout(syncTimer.current); void storage.close().catch(() => { }); };
  }, []);
  const runtime = useMemo((): ReadingRuntime | null => {
    if (!play)
      return null;
    const owners = new Map<string, {
      entry: ContentEntry;
      revision: WorkspaceGraphRevision;
    }>();
    for (const card of play.catalogue) {
      const entry = play.view.entries.find((item) => item.id === card.contentId);
      const revision = play.view.revisions.find((item) => item.id === card.revisionId);
      if (entry && revision)
        owners.set(card.episodeId, { entry, revision: revision });
    }
    return { session: play.session, library: play.library, branch: play.branch, owners };
  }, [play]);
  const session = runtime?.session ?? null;
  const library = runtime?.library ?? content.pilot;
  const view: PlayerView | null = useMemo(() => runtime ? projectSession(runtime.session, runtime.library) : null, [runtime]);
  async function syncNow(): Promise<void> {
    const engine = syncEngine.current;
    const repo = repository.current;
    if (!engine || !repo || syncBusy.current || pending.current || currentTicket.current)
      return;
    syncBusy.current = true;
    setCloudSyncing(true);
    let report: SyncReport | undefined;
    let message = '';
    try {
      await revisionEngine.current?.resume();
      report = await engine.run();
      if (!(await repo.syncState()).paused)
        await new ManagementSync(repo, new CloudApi(), cloud.workspaceId, content).run();
    }
    catch (error) {
      message = error instanceof Error ? error.message : '云端同步失败；本机进度已保留';
    }
    finally {
      // A request may have committed before a later request failed. Always reload the durable baseline.
      try {
        const [opened, status, metadata, lifecycle, archives] = await Promise.all([repo.reloadCloudReading(), engine.status(), repo.metadataState(), repo.lifecycleState(), repo.archiveState()]);
        setPlay(opened);
        current.current = null;
        setWorkspace(null);
        writer.current = new SessionCommitter(repo, opened.repositoryRevision);
        setCloudRevisionAvailable(revisionEngine.current?.available ?? false);
        setCloudRevisions(await repo.revisionState());
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
      }
      catch (error) {
        setNotice(error instanceof Error ? error.message : '读取同步结果失败，原件保留');
      }
      syncBusy.current = false;
      setCloudSyncing(false);
    }
  }
  function scheduleSync() {
    if (!syncEngine.current)
      return;
    if (syncTimer.current)
      clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      syncTimer.current = null;
      void syncNow();
    }, 700);
  }
  async function awaitSyncIdle(): Promise<void> {
    for (let tick = 0; tick < 100 && syncBusy.current; tick++)
      await new Promise((resolve) => setTimeout(resolve, 30));
    if (syncBusy.current)
      throw new Error('同步尚未完成，请稍后重试本次操作');
  }
  async function commit(next: Workspace, options: {
    closingTicketId?: string;
  } = {}): Promise<boolean> {
    await awaitSyncIdle();
    const committer = writer.current;
    if (!committer)
      return false;
    const result = await committer.commit(next, options);
    if (!result.ok) {
      setNotice(result.error);
      return false;
    }
    current.current = result.workspace;
    setWorkspace(result.workspace);
    if (repository.current) {
      try {
        const [display, lifecycle] = await Promise.all([repository.current.metadataState(), repository.current.lifecycleState()]);
        setCloudMetadata(display);
        setCloudLifecycle(lifecycle);
        setCloudView((held) => held && ({ ...held,
          metadataPending: Object.keys(display.pending).length,
          metadataConflicts: Object.values(display.pending).filter((entry) => entry.conflict).length,
          lifecyclePending: Object.keys(lifecycle.pending).length,
          lifecycleConflicts: Object.values(lifecycle.pending).filter((entry) => entry.conflict).length,
        }));
      }
      catch {
        setNotice('操作已保存，但同步状态尚未读取，请重试同步');
      }
    }
    scheduleSync();
    return true;
  }
  async function dispatch(command: PlayerCommand): Promise<boolean> {
    if (pending.current || currentTicket.current || !repository.current)
      return false;
    pending.current = true;
    setSaving(true);
    setNotice('');
    try {
      await awaitSyncIdle();
      const opened = await repository.current.playCloudReading(command, new Date());
      setPlay(opened);
      writer.current = new SessionCommitter(repository.current, opened.repositoryRevision);
      scheduleSync();
      return true;
    }
    catch (error) {
      setNotice(error instanceof Error ? error.message : '操作未保存，请重试');
      return false;
    }
    finally {
      pending.current = false;
      setSaving(false);
    }
  }
  async function manage(fn: (workspace: Workspace) => Workspace): Promise<boolean> {
    if (pending.current || currentTicket.current || !repository.current)
      return false;
    pending.current = true;
    setSaving(true);
    setNotice('');
    try {
      await awaitSyncIdle();
      const base = current.current ?? await repository.current?.load() ?? null;
      if (!base)
        throw new Error('本机云副本不存在');
      current.current = base;
      // 管理命令只执行一次；在任何持久化前先过临时 Key 护栏，再提交
      const next = fn(base);
      assertNoSecrets(next, []);
      const ok = await commit(next);
      if (ok && repository.current) {
        const opened = await repository.current.reloadCloudReading();
        setPlay(opened);
        current.current = null;
        setWorkspace(null);
        writer.current = new SessionCommitter(repository.current, opened.repositoryRevision);
      }
      return ok;
    }
    catch (error) {
      setNotice(error instanceof Error ? error.message : '操作未保存，请重试');
      return false;
    }
    finally {
      pending.current = false;
      setSaving(false);
    }
  }
  const editDisplay = (entry: ContentEntry, patch: Partial<ContentEntry['display']>) => manage((ws) => {
    const held = ws.entries.find((candidate) => candidate.id === entry.id);
    if (!held || held.updatedAt !== entry.updatedAt || !sameMetadata(editableMetadata(held.display), editableMetadata(entry.display))) {
      throw new Error('展示信息在编辑期间已变化，请重新打开编辑器；本次输入尚未保存');
    }
    return updateDisplay(ws, entry.id, patch);
  });
  async function resolveMetadata(contentId: string, decision: 'local' | 'cloud', commandId: string, version: number): Promise<void> {
    if (!repository.current || pending.current || syncBusy.current)
      return;
    pending.current = true;
    setSaving(true);
    try {
      const repo = repository.current;
      await repo.updateMetadata({ contentId, decision, commandId, version });
      const stored = await repo.load();
      if (stored) {
        current.current = stored;
        setWorkspace(stored);
        writer.current = new SessionCommitter(repo, stored.identity.repositoryRevision);
      }
      setCloudMetadata(await repo.metadataState());
      scheduleSync();
    }
    catch (error) {
      setNotice(error instanceof Error ? error.message : '冲突处理未保存');
    }
    finally {
      pending.current = false;
      setSaving(false);
    }
  }
  const trash = (entry: ContentEntry, waive = false) => manage((ws) => {
    if (waive)
      throw new Error('云端回收暂不支持撤销阅读义务，原义务保留');
    return trashContent(ws, entry.id, new Date(), waive);
  });
  const restore = (entry: ContentEntry, reobligate = false) => manage((ws) => {
    if (reobligate)
      throw new Error('云端恢复暂不支持新增阅读义务');
    return restoreContent(ws, entry.id, new Date(), reobligate);
  });
  async function resolveLifecycle(contentId: string, decision: 'local' | 'cloud', commandId: string, version: number): Promise<void> {
    if (!repository.current || pending.current || syncBusy.current)
      return;
    pending.current = true;
    setSaving(true);
    try {
      const repo = repository.current;
      await repo.updateManagement({ contentId, decision, commandId, version });
      const stored = await repo.load();
      if (stored) {
        current.current = stored;
        setWorkspace(stored);
        writer.current = new SessionCommitter(repo, stored.identity.repositoryRevision);
      }
      setCloudLifecycle(await repo.lifecycleState());
      scheduleSync();
    }
    catch (error) {
      setNotice(error instanceof Error ? error.message : '回收站冲突未处理');
    }
    finally {
      pending.current = false;
      setSaving(false);
    }
  }
  async function cloudRevisionAction(action: {
    queue: {
      contentId: string;
      draft: string;
    };
  } | {
    confirm: {
      requestId: string;
      digest: string;
    };
  } | {
    discard: string;
  }): Promise<boolean> {
    if (!repository.current || pending.current || currentTicket.current)
      return false;
    await syncNow();
    await awaitSyncIdle();
    const repo = repository.current;
    syncBusy.current = true;
    setCloudSyncing(true);
    try {
      assertNoSecrets(action, []);
      await repo.revisionAction(content, action);
      setNotice('');
      return true;
    }
    catch (error) {
      setNotice(error instanceof Error ? error.message : '修订请求未保存');
      return false;
    }
    finally {
      try {
        const stored = await repo.load();
        if (stored) {
          current.current = stored;
          setWorkspace(stored);
          writer.current = new SessionCommitter(repo, stored.identity.repositoryRevision);
        }
        setCloudRevisions(await repo.revisionState());
      }
      catch (error) {
        setNotice(error instanceof Error ? error.message : '读取修订结果失败，原请求保留');
      }
      finally {
        syncBusy.current = false;
        setCloudSyncing(false);
        scheduleSync();
      }
    }
  }
  async function cloudArchiveAction(action: {
    type: 'archive';
    memberContentIds: string[];
    title?: string;
  } | {
    type: 'unarchive';
    volumeId: string;
  } | {
    decision: 'retry' | 'cloud';
    commandId: string;
    version: number;
  }): Promise<boolean> {
    if (!repository.current || pending.current || currentTicket.current)
      return false;
    pending.current = true;
    setSaving(true);
    setNotice('');
    try {
      await awaitSyncIdle();
      const repo = repository.current;
      if ('decision' in action)
        await repo.updateManagement({ archiveDecision: action.decision, commandId: action.commandId, version: action.version }, content);
      else {
        assertNoSecrets(action, []);
        await repo.queueArchive(content, action);
      }
      const opened = await repo.reloadCloudReading();
      setPlay(opened);
      current.current = null;
      setWorkspace(null);
      writer.current = new SessionCommitter(repo, opened.repositoryRevision);
      setCloudArchives(await repo.archiveState());
      setNotice('decision' in action && action.decision === 'cloud' ? '已采用云端归档状态，原请求留存在本机恢复记录中' : '');
      scheduleSync();
      return true;
    }
    catch (error) {
      setNotice(error instanceof Error ? error.message : '归档请求未保存');
      return false;
    }
    finally {
      pending.current = false;
      setSaving(false);
    }
  }
  const archive = (memberContentIds: string[], title?: string) => cloudArchiveAction({ type: 'archive', memberContentIds, title });
  const unarchive = (volume: ArchiveVolume) => cloudArchiveAction({ type: 'unarchive', volumeId: volume.id });
  const resolveArchive = (decision: 'retry' | 'cloud', commandId: string, version: number) => cloudArchiveAction({ decision, commandId, version });
  const unavailable = async (..._args: unknown[]): Promise<never> => { throw new Error('云阅读暂不提供本机生成或本机备份操作'); };
  const obligations = (play?.view.obligations ?? workspace?.obligations ?? []).filter(o => !o.waivedAt);
  const learningNotes = useMemo(() => session ? content.learningNotes(session, library) : [], [session, library]);
  return {
    workspace, session, view, library, loading, failure, notice, saving, dispatch,
    api: null, apiError: '', refreshApi: unavailable, generate: unavailable, generating: false, phase: '', ticket: null,
    cancelGeneration: unavailable, readyForGeneration: false, apiKey: '', setApiKey: (_key: string) => { }, canUseModel: false,
    learningNotes, nextWords: [], runtime, obligations, fillerCard: null,
    entries: play?.view.entries ?? workspace?.entries ?? [], branches: play?.view.branches ?? workspace?.branches ?? [], volumes: play?.view.volumes ?? workspace?.volumes ?? [], activeBranchId: play?.branch.id ?? workspace?.activeBranchId,
    loadCloudDraft: (id: string) => repository.current?.lookupCloudDraft(id) ?? Promise.resolve(null),
    switchBranchTo: (id: string) => manage(ws => switchBranch(ws, id)),
    editDisplay, resolveMetadata, cloudMetadata, resolveLifecycle, cloudLifecycle, cloudArchives, resolveArchive, trash, restore,
    waive: unavailable, purge: unavailable, purgeInfo: (_entry: ContentEntry) => null, previewEdit: (_entry: ContentEntry, _draft: string) => null, adoptEdit: unavailable,
    archive, unarchive, suggestions: [], backup: () => null, previewImport: (_raw: unknown): ImportPreview => { throw new Error('云阅读暂不支持导入'); }, importBackup: unavailable,
    busy: saving || cloudSyncing || (!!cloudRevisions && revisionFrozen(cloudRevisions)),
    cloudRevisions, cloudRevisionAvailable, cloudRevisionAction,
    cloudMode: true as const, cloudCatalog: play?.catalogue ?? null, cloudView, cloudSyncing, syncNow, raw,
  };
}
