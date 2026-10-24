/**
 * 正文修订流水线：手工编辑草稿 → 同一编译器重建 → 全量校验 → 预览差异 → 确认采用。
 * 已读内容采用修订时创建明确的新分支；修订保存可复现的编译依据（不只是新 hash）。
 */
import { contentHash, type ValidationIssue } from '@endless/esl';
import {
  newId, type Content, type ContentEntry, type ContentRevision, type GeneratedEpisode,
  type GenerationBasis, type SavedPlayer, type Workspace,
} from './index.js';
import {
  adoptRevisionInPlace, bridge, checked, forkForRevision, type WorkspaceRuntime,
} from './workspace.js';

const uuid = () => globalThis.crypto.randomUUID();
const isGenerated = (r: { origin: string }): r is ContentRevision => r.origin !== 'bundled';

/** 依据中的前缀：生成该修订时实际看到的历史（采用清单 + 事件前缀）。 */
export function basisPrefix(content: Content, workspace: Workspace, basis: GenerationBasis) {
  const branch = workspace.branches.find((b) => b.id === basis.branchId)
    ?? workspace.branches.find((b) => b.id === workspace.activeBranchId);
  if (!branch) throw new Error('生成依据引用的分支不存在');
  const byId = new Map(workspace.revisions.map((r) => [r.id, r]));
  const generated = basis.adopted
    .map((a) => byId.get(a.revisionId))
    .filter((r): r is ContentRevision => !!r && isGenerated(r))
    .map((revision): GeneratedEpisode => ({
      version: 1, generatedAt: revision.plannedAt,
      basedOn: { eventCount: revision.basis.eventCount, hash: revision.basis.eventHash },
      title: revision.title, subtitle: revision.subtitle, description: revision.description,
      batch: revision.batch, hash: revision.hash, learningVersion: 4, creation: revision.creation,
    }));
  const session = {
    ...branch.session,
    events: branch.session.events.slice(0, basis.eventCount),
    current: content.pilot.episodes.at(-1)!.id,
  };
  const save: SavedPlayer = { version: 2, revision: session.revision, session, generated };
  return { ...content.restore(save), save };
}

export interface RevisionPreview {
  ok: boolean;
  issues: ValidationIssue[];
  revision?: ContentRevision;
  before?: { scenes: { id: string; type: string }[] };
  after?: { scenes: { id: string; type: string }[] };
}

/** 编译编辑后的草稿。task 由原修订的计划依据重建，plannedAt 保持原值以复现学习任务。 */
export function previewRevision(content: Content, workspace: Workspace, entry: ContentEntry, draftText: string, at = new Date()): RevisionPreview {
  const head = workspace.revisions.find((r) => r.id === entry.headRevisionId);
  if (!head || !isGenerated(head)) return { ok: false, issues: [{ code: 'E-REVISION', level: 'error', message: '只有生成内容可以编辑正文' }] };
  const scenesOf = (batch: { scenes: { id: string; type: string }[] }) => batch.scenes.map((s) => ({ id: s.id, type: s.type }));
  let prefix;
  try {
    prefix = basisPrefix(content, workspace, head.basis);
  } catch (error) {
    return { ok: false, issues: [{ code: 'E-REVISION', level: 'error', message: `生成依据无法恢复：${error instanceof Error ? error.message : error}` }] };
  }
  // 复现学习任务必须用生成当时的计划时间（basis.plannedAt），不是文档生成时间
  const task = content.planCreative(prefix.session, prefix.library, new Date(head.basis.plannedAt));
  const compiled = content.compileDraft(draftText, task, prefix.library, head.episodeId);
  if (!compiled.ok) return { ok: false, issues: compiled.issues, before: { scenes: scenesOf(head.batch) } };
  // 路径验收：把前缀 + 新修订还原成库，验证该集全部选项与跳过路径
  const save: SavedPlayer = { ...prefix.save, generated: [...prefix.save.generated, {
    version: 1, generatedAt: head.basis.plannedAt,
    basedOn: { eventCount: head.basis.eventCount, hash: head.basis.eventHash },
    title: compiled.title, subtitle: compiled.subtitle, description: compiled.description,
    batch: compiled.batch, hash: contentHash(compiled.batch),
    learningVersion: 4, creation: compiled.creation,
  }] };
  const issues: ValidationIssue[] = [];
  try {
    const restored = content.restore(save);
    content.validatePathsCreative(prefix.session, restored.library);
  } catch (error) {
    issues.push({ code: 'E-REVISION', level: 'error', message: error instanceof Error ? error.message : '修订路径校验失败' });
    return { ok: false, issues, before: { scenes: scenesOf(head.batch) } };
  }
  const revision: ContentRevision = {
    id: newId('revision', uuid), contentId: entry.id, parentRevisionId: head.id,
    ordinal: head.ordinal + 1, origin: 'edited', episodeId: head.episodeId,
    draft: compiled.creation.draft, batch: compiled.batch, hash: contentHash(compiled.batch),
    title: compiled.title, subtitle: compiled.subtitle, description: compiled.description,
    creation: compiled.creation, learningVersion: 4,
    basis: { ...head.basis }, plannedAt: head.plannedAt, authoredAt: at.toISOString(),
    validation: { ok: true, issues: [] },
  };
  return {
    ok: true, issues: [], revision,
    before: { scenes: scenesOf(head.batch) },
    after: { scenes: scenesOf(compiled.batch) },
  };
}

/**
 * 确认采用：未交互内容原位替换；已有交互则创建新分支（forkForRevision 复制边界前历史）。
 * 返回 {workspace, mode}，mode 标明原位替换或新分支。
 */
export function adoptRevision(content: Content, workspace: Workspace, entry: ContentEntry, revision: ContentRevision, at = new Date()): { workspace: Workspace; mode: 'in-place' | 'fork' } {
  const runtime: WorkspaceRuntime = bridge(content, workspace, workspace.activeBranchId);
  const hasEvents = runtime.branch.session.events.some((event) => event.episode === revision.episodeId);
  if (!hasEvents) {
    return { workspace: adoptRevisionInPlace(workspace, entry.id, revision, at), mode: 'in-place' };
  }
  return { workspace: forkForRevision(workspace, runtime.branch.id, entry.id, revision, at), mode: 'fork' };
}
