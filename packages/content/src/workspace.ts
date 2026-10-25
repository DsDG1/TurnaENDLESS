/**
 * 工作区运行时（`endless-workspace`）：创建档案、把分支还原成播放器可用的
 * 会话+内容库、以及全部玩法/管理命令。命令是纯函数：先在内存完成校验并产出
 * 下一个工作区，再由仓库在一次事务里原子提交。
 *
 * 玩法事件仍记录在分支的 `session.events`；修订采用列表决定运行时内容库顺序。
 * 生成路径通过 `bridgeSave` 还原成 `SavedPlayer`，复用 `content.restore` 的
 * 全部校验（创作绑定、哈希前缀、可玩路径），不在此另建一套规则。
 */
import { contentHash, stableStringify } from '@endless/esl';
import { episodeCompletion, getScenes, SessionSchema, transition, type Library, type PlayerCommand, type PlayerSession } from '@endless/player';
import {
  assertWorkspace, newId,
  WorkspaceSchema,
  type AnyRevision, type ArchiveVolume, type Branch, type BundledRevision,
  type Content, type ContentEntry, type ContentRevision, type GeneratedEpisode,
  type GenerationBasis, type GenerationTicket, type LocalProfile, type ManagementEvent,
  type ManagementOp, type ReadingObligation, type SavedPlayer, type Workspace,
} from './index.js';

export interface WorkspaceRuntime {
  session: PlayerSession;
  library: Library;
  /** episodeId（batch.batch）→ 内容条目与采用的修订 */
  owners: Map<string, { entry: ContentEntry; revision: AnyRevision }>;
  save: SavedPlayer;
  branch: Branch;
}

const uuid = () => globalThis.crypto.randomUUID();
const clone = <T>(value: T): T => structuredClone(value);
const episodeIdOf = (revision: AnyRevision) => revision.episodeId;
const isGenerated = (revision: AnyRevision): revision is ContentRevision => revision.origin !== 'bundled';

function revisionToDocument(revision: ContentRevision): GeneratedEpisode {
  return {
    version: 1,
    generatedAt: revision.plannedAt,
    basedOn: { eventCount: revision.basis.eventCount, hash: revision.basis.eventHash },
    title: revision.title,
    subtitle: revision.subtitle,
    description: revision.description,
    batch: revision.batch,
    hash: revision.hash,
    learningVersion: 4,
    creation: revision.creation,
  };
}

/** 分支采用清单 → 运行时文档顺序（与 generation 顺序一致）。 */
function adoptedRevisions(workspace: Workspace, branch: Branch): AnyRevision[] {
  const byId = new Map(workspace.revisions.map((revision) => [revision.id, revision]));
  const out: AnyRevision[] = [];
  for (const adopted of branch.adopted) {
    const revision = byId.get(adopted.revisionId);
    if (!revision) throw new Error(`分支采用了不存在的修订 ${adopted.revisionId}`);
    out.push(revision);
  }
  return out;
}

/** 把分支还原成 `SavedPlayer` 信封：事件 + 已采用修订对应的生成文档。 */
export function bridgeSave(workspace: Workspace, branch: Branch): SavedPlayer {
  const generated = adoptedRevisions(workspace, branch)
    .filter(isGenerated)
    .map(revisionToDocument);
  return { version: 2, revision: branch.session.revision, session: branch.session, generated };
}

/** 还原分支运行时：复用 `content.restore` 的完整校验。 */
export function bridge(content: Content, workspace: Workspace, branchId = workspace.activeBranchId): WorkspaceRuntime {
  const branch = workspace.branches.find((b) => b.id === branchId);
  if (!branch) throw new Error('分支不存在');
  const save = bridgeSave(workspace, branch);
  const restored = content.restore(save);
  const owners = new Map<string, { entry: ContentEntry; revision: AnyRevision }>();
  const entries = new Map(workspace.entries.map((entry) => [entry.id, entry]));
  for (const adopted of branch.adopted) {
    const revision = workspace.revisions.find((r) => r.id === adopted.revisionId)!;
    const entry = entries.get(adopted.contentId)!;
    owners.set(episodeIdOf(revision), { entry, revision });
  }
  return { session: restored.session, library: restored.library, owners, save, branch };
}

/** 新工作区：一个本地档案、一条根分支、三集捆绑内容全部就位。 */
export function createWorkspace(content: Content, now = new Date()): Workspace {
  const at = now.toISOString();
  const profile: LocalProfile = { id: newId('profile', uuid), createdAt: at, boundAccountId: null };
  const entries: ContentEntry[] = [];
  const revisions: BundledRevision[] = [];
  const adopted: Branch['adopted'] = [];
  for (const episode of content.pilot.episodes) {
    const entryId = newId('content', uuid);
    const revisionId = newId('revision', uuid);
    entries.push({
      id: entryId, sourceKind: 'bundled', series: 'duck_detective', kind: 'story',
      label: episode.title,
      display: { title: episode.title, subtitle: episode.subtitle, description: episode.description, tags: [], note: '' },
      lifecycle: 'active', trashedAt: null, archiveVolumeId: null,
      revisionIds: [revisionId], headRevisionId: revisionId, createdAt: at, updatedAt: at,
    });
    revisions.push({
      id: revisionId, contentId: entryId, parentRevisionId: null, ordinal: 1,
      origin: 'bundled', episodeId: episode.id, catalogId: episode.id,
      hash: contentHash(stableStringify(episode.ast)),
      title: episode.title, subtitle: episode.subtitle, description: episode.description,
    });
    adopted.push({ contentId: entryId, revisionId });
  }
  const root: Branch = {
    id: newId('branch', uuid), label: '主线', parentBranchId: null, forkAtEventCount: null,
    adopted, session: { version: 1, catalog: content.pilot.version, revision: 0, current: content.pilot.episodes[0]!.id, largeText: false, events: [] },
    createdAt: at,
  };
  const workspace: Workspace = {
    identity: {
      format: 'endless-workspace', schemaVersion: 1,
      workspaceId: newId('workspace', uuid), profileId: profile.id, repositoryRevision: 0,
    },
    profile, entries, revisions,
    branches: [root], activeBranchId: root.id,
    obligations: [], volumes: [], checkpoints: [], tickets: [], management: [],
  };
  return assertWorkspace(workspace);
}

export function checked(workspace: Workspace): Workspace {
  WorkspaceSchema.parse(workspace);
  return assertWorkspace(workspace);
}

function manage(workspace: Workspace, op: ManagementOp, targets: string[], at: string, branchId: string | null, detail?: ManagementEvent['detail']): ManagementEvent {
  return { id: newId('management', uuid), sequence: workspace.management.length, at, op, branchId, targets, ...(detail ? { detail } : {}) };
}

function activeBranch(workspace: Workspace): Branch {
  return workspace.branches.find((b) => b.id === workspace.activeBranchId)!;
}

function replaceBranch(workspace: Workspace, next: Branch): Workspace {
  return { ...workspace, branches: workspace.branches.map((b) => b.id === next.id ? next : b) };
}

function touchEntry(workspace: Workspace, entryId: string, patch: Partial<ContentEntry>, at: string): Workspace {
  return {
    ...workspace,
    entries: workspace.entries.map((entry) => entry.id === entryId ? { ...entry, ...patch, updatedAt: at } : entry),
  };
}

function openTicket(workspace: Workspace): GenerationTicket | undefined {
  return workspace.tickets.find((ticket) => ticket.status === 'reserved' || ticket.status === 'submitted');
}

function basis(workspace: Workspace, branch: Branch, plannedAt: string): GenerationBasis {
  const obligations = workspace.obligations
    .filter((o) => !o.waivedAt)
    .map((o) => o.contentId);
  const normalized = SessionSchema.parse(branch.session);
  return {
    contract: 'endless-draft-v1', catalogVersion: normalized.catalog, branchId: branch.id,
    adopted: clone(branch.adopted), eventCount: normalized.events.length,
    eventHash: contentHash({ catalog: normalized.catalog, events: normalized.events }),
    obligations, plannedAt,
  };
}

// ---------- 玩法命令 ----------

/** 答题/推进/揭示/切换/字号。给新事件补上内容与修订引用，避免正文变化后误读旧选项。 */
export function applyPlayerCommand(content: Content, workspace: Workspace, command: PlayerCommand, at = new Date()): Workspace {
  if (openTicket(workspace)) throw new Error('生成任务进行中，请先完成或取消该任务');
  const branch = activeBranch(workspace);
  const runtime = bridge(content, workspace, branch.id);
  const nextSession = transition(branch.session, command, runtime.library, at.toISOString());
  if (nextSession === branch.session) return workspace;
  const byEpisode = new Map(branch.adopted.map((adopted) => {
    const revision = workspace.revisions.find((r) => r.id === adopted.revisionId)!;
    return [episodeIdOf(revision), adopted] as const;
  }));
  const events = nextSession.events.map((event, index) => {
    if (index < branch.session.events.length) return event;
    const adopted = byEpisode.get(event.episode);
    return adopted ? { ...event, contentId: adopted.contentId, revisionId: adopted.revisionId } : event;
  });
  let next = checked(replaceBranch(workspace, { ...branch, session: { ...nextSession, events } }));
  // 真正读完一集才自动解除其阅读义务（跳过会推进 cursor，不能算读完）
  if (next.obligations.some((o) => !o.waivedAt)) {
    const view = content.stateContext(nextSession, runtime.library).view;
    const time = at.toISOString();
    const fulfilled = new Set(
      next.obligations.filter((o) => {
        if (o.waivedAt) return false;
        const revision = next.revisions.find((r) => r.id === o.revisionId);
        if (!revision) return false;
        const episode = runtime.library.episodes.find((e) => e.id === episodeIdOf(revision));
        if (!episode) return false;
        return episodeCompletion(view.episodes[episode.id], getScenes(episode).length).read;
      }).map((o) => `${o.contentId}|${o.revisionId}`));
    if (fulfilled.size) {
      next = checked({
        ...next,
        obligations: next.obligations.map((o) =>
          !o.waivedAt && fulfilled.has(`${o.contentId}|${o.revisionId}`) ? { ...o, waivedAt: time } : o),
      });
    }
  }
  return next;
}

// ---------- 展示信息（不改正文） ----------

export function updateDisplay(workspace: Workspace, contentId: string, patch: Partial<ContentEntry['display']>, at = new Date()): Workspace {
  const entry = workspace.entries.find((e) => e.id === contentId);
  if (!entry) throw new Error('内容不存在');
  const time = at.toISOString();
  const display = { ...entry.display, ...patch };
  const next = touchEntry(workspace, contentId, { display }, time);
  next.management = [...next.management, manage(workspace, 'rename', [contentId], time, workspace.activeBranchId)];
  return checked(next);
}

// ---------- 生命周期：回收站 / 恢复 / 义务 ----------

export function trashContent(workspace: Workspace, contentId: string, at = new Date(), waive = false): Workspace {
  const entry = workspace.entries.find((e) => e.id === contentId);
  if (!entry || entry.sourceKind !== 'generated') throw new Error('只有生成内容可以移入回收站');
  if (entry.lifecycle === 'trashed') return workspace;
  const time = at.toISOString();
  let next = touchEntry(workspace, contentId, { lifecycle: 'trashed', trashedAt: time, archiveVolumeId: null }, time);
  if (waive) {
    next = {
      ...next,
      obligations: next.obligations.map((o) =>
        o.contentId === contentId && !o.waivedAt ? { ...o, waivedAt: time } : o),
    };
  }
  next.management = [...next.management, manage(workspace, 'trash', [contentId], time, workspace.activeBranchId, waive ? { waived: true } : undefined)];
  return checked(next);
}

export function restoreContent(workspace: Workspace, contentId: string, at = new Date(), reobligate = false): Workspace {
  const entry = workspace.entries.find((e) => e.id === contentId);
  if (!entry || entry.lifecycle !== 'trashed') throw new Error('内容不在回收站');
  const time = at.toISOString();
  let next = touchEntry(workspace, contentId, { lifecycle: 'active', trashedAt: null }, time);
  if (reobligate && !next.obligations.some((o) => o.contentId === contentId && !o.waivedAt)) {
    const adopted = activeBranch(next).adopted.find((a) => a.contentId === contentId);
    if (adopted) {
      const obligation: ReadingObligation = { contentId, revisionId: adopted.revisionId, createdAt: time, waivedAt: null };
      next = { ...next, obligations: [...next.obligations, obligation] };
    }
  }
  next.management = [...next.management, manage(workspace, 'restore', [contentId], time, workspace.activeBranchId, reobligate ? { reobligate: true } : undefined)];
  return checked(next);
}

/** 明确撤销未读内容的阅读义务（管理操作，不伪造已读/跳过）。 */
export function waiveObligation(workspace: Workspace, contentId: string, at = new Date()): Workspace {
  const time = at.toISOString();
  if (!workspace.obligations.some((o) => o.contentId === contentId && !o.waivedAt)) {
    throw new Error('该内容没有未处理的阅读义务');
  }
  const next: Workspace = {
    ...workspace,
    obligations: workspace.obligations.map((o) => o.contentId === contentId && !o.waivedAt ? { ...o, waivedAt: time } : o),
    management: [...workspace.management, manage(workspace, 'waive-obligation', [contentId], time, workspace.activeBranchId)],
  };
  return checked(next);
}

/** 彻底删除前的引用分析。 */
export function purgePreview(workspace: Workspace, contentId: string) {
  const usedByEvents = workspace.branches.filter((branch) =>
    branch.session.events.some((event) => (event as { contentId?: string }).contentId === contentId ||
      branch.adopted.some((a) => a.contentId === contentId &&
        workspace.revisions.some((r) => r.id === a.revisionId && r.episodeId === event.episode))));
  const usedByBasis = workspace.revisions.filter((r) => isGenerated(r) && r.basis.adopted.some((a) => a.contentId === contentId));
  const usedByVolumes = workspace.volumes.filter((volume) => volume.members.some((m) => m.contentId === contentId));
  const usedByTickets = workspace.tickets.filter((ticket) =>
    (ticket.status === 'reserved' || ticket.status === 'submitted') && ticket.basis.adopted.some((a) => a.contentId === contentId));
  return { usedByEvents, usedByBasis, usedByVolumes, usedByTickets };
}

/** 物理移除无依赖的生成内容；存在引用时必须由调用方先展示预览并选择。 */
export function purgeContent(workspace: Workspace, contentId: string, at = new Date()): Workspace {
  const entry = workspace.entries.find((e) => e.id === contentId);
  if (!entry || entry.sourceKind !== 'generated') throw new Error('只有生成内容可以彻底删除');
  const refs = purgePreview(workspace, contentId);
  if (refs.usedByEvents.length || refs.usedByBasis.length || refs.usedByTickets.length) {
    throw new Error('内容仍被分支历史、生成依据或待处理任务引用，不能安全删除');
  }
  const time = at.toISOString();
  const revisionIds = new Set(entry.revisionIds);
  const next: Workspace = {
    ...workspace,
    entries: workspace.entries.filter((e) => e.id !== contentId),
    revisions: workspace.revisions.filter((r) => !revisionIds.has(r.id)),
    obligations: workspace.obligations.filter((o) => o.contentId !== contentId),
    volumes: workspace.volumes.map((volume) => ({
      ...volume, members: volume.members.filter((m) => m.contentId !== contentId),
    })).filter((volume) => volume.members.length),
    branches: workspace.branches.map((branch) => ({
      ...branch, adopted: branch.adopted.filter((a) => a.contentId !== contentId),
    })),
    management: [...workspace.management, manage(workspace, 'purge', [contentId], time, null)],
  };
  return checked(next);
}

// ---------- 分支 ----------

export function switchBranch(workspace: Workspace, branchId: string): Workspace {
  if (!workspace.branches.some((b) => b.id === branchId)) throw new Error('分支不存在');
  return checked({ ...workspace, activeBranchId: branchId });
}

/**
 * 已读内容采用修订：在目标内容原生成边界创建新分支，复制边界前的真实历史，
 * 采用编辑后修订并从「未读」开始；原分支及其后续内容保持不变。
 */
export function forkForRevision(workspace: Workspace, parentBranchId: string, contentId: string, revision: ContentRevision, at = new Date()): Workspace {
  const parent = workspace.branches.find((b) => b.id === parentBranchId);
  if (!parent) throw new Error('父分支不存在');
  const index = parent.adopted.findIndex((a) => a.contentId === contentId);
  if (index < 0) throw new Error('该分支未采用此内容');
  const forkRevision = workspace.revisions.find((r) => r.id === parent.adopted[index]!.revisionId);
  const boundary = forkRevision && isGenerated(forkRevision) ? forkRevision.basis.eventCount : 0;
  const entry = workspace.entries.find((e) => e.id === contentId);
  if (!entry) throw new Error('内容条目不存在');
  const branchId = newId('branch', uuid);
  // 分叉出来的修订必须登记到条目：否则它不被任何内容收录，后续编辑仍按旧 head 编译
  const ordinal = Math.max(0, ...entry.revisionIds.map((id) => workspace.revisions.find((r) => r.id === id)?.ordinal ?? 0)) + 1;
  const registered: ContentRevision = {
    ...revision,
    ordinal,
    parentRevisionId: forkRevision?.id ?? revision.parentRevisionId,
    basis: { ...revision.basis },
  };
  const adopted = parent.adopted.slice(0, index).concat([{ contentId, revisionId: registered.id }]);
  const session: PlayerSession = {
    ...parent.session,
    events: parent.session.events.slice(0, boundary),
    // 分叉后直接停在被修订的这集，而不是回到第一集
    current: revision.episodeId,
    revision: parent.session.revision + 1,
  };
  const branch: Branch = {
    id: branchId, label: `${revision.title} · 修订线`,
    parentBranchId: parent.id, forkAtEventCount: boundary, adopted,
    session, createdAt: at.toISOString(),
  };
  const next: Workspace = {
    ...workspace,
    revisions: [...workspace.revisions, registered],
    entries: workspace.entries.map((e) => e.id === contentId
      ? {
        ...e, revisionIds: [...e.revisionIds, registered.id], headRevisionId: registered.id, updatedAt: at.toISOString(),
        display: { ...e.display, title: registered.title, subtitle: registered.subtitle, description: registered.description },
      } : e),
    branches: [...workspace.branches, branch],
    activeBranchId: branch.id,
    management: [...workspace.management, manage(workspace, 'branch', [contentId, branch.id], at.toISOString(), parent.id)],
  };
  return checked(next);
}

// ---------- 生成任务 ----------

/** 原子预留生成任务；一次只允许一个进行中任务。 */
export function reserveTicket(workspace: Workspace, plannedAt = new Date()): { workspace: Workspace; ticket: GenerationTicket } {
  if (openTicket(workspace)) throw new Error('已有生成任务进行中');
  const branch = activeBranch(workspace);
  const ticket: GenerationTicket = {
    id: newId('ticket', uuid), branchId: branch.id, basis: basis(workspace, branch, plannedAt.toISOString()),
    status: 'reserved', createdAt: plannedAt.toISOString(), updatedAt: plannedAt.toISOString(),
    resultContentId: null, failureCategory: null,
  };
  const next = checked({ ...workspace, tickets: [...workspace.tickets, ticket] });
  return { workspace: next, ticket };
}

export function markTicketSubmitted(workspace: Workspace, ticketId: string): Workspace {
  const ticket = workspace.tickets.find((t) => t.id === ticketId);
  if (!ticket) throw new Error('生成任务不存在');
  if (ticket.status !== 'reserved') throw new Error('生成任务不在预留状态，不能重复提交');
  return checked({
    ...workspace,
    tickets: workspace.tickets.map((t) => t.id === ticketId
      ? { ...t, status: 'submitted' as const, updatedAt: new Date().toISOString() } : t),
  });
}

/** 只有进行中的任务可以被标记失败；已结束的任务不能被改写状态。 */
export function markTicketFailed(workspace: Workspace, ticketId: string, category: string | null, at = new Date()): Workspace {
  const ticket = workspace.tickets.find((t) => t.id === ticketId);
  if (!ticket) throw new Error('生成任务不存在');
  if (ticket.status !== 'reserved' && ticket.status !== 'submitted') throw new Error('生成任务已结束，不能再标记失败');
  return checked({
    ...workspace,
    tickets: workspace.tickets.map((t) => t.id === ticketId
      ? { ...t, status: 'failed' as const, failureCategory: category, updatedAt: at.toISOString() } : t),
  });
}

/** 只有进行中的任务可以被取消；已结束的任务保持原状。 */
export function cancelTicket(workspace: Workspace, ticketId: string, at = new Date()): Workspace {
  const ticket = workspace.tickets.find((t) => t.id === ticketId);
  if (!ticket) throw new Error('生成任务不存在');
  if (ticket.status !== 'reserved' && ticket.status !== 'submitted') throw new Error('生成任务已结束，不能取消');
  return checked({
    ...workspace,
    tickets: workspace.tickets.map((t) => t.id === ticketId
      ? { ...t, status: 'cancelled' as const, updatedAt: at.toISOString() } : t),
  });
}

/** 生成完成：同一事务提交修订、条目、采用关系、义务与任务状态；历史不匹配时保留结果但不写入分支。 */
export function commitTicketResult(content: Content, workspace: Workspace, ticketId: string, document: GeneratedEpisode, at = new Date()): Workspace {
  const ticket = workspace.tickets.find((t) => t.id === ticketId);
  if (!ticket || (ticket.status !== 'reserved' && ticket.status !== 'submitted')) throw new Error('生成任务不存在或已结束');
  // 应用层只接受 v4 创作草稿契约；legacy 文档在这里会缺 creation，不能靠 TypeError 兜底
  if (document.learningVersion !== 4 || !document.creation) {
    throw new Error('生成结果不是 v4 创作草稿契约，拒绝写入工作区');
  }
  const branch = workspace.branches.find((b) => b.id === ticket.branchId);
  if (!branch) throw new Error('任务绑定的分支不存在');
  const runtime = bridge(content, workspace, branch.id);
  const key = content.historyKey(runtime.session);
  const matched = ticket.basis.eventHash === key.hash && ticket.basis.eventCount === key.eventCount;
  const time = at.toISOString();
  if (!matched) {
    // 历史已变化：保留结果与任务记录，提示用户处理，不写入错误分支
    return checked({
      ...workspace,
      tickets: workspace.tickets.map((t) => t.id === ticketId
        ? { ...t, status: 'failed' as const, failureCategory: 'history-mismatch', updatedAt: time } : t),
    });
  }
  const accepted = content.accept(document, runtime.save);
  void accepted;
  const contentId = newId('content', uuid);
  const revisionId = newId('revision', uuid);
  const revision: ContentRevision = {
    id: revisionId, contentId, parentRevisionId: null, ordinal: 1, origin: 'generated',
    episodeId: document.batch.batch, draft: document.creation!.draft, batch: document.batch,
    hash: document.hash, title: document.title, subtitle: document.subtitle, description: document.description,
    creation: document.creation!, learningVersion: 4,
    basis: ticket.basis, plannedAt: document.generatedAt, authoredAt: document.generatedAt,
    validation: { ok: true, issues: [] },
  };
  const entry: ContentEntry = {
    id: contentId, sourceKind: 'generated', series: document.creation!.series, kind: document.creation!.kind,
    label: document.title,
    display: { title: document.title, subtitle: document.subtitle, description: document.description, tags: [], note: '' },
    lifecycle: 'active', trashedAt: null, archiveVolumeId: null,
    revisionIds: [revisionId], headRevisionId: revisionId, createdAt: time, updatedAt: time,
  };
  const obligation: ReadingObligation = { contentId, revisionId, createdAt: time, waivedAt: null };
  const nextBranch: Branch = {
    ...branch,
    adopted: [...branch.adopted, { contentId, revisionId }],
    session: { ...branch.session, revision: branch.session.revision + 1 },
  };
  const next: Workspace = {
    ...workspace,
    entries: [...workspace.entries, entry],
    revisions: [...workspace.revisions, revision],
    obligations: [...workspace.obligations, obligation],
    branches: workspace.branches.map((b) => b.id === branch.id ? nextBranch : b),
    tickets: workspace.tickets.map((t) => t.id === ticketId
      ? { ...t, status: 'succeeded' as const, resultContentId: contentId, updatedAt: time } : t),
  };
  return checked(next);
}

// ---------- 修订采用（未读内容原位替换） ----------

export function adoptRevisionInPlace(workspace: Workspace, contentId: string, revision: ContentRevision, at = new Date()): Workspace {
  const branch = activeBranch(workspace);
  const adopted = branch.adopted.find((a) => a.contentId === contentId);
  if (!adopted) throw new Error('该分支未采用此内容');
  const hasEvents = branch.session.events.some((event) => (event as { revisionId?: string }).revisionId === adopted.revisionId ||
    event.episode === revision.episodeId);
  if (hasEvents) throw new Error('已有真实交互的内容不能在原分支替换，请使用新分支');
  const entry = workspace.entries.find((e) => e.id === contentId)!;
  const time = at.toISOString();
  const next: Workspace = {
    ...workspace,
    revisions: [...workspace.revisions, revision],
    // 采用新修订时同步展示信息：display 跟随当前采用修订的标题/副标题/说明（不改正文）。
    entries: workspace.entries.map((e) => e.id === contentId
      ? {
        ...e, revisionIds: [...e.revisionIds, revision.id], headRevisionId: revision.id, updatedAt: time,
        display: { ...e.display, title: revision.title, subtitle: revision.subtitle, description: revision.description },
      } : e),
    branches: workspace.branches.map((b) => b.id === branch.id
      ? { ...b, adopted: b.adopted.map((a) => a.contentId === contentId ? { contentId, revisionId: revision.id } : a) } : b),
    obligations: workspace.obligations.map((o) => o.contentId === contentId && !o.waivedAt ? { ...o, revisionId: revision.id } : o),
    management: [...workspace.management, manage(workspace, 'adopt-revision', [contentId, revision.id], time, branch.id)],
  };
  void entry;
  return checked(next);
}

// ---------- 归档 ----------

export function attachVolume(workspace: Workspace, volume: ArchiveVolume, at = new Date()): Workspace {
  const ids = new Set(volume.members.map((m) => m.contentId));
  // 一个内容只能属于一个卷（entry.archiveVolumeId 只有一个位置）；重新成卷要先取消原归档
  const conflict = workspace.entries.find((entry) => ids.has(entry.id) && entry.archiveVolumeId && entry.archiveVolumeId !== volume.id);
  if (conflict) throw new Error('该内容已归档在另一个卷中，请先取消原归档再重新成卷');
  const time = at.toISOString();
  const next: Workspace = {
    ...workspace,
    volumes: [...workspace.volumes.filter((v) => v.id !== volume.id), volume],
    entries: workspace.entries.map((entry) => ids.has(entry.id) ? { ...entry, archiveVolumeId: volume.id, updatedAt: time } : entry),
    management: [...workspace.management, manage(workspace, 'archive', [volume.id, ...ids], time, volume.derivedFrom.branchId)],
  };
  return checked(next);
}

export function detachVolume(workspace: Workspace, volumeId: string, at = new Date()): Workspace {
  const time = at.toISOString();
  const next: Workspace = {
    ...workspace,
    volumes: workspace.volumes.filter((v) => v.id !== volumeId),
    entries: workspace.entries.map((entry) => entry.archiveVolumeId === volumeId ? { ...entry, archiveVolumeId: null, updatedAt: time } : entry),
    management: [...workspace.management, manage(workspace, 'unarchive', [volumeId], time, workspace.activeBranchId)],
  };
  return checked(next);
}
