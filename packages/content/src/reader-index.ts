import { z } from 'zod';
import { contentHash, stableStringify } from '@endless/esl';
import { getScenes, projectSession, type Library, type PlayerCommand, type PlayerSession } from '@endless/player';
import {
  CLOUD_HISTORY_LIMITS, CLOUD_WORKSPACE_CONTRACT, CloudContentRevisionSchema, CloudEventSegmentSchema, CloudObjectRefSchema,
  type CloudContentRevision, type CloudEventSegment, type CloudObjectRef,
} from '@endless/cloud-contracts';
import {
  assertWorkspaceGraph, BundledRevisionSchema, ContentRevisionSchema, WorkspaceIdentitySchema, WorkspaceSchema,
  type AnyRevision, type Branch, type ContentRevision, type Workspace,
} from './application-contract.js';
export { applyReadingCommand } from './reading-command.js';
import { applyReadingCommand } from './reading-command.js';
import type { CloudCatalogEntry } from './cloud-catalog.js';
import type { Content, SavedPlayer } from './index.js';

const LEAF_BYTES = CLOUD_HISTORY_LIMITS.lineBytes;
const generatedHeader = ContentRevisionSchema.omit({ draft: true, batch: true, creation: true, validation: true }).extend({
  sceneCount: z.number().int().min(1).max(20),
  leaf: CloudObjectRefSchema,
}).strict();
const bundledHeader = BundledRevisionSchema.extend({
  sceneCount: z.number().int().positive(),
  leaf: z.null(),
}).strict();
export const ReaderRevisionSchema = z.union([generatedHeader, bundledHeader]);
export type ReaderRevision = z.infer<typeof ReaderRevisionSchema>;
const checkpointHeader = WorkspaceSchema.shape.checkpoints.element.omit({ state: true });

/** 写入时从已持有的工作区投影。读路径只加载这份目录，不再为了建目录去取每一份正文。 */
export const ReaderIndexSchema = z.object({
  format: z.literal('cloud-reader-index/1'),
  scope: z.string().min(1).max(300),
  token: z.string().uuid(),
  sourceContract: z.literal(CLOUD_WORKSPACE_CONTRACT),
  identity: WorkspaceIdentitySchema,
  revisions: z.array(ReaderRevisionSchema).min(3).max(64),
  contentRevisions: z.array(CloudContentRevisionSchema).max(64),
  segments: z.array(CloudEventSegmentSchema).max(640),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  volumes: WorkspaceSchema.shape.volumes,
  checkpoints: z.array(checkpointHeader).max(64),
  tickets: WorkspaceSchema.shape.tickets,
  management: WorkspaceSchema.shape.management,
}).strict();
export type ReaderIndex = z.infer<typeof ReaderIndexSchema>;

/** 显式的无正文阅读视图。它不是 endless-workspace/1，也不能拿去冒充一份完整存档。 */
export const ReadingViewSchema = WorkspaceSchema.omit({ revisions: true, checkpoints: true }).extend({
  format: z.literal('cloud-reading-view/1'),
  scope: z.string().min(1).max(300),
  revisions: z.array(ReaderRevisionSchema).min(3).max(64),
  checkpoints: z.array(checkpointHeader).max(64),
  contentRevisions: z.array(CloudContentRevisionSchema).max(64),
  segments: z.array(CloudEventSegmentSchema).max(640),
  indexDigest: z.string().regex(/^[0-9a-f]{64}$/),
  cacheToken: z.string().uuid(),
}).strict();
export type ReadingView = z.infer<typeof ReadingViewSchema>;
export function parseReadingView(raw: unknown): ReadingView {
  return assertWorkspaceGraph(ReadingViewSchema.parse(raw));
}

export type ReaderDigest = (value: unknown) => Promise<string>;
export interface LeafRead { key: string; bytes: number }
export interface PreparedReading {
  view: ReadingView;
  branch: Branch;
  session: PlayerSession;
  library: Library;
  catalogue: CloudCatalogEntry[];
  reads: LeafRead[];
  memoryBytes: number;
  catalogBytes: number;
}

const catalogBytesOf = (view: ReadingView) => new TextEncoder().encode(stableStringify({
  revisions: view.revisions, contentRevisions: view.contentRevisions, segments: view.segments,
})).length;

/** 稳定 UUID：段标识不随每次投影随机变化，也不把事件正文写进工作区文档。 */
function stableUuid(material: string): string {
  const hex = (contentHash(material) + contentHash(`id:${material}`)).slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = 'a';
  const text = hex.join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20, 32)}`;
}

const objectIdOf = (revisionId: string) => revisionId.slice(4);

function leafOf(revision: AnyRevision, sha256: string, bytes: number): CloudObjectRef {
  return CloudObjectRefSchema.parse({ objectId: objectIdOf(revision.id), sha256, bytes });
}

async function revisionHeader(content: Content, revision: AnyRevision, digest: ReaderDigest): Promise<ReaderRevision> {
  if (revision.origin === 'bundled') {
    const episode = content.pilot.episodes.find((item) => item.id === revision.catalogId);
    if (!episode || episode.id !== revision.episodeId || contentHash(stableStringify(episode.ast)) !== revision.hash) {
      throw new Error('捆绑修订与注册目录不一致，原记录保留');
    }
    return bundledHeader.parse({ ...revision, sceneCount: getScenes(episode).length, leaf: null });
  }
  const { draft, batch, creation, validation, ...metadata } = revision;
  void draft; void creation; void validation;
  const canonical = stableStringify(revision);
  return generatedHeader.parse({
    ...metadata,
    sceneCount: batch.scenes.length,
    leaf: leafOf(revision, await digest(revision), new TextEncoder().encode(canonical).length),
  });
}

export async function projectEventSegments(branches: readonly { id: string; session: { events: readonly unknown[] } }[], digest: ReaderDigest): Promise<CloudEventSegment[]> {
  const segments: CloudEventSegment[] = [];
  for (const branch of branches) {
    let previousSegmentId: string | null = null;
    for (let fromSeq = 0; fromSeq < branch.session.events.length; fromSeq += CLOUD_HISTORY_LIMITS.eventsPerSegment) {
      const chunk = branch.session.events.slice(fromSeq, fromSeq + CLOUD_HISTORY_LIMITS.eventsPerSegment);
      const canonical = stableStringify(chunk);
      const bytes = new TextEncoder().encode(canonical).length;
      if (bytes > LEAF_BYTES) throw new Error('事件段超出单段上限，原历史保留');
      const segmentId = `seg_${stableUuid(`${branch.id}:${fromSeq}`)}`;
      const segment = CloudEventSegmentSchema.parse({
        contract: 'cloud-event-segment/1',
        segmentId,
        streamId: branch.id,
        previousSegmentId,
        fromSeq,
        toSeq: fromSeq + chunk.length,
        eventCount: chunk.length,
        segmentHash: contentHash(chunk),
        body: { objectId: stableUuid(`body:${segmentId}`), sha256: await digest(chunk), bytes },
      });
      segments.push(segment);
      previousSegmentId = segmentId;
    }
  }
  return segments;
}

const indexPayload = (index: Pick<ReaderIndex, 'revisions' | 'contentRevisions' | 'segments'>) => ({
  revisions: index.revisions, contentRevisions: index.contentRevisions, segments: index.segments,
});

export async function projectReaderIndex(content: Content, workspace: Workspace, scope: string, digest: ReaderDigest): Promise<ReaderIndex> {
  const revisions = await Promise.all(workspace.revisions.map((revision) => revisionHeader(content, revision, digest)));
  const contentRevisions = revisions.flatMap((revision) => revision.origin === 'bundled' ? [] : [CloudContentRevisionSchema.parse({
    contract: 'cloud-content-revision/1',
    revisionId: revision.id,
    contentId: revision.contentId,
    basisId: `bas_${objectIdOf(revision.id)}`,
    leaf: revision.leaf,
    plannedAt: revision.plannedAt,
    authoredAt: revision.authoredAt,
  })]);
  const segments = await projectEventSegments(workspace.branches, digest);
  const payload = { revisions, contentRevisions, segments };
  return ReaderIndexSchema.parse({
    format: 'cloud-reader-index/1',
    scope,
    token: globalThis.crypto.randomUUID(),
    sourceContract: CLOUD_WORKSPACE_CONTRACT,
    identity: workspace.identity,
    ...payload,
    digest: await digest(payload),
    volumes: workspace.volumes,
    checkpoints: workspace.checkpoints.map(({ state, ...metadata }) => metadata),
    tickets: workspace.tickets,
    management: workspace.management,
  });
}

export async function verifyReaderIndex(raw: unknown, scope: string, digest: ReaderDigest): Promise<ReaderIndex> {
  const index = ReaderIndexSchema.parse(raw);
  if (index.scope !== scope || index.sourceContract !== CLOUD_WORKSPACE_CONTRACT) throw new Error('阅读目录契约不一致，原记录保留');
  if (await digest(indexPayload(index)) !== index.digest) throw new Error('阅读目录摘要不一致，原记录保留');
  for (const revision of index.revisions) {
    if (revision.origin === 'bundled') continue;
    if (revision.leaf.objectId !== objectIdOf(revision.id)) throw new Error('正文引用身份不一致，原记录保留');
    const linked = index.contentRevisions.find((item) => item.revisionId === revision.id);
    if (!linked || linked.leaf.objectId !== revision.leaf.objectId || linked.leaf.sha256 !== revision.leaf.sha256
      || linked.leaf.bytes !== revision.leaf.bytes || linked.contentId !== revision.contentId) {
      throw new Error('正文引用与目录绑定不一致，原记录保留');
    }
  }
  return index;
}

/** 边界、引用身份、字节摘要都通过之后，才解析正文。原生恢复由调用方接着做。 */
export async function acceptRevisionLeaf(binding: { revisionId: string; leaf: CloudObjectRef }, raw: unknown, digest: ReaderDigest): Promise<ContentRevision> {
  if (raw == null || typeof raw !== 'object') throw new Error('缺少正文叶，不能当作完整工作区');
  const record = raw as Record<string, unknown>;
  if ('contract' in record || record.format === 'cloud-reading-view/1' || record.format === 'cloud-reader-index/1') {
    throw new Error('未知契约，原正文保留');
  }
  const canonical = stableStringify(raw);
  const bytes = new TextEncoder().encode(canonical).length;
  if (bytes > LEAF_BYTES || bytes !== binding.leaf.bytes) throw new Error('正文叶超出边界或与引用字节数不一致，原记录保留');
  if (binding.leaf.objectId !== objectIdOf(binding.revisionId) || record.id !== binding.revisionId) {
    throw new Error('正文引用身份不一致，原记录保留');
  }
  if (await digest(raw) !== binding.leaf.sha256) throw new Error('正文摘要不一致，原记录保留');
  const parsed = ContentRevisionSchema.safeParse(raw);
  if (!parsed.success || stableStringify(parsed.data) !== canonical) throw new Error('未知契约或正文含未知字段，原记录保留');
  if (parsed.data.id !== binding.revisionId) throw new Error('正文引用身份不一致，原记录保留');
  return parsed.data;
}

const documentOf = (revision: ContentRevision): SavedPlayer['generated'][number] => ({
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
});

type GeneratedHeader = Extract<ReaderRevision, { origin: 'generated' | 'edited' }>;

/** 按目录按需读取不可变正文。未打开、且没有事件的更晚生成集不会取叶。 */
export class AsyncCloudReader {
  private resident = 0;
  private reads: LeafRead[] = [];
  constructor(
    private readonly content: Content,
    private readonly read: (leaf: CloudObjectRef, revisionId: string) => Promise<unknown>,
    private readonly digest: ReaderDigest,
  ) {}

  catalogue(view: ReadingView): CloudCatalogEntry[] {
    const branch = view.branches.find((item) => item.id === view.activeBranchId);
    if (!branch) throw new Error('当前分支不存在');
    return branch.adopted.map((adopted) => {
      const revision = view.revisions.find((item) => item.id === adopted.revisionId);
      const entry = view.entries.find((item) => item.id === adopted.contentId);
      if (!revision || !entry) throw new Error('分支采用了不存在的修订');
      return {
        episodeId: revision.episodeId,
        contentId: entry.id,
        revisionId: revision.id,
        title: entry.display.title || revision.title,
        subtitle: entry.display.subtitle || revision.subtitle,
        description: entry.display.description || revision.description,
        series: entry.series,
        bundled: revision.origin === 'bundled',
        sceneCount: revision.sceneCount,
      };
    });
  }

  private assertBundled(revision: ReaderRevision): void {
    if (revision.origin !== 'bundled') return;
    const episode = this.content.pilot.episodes.find((item) => item.id === revision.catalogId);
    if (!episode || episode.id !== revision.episodeId || contentHash(stableStringify(episode.ast)) !== revision.hash
      || getScenes(episode).length !== revision.sceneCount) {
      throw new Error('捆绑修订与注册目录不一致，原记录保留');
    }
  }

  private async leaf(revision: GeneratedHeader): Promise<ContentRevision> {
    const raw = await this.read(revision.leaf, revision.id);
    const parsed = await acceptRevisionLeaf({ revisionId: revision.id, leaf: revision.leaf }, raw, this.digest);
    if (parsed.contentId !== revision.contentId || parsed.episodeId !== revision.episodeId || parsed.hash !== revision.hash
      || parsed.plannedAt !== revision.plannedAt || parsed.basis.eventHash !== revision.basis.eventHash
      || parsed.batch.scenes.length !== revision.sceneCount) {
      throw new Error('正文叶与目录绑定不一致，原始正文保留');
    }
    this.reads.push({ key: revision.id, bytes: revision.leaf.bytes });
    this.resident += revision.leaf.bytes;
    return parsed;
  }

  async prepare(raw: ReadingView, command?: PlayerCommand): Promise<PreparedReading> {
    const view = parseReadingView(raw);
    if (await this.digest(indexPayload(view)) !== view.indexDigest) throw new Error('阅读目录摘要不同，原数据保留');
    const branch = view.branches.find((item) => item.id === view.activeBranchId);
    if (!branch) throw new Error('当前分支不存在');
    const adopted = branch.adopted.map((item) => {
      const revision = view.revisions.find((candidate) => candidate.id === item.revisionId);
      if (!revision) throw new Error('分支采用了不存在的修订');
      return revision;
    });
    for (const revision of adopted) this.assertBundled(revision);
    const needed = new Set<string>([branch.session.current, ...branch.session.events.map((event) => event.episode)]);
    if (command?.type === 'select') needed.add(command.episode);
    if ([...needed].some((id) => !adopted.some((revision) => revision.episodeId === id))) throw new Error('阅读位置不在该分支目录中');
    const through = Math.max(...adopted.map((revision, index) => needed.has(revision.episodeId) ? index : -1));
    const slice = adopted.slice(0, through + 1);
    const revisions = await Promise.all(slice.filter((revision): revision is GeneratedHeader => revision.origin !== 'bundled').map((revision) => this.leaf(revision)));
    const restored = this.content.restore({
      version: 2,
      revision: branch.session.revision,
      session: branch.session,
      generated: revisions.map(documentOf),
    });
    return {
      view,
      branch,
      session: branch.session,
      library: restored.library,
      catalogue: this.catalogue(view),
      reads: this.reads,
      memoryBytes: this.resident,
      catalogBytes: catalogBytesOf(view),
    };
  }

  async lookupSource(view: ReadingView, revisionId: string, sceneId: string): Promise<string[]> {
    const revision = view.revisions.find((item) => item.id === revisionId);
    if (!revision) throw new Error('历史来源修订不存在，原件保留');
    if (revision.origin === 'bundled') {
      this.assertBundled(revision);
      const episode = this.content.pilot.episodes.find((item) => item.id === revision.catalogId);
      if (!episode) throw new Error('历史来源不在注册目录中');
      return episode.ast.nodes.flatMap((node) => {
        if ((node.type !== 'bubble' && node.type !== 'message') || typeof node.data.text !== 'string' || !node.data.text) return [];
        const parent = typeof node.parent === 'string' ? node.parent : '';
        const scene = parent === sceneId || parent.startsWith(`${sceneId}.`)
          ? sceneId
          : episode.ast.nodes.find((item) => item.id === parent)?.parent;
        return scene === sceneId ? [node.data.text] : [];
      });
    }
    const body = await this.leaf(revision);
    const source = view.branches.find((item) => item.id === body.basis.branchId);
    if (!source || source.session.events.length < body.basis.eventCount) throw new Error('历史来源缺少生成时前缀，原件保留');
    const prior = await Promise.all(body.basis.adopted.map((item) => view.revisions.find((candidate) => candidate.id === item.revisionId))
      .filter((item): item is GeneratedHeader => !!item && item.origin !== 'bundled' && item.id !== body.id)
      .map((item) => this.leaf(item)));
    const session = { ...source.session, current: body.episodeId, events: source.session.events.slice(0, body.basis.eventCount) };
    this.content.restore({
      version: 2,
      revision: session.revision,
      session,
      generated: [...prior.map(documentOf), documentOf(body)],
    });
    const scene = body.batch.scenes.find((item) => item.id === sceneId);
    if (!scene) throw new Error('历史来源场景不存在');
    if (scene.type === 'comic') return scene.panels.flatMap((panel) => [...(panel.caption ? [panel.caption] : []), ...(panel.bubbles ?? []).map((bubble) => bubble.text)]);
    if (scene.type === 'chat') return scene.messages.map((message) => message.text);
    throw new Error('历史来源不是可引用的叙述');
  }

  async draft(view: ReadingView, contentId: string): Promise<string | null> {
    const branch = view.branches.find((item) => item.id === view.activeBranchId);
    const adopted = branch?.adopted.find((item) => item.contentId === contentId);
    const revision = view.revisions.find((item) => item.id === adopted?.revisionId);
    if (!revision || revision.origin === 'bundled') return null;
    await this.prepare(view, { type: 'select', episode: revision.episodeId });
    return (await this.leaf(revision)).draft;
  }

  command(view: ReadingView, library: Library, command: PlayerCommand, at = new Date()) {
    if (view.tickets.some((ticket) => ticket.status === 'reserved' || ticket.status === 'submitted')) {
      throw new Error('生成任务进行中，请先完成或取消该任务');
    }
    const branch = view.branches.find((item) => item.id === view.activeBranchId);
    if (!branch) throw new Error('当前分支不存在');
    return applyReadingCommand(this.content, branch, view.revisions, view.obligations, library, command, at);
  }
}

export function readingMemory(prepared: PreparedReading) {
  return { reads: prepared.reads, memoryBytes: prepared.memoryBytes, catalogBytes: prepared.catalogBytes };
}
