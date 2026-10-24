/**
 * 全局目录、覆盖矩阵与教学编排（设计文档 §7）。
 *
 * 关键判断：容量不足时进入 `needs_sources`，给缩小范围/补资料/减少期数的建议，
 * 绝不用重复片段、编造事实或空题目凑满原定规模。
 */
import { tokenize } from '@endless/esl';
import type { CorpusRevision } from './sources.js';
import {
  CEFR_RANK,
  type CoverageEntry,
  type EditorialRevision,
  type EditionSpec,
  type IssuePlan,
  type UnitLevelPlan,
  type UnitPlan,
} from './contract.js';
import type { LanguageEntry, LanguagePackRevision } from './language.js';

/** 估时参数是显式假设，不包装成科学测量。 */
export const DURATION_POLICY = {
  version: 'edition-duration-1',
  readingWpm: 110,
  secondsPerInteraction: 25,
  /** 展示为区间，不给未经校准的精确值。 */
  bandRatio: 0.15,
} as const;

export interface DurationEstimate {
  narrativeWords: number;
  interactions: number;
  minutes: number;
  minMinutes: number;
  maxMinutes: number;
  policyVersion: string;
}

export function estimateMinutes(narrativeWordCount: number, interactionCount: number, explanationMinutes = 0): DurationEstimate {
  const minutes = narrativeWordCount / DURATION_POLICY.readingWpm
    + (interactionCount * DURATION_POLICY.secondsPerInteraction) / 60
    + explanationMinutes;
  const spread = Math.max(1, Math.round(minutes * DURATION_POLICY.bandRatio));
  return {
    narrativeWords: narrativeWordCount,
    interactions: interactionCount,
    minutes: Number(minutes.toFixed(1)),
    minMinutes: Math.max(1, Math.round(minutes) - spread),
    maxMinutes: Math.round(minutes) + spread,
    policyVersion: DURATION_POLICY.version,
  };
}

export function countNarrativeWords(texts: readonly string[]): number {
  return texts.reduce((total, text) => total + tokenize(text).length, 0);
}

// ---------- 7.2 覆盖矩阵 ----------

/** 覆盖检查必须区分新角度与重复表达：重用同一事实要说明教学或叙事目的。 */
export function coverageIssues(revision: EditorialRevision): { code: string; message: string }[] {
  const issues: { code: string; message: string }[] = [];
  for (const issue of revision.issues) {
    const entries = revision.coverage.filter((entry) => entry.issueId === issue.id);
    if (!entries.length) {
      issues.push({ code: 'E-COVERAGE-EMPTY', message: `${issue.id} 没有覆盖条目，不能只把一篇文章切成十段` });
      continue;
    }
    const angles = new Set(entries.map((entry) => entry.angle.trim().toLowerCase()));
    if (angles.size < Math.min(2, entries.length)) {
      issues.push({ code: 'E-COVERAGE-ANGLE', message: `${issue.id} 的多个单元共用同一角度，缺少独立阅读价值` });
    }
    const unitsWithCoverage = new Set(entries.map((entry) => entry.unitId));
    for (const unitId of issue.unitIds) {
      if (!unitsWithCoverage.has(unitId)) {
        issues.push({ code: 'E-COVERAGE-UNIT', message: `${unitId} 没有概念覆盖，属于空单元` });
      }
    }
    for (const concept of issue.conceptScope) {
      if (!entries.some((entry) => entry.concept === concept)) {
        issues.push({ code: 'E-COVERAGE-CONCEPT', message: `${issue.id} 声明的概念「${concept}」没有对应单元` });
      }
    }
  }
  return issues;
}

/** 同一 claim 在多期重复出现时，必须给出不同角度说明。 */
export function reusedClaimIssues(units: readonly UnitPlan[]): { code: string; message: string }[] {
  const seen = new Map<string, string[]>();
  for (const unit of units) {
    for (const claim of unit.claimRefs) seen.set(claim, [...(seen.get(claim) ?? []), unit.id]);
  }
  const issues: { code: string; message: string }[] = [];
  for (const [claim, unitIds] of seen) {
    if (new Set(unitIds).size > 2) {
      issues.push({ code: 'W-CLAIM-REUSE', message: `资料 ${claim} 被 ${unitIds.length} 个单元使用，需要说明教学或叙事目的` });
    }
  }
  return issues;
}

// ---------- 7.3 语言目标 ----------

export const EDITION_TARGET_POLICY = {
  version: 'edition-targets-1',
  maxPerUnit: 3,
  /** 每个首次教学目标至少两处语义不同的真实语境 + 一次练习。 */
  minContexts: 2,
  minPractice: 1,
} as const;

export function teachTargetIssues(
  units: readonly UnitPlan[],
  levelPlans: readonly UnitLevelPlan[],
  pack: LanguagePackRevision,
): { code: string; message: string }[] {
  const issues: { code: string; message: string }[] = [];
  const entries = new Map(pack.entries.map((entry) => [entry.item, entry]));
  const targetsByUnit = new Map<string, string[]>();
  for (const plan of levelPlans) targetsByUnit.set(plan.unitId, [...plan.targetRefs]);
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  for (const plan of levelPlans) {
    const unit = unitById.get(plan.unitId);
    if (!unit) { issues.push({ code: 'E-TARGET-UNIT', message: `分级计划引用了不存在的单元 ${plan.unitId}` }); continue; }
    if (plan.targetRefs.length > EDITION_TARGET_POLICY.maxPerUnit) {
      issues.push({ code: 'E-TARGET-COUNT', message: `${plan.unitId} 有 ${plan.targetRefs.length} 个首次教学目标，上限 ${EDITION_TARGET_POLICY.maxPerUnit}` });
    }
    if (new Set(plan.targetRefs).size !== plan.targetRefs.length) {
      issues.push({ code: 'E-TARGET-DUP', message: `${plan.unitId} 的教学目标重复` });
    }
    if (unit.role === 'recap' && plan.targetRefs.length > 0) {
      issues.push({ code: 'E-TARGET-RECAP', message: `回顾单元 ${plan.unitId} 允许零首次教学目标，不应新增` });
    }
    for (const item of plan.targetRefs) {
      const entry = entries.get(item);
      if (!entry) { issues.push({ code: 'E-TARGET-MISSING', message: `${plan.unitId} 的目标 ${item} 不在冻结语言包中` }); continue; }
      if (entry.kind === 'pattern' && !entry.forms.length) {
        issues.push({ code: 'E-TARGET-PATTERN', message: `句型 ${item} 没有可定位形式，首版只能展示，不能当作可检测目标` });
      }
      if (entry.cefr !== 'A1' && CEFR_RANK[entry.cefr] > CEFR_RANK[plan.cefr]) {
        issues.push({ code: 'E-TARGET-LEVEL', message: `${item} 属于 ${entry.cefr}，高于本单元 ${plan.cefr}` });
      }
    }
  }
  for (const unit of units) if (!targetsByUnit.has(unit.id)) {
    issues.push({ code: 'E-TARGET-PLAN', message: `${unit.id} 缺少分级教学计划` });
  }
  // 首次教学目标在整本合辑内只应首次出现一次
  const firstSeen = new Map<string, string>();
  for (const plan of [...levelPlans].sort((a, b) => {
    const ua = unitById.get(a.unitId);
    const ub = unitById.get(b.unitId);
    return (ua?.order ?? 0) - (ub?.order ?? 0);
  })) {
    for (const item of plan.targetRefs) {
      if (firstSeen.has(item)) {
        issues.push({ code: 'E-TARGET-REPEAT', message: `${item} 已在 ${firstSeen.get(item)} 首次教学，后续应作为复现而不是新的首次目标` });
      } else firstSeen.set(item, plan.unitId);
    }
  }
  return issues;
}

// ---------- 资料容量 ----------

export interface CapacityInput {
  spec: EditionSpec;
  corpus: Pick<CorpusRevision, 'claims' | 'passages' | 'spans'>;
  coverage: readonly CoverageEntry[];
  units: readonly UnitPlan[];
}

export interface CapacityResult {
  state: 'sufficient' | 'needs_sources';
  supportedIssues: number;
  requestedIssues: number;
  gaps: string[];
  suggestions: string[];
}

/**
 * 容量检查：每个单元至少需要一条已审阅主张和一段已审阅正文，并且单元角度不重复。
 * 资料不够就报缺口并给建议，不承诺 20 期、不重复灌水、不编造事实。
 */
export function checkCapacity(input: CapacityInput): CapacityResult {
  const approvedClaims = new Set(input.corpus.claims.filter((claim) => claim.reviewStatus === 'approved').map((claim) => claim.id));
  const approvedPassages = input.corpus.passages.filter((passage) => passage.semanticReview.status === 'approved');
  const spanIds = new Set(input.corpus.spans.map((span) => span.id));
  const conceptsByUnit = new Map<string, Set<string>>();
  for (const entry of input.coverage) {
    const set = conceptsByUnit.get(entry.unitId) ?? new Set<string>();
    set.add(entry.concept.trim().toLowerCase());
    conceptsByUnit.set(entry.unitId, set);
  }
  const supportable = input.units.filter((unit) => {
    const claims = unit.claimRefs.filter((claimId) => approvedClaims.has(claimId));
    const passages = approvedPassages.filter((passage) =>
      unit.claimRefs.some((claimId) => passage.textSegments.some((segment) => segment.claimRevisionIds.includes(claimId))));
    return claims.length > 0 && passages.length > 0;
  });
  const seenConcepts = new Set<string>();
  let supportedUnits = 0;
  for (const unit of supportable) {
    const concepts = conceptsByUnit.get(unit.id);
    if (!concepts || !concepts.size) continue;
    // 概念全部已被其他单元用过 = 重复表达，不增加可支撑的容量
    if ([...concepts].every((concept) => seenConcepts.has(concept))) continue;
    for (const concept of concepts) seenConcepts.add(concept);
    supportedUnits += 1;
  }
  const unitsNeeded = input.spec.targetIssues * input.spec.unitsPerIssue;
  const supportedIssues = Math.max(0, Math.min(input.spec.targetIssues, Math.floor(supportedUnits / input.spec.unitsPerIssue)));
  const gaps: string[] = [];
  const suggestions: string[] = [];
  if (supportedUnits < unitsNeeded) {
    gaps.push(`只有 ${supportable.length} 个单元同时具备已审阅主张与正文（去重后 ${supportedUnits}），目标需要 ${unitsNeeded} 个`);
    suggestions.push(`把规模调整为 ${Math.max(1, supportedIssues)} 期 × ${input.spec.unitsPerIssue} 单元`);
    suggestions.push('补充经审核的公有领域/CC0 资料，并冻结新的语料修订');
    suggestions.push('缩小主题范围，去掉资料不足的角度');
  }
  const emptyClaims = input.units.flatMap((unit) => unit.claimRefs).filter((claimId) => !approvedClaims.has(claimId));
  if (emptyClaims.length) gaps.push(`${new Set(emptyClaims).size} 条单元主张缺少已审阅的资料依据`);
  const danglingSpans = input.corpus.claims.filter((claim) => claim.sourceSpanIds.some((id) => !spanIds.has(id)));
  if (danglingSpans.length) gaps.push(`${danglingSpans.length} 条主张的来源片段缺失`);
  return {
    state: gaps.length ? 'needs_sources' : 'sufficient',
    supportedIssues,
    requestedIssues: input.spec.targetIssues,
    gaps,
    suggestions,
  };
}

/** 期级估时与负担检查：明显偏离目标就编辑调整，不靠倒计时或阻止前进凑时长。 */
export function issueDurationIssues(issue: IssuePlan, units: readonly UnitPlan[], levelPlans: readonly UnitLevelPlan[]): { code: string; message: string }[] {
  const issues: { code: string; message: string }[] = [];
  const total = units.reduce((sum, unit) => sum + unit.estimatedMinutes, 0);
  const low = issue.targetMinutes * 0.7;
  const high = issue.targetMinutes * 1.3;
  if (total < low || total > high) {
    issues.push({
      code: 'W-ISSUE-DURATION',
      message: `${issue.id} 估计 ${total.toFixed(0)} 分钟，明显偏离目标 ${issue.targetMinutes} 分钟`,
    });
  }
  for (const plan of levelPlans) {
    const unit = units.find((entry) => entry.id === plan.unitId);
    if (unit && unit.estimatedMinutes > 30) {
      issues.push({ code: 'W-UNIT-LONG', message: `${unit.id} 估计超过 30 分钟，应拆分为更小的阅读单元` });
    }
  }
  return issues;
}

/** 教学目标池：每期以明确的总目标池控制负担，不把目标摊进回顾单元。 */
export function issueTargetPool(issue: IssuePlan, units: readonly UnitPlan[], levelPlans: readonly UnitLevelPlan[]): number {
  const unitIds = new Set(issue.unitIds);
  void units;
  return levelPlans.filter((plan) => unitIds.has(plan.unitId)).reduce((sum, plan) => sum + plan.targetRefs.length, 0);
}

/** 教学目标必须能在语言包中找到（形式、词义、例句齐全）。 */
export function targetEntries(pack: LanguagePackRevision, items: readonly string[]): LanguageEntry[] {
  const entries = new Map(pack.entries.map((entry) => [entry.item, entry]));
  return items.map((item) => entries.get(item)).filter((entry): entry is LanguageEntry => !!entry);
}
