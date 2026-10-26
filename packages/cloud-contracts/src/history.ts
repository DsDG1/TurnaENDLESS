/**
 * C4 长期历史的外层契约。
 *
 * 这不是 endless-workspace/1 的新版本：旧工作区数组上限保持原义。
 * 云端用事件段、采用清单和生成依据的引用组织历史，不把无界数组塞回旧文档。
 */
import { z } from 'zod';
import { UuidSchema } from './envelope.js';

export const CLOUD_WORKSPACE_CONTRACT = 'endless-cloud-workspace/1' as const;
export const CLOUD_EVENT_SEGMENT_CONTRACT = 'cloud-event-segment/1' as const;
export const CLOUD_ADOPTION_MANIFEST_CONTRACT = 'cloud-adoption-manifest/1' as const;
export const CLOUD_GENERATION_BASIS_CONTRACT = 'cloud-generation-basis/1' as const;
export const CLOUD_CONTENT_REVISION_CONTRACT = 'cloud-content-revision/1' as const;
export const CLOUD_REPLAY_PROJECTOR_VERSION = 'player-replay-1' as const;

/** 单个对象的上限。超过就分成下一段/下一页，不删历史，也不放宽旧会话的 10_000。 */
export const CLOUD_HISTORY_LIMITS = {
  eventsPerSegment: 1000,
  adoptionsPerManifest: 500,
  obligationsPerBasis: 500,
  lineBytes: 2_097_152,
} as const;

const hash16 = z.string().regex(/^[a-f0-9]{16}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const localId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-f-]{36}$`));

export const CloudObjectRefSchema = z.object({
  objectId: UuidSchema,
  sha256,
  bytes: z.number().int().positive().max(CLOUD_HISTORY_LIMITS.lineBytes),
}).strict();
export type CloudObjectRef = z.infer<typeof CloudObjectRefSchema>;

const historyHead = z.object({
  streamId: localId('brn'),
  eventCount: z.number().int().nonnegative(),
  eventHash: hash16,
  headSegmentId: localId('seg').nullable(),
}).strict();

export const CloudEventSegmentSchema = z.object({
  contract: z.literal(CLOUD_EVENT_SEGMENT_CONTRACT),
  segmentId: localId('seg'),
  streamId: localId('brn'),
  previousSegmentId: localId('seg').nullable(),
  fromSeq: z.number().int().nonnegative(),
  toSeq: z.number().int().positive(),
  eventCount: z.number().int().min(1).max(CLOUD_HISTORY_LIMITS.eventsPerSegment),
  /** 这一段正文的摘要，不是整条历史的前缀摘要。整段前缀摘要在工作区信封上。 */
  segmentHash: hash16,
  body: CloudObjectRefSchema,
}).strict().superRefine((segment, ctx) => {
  if (segment.toSeq - segment.fromSeq !== segment.eventCount) {
    ctx.addIssue({ code: 'custom', message: '事件段的序号跨度必须等于事件数' });
  }
  if ((segment.previousSegmentId === null) !== (segment.fromSeq === 0)) {
    ctx.addIssue({ code: 'custom', message: '只有第一段可以没有前段，且必须从 0 开始' });
  }
});
export type CloudEventSegment = z.infer<typeof CloudEventSegmentSchema>;

export const CloudAdoptionManifestSchema = z.object({
  contract: z.literal(CLOUD_ADOPTION_MANIFEST_CONTRACT),
  manifestId: localId('adm'),
  previousManifestId: localId('adm').nullable(),
  ordinal: z.number().int().nonnegative(),
  entries: z.array(z.object({
    contentId: localId('ent'),
    revisionId: localId('rev'),
  }).strict()).min(1).max(CLOUD_HISTORY_LIMITS.adoptionsPerManifest),
}).strict().superRefine((manifest, ctx) => {
  if ((manifest.previousManifestId === null) !== (manifest.ordinal === 0)) {
    ctx.addIssue({ code: 'custom', message: '只有第一页采用清单可以没有前页' });
  }
  if (new Set(manifest.entries.map((entry) => entry.contentId)).size !== manifest.entries.length) {
    ctx.addIssue({ code: 'custom', message: '同一页不能采用同一内容的两个修订' });
  }
});
export type CloudAdoptionManifest = z.infer<typeof CloudAdoptionManifestSchema>;

export const CloudGenerationBasisSchema = z.object({
  contract: z.literal(CLOUD_GENERATION_BASIS_CONTRACT),
  basisId: localId('bas'),
  catalogVersion: z.string().min(1).max(64),
  learningContract: z.literal('endless-draft-v1'),
  projectorVersion: z.literal(CLOUD_REPLAY_PROJECTOR_VERSION),
  history: historyHead,
  adoption: z.object({
    headManifestId: localId('adm').nullable(),
    entryCount: z.number().int().nonnegative(),
  }).strict(),
  obligations: z.array(localId('ent')).max(CLOUD_HISTORY_LIMITS.obligationsPerBasis),
  /** 重建学习任务的时间。不是落稿时间，也不是 Worker 后来醒来的时间。 */
  plannedAt: z.string().datetime(),
  authoredAt: z.string().datetime(),
}).strict();
export type CloudGenerationBasis = z.infer<typeof CloudGenerationBasisSchema>;

export const CloudContentRevisionSchema = z.object({
  contract: z.literal(CLOUD_CONTENT_REVISION_CONTRACT),
  revisionId: localId('rev'),
  contentId: localId('ent'),
  basisId: localId('bas'),
  leaf: CloudObjectRefSchema,
  plannedAt: z.string().datetime(),
  authoredAt: z.string().datetime(),
}).strict();
export type CloudContentRevision = z.infer<typeof CloudContentRevisionSchema>;

export const CloudWorkspaceEnvelopeSchema = z.object({
  contract: z.literal(CLOUD_WORKSPACE_CONTRACT),
  workspaceId: UuidSchema,
  catalogVersion: z.string().min(1).max(64),
  history: historyHead,
  adoption: z.object({
    headManifestId: localId('adm').nullable(),
    entryCount: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export type CloudWorkspaceEnvelope = z.infer<typeof CloudWorkspaceEnvelopeSchema>;

export class CloudHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudHistoryError';
  }
}

export function parseCloudWorkspace(raw: unknown): CloudWorkspaceEnvelope {
  const parsed = CloudWorkspaceEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw new CloudHistoryError('不是 endless-cloud-workspace/1，旧工作区不会被当成云历史改写');
  return parsed.data;
}

export function assertSegmentChain(segments: readonly CloudEventSegment[]): { eventCount: number } {
  const ordered = [...segments].sort((a, b) => a.fromSeq - b.fromSeq);
  if (new Set(ordered.map((segment) => segment.segmentId)).size !== ordered.length) {
    throw new CloudHistoryError('事件段 ID 重复');
  }
  let cursor = 0;
  let previous: CloudEventSegment | null = null;
  for (const segment of ordered) {
    if (segment.fromSeq !== cursor || segment.previousSegmentId !== (previous?.segmentId ?? null)) {
      throw new CloudHistoryError('事件段必须首尾相接，不能跳过或重叠');
    }
    if (previous && (segment.streamId !== previous.streamId)) throw new CloudHistoryError('事件段不属于同一条历史');
    cursor = segment.toSeq;
    previous = segment;
  }
  return { eventCount: cursor };
}

export function assertAdoptionChain(manifests: readonly CloudAdoptionManifest[]): { entryCount: number } {
  const ordered = [...manifests].sort((a, b) => a.ordinal - b.ordinal);
  if (new Set(ordered.map((manifest) => manifest.manifestId)).size !== ordered.length) {
    throw new CloudHistoryError('采用清单 ID 重复');
  }
  const seen = new Set<string>();
  let previous: CloudAdoptionManifest | null = null;
  for (const [index, manifest] of ordered.entries()) {
    if (manifest.ordinal !== index || manifest.previousManifestId !== (previous?.manifestId ?? null)) {
      throw new CloudHistoryError('采用清单必须按页相接');
    }
    for (const entry of manifest.entries) {
      if (seen.has(entry.contentId)) throw new CloudHistoryError('同一内容不能在采用链里出现两次');
      seen.add(entry.contentId);
    }
    previous = manifest;
  }
  return { entryCount: seen.size };
}

/** 信封上的计数必须等于段链和采用链的实际闭合，少一页就不能声称已经到了这个长度。 */
export function assertCloudHistory(input: {
  workspace: CloudWorkspaceEnvelope;
  segments: readonly CloudEventSegment[];
  manifests: readonly CloudAdoptionManifest[];
}): void {
  for (const segment of input.segments) {
    if (segment.streamId !== input.workspace.history.streamId) throw new CloudHistoryError('事件段不属于该云工作区');
  }
  const history = assertSegmentChain(input.segments);
  if (history.eventCount !== input.workspace.history.eventCount) {
    throw new CloudHistoryError('云工作区声明的事件数与事件段不一致');
  }
  const head = input.segments.length ? [...input.segments].sort((a, b) => a.fromSeq - b.fromSeq).at(-1)!.segmentId : null;
  if (head !== input.workspace.history.headSegmentId) throw new CloudHistoryError('云工作区的事件段头与链尾不一致');
  const adoption = assertAdoptionChain(input.manifests);
  if (adoption.entryCount !== input.workspace.adoption.entryCount) {
    throw new CloudHistoryError('云工作区声明的采用数与清单不一致');
  }
  const adoptionHead = input.manifests.length
    ? [...input.manifests].sort((a, b) => a.ordinal - b.ordinal).at(-1)!.manifestId
    : null;
  if (adoptionHead !== input.workspace.adoption.headManifestId) throw new CloudHistoryError('云工作区的采用清单头与链尾不一致');
}
