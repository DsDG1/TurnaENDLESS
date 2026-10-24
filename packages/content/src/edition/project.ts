/**
 * 可参数化的 Edition 项目构建器（样刊、规模夹具、第二等级共用）。
 *
 * 只做**组装与验收**：正文来自调用方给的单元种子，语言包可以外部注入，
 * 期数与每期单元数由参数决定。这里不抓网页、不调用模型；所有产物都是
 * 自有文本（`own-work`），因此可以离线重建与复核。
 */
import { validateBatch } from '@endless/esl';
import { loadLexicon, type Lexicon } from '@endless/learning';
import {
  assertEditorialRevision,
  editorialDigest,
  newEditionId,
  unitRevisionDigest,
  type Cefr,
  type CoverageEntry,
  type Edition,
  type EditionSpec,
  type EditorialRevision,
  type EditionRun,
  type IssuePlan,
  type IssueRelease,
  type UnitLevelPlan,
  type UnitPlan,
  type UnitRevision,
} from './contract.js';
import { digestOf } from './digest.js';
import { buildLanguagePack, packEntriesFromLexicon, type LanguagePackRevision } from './language.js';
import { checkCapacity, coverageIssues } from './editorial.js';
import {
  corpusDigest,
  makeSpan,
  type ClaimRevision,
  type CorpusRevision,
  type PassageRevision,
  type RightsDecision,
  type SourceSnapshot,
  type SourceSpan,
} from './sources.js';
import { compileEditionDraft, type EditionTarget } from './compile.js';
import { acceptEditionUnit, editionValidationContext } from './validate.js';
import { buildPublicationPackage, createIssueRelease } from './release.js';
import { createRun, type EditionInstall } from './run.js';

export interface ProjectUnitSeed {
  key: string;
  title: string;
  subtitle: string;
  description: string;
  role: UnitPlan['role'];
  concept: string;
  goal: string;
  segments: string[];
  targets: { alias: string; item: string; introduce: boolean }[];
  extra: { form: string; reason: string }[];
  /** `EDITION-DRAFT/1` 草稿：正文用 `@reading <alias>` 引用已批准段落。 */
  draft: string;
}

export interface ProjectIssueSeed {
  title: string;
  summary: string;
  units: ProjectUnitSeed[];
}

export interface BuildProjectInput {
  lexiconYaml: string;
  cefr: Cefr;
  /** 第二等级包由调用方注入；缺省从本地词库派生（仅 A1/A2 词库可用）。 */
  pack?: LanguagePackRevision;
  title: string;
  subtitle: string;
  description: string;
  issues: ProjectIssueSeed[];
  spec: EditionSpec;
  now?: Date;
  editionId?: string;
  allowedCharacters?: readonly string[];
  background?: string;
  /** 权利记录：缺省为项目自有文本，允许改编与导出。 */
  rights?: RightsDecision;
  /** 覆盖单元修订的作者标注来源。 */
  origin?: UnitRevision['origin'];
}

export interface BuiltProject {
  edition: Edition;
  editorial: EditorialRevision;
  corpus: CorpusRevision;
  rights: RightsDecision[];
  pack: LanguagePackRevision;
  units: UnitRevision[];
  levelPlans: UnitLevelPlan[];
  unitPlans: UnitPlan[];
  targets: Record<string, EditionTarget[]>;
  releases: IssueRelease[];
  installs: EditionInstall[];
  /** 按期的单元修订 ID，供界面/测试定位。 */
  issueUnits: Record<string, string[]>;
  run: EditionRun;
}

const DEFAULT_CHARACTERS = ['shopkeeper', 'cat', 'guide'] as const;

function ownWorkRights(id: string, sourceId: string, at: string, note: string): RightsDecision {
  const decision: RightsDecision = {
    id,
    sourceId,
    decision: 'approved',
    licenseIdentifier: 'own-work',
    licenseVersion: null,
    licenseUrl: null,
    licenseEvidenceText: note,
    licenseEvidenceDigest: null,
    rightsScope: 'full-text',
    jurisdiction: 'CN',
    allowedUses: ['publish', 'adapt', 'export'],
    exclusions: [],
    reviewer: 'owner',
    reviewedAt: at,
    reason: '自有教学文本，允许改编与导出',
    policyVersion: 'rights-policy-v1',
  };
  decision.licenseEvidenceDigest = digestOf(decision.licenseEvidenceText ?? '');
  return decision;
}

function packFor(input: BuildProjectInput, lexicon: Lexicon, at: string): LanguagePackRevision {
  if (input.pack) {
    if (input.pack.cefr !== input.cefr) throw new Error(`注入的语言包是 ${input.pack.cefr}，与项目 ${input.cefr} 不一致`);
    return input.pack;
  }
  return buildLanguagePack({
    id: newEditionId('lpk'),
    revisionId: `pack-${input.cefr.toLowerCase()}-1`,
    cefr: input.cefr,
    frozenAt: at,
    entries: packEntriesFromLexicon(lexicon, input.cefr),
    functionWords: [...lexicon.functionWords],
    properNouns: [...DEFAULT_CHARACTERS, 'duck', 'moon', 'badger'],
    rights: {
      basis: '仓库内 A1–A2 种子词库（项目自有整理）',
      decisionId: null,
      note: '词库条目与例句随仓库授权；未使用第三方词表或词典例句',
    },
  });
}

/**
 * 把单元种子组装成完整项目：语料 → 目录 → 分级计划 → 编译 → 逐单元验收 →
 * 逐期发布 → 安装包 → Run。任何一步失败都抛错，不产出「看起来像完成」的半成品。
 */
export function buildEditionProject(input: BuildProjectInput): BuiltProject {
  const now = input.now ?? new Date();
  const at = now.toISOString();
  const loaded = loadLexicon(input.lexiconYaml);
  if (!loaded.lexicon || loaded.issues.length) throw new Error('项目词库无法加载');
  const lexicon: Lexicon = loaded.lexicon;

  const editionId = input.editionId ?? newEditionId('edn');
  const editorialId = newEditionId('edr');
  const corpusId = newEditionId('crp');
  const pack = packFor(input, lexicon, at);
  const rights = input.rights ?? ownWorkRights(
    newEditionId('rdc'), newEditionId('src'), at,
    '项目正文由本仓库编写，随仓库授权；不是第三方抓取内容。',
  );
  const allowedCharacters = input.allowedCharacters ?? DEFAULT_CHARACTERS;
  const background = input.background ?? 'cafe';
  const origin = input.origin ?? 'imported';

  const snapshots: SourceSnapshot[] = [];
  const spans: SourceSpan[] = [];
  const claims: ClaimRevision[] = [];
  const passages: PassageRevision[] = [];
  const units: UnitRevision[] = [];
  const levelPlans: UnitLevelPlan[] = [];
  const unitPlans: UnitPlan[] = [];
  const coverage: CoverageEntry[] = [];
  const issueUnits: Record<string, string[]> = {};
  const issueSnapshots = new Map<string, SourceSnapshot[]>();

  const issueIds = input.issues.map(() => newEditionId('iss'));

  input.issues.forEach((issueSeed, issueIndex) => {
    const issueId = issueIds[issueIndex]!;
    issueUnits[issueId] = [];
    const seen: SourceSnapshot[] = [];
    issueSnapshots.set(issueId, seen);
    let previousUnitId: string | null = null;

    issueSeed.units.forEach((seed) => {
      const snapshot: SourceSnapshot = {
        id: newEditionId('snp'),
        sourceId: rights.sourceId,
        title: `项目来源 · ${seed.title}`,
        canonicalUrl: `https://local.edition/project/${encodeURIComponent(seed.key)}`,
        finalUrl: `https://local.edition/project/${encodeURIComponent(seed.key)}`,
        retrievedAt: at,
        extractorVersion: 'edition-extractor-1',
        spanIndexVersion: 'unicode-codepoint-1',
        encoding: 'utf-8',
        text: seed.segments.join('\n\n'),
        textDigest: digestOf(seed.segments.join('\n\n')),
        paragraphCount: seed.segments.length,
      };
      snapshots.push(snapshot);
      seen.push(snapshot);

      const unitSpans: SourceSpan[] = [];
      let cursor = 0;
      seed.segments.forEach((segment, segmentIndex) => {
        const start = cursor;
        const end = start + [...segment].length;
        unitSpans.push(makeSpan(snapshot, newEditionId('spn'), segmentIndex, start, end));
        cursor = end + 2;
      });
      spans.push(...unitSpans);

      const claim: ClaimRevision = {
        id: newEditionId('clm'),
        revisionId: `claim-${seed.key}`,
        statement: seed.goal,
        sourceSpanIds: unitSpans.map((span) => span.id),
        claimType: 'language_usage',
        qualifiers: [`${input.cefr} 教学语境`],
        timeScope: null,
        locationScope: null,
        uncertainty: 'certain',
        reviewStatus: 'approved',
        reviewer: 'owner',
        reviewedAt: at,
        reviewPolicyVersion: 'rights-policy-v1',
      };
      claims.push(claim);

      const passage: PassageRevision = {
        id: newEditionId('psg'),
        revisionId: `passage-${seed.key}`,
        cefr: input.cefr,
        title: seed.title,
        textSegments: seed.segments.map((segment, segmentIndex) => ({
          text: segment,
          claimRevisionIds: [claim.id],
          sourceSpanIds: [unitSpans[segmentIndex]!.id],
          adaptationKind: 'original',
        })),
        languagePackRevisionId: pack.id,
        difficultyReport: null,
        semanticReview: {
          reviewer: 'owner',
          reviewedAt: at,
          status: 'approved',
          note: '自有教学文本，事实为日常场景；不涉及外部事实断言',
        },
        rightsBindings: [rights.id],
      };
      passages.push(passage);

      const unitPlanId = newEditionId('unt');
      const unitPlan: UnitPlan = {
        id: unitPlanId,
        // order 是「期内序号」，不是全刊序号：契约按 issue.unitIds 校验，上限 20
        order: issueUnits[issueId]!.length + 1,
        title: seed.title,
        role: seed.role,
        goals: [seed.goal],
        conceptRefs: [seed.concept],
        dependencyIds: previousUnitId ? [previousUnitId] : [],
        claimRefs: [claim.id],
        estimatedMinutes: 8,
      };
      unitPlans.push(unitPlan);
      previousUnitId = unitPlanId;
      issueUnits[issueId]!.push(unitPlanId);

      const levelPlan: UnitLevelPlan = {
        id: newEditionId('ulv'),
        unitId: unitPlanId,
        cefr: input.cefr,
        passageRefs: [passage.id],
        targetRefs: seed.targets.filter((target) => target.introduce).map((target) => target.item),
        contextBudget: { readingScenes: 2, practiceScenes: 4, maxWords: 220 },
        allowedExtra: seed.extra,
        status: 'approved',
      };
      levelPlans.push(levelPlan);

      coverage.push({ concept: seed.concept, issueId, unitId: unitPlanId, angle: seed.goal });

      const targets: EditionTarget[] = seed.targets.map((target) => {
        const entry = pack.entries.find((candidate) => candidate.item === target.item);
        if (!entry) throw new Error(`语言包缺少目标 ${target.item}（${input.cefr}）`);
        return { alias: target.alias, item: target.item, entry, introduce: target.introduce };
      });
      const revisionId = newEditionId('urv');
      const basisRefs = {
        contract: 'edition-draft-v1' as const,
        editionId,
        editorialRevisionId: editorialId,
        corpusRevisionId: corpusId,
        issuePlanId: issueId,
        unitPlanId,
        unitLevelPlanId: levelPlan.id,
        cefr: input.cefr,
        passageRevisionIds: [passage.id],
        languagePackRevisionId: pack.id,
        materialCatalogVersion: 'material-catalog-1',
        promptVersion: 'edition-prompt-1',
        compilerVersion: 'edition-compiler-1',
        validationPolicyVersion: 'edition-validation-1',
      };
      const compiled = compileEditionDraft(seed.draft, {
        seed: revisionId,
        batchId: revisionId,
        unitId: unitPlanId,
        cefr: input.cefr,
        plan: levelPlan,
        pack,
        passages: [{ alias: 'p1', revision: passage }],
        targets,
        readingBackground: background,
        allowedCharacters,
        validate: (batch) => validateBatch(batch, editionValidationContext(pack, levelPlan, targets)).issues,
      });
      if (!compiled.ok) {
        throw new Error(`单元「${seed.title}」编译失败：${compiled.issues.map((issue) => issue.message).join('；')}`);
      }
      const revisionBase = {
        id: revisionId,
        unitId: unitPlanId,
        parentRevisionId: null,
        ordinal: 1,
        origin,
        contract: 'edition-draft-v1' as const,
        cefr: input.cefr,
        title: compiled.title,
        subtitle: compiled.subtitle,
        description: compiled.description,
        draft: seed.draft,
        batch: compiled.batch,
        creation: compiled.creation,
        basis: { ...basisRefs, basisDigest: digestOf(basisRefs) },
        reports: {
          validation: { ok: true, issues: [] },
          teaching: {
            contexts: compiled.teaching.contexts,
            practiceItems: compiled.teaching.practiceItems,
            estimatedMinutes: compiled.teaching.estimatedMinutes,
          },
        },
        status: 'draft' as const,
        createdAt: at,
        authoredAt: at,
      };
      units.push({ ...revisionBase, digest: unitRevisionDigest(revisionBase) });
    });
  });

  const corpusBody = {
    id: corpusId,
    revisionId: `${input.cefr.toLowerCase()}-corpus-1`,
    frozenAt: at,
    sourceIds: [rights.sourceId],
    snapshotIds: snapshots.map((snapshot) => snapshot.id),
    spans,
    claims,
    passages,
    rightsDecisionIds: [rights.id],
    approvedBy: 'owner',
  };
  const corpus: CorpusRevision = { ...corpusBody, digest: corpusDigest(corpusBody) };

  const issues: IssuePlan[] = input.issues.map((seed, index) => {
    const unitIds = issueUnits[issueIds[index]!]!;
    const targetMinutes = unitIds.reduce((sum, unitId) => sum + (unitPlans.find((unit) => unit.id === unitId)?.estimatedMinutes ?? 0), 0);
    return {
      id: issueIds[index]!,
      order: index + 1,
      title: seed.title,
      summary: seed.summary,
      unitIds,
      targetMinutes,
      conceptScope: unitIds.flatMap((unitId) => unitPlans.find((unit) => unit.id === unitId)?.conceptRefs ?? []),
    };
  });

  const unitsPerIssue = Math.max(...issues.map((issue) => issue.unitIds.length));
  const spec: EditionSpec = {
    ...input.spec,
    cefr: input.cefr,
    targetIssues: issues.length,
    unitsPerIssue,
  };
  const capacity = checkCapacity({ spec, corpus, coverage, units: unitPlans });
  const editorialBase = {
    id: editorialId,
    editionId,
    parentId: null,
    revision: 1,
    spec,
    corpusRevisionId: corpus.id,
    issues,
    units: unitPlans,
    coverage,
    status: 'approved' as const,
    capacity,
    approvedBy: 'owner',
    approvedAt: at,
    createdAt: at,
  };
  const editorial: EditorialRevision = { ...editorialBase, digest: editorialDigest(editorialBase) };
  const planIssues = coverageIssues(editorial);
  if (planIssues.length) throw new Error(`覆盖矩阵不成立：${planIssues.map((entry) => entry.message).join('；')}`);
  // 构建器自己也要过一遍契约：否则「生产者写全局序号、校验按期内序号」这类偏差会被掩盖
  assertEditorialRevision(editorial);

  // 逐单元验收：重新编译并逐项比较，通过后才允许进入发布
  const targetsByUnit: Record<string, EditionTarget[]> = {};
  const levelPlanByUnit = new Map(levelPlans.map((plan) => [plan.unitId, plan]));
  const validated = units.map((unit) => {
    const plan = levelPlanByUnit.get(unit.unitId);
    if (!plan) throw new Error(`单元 ${unit.unitId} 缺少分级计划`);
    const passageId = unit.basis.passageRevisionIds[0]!;
    const passage = passages.find((entry) => entry.id === passageId);
    if (!passage) throw new Error(`单元 ${unit.unitId} 的正文不在语料中`);
    const seed = findSeed(input.issues, unit.unitId, issueUnits, issueIds);
    const targets: EditionTarget[] = seed.targets.map((target) => {
      const entry = pack.entries.find((candidate) => candidate.item === target.item);
      if (!entry) throw new Error(`语言包缺少目标 ${target.item}`);
      return { alias: target.alias, item: target.item, entry, introduce: target.introduce };
    });
    targetsByUnit[unit.unitId] = targets;
    return acceptEditionUnit({
      revision: unit,
      editorial,
      levelPlan: plan,
      targets,
      pack,
      passages: [{ alias: 'p1', revision: passage }],
      corpus,
      rights: [rights],
      allowedCharacters,
    }, now);
  });

  const releases: IssueRelease[] = [];
  const installs: EditionInstall[] = [];
  const edition: Edition = {
    id: editionId,
    title: input.title,
    subtitle: input.subtitle,
    description: input.description,
    headEditorialRevisionId: editorial.id,
    createdAt: at,
    updatedAt: at,
  };
  const validatedByUnitId = new Map(validated.map((unit) => [unit.unitId, unit]));

  issues.forEach((issue) => {
    const issueValidated = issue.unitIds.map((unitId) => validatedByUnitId.get(unitId)!);
    const issueSnap = issueSnapshots.get(issue.id) ?? [];
    const release = createIssueRelease({
      editionId,
      issueId: issue.id,
      cefr: input.cefr,
      editorial,
      corpus,
      rights: [rights],
      pack,
      units: issueValidated,
      sources: issueSnap.map((snapshot) => ({
        sourceId: snapshot.sourceId,
        title: snapshot.title,
        license: 'own-work',
        licenseUrl: null,
        canonicalUrl: snapshot.canonicalUrl,
      })),
      publishedBy: 'owner',
      now,
    });
    releases.push(release);
    installs.push({
      release,
      package: buildPublicationPackage(release, issueValidated, pack, {
        editionTitle: edition.title,
        issueTitle: issue.title,
      }),
    });
  });

  const run = createRun({ editionId, editorialRevisionId: editorial.id, releases, now });
  return {
    edition, editorial, corpus, rights: [rights], pack, units: validated,
    levelPlans, unitPlans, targets: targetsByUnit, releases, installs, issueUnits, run,
  };
}

function findSeed(
  issues: readonly ProjectIssueSeed[],
  unitId: string,
  issueUnits: Record<string, string[]>,
  issueIds: readonly string[],
): ProjectUnitSeed {
  for (let issueIndex = 0; issueIndex < issueIds.length; issueIndex++) {
    const index = (issueUnits[issueIds[issueIndex]!] ?? []).indexOf(unitId);
    if (index >= 0) return issues[issueIndex]!.units[index]!;
  }
  throw new Error(`找不到单元 ${unitId} 的种子`);
}
