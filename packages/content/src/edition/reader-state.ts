import {
  EDITION_POLICY_VERSIONS, EDITION_REVIEW_CONSTRUCTOR_VERSION,
  EditionRunSchema, ReviewRevisionSchema, assertRun, isEditionId,
  type EditionId, type EditionRun, type ReviewRevision,
} from './contract.js';
import { canonicalJson, digestOf } from './digest.js';
import { publicationIssues, type EditionPublicationPackage } from './release.js';
import {
  buildReviewBasis, buildReviewRevision, eventPrefixHash, projectRun, unitEpisode, type EditionInstall,
} from './run.js';

/** Storage-only counters are not part of the portable Run contract. */
export function readerRun(run: EditionRun): EditionRun {
  const parsed = EditionRunSchema.parse(run);
  if (!isEditionId(parsed.id, 'run')) throw new Error('Run ID 类型不正确');
  return assertRun(parsed);
}

export function assertReaderRunExtension(previous: EditionRun, next: EditionRun): void {
  if (previous.editionId !== next.editionId || previous.editorialRevisionId !== next.editorialRevisionId ||
      previous.createdAt !== next.createdAt) throw new Error('Run 的固定依据不能改变');
  if (next.events.length < previous.events.length) throw new Error('拒绝回退历史');
  if (canonicalJson(previous.events) !== canonicalJson(next.events.slice(0, previous.events.length))) {
    throw new Error('阅读历史发生分叉，不能覆盖或拼接不同事件');
  }
  const consumed = new Set(previous.events.filter((event) => event.streamId.startsWith('issue:'))
    .map((event) => event.streamId.slice('issue:'.length)));
  for (const adopted of previous.adoptedReleases.filter((entry) => consumed.has(entry.issueId))) {
    if (!next.adoptedReleases.some((entry) => entry.issueId === adopted.issueId &&
        entry.releaseId === adopted.releaseId && entry.cefr === adopted.cefr)) {
      throw new Error('恢复会替换已发生事件的发行依据，拒绝合并');
    }
  }
}

/** Only a byte-identical event prefix may be extended; never combine divergent branches. */
export function mergeReaderRun(local: EditionRun, incoming: EditionRun): EditionRun {
  const left = readerRun(local);
  const right = readerRun(incoming);
  if (left.id !== right.id || left.editionId !== right.editionId ||
      left.editorialRevisionId !== right.editorialRevisionId || left.createdAt !== right.createdAt) {
    throw new Error('同 ID Run 的固定依据不同，拒绝恢复');
  }
  const common = Math.min(left.events.length, right.events.length);
  if (canonicalJson(left.events.slice(0, common)) !== canonicalJson(right.events.slice(0, common))) {
    throw new Error('阅读历史发生分叉，不能覆盖或拼接不同事件');
  }
  if (left.events.length === right.events.length) {
    if (canonicalJson(left.adoptedReleases) !== canonicalJson(right.adoptedReleases) ||
        canonicalJson(left.levelSchedule) !== canonicalJson(right.levelSchedule)) {
      throw new Error('相同事件前缀的采用清单不同，需要明确处理冲突');
    }
    return left;
  }
  const [older, newer] = left.events.length < right.events.length ? [left, right] : [right, left];
  assertReaderRunExtension(older, newer);
  return newer;
}

/** Validate the actual reader graph, not just hashes or the presence of matching IDs. */
export function assertReaderState(
  packages: readonly EditionPublicationPackage[],
  runs: readonly EditionRun[],
  reviews: readonly ReviewRevision[],
): void {
  const immutable = new Map<string, string>();
  const remember = (type: string, id: string, body: unknown) => {
    const key = `${type}:${id}`;
    const digest = digestOf(body);
    if (immutable.has(key) && immutable.get(key) !== digest) throw new Error(`对象 ${id} 内容不同，不能接受同 ID 异文`);
    immutable.set(key, digest);
  };
  const installs: EditionInstall[] = packages.map((pkg) => {
    const issues = publicationIssues(pkg);
    if (issues.length) throw new Error(issues.map((issue) => `${issue.code}：${issue.message}`).join('；'));
    remember('package', pkg.release.id, pkg);
    remember('release', pkg.release.id, pkg.release);
    remember('pack', pkg.pack.id, pkg.pack);
    for (const unit of pkg.units) {
      remember('unit', unit.revisionId, unit);
      if (unit.batch.batch !== unit.revisionId || unit.batch.scenes.some((scene) =>
        (scene.effects && Object.keys(scene.effects).length) || (scene.evidence && scene.evidence.type !== 'practice'))) {
        throw new Error('正文单元的批次绑定、剧情效果或练习证据不符合 Edition 契约');
      }
      unitEpisode(unit, pkg.release.issueId, pkg.pack);
    }
    return { release: pkg.release, package: pkg };
  });
  const byRelease = new Map(installs.map((install) => [install.release.id, install]));
  const byRun = new Map<string, EditionRun>();
  for (const value of runs) {
    const run = readerRun(value);
    if (byRun.has(run.id)) throw new Error('阅读记录 ID 重复');
    byRun.set(run.id, run);
    const scheduled = new Set(run.levelSchedule.map((entry) => entry.issueId));
    if (scheduled.size !== run.levelSchedule.length || scheduled.size !== run.adoptedReleases.length) {
      throw new Error('Run 的等级计划与采用清单不完整或重复');
    }
    for (const adopted of run.adoptedReleases) {
      const release = byRelease.get(adopted.releaseId)?.release;
      if (!release || release.editionId !== run.editionId ||
          release.editorialRevisionId !== run.editorialRevisionId ||
          release.issueId !== adopted.issueId || release.cefr !== adopted.cefr || !scheduled.has(adopted.issueId)) {
        throw new Error('Run 采用了缺失、其他合辑/目录或不同等级的发行');
      }
    }
  }
  const byReview = new Map<string, ReviewRevision>();
  for (const value of reviews) {
    const review = ReviewRevisionSchema.parse(value);
    if (!isEditionId(review.id, 'rvr') || byReview.has(review.id) || !byRun.has(review.runId)) {
      throw new Error('复习修订 ID 重复、类型不正确或缺少对应 Run');
    }
    byReview.set(review.id, review);
  }
  for (const run of byRun.values()) {
    const adopted = run.adoptedReleases.map((entry) => byRelease.get(entry.releaseId)!);
    const unitBindings = new Map(adopted.flatMap((install) => install.package.units.map((unit) =>
      [unit.revisionId, { unitId: unit.unitId, streamId: `issue:${install.release.issueId}` }] as const)));
    run.events.forEach((event, index) => {
      if (index && Date.parse(event.at) < Date.parse(run.events[index - 1]!.at)) throw new Error('阅读事件时间倒退');
      if (event.unitId.startsWith('review:')) {
        const review = byReview.get(event.revisionId);
        if (!review || review.runId !== run.id || event.unitId !== `review:${review.id}` ||
            event.streamId !== `review:${review.id}` || index < review.basis.eventCount) {
          throw new Error('复习事件未绑定有效的已冻结复习依据');
        }
      } else {
        const binding = unitBindings.get(event.revisionId);
        if (!binding || binding.unitId !== event.unitId || binding.streamId !== event.streamId) {
          throw new Error('阅读事件的单元、发行或事件流绑定不正确');
        }
      }
      if (event.action === 'answer' && event.payload.choice === undefined) throw new Error('答题事件缺少选项');
    });
    const validated: ReviewRevision[] = [];
    for (const review of [...byReview.values()].filter((entry) => entry.runId === run.id)
      .sort((a, b) => a.basis.eventCount - b.basis.eventCount)) {
      const install = adopted.find((entry) => entry.release.issueId === review.issueId);
      const basis = review.basis;
      if (!install || basis.runId !== run.id || basis.issueId !== review.issueId ||
          basis.cefr !== install.release.cefr || basis.eventCount > run.events.length ||
          basis.constructorVersion !== EDITION_REVIEW_CONSTRUCTOR_VERSION ||
          !EDITION_POLICY_VERSIONS.includes(basis.policyVersion)) {
        throw new Error('复习修订的发行、事件前缀或版本不受支持');
      }
      const prefix = { ...run, events: run.events.slice(0, basis.eventCount) };
      if (eventPrefixHash(prefix) !== basis.eventHash) throw new Error('复习修订的事件前缀摘要不一致');
      // 按冻结时记录的策略版本重算：旧依据走 v1 原语义，新依据走当前修正语义。
      const expectedBasis = buildReviewBasis(
        prefix, installs, install.package.pack, review.issueId, new Date(basis.createdAt), validated, basis.policyVersion,
      );
      if (canonicalJson(expectedBasis) !== canonicalJson(basis)) throw new Error('复习资格、取材行或到期状态与真实阅读前缀不一致');
      const expected = buildReviewRevision(basis, install.package.pack, review.id as EditionId, new Date(review.createdAt)).revision;
      if (canonicalJson(expected) !== canonicalJson(review)) throw new Error('复习正文、选项或证据与确定性构造结果不一致');
      validated.push(review);
    }
    projectRun(run, installs, validated);
  }
}
