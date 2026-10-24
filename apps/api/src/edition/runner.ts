/**
 * Edition 的确定性编译执行器（M2）。
 *
 * 一个 `compile_issue` 单元只做两件事：**复核**已登记的草稿，然后把它作为
 * 不可变单元对象落库。复核复用共享契约里的 `verifyPublishedUnit`（重新编译、
 * 逐项比较、路径验收），所以「保存成功」不等于「模型说了算」。
 *
 * 模型路径以 `EditorialModel` 接口暴露，但默认未配置：没有 provider Key 或
 * 提示词闭环时不伪造成功，任务会以明确的安全分类失败，也不会调用任何外部服务。
 */
import { edition } from '@endless/content';
import type { EditionStore } from './store.js';
import type { EditionUnitResult, EditionUnitRunner } from './jobs.js';
import type { PromptPair } from './prompts.js';

type EditionValidationInput = edition.EditionValidationInput;
type UnitRevision = edition.UnitRevision;

export interface EditorialModel {
  readonly name: string;
  complete(prompt: PromptPair): Promise<string>;
}

export class EditorialModelUnavailableError extends Error {
  override name = 'EditorialModelUnavailableError';
  constructor(message = '未配置编辑模型：可以导入已批准草稿，或先配置 provider 后再生成') {
    super(message);
  }
}

export interface DraftUnitRecord {
  /** 已编译并验收过的单元修订。 */
  revision: UnitRevision;
  /** 复核所需的完整依据（计划、语言包、正文、语料、权利）。 */
  context: EditionValidationInput;
  model?: { name: string; promptVersion: string } | null;
}

/** 草稿对象的固定类型：导入路径只接受这个类型，避免任意对象冒充草稿。 */
export const DRAFT_OBJECT_TYPE = 'unit-draft';

export function putDraftUnit(store: EditionStore, unitId: string, record: DraftUnitRecord): void {
  store.putObject(DRAFT_OBJECT_TYPE, unitId, edition.digestOf(record), record);
}

export function createEditionCompileRunner(
  store: EditionStore,
  options: { model?: EditorialModel | null } = {},
): EditionUnitRunner {
  return async ({ unitId, job }): Promise<EditionUnitResult> => {
    if (job.kind !== 'compile_issue') throw new EditorialModelUnavailableError();
    const drafts = store.objectsById(DRAFT_OBJECT_TYPE, unitId).map((object) => object.body as DraftUnitRecord);
    const candidates = drafts.filter((record) => record.revision?.basis.editionId === job.editionId &&
      record.revision.basis.editorialRevisionId === job.editorialRevisionId &&
      record.revision.basis.issuePlanId === job.issuePlanId && record.revision.cefr === job.cefr);
    if (!candidates.length) {
      if (drafts.length) throw new Error('草稿与任务的合辑、目录、期或等级依据不一致');
      if (!options.model) throw new EditorialModelUnavailableError();
      throw new EditorialModelUnavailableError(
        `编辑模型 ${options.model.name} 已配置，但本期缺少已批准的分级计划/语言包/正文上下文，不能直接生成单元`,
      );
    }
    if (candidates.length !== 1) throw new Error('同一依据有多个草稿修订，必须明确选择成稿');
    const record = candidates[0]!;
    if (!record?.revision || !record.context) throw new Error('草稿对象缺少修订或复核依据');
    const approval = store.latestApproval(job.editionId, 'plan', record.context.editorial.id);
    if (approval?.digest !== record.context.editorial.digest) throw new Error('目录审批摘要与草稿依据不一致');
    // 以草稿里的修订为准复核：不能相信 context 自带的旧 revision（改一个字不改摘要）
    const issues = edition.verifyPublishedUnit({ ...record.context, revision: record.revision });
    const errors = issues.filter((issue) => issue.level === 'error');
    if (errors.length) {
      throw new Error(`单元 ${unitId} 复核未通过：${errors.map((issue) => issue.message).join('；')}`);
    }
    return {
      objectType: 'unit',
      objectId: record.revision.id,
      objectDigest: record.revision.digest,
      body: record.revision,
    };
  };
}

/** 发布时仍需复核完整草稿依据，不能把 schema 合法或自述 validated 当成验收。 */
export function verifyReleaseForPublication(store: EditionStore, release: edition.IssueRelease): void {
  const objects = store.getUnitsByIds(release.orderedUnitRevisionIds);
  const units = objects.map((object) => edition.UnitRevisionSchema.parse(object.body));
  edition.assertIssueRelease(release, units);
  for (const unit of units) {
    const records = store.objectsById(DRAFT_OBJECT_TYPE, unit.unitId);
    const draft = records.map((object) => object.body as DraftUnitRecord)
      .find((record) => record.revision?.id === unit.id && record.revision.digest === unit.digest);
    if (!draft?.context) throw new Error('缺少可重编译的草稿依据，不能发布');
    const input = { ...draft.context, revision: unit };
    if (edition.verifyPublishedUnit(input).some((issue) => issue.level === 'error')) throw new Error('成稿复核未通过');
    const approval = store.latestApproval(release.editionId, 'plan', input.editorial.id);
    if (approval?.digest !== input.editorial.digest) throw new Error('目录尚未按当前摘要审批');
    const issues = edition.releaseIssues({
      editionId: release.editionId, issueId: release.issueId, cefr: release.cefr,
      editorial: input.editorial, corpus: input.corpus, rights: input.rights, pack: input.pack,
      units, sources: release.manifest.sourceAcks, publishedBy: release.publishedBy,
    });
    if (issues.length) throw new Error('发行的目录、资料、权利或成稿集合未通过验收');
  }
}

/** 供路由/文档展示：当前执行器支持的能力与明确缺口。 */
export const editionRunnerCapabilities = {
  deterministicCompile: true,
  /** 已批准草稿可以通过 `POST /api/editions/:id/drafts` 登记，随后 compile_issue 做确定性复核。 */
  draftRegistration: true,
  modelDrafts: false,
  /** 研究与抓取是库级能力：已有实现与测试，但还没有 HTTP 路由与界面。 */
  research: 'library-only',
  fetch: 'library-only',
  fetchTransport: 'node-https（固定 IP + 原域名 SNI）',
  note: '正文草稿需先登记（POST /api/editions/:id/drafts）才能确定性复核；模型自动写作仍需显式配置 EditorialModel。',
} as const;
