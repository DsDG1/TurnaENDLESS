/**
 * 有界 JSONL：一行一个云历史对象。
 * 读的时候按行拉取，不要求调用方先把整份历史拼成一个 JSON 数组。
 */
import { z } from 'zod';
import {
  CLOUD_HISTORY_LIMITS, CloudAdoptionManifestSchema, CloudContentRevisionSchema,
  CloudEventSegmentSchema, CloudGenerationBasisSchema, CloudHistoryError, CloudWorkspaceEnvelopeSchema,
  assertCloudHistory,
  type CloudAdoptionManifest, type CloudContentRevision, type CloudEventSegment,
  type CloudGenerationBasis, type CloudWorkspaceEnvelope,
} from './history.js';

export const CloudHistoryRecordSchema = z.discriminatedUnion('contract', [
  CloudWorkspaceEnvelopeSchema,
  CloudEventSegmentSchema,
  CloudAdoptionManifestSchema,
  CloudGenerationBasisSchema,
  CloudContentRevisionSchema,
]);
export type CloudHistoryRecord = z.infer<typeof CloudHistoryRecordSchema>;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function encodeCloudHistoryLine(record: CloudHistoryRecord): string {
  const line = JSON.stringify(CloudHistoryRecordSchema.parse(record));
  if (line.includes('\n') || byteLength(line) > CLOUD_HISTORY_LIMITS.lineBytes) {
    throw new CloudHistoryError('云历史记录超过单行上限，不能并成一个无界文档');
  }
  return line;
}

export function decodeCloudHistoryLine(line: string): CloudHistoryRecord {
  if (byteLength(line) > CLOUD_HISTORY_LIMITS.lineBytes) {
    throw new CloudHistoryError('云历史记录超过单行上限');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new CloudHistoryError('云历史记录不是一行 JSON');
  }
  const parsed = CloudHistoryRecordSchema.safeParse(raw);
  if (!parsed.success) throw new CloudHistoryError('云历史记录的契约无法识别，陌生版本拒绝写入');
  return parsed.data;
}

/** 逐行访问。迭代器只在访客取下一行时前进。 */
export function scanCloudHistoryLines(lines: Iterable<string>, visit: (record: CloudHistoryRecord) => void): void {
  for (const line of lines) visit(decodeCloudHistoryLine(line));
}

export interface CloudHistoryDocument {
  workspace: CloudWorkspaceEnvelope;
  segments: CloudEventSegment[];
  manifests: CloudAdoptionManifest[];
  bases: CloudGenerationBasis[];
  revisions: CloudContentRevision[];
}

export function readCloudHistory(lines: Iterable<string>): CloudHistoryDocument {
  let workspace: CloudWorkspaceEnvelope | null = null;
  const document: CloudHistoryDocument = { workspace: undefined as never, segments: [], manifests: [], bases: [], revisions: [] };
  scanCloudHistoryLines(lines, (record) => {
    if (!workspace && record.contract !== 'endless-cloud-workspace/1') {
      throw new CloudHistoryError('云历史的第一行必须是工作区信封');
    }
    if (record.contract === 'endless-cloud-workspace/1') {
      if (workspace) throw new CloudHistoryError('一份云历史只能有一个工作区信封');
      workspace = record;
      document.workspace = record;
    } else if (record.contract === 'cloud-event-segment/1') document.segments.push(record);
    else if (record.contract === 'cloud-adoption-manifest/1') document.manifests.push(record);
    else if (record.contract === 'cloud-generation-basis/1') document.bases.push(record);
    else document.revisions.push(record);
  });
  if (!workspace) throw new CloudHistoryError('云历史缺少工作区信封');
  assertCloudHistory(document);
  const basisIds = new Set(document.bases.map((basis) => basis.basisId));
  for (const revision of document.revisions) {
    if (!basisIds.has(revision.basisId)) throw new CloudHistoryError('云修订引用了不存在的生成依据');
    if (revision.plannedAt !== document.bases.find((basis) => basis.basisId === revision.basisId)!.plannedAt) {
      throw new CloudHistoryError('云修订的计划时间必须与生成依据一致');
    }
  }
  return document;
}
