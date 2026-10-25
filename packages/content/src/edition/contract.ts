/**
 * Edition 数据契约（设计文档 §6、§7）。版本、ID、跨对象不变量都在这里。
 *
 * 与 ENDLESS 的关系：Edition 是独立契约 `edition-draft-v1`，不是 `learningVersion: 4`。
 * 旧修订、旧事件、旧备份的解释一律不受本文件影响；本文件也不被旧验收器接受。
 */
import { z } from 'zod';
import { Batch } from '@endless/esl';
import { digestOf, DIGEST_PATTERN } from './digest.js';

export const EDITION_FORMAT = 'endless-edition' as const;
export const EDITION_SCHEMA_VERSION = 1 as const;
export const EDITION_CONTRACT = 'edition-draft-v1' as const;
export const EDITION_DRAFT_HEADER = 'EDITION-DRAFT/1' as const;
export const EDITION_DRAFT_PROTOCOL = 'edition-draft-v1' as const;
export const EDITION_LEARNING_POLICY = 'S-B' as const;
/**
 * 编译器/学习策略版本分派（bugfix §2.0）：
 * - `edition-compiler-1` 只服务于已冻结的修订、复习依据与安装包的复核；
 * - `edition-compiler-2` 起修正：@fact 词义不进叙述原句池、uses 只统计叙述单元、
 *   同场景曝光去重、find 干扰项确定性抽样。
 * 新内容一律走当前版本；旧版本仅用于按原语义重放既有冻结数据。
 */
export const EDITION_COMPILER_VERSION_V1 = 'edition-compiler-1' as const;
export const EDITION_COMPILER_VERSION = 'edition-compiler-2' as const;
export const EDITION_COMPILER_VERSIONS: readonly string[] = [
  EDITION_COMPILER_VERSION_V1, EDITION_COMPILER_VERSION,
];
export const EDITION_POLICY_VERSION_V1 = `${EDITION_LEARNING_POLICY}/${EDITION_COMPILER_VERSION_V1}` as const;
export const EDITION_POLICY_VERSION = `${EDITION_LEARNING_POLICY}/${EDITION_COMPILER_VERSION}` as const;
export const EDITION_POLICY_VERSIONS: readonly string[] = [
  EDITION_POLICY_VERSION_V1, EDITION_POLICY_VERSION,
];
export const EDITION_VALIDATION_POLICY_VERSION = 'edition-validation-1' as const;
export const EDITION_REVIEW_CONSTRUCTOR_VERSION = 'edition-review-1' as const;
export const EDITION_SCENE_POLICY_VERSION = 'edition-scene-policy-1' as const;
export const MATERIAL_CATALOG_VERSION = 'material-catalog-1' as const;
export const EDITION_PROMPT_VERSION = 'edition-prompt-1' as const;

/**
 * 首版只开放一个经过验证的等级。类型上预留六档，界面/计划只允许 `OPEN_CEFR_LEVELS`。
 * 逐档开放，而不是一次点亮六档。
 */
export const CefrSchema = z.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
export type Cefr = z.infer<typeof CefrSchema>;
export const OPEN_CEFR_LEVELS: readonly Cefr[] = ['A2', 'B1'];
export const CEFR_RANK: Record<Cefr, number> = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };

// ---------- 6.1 ID 与摘要 ----------

export const editionIdKinds = [
  'edn', 'edr', 'iss', 'unt', 'ulv', 'lpk', 'urv', 'rel', 'run', 'rvr',
  'evt', 'job', 'src', 'snp', 'spn', 'clm', 'psg', 'crp', 'rdc', 'rvi',
] as const;
export type EditionIdKind = (typeof editionIdKinds)[number];
export type EditionId = `${EditionIdKind}_${string}`;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const EditionRefSchema = z.string().regex(new RegExp(`^(${editionIdKinds.join('|')})_${UUID}$`), '不是合法的 Edition 对象 ID');
export const DigestSchema = z.string().regex(DIGEST_PATTERN);

export function newEditionId(kind: EditionIdKind, uuid: () => string = () => globalThis.crypto.randomUUID()): EditionId {
  return `${kind}_${uuid()}`;
}

export function isEditionId(value: string, kind?: EditionIdKind): boolean {
  if (!EditionRefSchema.safeParse(value).success) return false;
  return kind ? value.startsWith(`${kind}_`) : true;
}

// ---------- 7.1 编辑计划 ----------

export const EditionSpecSchema = z.object({
  topic: z.string().min(1).max(120),
  angles: z.array(z.string().min(1).max(120)).max(8),
  exclusions: z.array(z.string().min(1).max(120)).max(8),
  audience: z.string().min(1).max(120),
  cefr: CefrSchema,
  /** 目标配置，不是无限填充的理由。 */
  targetIssues: z.number().int().min(1).max(40),
  unitsPerIssue: z.number().int().min(1).max(20),
  minutesPerIssue: z.number().int().min(5).max(180),
  preferences: z.array(z.enum(['documentary', 'dialogue', 'story', 'interactive'])).max(4),
  sourcePolicy: z.enum(['local-pack-only', 'network-research']),
  networkAuthorized: z.boolean(),
});
export type EditionSpec = z.infer<typeof EditionSpecSchema>;

export const UnitRoleSchema = z.enum(['introduce', 'explore', 'apply', 'recap']);
export type UnitRole = z.infer<typeof UnitRoleSchema>;

export const UnitPlanSchema = z.object({
  id: EditionRefSchema,
  order: z.number().int().min(1).max(20),
  title: z.string().min(1).max(120),
  role: UnitRoleSchema,
  /** 概念目标（跨等级相对稳定），不是“用户此前不认识”的断言。 */
  goals: z.array(z.string().min(1).max(160)).max(6),
  conceptRefs: z.array(z.string().min(1).max(80)).max(8),
  dependencyIds: z.array(EditionRefSchema).max(6),
  claimRefs: z.array(EditionRefSchema).max(12),
  estimatedMinutes: z.number().min(1).max(40),
});
export type UnitPlan = z.infer<typeof UnitPlanSchema>;

export const IssuePlanSchema = z.object({
  id: EditionRefSchema,
  order: z.number().int().min(1).max(40),
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(400),
  unitIds: z.array(EditionRefSchema).min(1).max(20),
  targetMinutes: z.number().int().min(5).max(180),
  conceptScope: z.array(z.string().min(1).max(80)).max(12),
});
export type IssuePlan = z.infer<typeof IssuePlanSchema>;

export const CoverageEntrySchema = z.object({
  concept: z.string().min(1).max(80),
  issueId: EditionRefSchema,
  unitId: EditionRefSchema,
  angle: z.string().min(1).max(120),
});
export type CoverageEntry = z.infer<typeof CoverageEntrySchema>;

export const EditorialRevisionSchema = z.object({
  id: EditionRefSchema,
  editionId: EditionRefSchema,
  parentId: EditionRefSchema.nullable(),
  revision: z.number().int().min(1),
  spec: EditionSpecSchema,
  corpusRevisionId: EditionRefSchema,
  issues: z.array(IssuePlanSchema).min(1).max(40),
  units: z.array(UnitPlanSchema).min(1).max(800),
  coverage: z.array(CoverageEntrySchema).max(2000),
  status: z.enum(['draft', 'approved', 'superseded']),
  /** 资料不足时不是“再生成一次”，而是缩小范围或补资料。 */
  capacity: z.object({
    state: z.enum(['sufficient', 'needs_sources']),
    supportedIssues: z.number().int().nonnegative(),
    requestedIssues: z.number().int().nonnegative(),
    gaps: z.array(z.string().max(200)).max(40),
    suggestions: z.array(z.string().max(200)).max(12),
  }),
  approvedBy: z.string().max(80).nullable(),
  approvedAt: z.string().datetime().nullable(),
  digest: DigestSchema,
  createdAt: z.string().datetime(),
});
export type EditorialRevision = z.infer<typeof EditorialRevisionSchema>;

export const EditionSchema = z.object({
  id: EditionRefSchema,
  title: z.string().min(1).max(120),
  subtitle: z.string().min(1).max(160),
  description: z.string().min(1).max(600),
  /** 改展示名不修改正文：head 只决定“下一期从哪份编辑修订继续”。 */
  headEditorialRevisionId: EditionRefSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Edition = z.infer<typeof EditionSchema>;

/** 编辑修订摘要：只覆盖编辑内容，展示名与状态不参与。 */
export function editorialDigest(revision: Omit<EditorialRevision, 'digest'>): string {
  return digestOf({
    editionId: revision.editionId, revision: revision.revision, parentId: revision.parentId,
    spec: revision.spec, corpusRevisionId: revision.corpusRevisionId,
    issues: revision.issues, units: revision.units, coverage: revision.coverage,
    capacity: revision.capacity,
  });
}

export interface EditorialIssue { code: string; message: string }

function cycles(nodes: readonly { id: string; dependencyIds: readonly string[] }[]): string[][] {
  const out: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visit = (id: string): void => {
    const status = state.get(id) ?? 0;
    if (status === 2) return;
    if (status === 1) {
      const at = stack.indexOf(id);
      out.push(stack.slice(at >= 0 ? at : 0).concat(id));
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const dep of byId.get(id)?.dependencyIds ?? []) if (byId.has(dep)) visit(dep);
    stack.pop();
    state.set(id, 2);
  };
  for (const node of nodes) visit(node.id);
  return out;
}

/**
 * 有限目录不变量：期/单元顺序唯一、单元归属唯一、依赖无环且不指向未来期、
 * 数量与 spec 一致、覆盖矩阵引用真实单元。
 */
export function editorialPlanIssues(revision: EditorialRevision): EditorialIssue[] {
  const issues: EditorialIssue[] = [];
  const push = (code: string, message: string) => issues.push({ code, message });
  if (revision.issues.length !== revision.spec.targetIssues) {
    push('E-PLAN-SIZE', `期数为 ${revision.issues.length}，与声明的 ${revision.spec.targetIssues} 不一致`);
  }
  const issueOrders = new Set<number>();
  const issueIds = new Set<string>();
  const unitIds = new Set<string>();
  const unitOwner = new Map<string, string>();
  let totalUnits = 0;
  for (const issue of revision.issues) {
    if (issueOrders.has(issue.order)) push('E-PLAN-ORDER', `期顺序重复：${issue.order}`);
    issueOrders.add(issue.order);
    if (issueIds.has(issue.id)) push('E-PLAN-DUP', `期 ID 重复：${issue.id}`);
    issueIds.add(issue.id);
    if (issue.unitIds.length !== revision.spec.unitsPerIssue) {
      push('E-PLAN-UNITS', `${issue.id} 单元数为 ${issue.unitIds.length}，与声明的 ${revision.spec.unitsPerIssue} 不一致`);
    }
    totalUnits += issue.unitIds.length;
    for (const unitId of issue.unitIds) {
      if (unitOwner.has(unitId)) push('E-PLAN-DUP', `单元 ${unitId} 同时出现在两期`);
      unitOwner.set(unitId, issue.id);
      if (unitIds.has(unitId)) push('E-PLAN-DUP', `单元 ID 重复：${unitId}`);
      unitIds.add(unitId);
    }
  }
  for (let order = 1; order <= revision.issues.length; order++) {
    if (!issueOrders.has(order)) push('E-PLAN-ORDER', `期顺序缺失：${order}`);
  }
  const units = new Map(revision.units.map((unit) => [unit.id, unit]));
  for (const unitId of unitIds) if (!units.has(unitId)) push('E-PLAN-MISSING', `目录引用了不存在的单元 ${unitId}`);
  for (const unit of revision.units) {
    if (!unitOwner.has(unit.id)) push('E-PLAN-ORPHAN', `单元 ${unit.id} 不属于任何一期`);
    const issue = revision.issues.find((entry) => entry.id === unitOwner.get(unit.id));
    if (issue && unit.order > issue.unitIds.length) push('E-PLAN-ORDER', `${unit.id} 的单元顺序超出该期容量`);
    for (const dep of unit.dependencyIds) {
      if (!units.has(dep)) { push('E-PLAN-DEP', `单元 ${unit.id} 依赖不存在的 ${dep}`); continue; }
      // 前置必须位于同期更早位置或更早期，不能依赖未来内容
      const depIssue = issueOwner(revision, dep);
      if (depIssue && issue && depIssue.order > issue.order) {
        push('E-PLAN-DEP', `单元 ${unit.id} 依赖了未来期的 ${dep}`);
      }
      if (dep === unit.id) push('E-PLAN-DEP', `单元 ${unit.id} 不能依赖自己`);
    }
    if (unit.role === 'recap' && unit.dependencyIds.length === 0) {
      // 回顾单元必须真的有前置，否则只是空标题
      push('E-PLAN-RECAP', `回顾单元 ${unit.id} 缺少前置`);
    }
  }
  for (const cycle of cycles(revision.units)) push('E-PLAN-CYCLE', `单元依赖成环：${cycle.join(' → ')}`);
  for (const entry of revision.coverage) {
    if (!unitIds.has(entry.unitId)) push('E-COVERAGE-UNIT', `覆盖矩阵引用了不存在的单元 ${entry.unitId}`);
    if (!issueIds.has(entry.issueId)) push('E-COVERAGE-ISSUE', `覆盖矩阵引用了不存在的期 ${entry.issueId}`);
  }
  const uncovered = revision.issues.filter((issue) =>
    !revision.coverage.some((entry) => entry.issueId === issue.id));
  for (const issue of uncovered) push('E-COVERAGE-EMPTY', `期 ${issue.id} 没有任何覆盖条目`);
  if (totalUnits !== revision.units.length) {
    push('E-PLAN-COUNT', `目录单元总数为 ${totalUnits}，实际列出 ${revision.units.length}`);
  }
  return issues;
}

function issueOwner(revision: EditorialRevision, unitId: string): IssuePlan | undefined {
  return revision.issues.find((issue) => issue.unitIds.includes(unitId));
}

export function assertEditorialRevision(revision: EditorialRevision): EditorialRevision {
  const issues = editorialPlanIssues(revision);
  if (issues.length) throw new Error(issues.map((issue) => `${issue.code}：${issue.message}`).join('；'));
  if (revision.digest !== editorialDigest(revision)) throw new Error('E-PLAN-DIGEST：编辑修订摘要不匹配，目录或资料已被改动');
  return revision;
}

/** 审批必须绑定当前 digest：被审对象变化后旧 approve 自动失效。 */
export interface Approval { targetId: string; digest: string; reviewer: string; approvedAt: string }

export function assertApproval(approval: Approval | null, targetId: string, digest: string): void {
  if (!approval) throw new Error('E-APPROVAL-MISSING：缺少审阅批准，不能发布');
  if (approval.targetId !== targetId) throw new Error('E-APPROVAL-TARGET：批准属于其他对象');
  if (approval.digest !== digest) throw new Error('E-APPROVAL-STALE：对象已变化，原批准失效，需要重新审阅');
}

// ---------- 6.3 生成依据 ----------

export const EditionGenerationBasisSchema = z.object({
  contract: z.literal(EDITION_CONTRACT),
  editionId: EditionRefSchema,
  editorialRevisionId: EditionRefSchema,
  corpusRevisionId: EditionRefSchema,
  issuePlanId: EditionRefSchema,
  unitPlanId: EditionRefSchema,
  unitLevelPlanId: EditionRefSchema,
  cefr: CefrSchema,
  passageRevisionIds: z.array(EditionRefSchema).min(1).max(8),
  languagePackRevisionId: EditionRefSchema,
  materialCatalogVersion: z.string().min(1).max(60),
  promptVersion: z.string().min(1).max(60),
  compilerVersion: z.string().min(1).max(60),
  validationPolicyVersion: z.string().min(1).max(60),
  basisDigest: DigestSchema,
});
export type EditionGenerationBasis = z.infer<typeof EditionGenerationBasisSchema>;

export function basisDigest(basis: Omit<EditionGenerationBasis, 'basisDigest'>): string {
  return digestOf(basis);
}

export const UnitLevelPlanSchema = z.object({
  id: EditionRefSchema,
  unitId: EditionRefSchema,
  cefr: CefrSchema,
  passageRefs: z.array(EditionRefSchema).min(1).max(8),
  /** 本单元首次教学目标：0–3 个，称 teachTargets，不声称“用户此前不认识”。 */
  targetRefs: z.array(EditionRefSchema).max(3),
  contextBudget: z.object({
    readingScenes: z.number().int().min(1).max(8),
    practiceScenes: z.number().int().min(0).max(8),
    maxWords: z.number().int().min(20).max(1200),
  }),
  allowedExtra: z.array(z.object({
    form: z.string().min(1).max(40),
    reason: z.string().min(1).max(160),
  })).max(12),
  status: z.enum(['draft', 'approved']),
});
export type UnitLevelPlan = z.infer<typeof UnitLevelPlanSchema>;

export const TeachTargetSchema = z.object({
  /** 稳定 sense ID：词块/句型不能只按词面字符串去重。 */
  item: z.string().regex(/^(lx:[^#\s]+#[\w-]+(\.[\w-]+)?|ck:[a-z0-9-]+|pt:[a-z0-9-]+)$/),
  kind: z.enum(['sense', 'chunk', 'pattern']),
  forms: z.array(z.string().min(1)).min(1).max(6),
  glossZh: z.string().min(1).max(120),
  example: z.string().max(400).nullable(),
  cefr: CefrSchema,
  sourceRef: z.string().min(1).max(200),
});
export type TeachTarget = z.infer<typeof TeachTargetSchema>;

// ---------- 9.3 编译产物与 creation ----------

export const EditionComponentKindSchema = z.enum([
  'reading', 'comic', 'chat', 'post', 'quiz', 'card', 'fact', 'example', 'choice',
]);
export type EditionComponentKind = z.infer<typeof EditionComponentKindSchema>;

export const EditionSourceBindingSchema = z.object({
  sceneId: z.string().min(1).max(64),
  field: z.enum(['passage', 'gloss', 'example', 'prior']),
  reference: z.string().min(1).max(160),
  text: z.string().min(1).max(600),
  hash: DigestSchema,
});
export type EditionSourceBinding = z.infer<typeof EditionSourceBindingSchema>;

export const EditionCreationSchema = z.object({
  protocol: z.literal(EDITION_DRAFT_PROTOCOL),
  draft: z.string().min(1),
  unitId: EditionRefSchema,
  compilerVersion: z.string().min(1).max(60),
  passageBindings: z.array(z.object({
    sceneId: z.string().min(1).max(64),
    passageRevisionId: EditionRefSchema,
    segmentIndex: z.number().int().nonnegative(),
  })).max(32),
  sources: z.array(EditionSourceBindingSchema).max(80),
  sceneSources: z.record(z.string(), z.string().max(200)),
});
export type EditionCreation = z.infer<typeof EditionCreationSchema>;

export const UnitRevisionSchema = z.object({
  id: EditionRefSchema,
  unitId: EditionRefSchema,
  parentRevisionId: EditionRefSchema.nullable(),
  ordinal: z.number().int().min(1),
  origin: z.enum(['generated', 'edited', 'imported']),
  contract: z.literal(EDITION_CONTRACT),
  cefr: CefrSchema,
  title: z.string().min(1).max(120),
  subtitle: z.string().min(1).max(160),
  description: z.string().min(1).max(500),
  draft: z.string().min(1),
  batch: Batch,
  creation: EditionCreationSchema,
  basis: EditionGenerationBasisSchema,
  reports: z.object({
    validation: z.object({
      ok: z.boolean(),
      issues: z.array(z.object({
        code: z.string().min(1).max(64),
        level: z.enum(['error', 'warning']),
        scene: z.string().max(64).optional(),
        message: z.string().max(400),
      })).max(120),
    }),
    teaching: z.object({
      contexts: z.array(z.object({ item: z.string(), scenes: z.array(z.string()).max(8), distinct: z.number().int().min(0).max(8) })).max(6),
      practiceItems: z.array(z.string()).max(6),
      estimatedMinutes: z.number().min(0).max(120),
    }),
  }),
  status: z.enum(['draft', 'validated', 'rejected']),
  digest: DigestSchema,
  createdAt: z.string().datetime(),
  authoredAt: z.string().datetime(),
});
export type UnitRevision = z.infer<typeof UnitRevisionSchema>;

export function unitRevisionDigest(revision: Omit<UnitRevision, 'digest'>): string {
  return digestOf({
    unitId: revision.unitId, parentRevisionId: revision.parentRevisionId, ordinal: revision.ordinal,
    contract: revision.contract, cefr: revision.cefr,
    title: revision.title, subtitle: revision.subtitle, description: revision.description,
    draft: revision.draft, batch: revision.batch, creation: revision.creation, basis: revision.basis,
  });
}

// ---------- 6.2 发行 ----------

export const ReleaseManifestSchema = z.object({
  contract: z.literal('edition-publication/1'),
  editionId: EditionRefSchema,
  issueId: EditionRefSchema,
  cefr: CefrSchema,
  languagePackRevisionId: EditionRefSchema,
  units: z.array(z.object({
    unitRevisionId: EditionRefSchema,
    unitId: EditionRefSchema,
    order: z.number().int().min(1),
    title: z.string().min(1).max(120),
    batchDigest: DigestSchema,
    scenes: z.number().int().min(1),
    estimatedMinutes: z.number().min(0).max(60),
  })).min(1).max(20),
  materials: z.object({
    characters: z.array(z.string().min(1).max(40)).max(12),
    backgrounds: z.array(z.string().min(1).max(40)).max(12),
    props: z.array(z.string().min(1).max(40)).max(24),
  }),
  sourceAcks: z.array(z.object({
    sourceId: EditionRefSchema,
    title: z.string().min(1).max(300),
    license: z.string().min(1).max(60),
    licenseUrl: z.string().url().nullable(),
    canonicalUrl: z.string().url(),
  })).max(40),
  counts: z.object({
    units: z.number().int().min(1), scenes: z.number().int().min(1), words: z.number().int().nonnegative(),
  }),
  digest: DigestSchema,
});
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

export const IssueReleaseSchema = z.object({
  id: EditionRefSchema,
  editionId: EditionRefSchema,
  issueId: EditionRefSchema,
  cefr: CefrSchema,
  editorialRevisionId: EditionRefSchema,
  corpusRevisionId: EditionRefSchema,
  orderedUnitRevisionIds: z.array(EditionRefSchema).min(1).max(20),
  manifest: ReleaseManifestSchema,
  /** 正文不可变；状态与取代关系是发布元数据，另行记录。 */
  status: z.enum(['published', 'superseded', 'withdrawn']),
  supersedes: EditionRefSchema.nullable(),
  supersededBy: EditionRefSchema.nullable(),
  publishedAt: z.string().datetime(),
  publishedBy: z.string().min(1).max(80),
  digest: DigestSchema,
});
export type IssueRelease = z.infer<typeof IssueReleaseSchema>;

export function releaseDigest(release: Omit<IssueRelease, 'id' | 'digest' | 'status' | 'supersedes' | 'supersededBy'>): string {
  return digestOf({
    editionId: release.editionId, issueId: release.issueId, cefr: release.cefr,
    editorialRevisionId: release.editorialRevisionId, corpusRevisionId: release.corpusRevisionId,
    orderedUnitRevisionIds: release.orderedUnitRevisionIds, manifest: release.manifest,
  });
}

export function assertReleaseManifest(release: IssueRelease): void {
  IssueReleaseSchema.parse(release);
  const manifest = release.manifest;
  if (release.digest !== releaseDigest(release)) throw new Error('E-RELEASE-DIGEST：发行摘要在发布后被改动');
  if (manifest.digest !== digestOf({
    units: manifest.units, sourceAcks: manifest.sourceAcks, materials: manifest.materials,
    counts: manifest.counts, editionId: manifest.editionId, issueId: manifest.issueId,
    cefr: manifest.cefr, languagePackRevisionId: manifest.languagePackRevisionId,
  })) throw new Error('E-RELEASE-MANIFEST：发行清单摘要不匹配');
  if (manifest.editionId !== release.editionId || manifest.issueId !== release.issueId || manifest.cefr !== release.cefr) {
    throw new Error('E-RELEASE-BASIS：发行清单归属或等级不一致');
  }
  if (release.orderedUnitRevisionIds.length !== manifest.units.length) {
    throw new Error('E-RELEASE-UNITS：单元清单与 manifest 数量不一致');
  }
  if (new Set(release.orderedUnitRevisionIds).size !== manifest.units.length ||
      new Set(manifest.units.map((unit) => unit.unitId)).size !== manifest.units.length ||
      manifest.units.some((unit, index) => unit.unitRevisionId !== release.orderedUnitRevisionIds[index] || unit.order !== index + 1)) {
    throw new Error('E-RELEASE-ORDER：单元重复或清单顺序不一致');
  }
  if (manifest.counts.units !== manifest.units.length ||
      manifest.counts.scenes !== manifest.units.reduce((sum, unit) => sum + unit.scenes, 0)) {
    throw new Error('E-RELEASE-COUNT：发行统计与单元清单不一致');
  }
}

export function assertIssueRelease(release: IssueRelease, units: readonly UnitRevision[]): IssueRelease {
  assertReleaseManifest(release);
  const manifest = release.manifest;
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  release.orderedUnitRevisionIds.forEach((id, index) => {
    const unit = byId.get(id);
    if (!unit) throw new Error(`E-RELEASE-UNITS：缺少单元修订 ${id}`);
    if (unit.cefr !== release.cefr) throw new Error('E-RELEASE-LEVEL：一个发行只能使用一个 CEFR，不能混入其他等级');
    if (unit.status !== 'validated') throw new Error('E-RELEASE-STATUS：未通过验收的单元不能出现在正式发行中');
    if (unit.digest !== unitRevisionDigest(unit)) throw new Error('E-RELEASE-UNITS：单元修订摘要不一致');
    if (unit.basis.editionId !== release.editionId || unit.basis.issuePlanId !== release.issueId ||
        unit.basis.editorialRevisionId !== release.editorialRevisionId || unit.basis.corpusRevisionId !== release.corpusRevisionId ||
        unit.basis.languagePackRevisionId !== manifest.languagePackRevisionId) {
      throw new Error('E-RELEASE-BASIS：单元与发行依据不一致');
    }
    const entry = manifest.units[index];
    if (!entry || entry.unitRevisionId !== id) throw new Error('E-RELEASE-ORDER：发行单元顺序与目录不一致');
    if (unit.basis.unitPlanId !== entry.unitId) throw new Error('E-RELEASE-UNITS：单元计划引用不一致');
    if (digestOf(unit.batch) !== entry.batchDigest) {
      throw new Error('E-RELEASE-UNITS：单元正文与清单摘要不一致');
    }
  });
  return release;
}

// ---------- 11.4 事件与 Run ----------

export const EvidenceActionSchema = z.enum(['answer', 'advance', 'reveal']);
export type EvidenceAction = z.infer<typeof EvidenceActionSchema>;

export const EvidenceEventSchema = z.object({
  eventId: EditionRefSchema,
  runId: EditionRefSchema,
  streamId: z.string().min(1).max(80),
  seq: z.number().int().min(1),
  revisionId: EditionRefSchema,
  /** 单元事件用 `unt_…`；复习段事件用 `review:<rvr_…>`，与正文单元明确区分。 */
  unitId: z.string().regex(/^(unt_[0-9a-f-]{36}|review:rvr_[0-9a-f-]{36})$/),
  sceneId: z.string().min(1).max(64),
  action: EvidenceActionSchema,
  payload: z.object({
    choice: z.number().int().nonnegative().optional(),
    skip: z.boolean().optional(),
  }),
  at: z.string().datetime(),
  prevHash: z.string().regex(/^(sha256:[a-f0-9]{64}|genesis)$/),
  hash: DigestSchema,
});
export type EvidenceEvent = z.infer<typeof EvidenceEventSchema>;

export function eventHash(event: Omit<EvidenceEvent, 'hash'>): string {
  return digestOf({
    eventId: event.eventId, runId: event.runId, streamId: event.streamId, seq: event.seq,
    revisionId: event.revisionId, unitId: event.unitId, sceneId: event.sceneId,
    action: event.action, payload: event.payload, at: event.at, prevHash: event.prevHash,
  });
}

export const EditionRunSchema = z.object({
  id: EditionRefSchema,
  editionId: EditionRefSchema,
  editorialRevisionId: EditionRefSchema,
  adoptedReleases: z.array(z.object({
    issueId: EditionRefSchema,
    releaseId: EditionRefSchema,
    cefr: CefrSchema,
    adoptedAt: z.string().datetime(),
  })).max(40),
  levelSchedule: z.array(z.object({ issueId: EditionRefSchema, cefr: CefrSchema })).max(40),
  events: z.array(EvidenceEventSchema).max(20_000),
  createdAt: z.string().datetime(),
  revision: z.number().int().nonnegative(),
});
export type EditionRun = z.infer<typeof EditionRunSchema>;

/** 事件流校验：seq 连续、哈希链一致、eventId 唯一。 */
export function runEventIssues(run: EditionRun): EditorialIssue[] {
  const issues: EditorialIssue[] = [];
  const seen = new Set<string>();
  const streams = new Map<string, { seq: number; hash: string }>();
  for (const event of run.events) {
    if (seen.has(event.eventId)) issues.push({ code: 'E-EVENT-DUP', message: `事件 ID 重复：${event.eventId}` });
    seen.add(event.eventId);
    if (event.runId !== run.id) issues.push({ code: 'E-EVENT-RUN', message: `事件不属于该 Run：${event.eventId}` });
    const current = streams.get(event.streamId) ?? { seq: 0, hash: 'genesis' };
    if (event.seq !== current.seq + 1) issues.push({ code: 'E-EVENT-SEQ', message: `${event.streamId} 的 seq 不连续` });
    if (event.prevHash !== current.hash) issues.push({ code: 'E-EVENT-CHAIN', message: `${event.streamId} 的哈希链断开` });
    const { hash, ...rest } = event;
    if (hash !== eventHash(rest)) issues.push({ code: 'E-EVENT-HASH', message: `${event.eventId} 的摘要不匹配` });
    streams.set(event.streamId, { seq: event.seq, hash: event.hash });
  }
  const adoptedIssues = new Set<string>();
  for (const adopted of run.adoptedReleases) {
    if (adoptedIssues.has(adopted.issueId)) issues.push({ code: 'E-RUN-ADOPT', message: `同一期采用了两个版本：${adopted.issueId}` });
    adoptedIssues.add(adopted.issueId);
  }
  for (const schedule of run.levelSchedule) {
    const adopted = run.adoptedReleases.find((entry) => entry.issueId === schedule.issueId);
    if (!adopted) issues.push({ code: 'E-RUN-LEVEL', message: `等级计划引用了未采用的期 ${schedule.issueId}` });
    else if (adopted.cefr !== schedule.cefr) issues.push({ code: 'E-RUN-LEVEL', message: `${schedule.issueId} 的等级与采用版本不一致` });
  }
  return issues;
}

export function assertRun(run: EditionRun): EditionRun {
  const issues = runEventIssues(run);
  if (issues.length) throw new Error(issues.map((issue) => `${issue.code}：${issue.message}`).join('；'));
  return run;
}

// ---------- 11.3 复习 ----------

export const ReviewBasisSchema = z.object({
  runId: EditionRefSchema,
  issueId: EditionRefSchema,
  cefr: CefrSchema,
  eventCount: z.number().int().nonnegative(),
  eventHash: DigestSchema,
  dueItems: z.array(z.object({
    item: z.string().min(1).max(80),
    exposures: z.number().int().nonnegative(),
    dueAt: z.string().datetime().nullable(),
  })).max(40),
  sourceRefs: z.array(z.object({
    reference: z.string().min(1).max(160),
    text: z.string().min(1).max(600),
    hash: DigestSchema,
  })).max(40),
  constructorVersion: z.string().min(1).max(60),
  policyVersion: z.string().min(1).max(60),
  createdAt: z.string().datetime(),
});
export type ReviewBasis = z.infer<typeof ReviewBasisSchema>;

export const ReviewRevisionSchema = z.object({
  id: EditionRefSchema,
  runId: EditionRefSchema,
  issueId: EditionRefSchema,
  basis: ReviewBasisSchema,
  batch: Batch,
  /** 哪些条目真正进入了评分轨（recognition-4）；其余是明确练习。 */
  gradedItems: z.array(z.string()).max(40),
  practiceItems: z.array(z.string()).max(40),
  digest: DigestSchema,
  createdAt: z.string().datetime(),
});
export type ReviewRevision = z.infer<typeof ReviewRevisionSchema>;

export function reviewDigest(revision: Omit<ReviewRevision, 'id' | 'digest' | 'createdAt'>): string {
  return digestOf({
    runId: revision.runId, issueId: revision.issueId, basis: revision.basis, batch: revision.batch,
    gradedItems: revision.gradedItems, practiceItems: revision.practiceItems,
  });
}

// ---------- 12.2 编译任务（与 API 共享的安全子集） ----------

export const CompileJobKindSchema = z.enum([
  'research_sources', 'extract_and_review', 'build_plan', 'prepare_language_assets', 'compile_issue',
]);
export type CompileJobKind = z.infer<typeof CompileJobKindSchema>;

export const CompileJobStatusSchema = z.enum([
  'queued', 'running', 'succeeded', 'failed', 'interrupted', 'cancel_requested', 'cancelled',
]);
export type CompileJobStatus = z.infer<typeof CompileJobStatusSchema>;

export const AttemptStatusSchema = z.enum(['reserved', 'call_started', 'result_saved', 'failed', 'unknown']);

export const CompileJobSchema = z.object({
  id: EditionRefSchema,
  requestId: z.string().min(1).max(80),
  kind: CompileJobKindSchema,
  editionId: EditionRefSchema,
  editorialRevisionId: EditionRefSchema.nullable(),
  issuePlanId: EditionRefSchema.nullable(),
  cefr: CefrSchema.nullable(),
  taskDigest: DigestSchema,
  status: CompileJobStatusSchema,
  attempts: z.array(z.object({
    unitId: EditionRefSchema,
    workKey: DigestSchema,
    status: AttemptStatusSchema,
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().nullable(),
    failureCode: z.string().max(64).nullable(),
  })).max(200),
  resultRefs: z.array(EditionRefSchema).max(200),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CompileJob = z.infer<typeof CompileJobSchema>;

/** 任务摘要：类别 + 全部冻结依据 + 操作参数；同 ID 不同摘要必须 409，不能复用结果。 */
export function compileTaskDigest(input: {
  kind: CompileJobKind; editionId: string; editorialRevisionId: string | null;
  issuePlanId: string | null; cefr: Cefr | null; unitIds: readonly string[]; intent: string;
}): string {
  return digestOf({
    kind: input.kind, editionId: input.editionId, editorialRevisionId: input.editorialRevisionId,
    issuePlanId: input.issuePlanId, cefr: input.cefr, unitIds: [...input.unitIds].sort(), intent: input.intent,
  });
}

export const editionContracts = {
  format: EDITION_FORMAT,
  schemaVersion: EDITION_SCHEMA_VERSION,
  contract: EDITION_CONTRACT,
  draftHeader: EDITION_DRAFT_HEADER,
  learningPolicy: EDITION_LEARNING_POLICY,
  compilerVersion: EDITION_COMPILER_VERSION,
  validationPolicyVersion: EDITION_VALIDATION_POLICY_VERSION,
  reviewConstructorVersion: EDITION_REVIEW_CONSTRUCTOR_VERSION,
  materialCatalogVersion: MATERIAL_CATALOG_VERSION,
} as const;
