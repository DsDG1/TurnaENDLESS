/**
 * 独立备份/导出容器（设计文档 §13.6）。
 *
 * - 不复用旧 `.endless.json`（那套格式与导入器保持原样，不迁移、不解释）。
 * - 逐行 JSON、有界记录，天然可流式读写；不引入 ZIP、不接受路径、不做任意文件写入。
 * - manifest 声明对象数、类型、总解码字节、逐对象摘要、根与事件截止点。
 * - 导入先隔离：未知信任根即使哈希全对也进 quarantine；同 ID 同摘要去重；同 ID 不同摘要是冲突。
 */
import { z } from 'zod';
import {
  EditionRefSchema,
  EditionRunSchema,
  ReviewRevisionSchema,
  assertRun,
  reviewDigest,
  IssueReleaseSchema,
  DigestSchema,
  type EditionRun,
  type EditorialRevision,
  type Edition,
  type IssueRelease,
  type ReviewRevision,
  type UnitRevision,
} from './contract.js';
import { canonicalJson, digestOf } from './digest.js';
import type { CorpusRevision, RightsDecision } from './sources.js';
import type { LanguagePackRevision } from './language.js';
import { publicationIssues, type EditionPublicationPackage } from './release.js';
import { eventPrefixHash } from './run.js';

export const CONTAINER_FORMATS = ['edition-publication/1', 'edition-project/1', 'edition-backup/1'] as const;
export type ContainerFormat = (typeof CONTAINER_FORMATS)[number];

export const CONTAINER_LIMITS = {
  version: 'edition-container-3',
  maxRecordBytes: 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxRecords: 20_000,
  maxDepth: 24,
} as const;

export type RecordType =
  | 'edition' | 'editorial' | 'corpus' | 'rights' | 'pack' | 'release' | 'unit'
  | 'install' | 'run' | 'review' | 'management';

export interface ContainerRecord {
  type: RecordType;
  id: string;
  digest: string;
  body: unknown;
}

export const ReaderManagementSchema = z.object({
  id: z.string().regex(/^mge_[a-zA-Z0-9_:.-]{1,196}$/),
  at: z.string().datetime(),
  op: z.enum(['install', 'supersede', 'run', 'review', 'export', 'import']),
  targets: z.array(z.string().min(1).max(80)).max(80),
  detail: z.string().max(1000),
}).strict();
export type ReaderManagement = z.infer<typeof ReaderManagementSchema>;

export const ReaderSnapshotSchema = z.object({
  repositoryRevision: z.number().int().nonnegative().nullable(),
  runs: z.array(z.object({
    runId: EditionRefSchema,
    eventCount: z.number().int().nonnegative(),
    eventHash: DigestSchema,
    runDigest: DigestSchema,
  }).strict()).max(CONTAINER_LIMITS.maxRecords),
}).strict();
export type ReaderSnapshot = z.infer<typeof ReaderSnapshotSchema>;

export interface ContainerManifest {
  format: ContainerFormat;
  schemaVersion: 1;
  containerVersion: string;
  createdAt: string;
  /** 信任根：本机生成的包是 `local`；外部包需要显式信任。 */
  trustRoot: string;
  records: number;
  bytes: number;
  digest: string;
  objects: { type: RecordType; id: string; digest: string }[];
  /** 个人学习事件的固定前缀：恢复时只接受这个截止点。 */
  cutoff: { eventCount: number; eventHash: string } | null;
  /** v3 records every Run cutoff; the legacy single cutoff is never reinterpreted. */
  readerSnapshot?: ReaderSnapshot;
}

export interface Container {
  manifest: ContainerManifest;
  records: ContainerRecord[];
}

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
const recordTypes: readonly string[] = [
  'edition', 'editorial', 'corpus', 'rights', 'pack', 'release', 'unit',
  'install', 'run', 'review', 'management',
];

function validRecordId(record: ContainerRecord): boolean {
  return record.type === 'management'
    ? ReaderManagementSchema.shape.id.safeParse(record.id).success
    : EditionRefSchema.safeParse(record.id).success;
}

function checkDepth(value: unknown, depth = 0): void {
  if (depth > CONTAINER_LIMITS.maxDepth) throw new Error('导出/导入容器嵌套过深');
  if (Array.isArray(value)) { for (const item of value) checkDepth(item, depth + 1); return; }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) checkDepth(item, depth + 1);
  }
}

export function buildContainer(format: ContainerFormat, records: readonly ContainerRecord[], options: {
  trustRoot?: string; createdAt?: string; cutoff?: ContainerManifest['cutoff']; readerSnapshot?: ReaderSnapshot;
} = {}): Container {
  if (records.length > CONTAINER_LIMITS.maxRecords) throw new Error('容器记录数超过上限');
  const normalized = records.map((record) => {
    const body = record.body;
    checkDepth(body);
    const serialized = canonicalJson(body);
    if (byteLength(serialized) > CONTAINER_LIMITS.maxRecordBytes) {
      throw new Error(`记录 ${record.id} 超过单条上限；请分包导出，不要截断`);
    }
    if (!validRecordId(record)) throw new Error(`记录 ID 不合法：${record.id}`);
    const digest = digestOf(body);
    if (record.digest && record.digest !== digest) throw new Error(`记录 ${record.id} 的摘要与实际内容不一致`);
    return { type: record.type, id: record.id, digest, body };
  });
  const objects = normalized.map((record) => ({ type: record.type, id: record.id, digest: record.digest }));
  const manifest: ContainerManifest = {
    format,
    schemaVersion: 1,
    containerVersion: CONTAINER_LIMITS.version,
    createdAt: options.createdAt ?? new Date().toISOString(),
    trustRoot: options.trustRoot ?? 'local',
    records: normalized.length,
    bytes: normalized.reduce((sum, record) => sum + byteLength(canonicalJson(record.body)), 0),
    digest: digestOf(normalized),
    objects,
    cutoff: options.cutoff ?? null,
    ...(format === 'edition-backup/1' ? {
      readerSnapshot: options.readerSnapshot ?? {
        repositoryRevision: null,
        runs: normalized.filter((record) => record.type === 'run').map((record) => {
          const run = readerRunRecord(record);
          return { runId: run.id, eventCount: run.events.length, eventHash: eventPrefixHash(run), runDigest: record.digest };
        }),
      },
    } : {}),
  };
  if (manifest.bytes > CONTAINER_LIMITS.maxTotalBytes) throw new Error('导出体积超过容器上限；请分包导出，不要截断');
  return { manifest, records: normalized };
}

function readerRunRecord(record: ContainerRecord): EditionRun {
  return assertRun(EditionRunSchema.parse(record.body));
}

/** 逐行 JSON：第一行 manifest，其后每行一个对象。 */
export function serializeContainer(container: Container): string {
  const text = [canonicalJson(container.manifest), ...container.records.map((record) => canonicalJson(record))].join('\n');
  if (byteLength(text) > CONTAINER_LIMITS.maxTotalBytes) throw new Error('容器超过解码体积上限');
  return text;
}

export function parseContainer(text: string): Container {
  if (byteLength(text) > CONTAINER_LIMITS.maxTotalBytes) throw new Error('容器超过解码体积上限');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) throw new Error('容器为空');
  const manifest = JSON.parse(lines[0]!) as ContainerManifest;
  checkDepth(manifest);
  if (!(CONTAINER_FORMATS as readonly string[]).includes(manifest.format)) {
    throw new Error(`不支持的容器格式：${String(manifest.format)}；原始文件未被修改`);
  }
  if (manifest.schemaVersion !== 1) throw new Error('不支持的容器 schema 版本；原始文件未被修改');
  if (![CONTAINER_LIMITS.version, 'edition-container-2', 'edition-container-1'].includes(manifest.containerVersion)) {
    throw new Error('不支持的容器版本；原始文件未被修改');
  }
  if (!Number.isInteger(manifest.records) || manifest.records < 0 || manifest.records > CONTAINER_LIMITS.maxRecords ||
      !Number.isInteger(manifest.bytes) || manifest.bytes < 0 || manifest.bytes > CONTAINER_LIMITS.maxTotalBytes ||
      typeof manifest.trustRoot !== 'string' || !manifest.trustRoot ||
      !Array.isArray(manifest.objects) || manifest.objects.length !== manifest.records) {
    throw new Error('容器 manifest 的数量、体积或信任字段无效');
  }
  if (lines.length - 1 !== manifest.records) throw new Error('容器记录数与 manifest 不一致');
  const records: ContainerRecord[] = [];
  for (const line of lines.slice(1)) {
    const record = JSON.parse(line) as ContainerRecord;
    checkDepth(record);
    if (!record || !recordTypes.includes(record.type) || !validRecordId(record) ||
        !/^sha256:[a-f0-9]{64}$/.test(record.digest)) throw new Error('容器记录类型或标识无效');
    if (byteLength(canonicalJson(record.body)) > CONTAINER_LIMITS.maxRecordBytes) throw new Error('单条记录超过上限');
    if (record.digest !== digestOf(record.body)) throw new Error('容器对象摘要不匹配');
    records.push(record);
  }
  // v1 counted UTF-16 code units; retain that interpretation while enforcing byte limits.
  const declaredSize = (body: unknown) => manifest.containerVersion === 'edition-container-1'
    ? canonicalJson(body).length : byteLength(canonicalJson(body));
  if (manifest.bytes !== records.reduce((sum, record) => sum + declaredSize(record.body), 0) ||
      canonicalJson(manifest.objects) !== canonicalJson(records.map(({ type, id, digest }) => ({ type, id, digest })))) {
    throw new Error('容器清单或体积与实际记录不一致');
  }
  if (digestOf(records) !== manifest.digest) throw new Error('容器摘要不匹配，可能被截断或篡改');
  if (manifest.readerSnapshot !== undefined) {
    if (manifest.containerVersion !== CONTAINER_LIMITS.version) throw new Error('旧容器不能声明新版本阅读截止规则');
    const snapshot = ReaderSnapshotSchema.parse(manifest.readerSnapshot);
    const runs = records.filter((record) => record.type === 'run');
    if (new Set(snapshot.runs.map((run) => run.runId)).size !== snapshot.runs.length || snapshot.runs.length !== runs.length) {
      throw new Error('阅读截止清单不完整或 Run 重复');
    }
    for (const record of runs) {
      const run = assertRun(EditionRunSchema.parse(record.body));
      const cutoff = snapshot.runs.find((entry) => entry.runId === record.id);
      if (!cutoff || run.id !== record.id || cutoff.runDigest !== record.digest ||
          cutoff.eventCount !== run.events.length || cutoff.eventHash !== eventPrefixHash(run)) {
        throw new Error('Run 的事件截止点与备份清单不一致');
      }
    }
  } else if (manifest.containerVersion === CONTAINER_LIMITS.version && manifest.format === 'edition-backup/1' &&
      records.some((record) => ['install', 'run', 'review', 'management'].includes(record.type))) {
    throw new Error('阅读备份缺少完整的事件截止清单');
  }
  return { manifest, records };
}

export interface ImportPolicy {
  /** 允许的信任根；默认只信任本机生成的包。 */
  trustedRoots?: readonly string[];
  /** 已存在的对象（id → digest），用于去重。 */
  existing?: ReadonlyMap<string, string>;
  /** 允许的容器类型。 */
  accept?: readonly ContainerFormat[];
}

export interface ImportResult {
  accepted: ContainerRecord[];
  skipped: ContainerRecord[];
  conflicts: { id: string; existing: string; incoming: string }[];
  quarantined: boolean;
  issues: { code: string; message: string }[];
}

/**
 * 导入验证：格式 → 引用闭包 → 去重/冲突 → 信任门禁。
 * 任一致命问题都不激活任何对象，原库不变。
 */
export function importContainer(text: string, policy: ImportPolicy = {}): ImportResult {
  const issues: { code: string; message: string }[] = [];
  let container: Container;
  try {
    container = parseContainer(text);
  } catch (error) {
    return { accepted: [], skipped: [], conflicts: [], quarantined: false, issues: [{ code: 'E-IMPORT-FORMAT', message: (error as Error).message }] };
  }
  const trusted = policy.trustedRoots ?? ['local'];
  if (!trusted.includes(container.manifest.trustRoot)) {
    return {
      accepted: [], skipped: [], conflicts: [], quarantined: true,
      issues: [{
        code: 'E-IMPORT-TRUST',
        message: `来自未信任来源（${container.manifest.trustRoot}）的包已隔离：即使哈希全部正确，也需要本地信任或授权审阅后才能导入`,
      }],
    };
  }
  if (policy.accept && !policy.accept.includes(container.manifest.format)) {
    return { accepted: [], skipped: [], conflicts: [], quarantined: false, issues: [{ code: 'E-IMPORT-KIND', message: `当前操作不接受 ${container.manifest.format}` }] };
  }
  // 去重键是 `type:id`：install 与 release 合法共用 rel_ ID，跨类型同 ID 不算冲突；
  // 同类型同 ID 不同摘要才是真正的同 ID 异文。
  const objectKey = (type: RecordType, id: string) => `${type}:${id}`;
  const objects = new Map<string, ContainerRecord>();
  for (const record of container.records) {
    const key = objectKey(record.type, record.id);
    const previous = objects.get(key);
    if (previous && previous.digest !== record.digest) {
      issues.push({ code: 'E-IMPORT-CONFLICT', message: `对象 ${record.id} 在包内出现同 ID 异文` });
    }
    objects.set(key, record);
  }
  const referenced = (id: string, types: readonly RecordType[]) => {
    for (const type of types) {
      const record = objects.get(objectKey(type, id));
      if (record) return record;
    }
    return undefined;
  };
  for (const record of container.records) {
    try {
      const bodyId = record.type === 'install'
        ? (record.body as EditionPublicationPackage).release.id : (record.body as { id: string }).id;
      if (bodyId !== record.id) throw new Error('记录标识与正文标识不一致');
      if (record.type === 'release') {
        const release = IssueReleaseSchema.parse(record.body);
        for (const unitId of release.orderedUnitRevisionIds) {
          if (!referenced(unitId, ['unit'])) issues.push({ code: 'E-IMPORT-CLOSURE', message: `发行 ${release.id} 缺少单元修订 ${unitId}` });
        }
      }
      if (record.type === 'install') {
        const pkg = record.body as EditionPublicationPackage;
        for (const problem of publicationIssues(pkg)) {
          issues.push({ code: problem.code, message: `安装包 ${pkg.release.id}：${problem.message}` });
        }
      }
      if (record.type === 'run') {
        const run = assertRun(EditionRunSchema.parse(record.body));
        for (const adopted of run.adoptedReleases) {
          const dependency = referenced(adopted.releaseId, ['release', 'install']);
          if (!dependency) {
            issues.push({ code: 'E-IMPORT-CLOSURE', message: `Run ${run.id} 引用了缺失的发行 ${adopted.releaseId}` });
          } else {
            const release = IssueReleaseSchema.parse(dependency.type === 'install'
              ? (dependency.body as EditionPublicationPackage).release : dependency.body);
            if (release.editionId !== run.editionId || release.issueId !== adopted.issueId || release.cefr !== adopted.cefr) {
              throw new Error('采用清单与发行归属不一致');
            }
          }
        }
        for (const event of run.events) {
          if (event.unitId.startsWith('review:') && !referenced(event.revisionId, ['review'])) {
            issues.push({ code: 'E-IMPORT-CLOSURE', message: `Run ${run.id} 缺少复习修订 ${event.revisionId}` });
          }
        }
      }
      if (record.type === 'review') {
        const review = ReviewRevisionSchema.parse(record.body);
        if (review.digest !== reviewDigest(review)) throw new Error('复习修订摘要不一致');
        if (!referenced(review.runId, ['run'])) issues.push({ code: 'E-IMPORT-CLOSURE', message: `复习 ${review.id} 引用了缺失的 Run ${review.runId}` });
      }
      if (record.type === 'management') {
        ReaderManagementSchema.parse(record.body);
      }
    } catch {
      issues.push({ code: 'E-IMPORT-CONTRACT', message: `对象 ${record.id} 不符合内容或事件契约` });
    }
  }
  if (issues.length) return { accepted: [], skipped: [], conflicts: [], quarantined: false, issues };

  // `policy.existing` 的键同样是 `type:id`（与记录去重键一致）。
  const seen = new Map<string, string>();
  const accepted: ContainerRecord[] = [];
  const skipped: ContainerRecord[] = [];
  const conflicts: { id: string; existing: string; incoming: string }[] = [];
  for (const record of container.records) {
    const key = `${record.type}:${record.id}`;
    const existing = policy.existing?.get(key) ?? seen.get(key);
    if (existing) {
      if (existing === record.digest) skipped.push(record);
      else conflicts.push({ id: record.id, existing, incoming: record.digest });
      continue;
    }
    seen.set(key, record.digest);
    accepted.push(record);
  }
  if (conflicts.length) {
    return {
      accepted: [], skipped, conflicts, quarantined: false,
      issues: [{ code: 'E-IMPORT-CONFLICT', message: `${conflicts.length} 个对象与本地同 ID 但内容不同；不采用「最后覆盖」，请人工确认` }],
    };
  }
  return { accepted, skipped, conflicts, quarantined: false, issues };
}

/** 出版包：正式内容与重编译闭包，不含个人学习事件或未批准草稿。 */
export function buildPublicationContainer(input: {
  edition: Edition;
  editorial: EditorialRevision;
  corpus: CorpusRevision;
  rights: readonly RightsDecision[];
  pack: LanguagePackRevision;
  releases: readonly IssueRelease[];
  units: readonly UnitRevision[];
}): Container {
  const records: ContainerRecord[] = [
    { type: 'edition', id: input.edition.id, digest: '', body: input.edition },
    { type: 'editorial', id: input.editorial.id, digest: '', body: input.editorial },
    { type: 'corpus', id: input.corpus.id, digest: '', body: input.corpus },
    { type: 'pack', id: input.pack.id, digest: '', body: input.pack },
    ...input.rights.map((right): ContainerRecord => ({ type: 'rights', id: right.id, digest: '', body: right })),
    ...input.releases.map((release): ContainerRecord => ({ type: 'release', id: release.id, digest: '', body: release })),
    ...input.units.map((unit): ContainerRecord => ({ type: 'unit', id: unit.id, digest: '', body: unit })),
  ];
  return buildContainer('edition-publication/1', records);
}

/**
 * 阅读备份：安装内容、Run、事件、复习与管理记录（需要必要闭包）。
 *
 * 浏览器端没有编纂库，因此编辑修订、语料与权利记录**可缺省**：缺省就是
 * 「本备份不包含编纂依据」，绝不伪造一份看起来像真的编辑修订。
 */
export function buildBackupContainer(input: {
  edition?: Edition | null;
  editorial?: EditorialRevision | null;
  corpus?: CorpusRevision | null;
  rights?: readonly RightsDecision[];
  pack?: LanguagePackRevision | null;
  /** 浏览器已安装的出版包：自足，阅读器不持有完整 UnitRevision。 */
  installs?: readonly EditionPublicationPackage[];
  releases?: readonly IssueRelease[];
  units?: readonly UnitRevision[];
  runs: readonly EditionRun[];
  reviews: readonly ReviewRevision[];
  cutoff: { eventCount: number; eventHash: string } | null;
  management?: readonly ReaderManagement[];
  repositoryRevision?: number;
  createdAt?: string;
}): Container {
  const records: ContainerRecord[] = [
    ...(input.pack ? [{ type: 'pack' as const, id: input.pack.id, digest: '', body: input.pack }] : []),
    ...(input.edition ? [{ type: 'edition' as const, id: input.edition.id, digest: '', body: input.edition }] : []),
    ...(input.editorial ? [{ type: 'editorial' as const, id: input.editorial.id, digest: '', body: input.editorial }] : []),
    ...(input.corpus ? [{ type: 'corpus' as const, id: input.corpus.id, digest: '', body: input.corpus }] : []),
    ...(input.rights ?? []).map((right): ContainerRecord => ({ type: 'rights', id: right.id, digest: '', body: right })),
    ...(input.installs ?? []).map((pkg): ContainerRecord => ({ type: 'install', id: pkg.release.id, digest: '', body: pkg })),
    ...(input.releases ?? []).map((release): ContainerRecord => ({ type: 'release', id: release.id, digest: '', body: release })),
    ...(input.units ?? []).map((unit): ContainerRecord => ({ type: 'unit', id: unit.id, digest: '', body: unit })),
    ...input.runs.map((value): ContainerRecord => {
      const run = assertRun(EditionRunSchema.parse(value));
      return { type: 'run', id: run.id, digest: '', body: run };
    }),
    ...input.reviews.map((review): ContainerRecord => ({ type: 'review', id: review.id, digest: '', body: review })),
    ...(input.management ?? []).map((value): ContainerRecord => {
      const row = ReaderManagementSchema.parse(value);
      return { type: 'management', id: row.id, digest: '', body: row };
    }),
  ];
  return buildContainer('edition-backup/1', records, {
    cutoff: input.cutoff, createdAt: input.createdAt,
    readerSnapshot: {
      repositoryRevision: input.repositoryRevision ?? null,
      runs: records.filter((record) => record.type === 'run').map((record) => {
        const run = record.body as EditionRun;
        return { runId: run.id, eventCount: run.events.length, eventHash: eventPrefixHash(run), runDigest: digestOf(run) };
      }),
    },
  });
}
