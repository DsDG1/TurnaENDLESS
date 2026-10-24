/**
 * 新应用统一契约（`endless-workspace`）。
 *
 * 项目没有旧用户，因此这是应用层唯一的存档格式：不做旧格式解析分支、不做迁移、
 * 不做双写。实验管线（`apps/lab`）与它的冻结产物继续保持独立，不经过本文件。
 *
 * 分层（见 ENDLESS-实施文档 §3）：
 *   本地档案 → 内容条目 → 内容修订 → 进度分支 → 玩法/管理事件 → 归档卷 → 检查点 → 生成任务
 *
 * 本文件只放「数据层」：格式标识、对象 schema、跨对象不变量。
 * 状态迁移与命令在 `workspace.ts`；修订流水线在 `revision.ts`；回收站在 `lifecycle.ts`。
 */
import { z } from 'zod';
import { Batch, contentHash, stableStringify } from '@endless/esl';
import { SessionSchema, type PlayerEvent } from '@endless/player';
import { creativeKinds, creativeSeries, type CreativeSeriesId } from './creative-policy.js';

// ---------- 1. 格式标识 ----------

export const WORKSPACE_FORMAT = 'endless-workspace' as const;
/** 新格式的版本号；与旧 `version: 1/2` 存档没有关系，读到旧数据必须明确报格式不支持。 */
export const WORKSPACE_SCHEMA_VERSION = 1 as const;
/** 应用层唯一现行生成契约；旧 1–3 只服务实验与历史测试，应用不接受它们。 */
export const APPLICATION_CONTRACT = 'endless-draft-v1' as const;
/** 检查点投影算法标识：算法变化必须让旧检查点失效，不能静默沿用。 */
export const PROJECTOR_VERSION = 'player-projection-1' as const;

export const idPrefix = {
  workspace: 'wrk',
  profile: 'prof',
  content: 'ent',
  revision: 'rev',
  branch: 'brn',
  management: 'mge',
  volume: 'vol',
  checkpoint: 'ckp',
  ticket: 'tkt',
} as const;

export type IdPrefix = keyof typeof idPrefix;

/** 稳定本地 ID：`<prefix>_<uuid>`。可读前缀只为排错，不承担语义。 */
export function newId(prefix: IdPrefix, uuid: () => string = () => globalThis.crypto.randomUUID()): string {
  return `${idPrefix[prefix]}_${uuid()}`;
}

const idSchema = (prefix: IdPrefix) => z.string().regex(new RegExp(`^${idPrefix[prefix]}_[0-9a-f-]{36}$`), `不是合法的 ${prefix} ID`);
const hashSchema = z.string().regex(/^[a-f0-9]{16}$/);

export const ContentIdSchema = idSchema('content');
export const RevisionIdSchema = idSchema('revision');
export const BranchIdSchema = idSchema('branch');
export const VolumeIdSchema = idSchema('volume');
export const CheckpointIdSchema = idSchema('checkpoint');
export const TicketIdSchema = idSchema('ticket');
export const ManagementIdSchema = idSchema('management');

// ---------- 2. 身份与档案 ----------

export const WorkspaceIdentitySchema = z.object({
  format: z.literal(WORKSPACE_FORMAT),
  schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
  workspaceId: z.string().min(1),
  profileId: z.string().min(1),
  /** 仓库修订号：每次原子提交 +1，用于多标签页 CAS 冲突检测。 */
  repositoryRevision: z.number().int().nonnegative(),
});
export type WorkspaceIdentity = z.infer<typeof WorkspaceIdentitySchema>;

/** 本地档案：稳定的本地归属标识。不等于已登录账号，`boundAccountId` 只能为 null（不做账号体系）。 */
export const LocalProfileSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  label: z.string().min(1).max(60).optional(),
  boundAccountId: z.literal(null),
});
export type LocalProfile = z.infer<typeof LocalProfileSchema>;

// ---------- 3. 生成文档与创作绑定（应用契约 v4） ----------

const CreationSourceSchema = z.object({
  sceneId: z.string().min(1),
  item: z.string().min(1),
  field: z.enum(['gloss', 'example', 'prior']),
  reference: z.string().min(1),
  text: z.string().min(1),
  hash: hashSchema,
});
export type CreationSource = z.infer<typeof CreationSourceSchema>;

export const DraftCreationSchema = z.object({
  protocol: z.literal('endless-draft-v1'),
  draft: z.string().min(1),
  kind: z.enum(creativeKinds),
  series: z.enum(Object.keys(creativeSeries) as [CreativeSeriesId, ...CreativeSeriesId[]]),
  sources: z.array(CreationSourceSchema).max(40),
});
export type DraftCreation = z.infer<typeof DraftCreationSchema>;

export const GeneratedEpisodeSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  basedOn: z.object({ eventCount: z.number().int().nonnegative(), hash: hashSchema }),
  title: z.string().min(1).max(100),
  subtitle: z.string().min(1).max(160),
  description: z.string().min(1).max(400),
  batch: Batch,
  hash: hashSchema,
  /** v2 = 学习任务契约；v3 = v2 + 程序练习卡；v4 = ENDLESS-DRAFT/1 创作草稿契约（带 creation 绑定） */
  learningVersion: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
  /** v4 必填：创作绑定（协议、原文草稿、形态/系列、取材来源记录） */
  creation: DraftCreationSchema.optional(),
  /**
   * 简单计量：input/output token 与真实调用次数。
   * `calls` 不设上限——修复循环允许超过 3 次，把上限写死会让「第 4 次修复成功」的结果无法保存。
   * 这不是每日额度或消费预算；账本能力另有独立端口且默认关闭。
   */
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    calls: z.number().int().min(1),
  }).optional(),
}).superRefine((doc, ctx) => {
  if (doc.learningVersion === 4 && !doc.creation) {
    ctx.addIssue({ code: 'custom', path: ['creation'], message: 'learningVersion 4 必须携带 creation 绑定' });
  }
  if (doc.creation && doc.learningVersion !== 4) {
    ctx.addIssue({ code: 'custom', path: ['creation'], message: 'creation 只允许出现在 learningVersion 4' });
  }
});
export type GeneratedEpisode = z.infer<typeof GeneratedEpisodeSchema>;

// ---------- 4. 内容条目与修订 ----------

export const ContentSourceKindSchema = z.enum(['generated', 'bundled']);
export type ContentSourceKind = z.infer<typeof ContentSourceKindSchema>;

/** 展示信息可编辑，永远不参与正文校验；改名不改变修订 hash。 */
export const ContentDisplaySchema = z.object({
  title: z.string().min(1).max(100),
  subtitle: z.string().min(1).max(160),
  description: z.string().min(1).max(400),
  tags: z.array(z.string().min(1).max(24)).max(12),
  note: z.string().max(500),
});
export type ContentDisplay = z.infer<typeof ContentDisplaySchema>;

export const ContentEntrySchema = z.object({
  id: ContentIdSchema,
  sourceKind: ContentSourceKindSchema,
  series: z.string().min(1),
  kind: z.string().min(1),
  label: z.string().min(1).max(60),
  display: ContentDisplaySchema,
  /** 生命周期：归档位置是独立维度，归档 ≠ 删除。 */
  lifecycle: z.enum(['active', 'trashed']),
  trashedAt: z.string().datetime().nullable(),
  /** 所属归档卷；null = 未归档（活跃区或回收站）。 */
  archiveVolumeId: VolumeIdSchema.nullable(),
  revisionIds: z.array(RevisionIdSchema).min(1),
  headRevisionId: RevisionIdSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ContentEntry = z.infer<typeof ContentEntrySchema>;

export const RevisionOriginSchema = z.enum(['generated', 'edited']);
export type RevisionOrigin = z.infer<typeof RevisionOriginSchema>;

/** 修订验收结论：保留错误码以便界面定位，不保存提示词或供应商原始响应。 */
export const RevisionValidationSchema = z.object({
  ok: z.boolean(),
  issues: z.array(z.object({
    code: z.string().min(1).max(64),
    level: z.enum(['error', 'warning']),
    scene: z.string().max(64).optional(),
    message: z.string().max(400),
  })).max(80),
});
export type RevisionValidation = z.infer<typeof RevisionValidationSchema>;

/**
 * 生成依据：绑定「这次生成看到的是什么」。展示名称、界面字号、归档布局不改变依据；
 * 真正影响学习或剧情的操作必须改变依据。
 */
export const GenerationBasisSchema = z.object({
  contract: z.literal(APPLICATION_CONTRACT),
  catalogVersion: z.string().min(1),
  branchId: BranchIdSchema,
  adopted: z.array(z.object({ contentId: ContentIdSchema, revisionId: RevisionIdSchema })).max(500),
  eventCount: z.number().int().nonnegative(),
  eventHash: hashSchema,
  /** 仍有阅读义务的内容：生成计划必须读到它们，归档不能绕过。 */
  obligations: z.array(ContentIdSchema).max(500),
  /** 学习计划时间：复现学习任务用它，`authoredAt` 只记录实际编辑时间。 */
  plannedAt: z.string().datetime(),
});
export type GenerationBasis = z.infer<typeof GenerationBasisSchema>;

export const ContentRevisionSchema = z.object({
  id: RevisionIdSchema,
  contentId: ContentIdSchema,
  parentRevisionId: RevisionIdSchema.nullable(),
  /** 该内容内递增序号，1 起；用于稳定比较与展示，不参与 ID。 */
  ordinal: z.number().int().min(1),
  origin: RevisionOriginSchema,
  /** 运行时 episode id（batch.batch）；编辑沿用同一逻辑内容的 episode 引用。 */
  episodeId: z.string().min(1),
  /** 不可变正文：草稿文本与它编译出的执行批次一起保存，恢复时重新编译并比较。 */
  draft: z.string().min(1),
  batch: Batch,
  hash: hashSchema,
  title: z.string().min(1).max(100),
  subtitle: z.string().min(1).max(160),
  description: z.string().min(1).max(400),
  creation: DraftCreationSchema,
  learningVersion: z.literal(4),
  basis: GenerationBasisSchema,
  plannedAt: z.string().datetime(),
  authoredAt: z.string().datetime(),
  validation: RevisionValidationSchema,
});
export type ContentRevision = z.infer<typeof ContentRevisionSchema>;

/**
 * 捆绑内容的唯一修订：正文是应用自带的注册批次，只有 catalogId 与完整性校验，
 * 不经过生成校验、不参与修订编辑；归档/进度把它当普通内容对待。
 */
export const BundledRevisionSchema = z.object({
  id: RevisionIdSchema,
  contentId: ContentIdSchema,
  parentRevisionId: z.null(),
  ordinal: z.literal(1),
  origin: z.literal('bundled'),
  episodeId: z.string().min(1),
  catalogId: z.string().min(1),
  hash: hashSchema,
  title: z.string().min(1).max(100),
  subtitle: z.string().min(1).max(160),
  description: z.string().min(1).max(400),
});
export type BundledRevision = z.infer<typeof BundledRevisionSchema>;

export const AnyRevisionSchema = z.union([ContentRevisionSchema, BundledRevisionSchema]);
export type AnyRevision = z.infer<typeof AnyRevisionSchema>;

// ---------- 5. 分支与事件 ----------

/**
 * 玩法事件：引用具体修订。
 * `PlayerEvent` 已经带 episode/scene/at；这里补上内容与修订引用，避免正文变化后
 * 重新解释旧选项（场景 ID 在每个修订内复用 s1、s2，只有带修订 ID 才无歧义）。
 */
export const StampedPlayerEventSchema = z.intersection(
  z.object({
    contentId: ContentIdSchema.optional(),
    revisionId: RevisionIdSchema.optional(),
  }),
  z.custom<PlayerEvent>((value) => value != null && typeof value === 'object'),
);
export type StampedPlayerEvent = z.infer<typeof StampedPlayerEventSchema>;

/**
 * 分支会话必须用 stamped 事件：否则 Zod 会把 contentId/revisionId 剥掉，
 * 备份往返之后事件就丢失了「这条玩法属于哪个修订」的绑定。
 */
export const StampedSessionSchema = SessionSchema.extend({ events: z.array(StampedPlayerEventSchema) });

export const BranchSchema = z.object({
  id: BranchIdSchema,
  label: z.string().min(1).max(60),
  parentBranchId: BranchIdSchema.nullable(),
  /** 分叉点：父分支中「目标内容开始之前」的事件数；null = 根分支。 */
  forkAtEventCount: z.number().int().nonnegative().nullable(),
  /** 该分支采用的内容修订（内容 ID → 修订 ID）。一个分支对每个内容只采用一个修订。 */
  adopted: z.array(z.object({ contentId: ContentIdSchema, revisionId: RevisionIdSchema })).max(500),
  /** 分支的玩法会话：有序事件、当前内容、界面偏好。 */
  session: StampedSessionSchema,
  createdAt: z.string().datetime(),
});
export type Branch = z.infer<typeof BranchSchema>;

export const ManagementOpSchema = z.enum([
  'rename', 'tags', 'note', 'trash', 'restore', 'adopt-revision',
  'archive', 'unarchive', 'waive-obligation', 'create-obligation', 'purge', 'branch',
]);
export type ManagementOp = z.infer<typeof ManagementOpSchema>;

/** 管理事件：不是学习事件。禁止用伪造 answer/advance/skip 实现管理操作。 */
export const ManagementEventSchema = z.object({
  id: ManagementIdSchema,
  sequence: z.number().int().nonnegative(),
  at: z.string().datetime(),
  op: ManagementOpSchema,
  branchId: BranchIdSchema.nullable(),
  targets: z.array(z.string().min(1).max(80)).max(500),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});
export type ManagementEvent = z.infer<typeof ManagementEventSchema>;

/** 阅读义务：只有明确的管理操作可以撤销；删除卡片不等于撤销义务。 */
export const ReadingObligationSchema = z.object({
  contentId: ContentIdSchema,
  revisionId: RevisionIdSchema,
  createdAt: z.string().datetime(),
  waivedAt: z.string().datetime().nullable(),
});
export type ReadingObligation = z.infer<typeof ReadingObligationSchema>;

// ---------- 6. 归档卷 ----------

export const ArchiveQuoteSchema = z.object({
  revisionId: RevisionIdSchema,
  contentId: ContentIdSchema,
  sceneId: z.string().min(1).max(64),
  /** 原文字段定位，如 `panels[0].bubbles[1].text`；练习取材要能回到这一处。 */
  path: z.string().min(1).max(160),
  text: z.string().min(1).max(600),
});
export type ArchiveQuote = z.infer<typeof ArchiveQuoteSchema>;

export const ArchiveVolumeSchema = z.object({
  id: VolumeIdSchema,
  title: z.string().min(1).max(100),
  series: z.string().min(1),
  createdAt: z.string().datetime(),
  /** 成员按播放顺序排列；引用修订，不复制正文。 */
  members: z.array(z.object({
    contentId: ContentIdSchema,
    revisionId: RevisionIdSchema,
    order: z.number().int().nonnegative(),
  })).min(1).max(500),
  /** 摘要派生自哪个分支的哪个事件前缀。 */
  derivedFrom: z.object({
    branchId: BranchIdSchema,
    eventCount: z.number().int().nonnegative(),
    eventHash: hashSchema,
  }),
  reading: z.array(z.object({
    contentId: ContentIdSchema,
    status: z.enum(['read', 'skipped', 'unread']),
  })).max(500),
  /** 结构化事实与真实选择；合并多卷从这里重建，避免摘要套摘要漂移。 */
  facts: z.array(z.object({ subject: z.string().min(1), predicate: z.string().min(1), object: z.string().min(1) })).max(200),
  choices: z.array(z.object({
    contentId: ContentIdSchema, sceneId: z.string().min(1), chosen: z.string().min(1),
  })).max(500),
  threads: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), status: z.string().min(1) })).max(200),
  narrative: z.string().min(1).max(2000),
  quotes: z.array(ArchiveQuoteSchema).max(200),
  strategy: z.object({
    kind: z.literal('programmatic'),
    version: z.number().int().min(1),
    /** 相关阅读状态或修订变化后摘要过期，必须从原始状态重建。 */
    stale: z.boolean(),
  }),
  checkpointId: CheckpointIdSchema.nullable(),
});
export type ArchiveVolume = z.infer<typeof ArchiveVolumeSchema>;

// ---------- 7. 状态检查点 ----------

/**
 * 检查点记录：覆盖影响后续重放的全部状态。
 * `state` 的结构由 `@endless/player` 的检查点 schema 负责；这里只保存前缀绑定与投影版本，
 * 校验时必须能被完整重放复算出来，客户端送来的检查点不能直接当证明。
 */
export const ProjectionCheckpointSchema = z.object({
  id: CheckpointIdSchema,
  branchId: BranchIdSchema,
  eventPrefix: z.object({ count: z.number().int().nonnegative(), hash: hashSchema }),
  projectorVersion: z.literal(PROJECTOR_VERSION),
  state: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
  /** 本机 API 首次使用时会重放验证；verified=false 的检查点只能加速本地、不能作为对外证明。 */
  verified: z.boolean(),
});
export type ProjectionCheckpoint = z.infer<typeof ProjectionCheckpointSchema>;

// ---------- 8. 生成任务 ----------

export const GenerationTicketSchema = z.object({
  id: TicketIdSchema,
  branchId: BranchIdSchema,
  basis: GenerationBasisSchema,
  status: z.enum(['reserved', 'submitted', 'succeeded', 'failed', 'cancelled']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** 成功时指向结果内容；历史不匹配时保留结果但不写入分支。 */
  resultContentId: ContentIdSchema.nullable(),
  failureCategory: z.string().min(1).max(40).nullable(),
});
export type GenerationTicket = z.infer<typeof GenerationTicketSchema>;

// ---------- 9. 工作区快照 ----------

export const WorkspaceSchema = z.object({
  identity: WorkspaceIdentitySchema,
  profile: LocalProfileSchema,
  entries: z.array(ContentEntrySchema).max(2000),
  revisions: z.array(AnyRevisionSchema).max(4000),
  branches: z.array(BranchSchema).max(64),
  activeBranchId: BranchIdSchema,
  obligations: z.array(ReadingObligationSchema).max(2000),
  volumes: z.array(ArchiveVolumeSchema).max(500),
  checkpoints: z.array(ProjectionCheckpointSchema).max(64),
  tickets: z.array(GenerationTicketSchema).max(200),
  management: z.array(ManagementEventSchema).max(4000),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const WorkspaceSnapshotSchema = z.object({
  identity: WorkspaceIdentitySchema,
  data: WorkspaceSchema,
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

export class ContractError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ContractError';
  }
}

const fail = (code: string, message: string): never => {
  throw new ContractError(message, code);
};

/**
 * 跨对象不变量。所有写入口（生成接收、修订采用、导入、恢复）都必须走这里，
 * 保证「生成、编辑、保存和恢复共享一致的校验规则」。
 *
 * 只做结构一致性；内容正确性（词汇/素材/来源/学习证据）由 `index.ts` 的编译验收负责。
 */
export function assertWorkspace(data: Workspace): Workspace {
  const sections: [string, { id: string }[]][] = [
    ['entries', data.entries],
    ['revisions', data.revisions],
    ['branches', data.branches],
    ['volumes', data.volumes],
    ['checkpoints', data.checkpoints],
    ['tickets', data.tickets],
    ['management', data.management],
  ];
  for (const [name, rows] of sections) {
    const ids = new Set<string>();
    for (const row of rows) {
      if (ids.has(row.id)) fail('E-CONTRACT-DUPLICATE', `${name} 中出现重复 ID`);
      ids.add(row.id);
    }
  }

  const revisions = new Map(data.revisions.map((revision) => [revision.id, revision]));
  const contents = new Map(data.entries.map((entry) => [entry.id, entry]));
  const branches = new Map(data.branches.map((branch) => [branch.id, branch]));
  if (!branches.has(data.activeBranchId)) fail('E-CONTRACT-BRANCH', '当前分支不存在');
  if (data.identity.profileId !== data.profile.id) fail('E-CONTRACT-PROFILE', '档案 ID 与身份不一致');

  for (const entry of data.entries) {
    if (!entry.revisionIds.includes(entry.headRevisionId)) fail('E-CONTRACT-REVISION', `${entry.id} 的当前修订不在修订清单内`);
    let previous = 0;
    for (const id of entry.revisionIds) {
      const revision = revisions.get(id);
      if (!revision) { fail('E-CONTRACT-REVISION', `${entry.id} 引用了不存在的修订`); continue; }
      if (revision.contentId !== entry.id) fail('E-CONTRACT-REVISION', `修订 ${id} 不属于内容 ${entry.id}`);
      if (revision.ordinal <= previous) fail('E-CONTRACT-REVISION', `${entry.id} 的修订序号必须递增`);
      previous = revision.ordinal;
      if (entry.sourceKind === 'bundled' && revision.origin !== 'bundled') {
        fail('E-CONTRACT-REVISION', '捆绑内容只能引用捆绑修订');
      }
      if (entry.sourceKind === 'generated' && revision.origin === 'bundled') {
        fail('E-CONTRACT-REVISION', '生成内容不能引用捆绑修订');
      }
      if (entry.sourceKind === 'generated' && revision.origin !== 'bundled' && revision.learningVersion !== 4) {
        fail('E-CONTRACT-REVISION', '应用契约只接受 learningVersion 4 的修订');
      }
    }
    const head = revisions.get(entry.headRevisionId)!;
    if (head.origin === 'generated' && head.parentRevisionId !== null) {
      fail('E-CONTRACT-REVISION', '生成的修订不能有父修订');
    }
    if (head.contentId !== entry.id) fail('E-CONTRACT-REVISION', '当前修订不属于该内容');
  }

  for (const revision of data.revisions) {
    const parent = revision.parentRevisionId ? revisions.get(revision.parentRevisionId) : null;
    if (revision.parentRevisionId && !parent) fail('E-CONTRACT-REVISION', '父修订不存在');
    if (parent && (parent.contentId !== revision.contentId || parent.ordinal >= revision.ordinal)) {
      fail('E-CONTRACT-REVISION', '父修订必须属于同一内容且序号更早');
    }
    if (!parent && revision.ordinal !== 1) fail('E-CONTRACT-REVISION', '首个修订的序号必须为 1');
    if (!contents.has(revision.contentId)) fail('E-CONTRACT-REVISION', '修订引用了不存在的内容');
    // 每条修订都必须被它所属内容的 revisionIds 收录：否则会出现谁都不认领的孤儿修订，
    // 后续编辑仍按旧的 head 编译，分叉分支上采纳的修订永远看不到。
    if (!contents.get(revision.contentId)?.revisionIds.includes(revision.id)) {
      fail('E-CONTRACT-REVISION', '修订未被其内容收录');
    }
    if (revision.origin !== 'bundled' && !branches.has(revision.basis.branchId)) {
      fail('E-CONTRACT-BASIS', '修订的生成依据引用了不存在的分支');
    }
  }

  for (const branch of data.branches) {
    const seen = new Set<string>();
    for (const adopted of branch.adopted) {
      if (!contents.has(adopted.contentId)) fail('E-CONTRACT-ADOPTED', '分支采用了不存在的内容');
      const revision = revisions.get(adopted.revisionId);
      if (!revision || revision.contentId !== adopted.contentId) fail('E-CONTRACT-ADOPTED', '分支采用的修订不属于该内容');
      if (seen.has(adopted.contentId)) fail('E-CONTRACT-ADOPTED', '同一分支不能采用同一内容的两个修订');
      seen.add(adopted.contentId);
    }
    if (branch.parentBranchId) {
      const parent = branches.get(branch.parentBranchId);
      if (!parent) { fail('E-CONTRACT-BRANCH', '父分支不存在'); continue; }
      if (branch.forkAtEventCount === null) fail('E-CONTRACT-BRANCH', '子分支必须记录分叉点');
      if (branch.forkAtEventCount! > parent.session.events.length) fail('E-CONTRACT-BRANCH', '分叉点超出父分支历史');
      // 分叉点之前必须逐字节等于父分支：否则导入的分支可以声称血缘却带不同历史
      const boundary = branch.forkAtEventCount!;
      if (stableStringify(branch.session.events.slice(0, boundary)) !== stableStringify(parent.session.events.slice(0, boundary))) {
        fail('E-CONTRACT-BRANCH', '子分支的历史前缀与父分支不一致');
      }
      if (branch.session.catalog !== parent.session.catalog) {
        fail('E-CONTRACT-BRANCH', '子分支的内容目录与父分支不一致');
      }
    } else if (branch.forkAtEventCount !== null) {
      fail('E-CONTRACT-BRANCH', '根分支不能有分叉点');
    }
    for (const event of branch.session.events) {
      const episode = event.episode;
      const owner = branch.adopted.some((adopted) => revisions.get(adopted.revisionId)?.episodeId === episode);
      if (!owner && !branch.adopted.some((adopted) => adopted.contentId === episode)) {
        fail('E-CONTRACT-EVENT', `事件引用了分支未采用的内容 ${episode}`);
      }
    }
  }

  for (const volume of data.volumes) {
    if (!branchExists(volume.derivedFrom.branchId, branches)) fail('E-CONTRACT-VOLUME', '归档卷派生自不存在的分支');
    for (const member of volume.members) {
      const revision = revisions.get(member.revisionId);
      if (!revision || revision.contentId !== member.contentId) fail('E-CONTRACT-VOLUME', '归档卷成员引用了不匹配的修订');
      const entry = contents.get(member.contentId);
      if (!entry) fail('E-CONTRACT-VOLUME', '归档卷成员引用了不存在的内容');
      // 活跃内容与卷成员必须双向一致；已回收的内容会被清空 archiveVolumeId，允许单向
      if (entry!.lifecycle === 'active' && entry!.archiveVolumeId !== volume.id) {
        fail('E-CONTRACT-VOLUME', '活跃内容与归档卷成员不一致');
      }
    }
    if (new Set(volume.members.map((member) => member.revisionId)).size !== volume.members.length) {
      fail('E-CONTRACT-VOLUME', '同一归档卷不能重复收录同一修订');
    }
    if (new Set(volume.members.map((member) => member.contentId)).size !== volume.members.length) {
      fail('E-CONTRACT-VOLUME', '同一归档卷不能重复收录同一内容');
    }
    if (volume.checkpointId && !data.checkpoints.some((checkpoint) => checkpoint.id === volume.checkpointId)) {
      fail('E-CONTRACT-VOLUME', '归档卷引用了不存在的检查点');
    }
  }

  for (const entry of data.entries) {
    if (entry.archiveVolumeId && !data.volumes.some((volume) => volume.id === entry.archiveVolumeId)) {
      fail('E-CONTRACT-ARCHIVE', '内容引用了不存在的归档卷');
    }
  }

  for (const checkpoint of data.checkpoints) {
    const branch = branches.get(checkpoint.branchId);
    if (!branch) fail('E-CONTRACT-CHECKPOINT', '检查点引用了不存在的分支');
    const owner = branch!;
    if (checkpoint.eventPrefix.count > owner.session.events.length) {
      fail('E-CONTRACT-CHECKPOINT', '检查点前缀超出分支历史');
    }
    const expected = contentHash({
      catalog: owner.session.catalog,
      events: owner.session.events.slice(0, checkpoint.eventPrefix.count),
    });
    if (checkpoint.eventPrefix.hash !== expected) {
      fail('E-CONTRACT-CHECKPOINT', '检查点前缀哈希与分支历史不一致');
    }
  }
  for (const ticket of data.tickets) {
    const branch = branches.get(ticket.branchId);
    if (!branch) fail('E-CONTRACT-TICKET', '生成任务引用了不存在的分支');
    if (ticket.basis.branchId !== ticket.branchId) fail('E-CONTRACT-TICKET', '生成任务的依据与分支不一致');
    // 进行中的任务必须能按其依据重新取出同样的库；已结束的任务不做闭包要求
    // （purgeContent 之后历史票据的 adopted 会指向已删内容，这是允许的）
    if (ticket.status === 'reserved' || ticket.status === 'submitted') {
      for (const adopted of ticket.basis.adopted) {
        const revision = revisions.get(adopted.revisionId);
        if (!revision || revision.contentId !== adopted.contentId) {
          fail('E-CONTRACT-TICKET', '进行中任务的依据引用了不匹配的修订');
        }
        if (!branch!.adopted.some((entry) => entry.revisionId === adopted.revisionId && entry.contentId === adopted.contentId)) {
          fail('E-CONTRACT-TICKET', '进行中任务的依据与分支采用清单不一致');
        }
      }
      for (const contentId of ticket.basis.obligations) {
        if (!contents.has(contentId)) fail('E-CONTRACT-TICKET', '进行中任务的依据引用了不存在的内容');
      }
    }
  }
  for (const obligation of data.obligations) {
    if (!contents.has(obligation.contentId)) fail('E-CONTRACT-OBLIGATION', '阅读义务引用了不存在的内容');
    const revision = revisions.get(obligation.revisionId);
    if (!revision || revision.contentId !== obligation.contentId) {
      fail('E-CONTRACT-OBLIGATION', '阅读义务的修订不属于该内容');
    }
  }
  for (const event of data.management) {
    if (event.branchId && !branches.has(event.branchId)) fail('E-CONTRACT-MANAGEMENT', '管理事件引用了不存在的分支');
  }
  return data;
}

function branchExists(id: string, branches: Map<string, Branch>) {
  return branches.has(id);
}

/** 解析并校验工作区：任何入口都先过这里，失败必须保留原始数据而不是静默初始化。 */
export function parseWorkspace(raw: unknown): Workspace {
  const parsed = WorkspaceSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail('E-CONTRACT-FORMAT', `本地存档不是 endless-workspace/v${WORKSPACE_SCHEMA_VERSION} 格式或结构不完整${issue ? `（${issue.path.join('.')}：${issue.message}）` : ''}`);
  }
  return assertWorkspace(parsed.data!);
}

/** 识别旧格式（或任意非本契约数据）：明确报不支持，不迁移、不覆盖。 */
export function describeUnsupportedSave(raw: unknown): string {
  if (raw == null) return '没有找到本地存档';
  if (typeof raw === 'object' && raw !== null && (raw as { format?: unknown }).format !== WORKSPACE_FORMAT) {
    return `本地存档不是 ${WORKSPACE_FORMAT}/v${WORKSPACE_SCHEMA_VERSION} 格式；项目不做旧格式迁移，原始数据已保留`;
  }
  return '本地存档无法识别，原始数据已保留，可先下载备份';
}

/**
 * 秘密护栏：临时 provider Key 不得进入任何持久化对象、导出或任务记录。
 * 调用方在真正写盘/导出前必须执行；这里只做保守的子串扫描。
 */
export function assertNoSecrets(value: unknown, secrets: readonly string[]): void {
  const present = secrets.filter((secret) => secret.trim().length >= 8);
  if (!present.length) return;
  const serialized = JSON.stringify(value);
  for (const secret of present) {
    if (serialized.includes(secret)) fail('E-SECRET-LEAK', '待保存数据包含临时 Key，已拒绝写入；不会保存或回显密钥');
  }
}

export const contracts = {
  format: WORKSPACE_FORMAT,
  schemaVersion: WORKSPACE_SCHEMA_VERSION,
  applicationContract: APPLICATION_CONTRACT,
  projectorVersion: PROJECTOR_VERSION,
} as const;
