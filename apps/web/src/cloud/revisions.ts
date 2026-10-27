import { stableStringify } from '@endless/esl';
import { adoptRevision, bridge, ContentRevisionSchema, parseWorkspace, previewRevision, switchBranch,
  type Content, type Workspace } from '@endless/content';
import { CLOUD_LIMITS, RevisionOutboxSchema, type RevisionOutbox, RevisionCatalogSchema,
  RevisionPreviewReceiptSchema,
  type RevisionCatalog, type RevisionPreviewReceipt, type RevisionRegistration } from '@endless/cloud-contracts';
import type { CloudWorkspaceRepository as WorkspaceRepository } from './repository.js';
import { CloudFailure, type CloudApiPort } from './client.js';
import { cloudDigest } from './local.js';
import { sameMetadata } from './metadata.js';

export type RevisionState = RevisionOutbox;
export const emptyRevisions = (): RevisionState => ({ format: 'revision-outbox/1', installed: [], pending: null });
export function parseRevisions(raw: unknown, workspaceId: string): RevisionState {
  const state = raw === undefined ? emptyRevisions() : RevisionOutboxSchema.parse(raw);
  if (state.installed.some((r, i) => r.version !== i + 1 || (i > 0 && r.readingChangeSeq < state.installed[i - 1]!.readingChangeSeq))) throw new Error('修订登记序列不受支持，原件保留');
  const held = state.pending;
  if (held) {
    parseWorkspace(held.baseline);
    if (held.request.workspaceId !== workspaceId || (held.preview && (held.preview.workspaceId !== workspaceId || held.preview.requestId !== held.request.requestId))
      || (held.confirmation && (held.confirmation.workspaceId !== workspaceId || held.confirmation.previewRequestId !== held.request.requestId
        || held.preview?.outcome !== 'ready' || held.confirmation.artifactDigest !== held.preview.artifact.digest))
      || (held.result && (!held.confirmation || held.result.workspaceId !== workspaceId || held.result.commandId !== held.confirmation.commandId))) throw new Error('修订请求身份不一致，原件保留');
  }
  return state;
}
export const revisionFrozen = (state: RevisionState) => !!state.pending?.confirmation
  && (!state.pending.result || state.pending.result.outcome === 'applied');

export async function validateCatalog(raw: RevisionCatalog, workspaceId: string, installed: RevisionRegistration[]) {
  const catalog = RevisionCatalogSchema.parse(raw);
  if (new TextEncoder().encode(JSON.stringify(catalog)).length > CLOUD_LIMITS.uploadObjectBytes - 8192
    || catalog.workspaceId !== workspaceId || catalog.version !== catalog.registrations.length
    || catalog.version < installed.length || await cloudDigest(catalog.registrations) !== catalog.digest
    || catalog.registrations.some((r, i) => r.version !== i + 1 || (i > 0 && r.readingChangeSeq < catalog.registrations[i - 1]!.readingChangeSeq)
      || (installed[i] && !sameMetadata(installed[i], r)))) throw new Error('修订目录摘要、版本或已安装记录不一致，原件保留');
  return catalog;
}

/** Recompile with the native content compiler; hashes alone are never authority to install executable content. */
export async function candidateFor(content: Content, workspace: Workspace, artifact: Extract<RevisionPreviewReceipt, { outcome: 'ready' }>['artifact']) {
  const revision = ContentRevisionSchema.parse(artifact.revision);
  const { digest, ...body } = artifact;
  if (stableStringify(revision) !== stableStringify(artifact.revision) || await cloudDigest(body) !== digest
    || await cloudDigest(revision) !== artifact.revisionDigest || revision.parentRevisionId !== artifact.binding.baseRevisionId) throw new Error('修订正文或预览摘要不一致');
  const source = workspace.branches.find((b) => b.id === artifact.binding.streamId);
  const entry = workspace.entries.find((e) => e.id === revision.contentId);
  if (!source || !entry || !source.adopted.some((a) => a.contentId === entry.id && a.revisionId === revision.parentRevisionId)
    || source.session.events.length < artifact.binding.eventCount) throw new Error('修订所需的原分支或阅读前缀尚未到达本机');
  const at = new Date(revision.authoredAt);
  const preview = previewRevision(content, switchBranch(workspace, source.id), entry, revision.draft, at, revision.id);
  if (!preview.ok || !preview.revision) throw new Error('新修订未通过本机原生编译验收');
  const candidate = adoptRevision(content, switchBranch(workspace, source.id), entry, preview.revision, at, artifact.branch.streamId);
  const branch = candidate.workspace.branches.find((b) => b.id === candidate.workspace.activeBranchId)!;
  const manifest = { streamId: branch.id, label: branch.label, parentBranchId: branch.parentBranchId, forkAtEventCount: branch.forkAtEventCount,
    adopted: branch.adopted, catalog: branch.session.catalog, createdAt: branch.createdAt, commonStreamId: branch.parentBranchId, commonPrefixSeq: branch.forkAtEventCount ?? 0 };
  if (candidate.mode !== artifact.mode || !sameMetadata(manifest, artifact.branch)
    || !sameMetadata(candidate.workspace.revisions.find((r) => r.id === revision.id), revision)) throw new Error('修订与本机候选分支不同，历史保留');
  for (const branch of candidate.workspace.branches) bridge(content, candidate.workspace, branch.id);
  return candidate.workspace;
}

export async function validatePreview(content: Content, state: RevisionState, raw: RevisionPreviewReceipt) {
  const held = state.pending;
  const result = RevisionPreviewReceiptSchema.parse(raw);
  if (!held || result.workspaceId !== held.request.workspaceId || result.requestId !== held.request.requestId) throw new Error('预览响应不属于原请求');
  if (result.outcome === 'ready') {
    const r = held.request, b = result.artifact.binding;
    if (b.streamId !== r.streamId || b.baseRevisionId !== r.baseRevisionId || b.eventCount !== r.baseSeq || b.lastEventId !== r.baseEventId
      || b.displayVersion !== r.displayVersion || b.lifecycleVersion !== r.lifecycleVersion || b.archiveVersion !== r.archiveVersion) throw new Error('预览前置版本与原请求不一致');
    const revision = ContentRevisionSchema.parse(result.artifact.revision);
    if (revision.contentId !== r.contentId || revision.draft !== r.draft) throw new Error('预览正文不是本次提交的草稿');
    await candidateFor(content, parseWorkspace(held.baseline), result.artifact);
  }
  return result;
}

export class RevisionSync {
  available = false;
  private catalog: RevisionCatalog | null = null;
  constructor(private readonly repo: WorkspaceRepository,
    private readonly api: Pick<CloudApiPort, 'revisionCatalog' | 'revisionPreview' | 'revisionAdopt'> & Partial<Pick<CloudApiPort, 'readingSnapshot'>>,
    private readonly content: Content, private readonly workspaceId: string) {}

  async resume() {
    if ((await this.repo.syncState()).paused) return;
    const state = await this.repo.revisionState(), held = state.pending;
    if (!held) return;
    if (!held.preview) await this.repo.revisionAction(this.content, { preview: await this.api.revisionPreview(held.request) });
    const fresh = (await this.repo.revisionState()).pending;
    if (fresh?.confirmation && !fresh.result) await this.repo.revisionAction(this.content, { result: await this.api.revisionAdopt(fresh.confirmation) });
  }
  async prepare() {
    const state = await this.repo.revisionState();
    let raw;
    try { raw = await this.api.revisionCatalog(this.workspaceId); }
    catch (error) {
      if (!(error instanceof CloudFailure) || error.status !== 404 || state.installed.length || state.pending) throw error;
      this.available = false;
      this.catalog = { workspaceId: this.workspaceId, version: 0, registrations: [], digest: await cloudDigest([]) };
      return;
    }
    this.catalog = await validateCatalog(raw, this.workspaceId, state.installed);
    this.available = true;
  }
  async through(readingSeq: number): Promise<boolean> {
    if (!this.catalog) throw new Error('尚未取得可验证的修订目录');
    if (!Number.isSafeInteger(readingSeq) || readingSeq < 0) throw new Error('阅读同步屏障无效，原件保留');
    const installed = (await this.repo.revisionState()).installed.length;
    for (const registration of this.catalog.registrations.slice(installed)) {
      if (registration.readingChangeSeq > readingSeq) break;
      if (registration.readingContext) {
        if (!this.api.readingSnapshot) throw new Error('当前服务缺少完整阅读上下文恢复，原修订与请求保留');
        const state = await this.repo.syncState();
        const snapshot = await this.api.readingSnapshot({ workspaceId: this.workspaceId, cloudVersion: state.cloudVersion ?? '0',
          streams: Object.entries(state.streams).map(([id, h]) => ({ streamId: id, branchId: id, eventSeq: h.seq, lastEventId: h.eventId })) });
        await this.repo.acceptReadingSnapshot(this.content, state, snapshot);
        await this.prepare();
        return true;
      }
      await this.repo.revisionAction(this.content, { install: registration, readingSeq });
    }
    return false;
  }
}
