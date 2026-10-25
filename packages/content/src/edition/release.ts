/**
 * 期级原子发布与安装包（设计文档 §10.4、§13.3）。
 *
 * 单元可以逐个保存为 validated，但**不能**因一个单元通过就宣称整期出版：
 * 全部计划单元齐全、版本一致、阻断解除、人工审阅通过后，才一次创建 IssueRelease。
 * Release 的正文不可变；更正产生新 Release，原版标 superseded/withdrawn，不覆盖、不自动删除。
 */
import { tokenize, type Batch } from '@endless/esl';
import {
  EDITION_CONTRACT,
  ReleaseManifestSchema,
  releaseDigest,
  assertReleaseManifest,
  type Cefr,
  type EditorialRevision,
  type IssueRelease,
  type ReleaseManifest,
  type UnitRevision,
} from './contract.js';
import { digestOf } from './digest.js';
import { acceptedLicenses, checkRights, type CorpusRevision, type RightsDecision } from './sources.js';
import { languagePackIssues, type LanguagePackRevision } from './language.js';

export interface ReleaseSourceAck {
  sourceId: string;
  title: string;
  license: string;
  licenseUrl: string | null;
  canonicalUrl: string;
}

export interface ReleaseInput {
  editionId: string;
  issueId: string;
  cefr: Cefr;
  editorial: EditorialRevision;
  corpus: CorpusRevision;
  rights: RightsDecision[];
  pack: LanguagePackRevision;
  units: UnitRevision[];
  sources: ReleaseSourceAck[];
  publishedBy: string;
  /** 更正时指向被取代的 Release。 */
  supersedes?: string | null;
  now?: Date;
}

function materialsOf(batch: Batch) {
  const characters = new Set<string>();
  const backgrounds = new Set<string>();
  const props = new Set<string>();
  for (const scene of batch.scenes) {
    if (scene.type === 'comic') {
      const tag = scene.setting.match(/^@tag:([a-z0-9_]+)$/);
      if (tag) backgrounds.add(tag[1]!);
      for (const panel of scene.panels) {
        for (const actor of panel.actors) {
          const match = actor.match(/^@char:([a-z0-9_]+)/);
          if (match) characters.add(match[1]!);
        }
        for (const prop of panel.props) {
          const match = prop.match(/^@emoji:([a-z0-9_]+)$/);
          if (match) props.add(match[1]!);
        }
      }
    }
  }
  return {
    characters: [...characters].sort(),
    backgrounds: [...backgrounds].sort(),
    props: [...props].sort(),
  };
}

export interface ReleaseCheck { ok: boolean; issues: { code: string; message: string }[] }

/** 发布门禁：单元齐全、等级一致、验收通过、权利允许发布、审阅批准绑定当前 digest。 */
export function releaseIssues(input: ReleaseInput): { code: string; message: string }[] {
  const issues: { code: string; message: string }[] = [];
  const issue = input.editorial.issues.find((entry) => entry.id === input.issueId);
  if (!issue) return [{ code: 'E-RELEASE-ISSUE', message: '该期不在编辑修订目录中' }];
  if (input.editorial.status !== 'approved') issues.push({ code: 'E-RELEASE-PLAN', message: '编辑修订尚未批准，不能发布' });
  const byUnit = new Map<string, UnitRevision[]>();
  for (const unit of input.units) byUnit.set(unit.unitId, [...(byUnit.get(unit.unitId) ?? []), unit]);
  for (const unitId of issue.unitIds) {
    const candidates = byUnit.get(unitId) ?? [];
    if (!candidates.length) { issues.push({ code: 'E-RELEASE-MISSING', message: `缺少单元 ${unitId} 的成稿` }); continue; }
    if (candidates.length > 1) issues.push({ code: 'E-RELEASE-DUP', message: `单元 ${unitId} 有多个候选修订，必须明确选择一个` });
    const unit = candidates[0]!;
    if (unit.cefr !== input.cefr) issues.push({ code: 'E-RELEASE-LEVEL', message: `${unitId} 是 ${unit.cefr}，与本期 ${input.cefr} 不一致` });
    if (unit.status !== 'validated') issues.push({ code: 'E-RELEASE-STATUS', message: `${unitId} 未通过验收` });
    if (unit.basis.editorialRevisionId !== input.editorial.id) issues.push({ code: 'E-RELEASE-BASIS', message: `${unitId} 生成自其他编辑修订` });
    if (unit.contract !== EDITION_CONTRACT) issues.push({ code: 'E-RELEASE-CONTRACT', message: `${unitId} 不是 Edition 契约` });
  }
  const unknown = input.units.filter((unit) => !issue.unitIds.includes(unit.unitId));
  if (unknown.length) issues.push({ code: 'E-RELEASE-EXTRA', message: `包含不属于本期的单元：${unknown.map((unit) => unit.unitId).join('、')}` });
  for (const decision of input.rights) {
    const check = checkRights(decision, 'publish');
    if (!check.ok) issues.push({ code: check.code, message: check.message });
  }
  // 来源署名必须与语料、权利决策闭合：否则一份许可写错的发行也能过门禁
  const ackedSources = new Set<string>();
  for (const source of input.sources) {
    ackedSources.add(source.sourceId);
    if (!input.corpus.sourceIds.includes(source.sourceId)) {
      issues.push({ code: 'E-RELEASE-SOURCE-CORPUS', message: `来源 ${source.sourceId} 不属于本语料` });
    }
    if (!(acceptedLicenses as readonly string[]).includes(source.license)) {
      issues.push({
        code: 'E-RELEASE-SOURCE-LICENSE',
        message: `来源 ${source.sourceId} 的许可 ${source.license} 不在允许列表（${acceptedLicenses.join(' / ')}）`,
      });
    }
    const usable = input.rights.some((decision) =>
      decision.sourceId === source.sourceId && checkRights(decision, 'publish').ok);
    if (!usable) {
      issues.push({ code: 'E-RELEASE-SOURCE-RIGHTS', message: `来源 ${source.sourceId} 没有允许发布的授权记录` });
    }
  }
  for (const sourceId of input.corpus.sourceIds) {
    if (!ackedSources.has(sourceId)) {
      issues.push({ code: 'E-RELEASE-SOURCE-MISSING', message: `语料来源 ${sourceId} 缺少署名` });
    }
  }
  for (const passage of input.corpus.passages) {
    if (!passage.rightsBindings.length) continue;
    const usable = passage.rightsBindings.some((id) => {
      const decision = input.rights.find((entry) => entry.id === id);
      return decision ? checkRights(decision, 'publish').ok : false;
    });
    if (!usable) issues.push({ code: 'E-RELEASE-RIGHTS', message: `正文 ${passage.id} 没有允许发布的授权` });
  }
  return issues;
}

export function createIssueRelease(input: ReleaseInput): IssueRelease {
  const issues = releaseIssues(input);
  if (issues.length) throw new Error(issues.map((issue) => `${issue.code}：${issue.message}`).join('；'));
  const issue = input.editorial.issues.find((entry) => entry.id === input.issueId)!;
  const ordered = issue.unitIds.map((unitId) => input.units.find((unit) => unit.unitId === unitId)!);
  const now = (input.now ?? new Date()).toISOString();

  const materials = ordered.reduce((acc, unit) => {
    const batchMaterials = materialsOf(unit.batch);
    return {
      characters: [...new Set([...acc.characters, ...batchMaterials.characters])].sort(),
      backgrounds: [...new Set([...acc.backgrounds, ...batchMaterials.backgrounds])].sort(),
      props: [...new Set([...acc.props, ...batchMaterials.props])].sort(),
    };
  }, { characters: [] as string[], backgrounds: [] as string[], props: [] as string[] });

  const manifestBody = {
    contract: 'edition-publication/1' as const,
    editionId: input.editionId,
    issueId: input.issueId,
    cefr: input.cefr,
    languagePackRevisionId: input.pack.id,
    units: ordered.map((unit, index) => ({
      unitRevisionId: unit.id,
      unitId: unit.unitId,
      order: index + 1,
      title: unit.title,
      batchDigest: digestOf(unit.batch),
      scenes: unit.batch.scenes.length,
      estimatedMinutes: unit.reports.teaching.estimatedMinutes,
    })),
    materials,
    sourceAcks: input.sources.map((source) => ({ ...source })),
    counts: {
      units: ordered.length,
      scenes: ordered.reduce((sum, unit) => sum + unit.batch.scenes.length, 0),
      words: ordered.reduce((sum, unit) => sum + countWords(unit.batch), 0),
    },
  };
  const manifest: ReleaseManifest = ReleaseManifestSchema.parse({
    ...manifestBody,
    digest: digestOf({
      units: manifestBody.units, sourceAcks: manifestBody.sourceAcks, materials: manifestBody.materials,
      counts: manifestBody.counts, editionId: manifestBody.editionId, issueId: manifestBody.issueId,
      cefr: manifestBody.cefr, languagePackRevisionId: manifestBody.languagePackRevisionId,
    }),
  });

  const body = {
    editionId: input.editionId,
    issueId: input.issueId,
    cefr: input.cefr,
    editorialRevisionId: input.editorial.id,
    corpusRevisionId: input.corpus.id,
    orderedUnitRevisionIds: ordered.map((unit) => unit.id),
    manifest,
    publishedAt: now,
    publishedBy: input.publishedBy,
  };
  return {
    id: newReleaseId(),
    ...body,
    status: 'published',
    supersedes: input.supersedes ?? null,
    supersededBy: null,
    digest: releaseDigest(body),
  };
}

let releaseCounter = 0;
/** 发布 ID 由调用方注入更合适；这里用一次性计数器 + 时间以保证同进程内唯一。 */
function newReleaseId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return `rel_${cryptoApi.randomUUID()}`;
  releaseCounter += 1;
  const tail = `${Date.now().toString(16)}${releaseCounter.toString(16)}`.padStart(12, '0').slice(-12);
  return `rel_00000000-0000-4000-8000-${tail}`;
}

function countWords(batch: Batch): number {
  return batch.scenes.reduce((sum, scene) => {
    const texts: string[] = [];
    if (scene.type === 'comic') for (const panel of scene.panels) {
      if (panel.caption) texts.push(panel.caption);
      for (const bubble of panel.bubbles) texts.push(bubble.text);
    } else if (scene.type === 'chat') for (const message of scene.messages) texts.push(message.text);
    else if (scene.type === 'card') texts.push(scene.front);
    else if (scene.type === 'pick') texts.push(scene.question);
    else if (scene.type === 'quiz') texts.push(scene.prompt);
    return sum + texts.reduce((count, text) => count + tokenize(text).length, 0);
  }, 0);
}

/** 发行更正：新发布取代旧发布，旧对象不覆盖、不自动删除。 */
export function supersedeRelease(previous: IssueRelease, next: IssueRelease): IssueRelease {
  if (previous.editionId !== next.editionId || previous.issueId !== next.issueId || previous.cefr !== next.cefr) {
    throw new Error('只能取代同一合辑同一期同等级的发行');
  }
  if (next.supersedes !== previous.id) throw new Error('新发行必须显式记录被取代的 Release');
  return { ...previous, status: 'superseded', supersededBy: next.id };
}

/** 撤回：保留私人历史与风险提示，不自动恢复为可公开分发状态。 */
export function withdrawRelease(release: IssueRelease, reason: string): IssueRelease & { withdrawReason: string } {
  return { ...release, status: 'withdrawn', withdrawReason: reason };
}

export interface InstalledUnit {
  revisionId: string;
  unitId: string;
  title: string;
  subtitle: string;
  description: string;
  batch: Batch;
  sceneSources: Record<string, string>;
  estimatedMinutes: number;
  /** 随发行冻结的教学目标清单（本单元首次教学目标）；旧安装包没有此字段 → 目标达成显示「目标信息不可用」。 */
  goalItems?: string[];
}

/** 离线安装包：正文、语言包、署名与编译依据必须自足，不依赖 API 或外部 URL。 */
export interface EditionPublicationPackage {
  contract: 'edition-publication/1';
  release: IssueRelease;
  pack: LanguagePackRevision;
  units: InstalledUnit[];
  /** 来源署名与许可：离线也能查看必要出处。 */
  sources: ReleaseSourceAck[];
  /** 书架展示信息：改名不改正文，但进入安装包摘要以便离线显示一致。 */
  display: { editionTitle: string; issueTitle: string } | null;
  digest: string;
}

export function buildPublicationPackage(
  release: IssueRelease,
  units: readonly UnitRevision[],
  pack: LanguagePackRevision,
  display: { editionTitle: string; issueTitle: string } | null = null,
): EditionPublicationPackage {
  const ordered = release.orderedUnitRevisionIds.map((id) => {
    const unit = units.find((entry) => entry.id === id);
    if (!unit) throw new Error(`安装包缺少单元修订 ${id}`);
    return unit;
  });
  const installed: InstalledUnit[] = ordered.map((unit) => ({
    revisionId: unit.id,
    unitId: unit.unitId,
    title: unit.title,
    subtitle: unit.subtitle,
    description: unit.description,
    batch: unit.batch,
    sceneSources: unit.creation.sceneSources,
    estimatedMinutes: unit.reports.teaching.estimatedMinutes,
    goalItems: [...new Set(unit.reports.teaching.contexts.map((entry) => entry.item))],
  }));
  const body = {
    contract: 'edition-publication/1' as const,
    release,
    pack,
    units: installed,
    sources: release.manifest.sourceAcks,
    display,
  };
  return { ...body, digest: digestOf(body) };
}

/** 安装校验：manifest、逐单元摘要、语言包等级、来源署名齐全。 */
export function publicationIssues(pkg: EditionPublicationPackage): { code: string; message: string }[] {
  const issues: { code: string; message: string }[] = [];
  try {
    if (pkg.contract !== 'edition-publication/1') throw new Error('不支持的安装包契约');
    assertReleaseManifest(pkg.release);
    issues.push(...languagePackIssues(pkg.pack));
  } catch {
    return [{ code: 'E-INSTALL-CONTRACT', message: '安装包契约、发行清单或版本无效' }];
  }
  if (digestOf({
    contract: pkg.contract, release: pkg.release, pack: pkg.pack, units: pkg.units,
    sources: pkg.sources, display: pkg.display,
  }) !== pkg.digest) issues.push({ code: 'E-INSTALL-DIGEST', message: '安装包摘要不匹配' });
  if (pkg.pack.cefr !== pkg.release.cefr) issues.push({ code: 'E-INSTALL-LEVEL', message: '语言包等级与发行等级不一致' });
  if (pkg.pack.id !== pkg.release.manifest.languagePackRevisionId) issues.push({ code: 'E-INSTALL-PACK', message: '语言包与发行依据不一致' });
  const manifestById = new Map(pkg.release.manifest.units.map((unit) => [unit.unitRevisionId, unit]));
  for (const [index, unit] of pkg.units.entries()) {
    const entry = manifestById.get(unit.revisionId);
    if (!entry) { issues.push({ code: 'E-INSTALL-MANIFEST', message: `安装包含有清单外的单元 ${unit.revisionId}` }); continue; }
    if (pkg.release.orderedUnitRevisionIds[index] !== unit.revisionId || entry.unitId !== unit.unitId ||
        entry.title !== unit.title || entry.estimatedMinutes !== unit.estimatedMinutes) {
      issues.push({ code: 'E-INSTALL-ORDER', message: '安装单元顺序、归属或展示信息与清单不一致' });
    }
    if (digestOf(unit.batch) !== entry.batchDigest) issues.push({ code: 'E-INSTALL-BODY', message: `${unit.revisionId} 的正文与清单摘要不一致` });
    if (unit.batch.scenes.length !== entry.scenes) issues.push({ code: 'E-INSTALL-SCENES', message: `${unit.revisionId} 的场景数与清单不一致` });
  }
  if (pkg.units.length !== pkg.release.manifest.units.length) issues.push({ code: 'E-INSTALL-COUNT', message: '安装单元数与清单不一致' });
  if (!pkg.sources.length) issues.push({ code: 'E-INSTALL-SOURCES', message: '缺少来源署名，离线无法查看必要出处' });
  if (digestOf(pkg.sources) !== digestOf(pkg.release.manifest.sourceAcks)) {
    issues.push({ code: 'E-INSTALL-SOURCES', message: '来源署名与发行清单不一致' });
  }
  return issues;
}
