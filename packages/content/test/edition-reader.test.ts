import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getOptions, getScenes } from '@endless/player';
import { edition } from '../src/index.js';

const lexicon = readFileSync(new URL('../../../apps/lab/data/lexicon/a1_a2.yaml', import.meta.url), 'utf8');
const sample = edition.createEditionSample(lexicon, { now: new Date('2026-10-24T08:00:00.000Z') });

function readUnit(run: edition.EditionRun, install = sample.install): edition.EditionRun {
  const unit = install.package.units[0]!;
  const episode = edition.runLibrary(run, [install]).episodes[0]!;
  let current = run;
  for (const scene of getScenes(episode)) {
    const options = getOptions(scene);
    if (options.length) current = edition.appendRunEvent(current, [install], {
      revisionId: unit.revisionId, unitId: unit.unitId, sceneId: scene.id,
      action: 'answer', payload: { choice: options.findIndex((option) => option.correct) },
      at: '2026-10-24T09:00:00.000Z',
    }).run;
    current = edition.appendRunEvent(current, [install], {
      revisionId: unit.revisionId, unitId: unit.unitId, sceneId: scene.id,
      action: 'advance', payload: { skip: false }, at: '2026-10-24T09:00:00.000Z',
    }).run;
  }
  return current;
}

describe('Edition 阅读恢复边界', () => {
  it('伪造资格或篡改正文的复习修订重算摘要也骗不过确定性重放', () => {
    // 无真实曝光的伪造 basis 会产出评分轨——因此伪造本身有后果
    const forgedBasis = edition.buildReviewBasis(sample.run, [sample.install], sample.pack, sample.release.issueId);
    forgedBasis.dueItems = [{ item: 'lx:hot#adj.temperature', exposures: 2, dueAt: null }];
    const forged = edition.buildReviewRevision(forgedBasis, sample.pack).revision;
    expect(forged.gradedItems).toContain('lx:hot#adj.temperature');
    expect(() => edition.assertReaderState([sample.install.package], [sample.run], [forged]))
      .toThrow(/复习资格|真实阅读前缀/);
    // 合法修订可重放；篡改选项并重算摘要仍被构造器重算拒绝
    const run = readUnit(sample.run);
    const basis = edition.buildReviewBasis(run, [sample.install], sample.pack, sample.release.issueId);
    const review = edition.buildReviewRevision(basis, sample.pack).revision;
    expect(() => edition.assertReaderState([sample.install.package], [run], [review])).not.toThrow();
    const tampered = structuredClone(review);
    const quiz = tampered.batch.scenes[0]!;
    if (quiz.type !== 'quiz') throw new Error('expected quiz');
    quiz.options[0]!.label = 'forged answer';
    tampered.digest = edition.reviewDigest(tampered);
    expect(() => edition.assertReaderState([sample.install.package], [run], [tampered])).toThrow(/确定性构造/);
  });

  it('第二次复习冻结真实 FSRS 到期状态，不丢弃已有复习事件', () => {
    let run = readUnit(sample.run);
    const at = new Date('2026-10-24T10:00:00.000Z');
    const first = edition.buildReviewRevision(
      edition.buildReviewBasis(run, [sample.install], sample.pack, sample.release.issueId, at), sample.pack,
    ).revision;
    const scene = first.batch.scenes[0]!;
    if (scene.type !== 'quiz') throw new Error('expected quiz');
    run = edition.appendRunEvent(run, [sample.install], {
      revisionId: first.id, unitId: `review:${first.id}`, sceneId: scene.id, action: 'answer',
      payload: { choice: scene.options.findIndex((option) => option.correct) }, at: at.toISOString(),
    }, [first]).run;
    const nextAt = new Date(at.getTime() + 1);
    const nextBasis = edition.buildReviewBasis(run, [sample.install], sample.pack, sample.release.issueId, nextAt, [first]);
    expect(nextBasis.dueItems.some((entry) => entry.dueAt !== null)).toBe(true);
    const next = edition.buildReviewRevision(nextBasis, sample.pack).revision;
    expect(() => edition.assertReaderState([sample.install.package], [run], [first, next])).not.toThrow();
  });

  it('复习按对应期刊选择语言包，而非安装顺序中的第一个', () => {
    const b1 = edition.createB1Sample(lexicon, new Date('2026-10-24T08:00:00.000Z'));
    const install = b1.installs[0]!;
    const run = readUnit(b1.run, install);
    const review = edition.buildReviewRevision(
      edition.buildReviewBasis(run, [install], b1.pack, install.release.issueId), b1.pack,
    ).revision;
    const expected = edition.runLibrary(run, [install], [review]).episodes.find((episode) => episode.id === review.id);
    const reversed = edition.runLibrary(run, [sample.install, install], [review]).episodes.find((episode) => episode.id === review.id);
    expect(reversed?.ast).toEqual(expected?.ast);
    expect(() => edition.assertReaderState([sample.install.package, install.package], [run], [review])).not.toThrow();
  });

  it('容器记录的外层 ID、类型与正文必须一致', () => {
    // 同 ID 的不同记录类型不能冒充引用闭包
    const crossType = edition.buildContainer('edition-backup/1', [
      { type: 'pack', id: sample.release.id, digest: '', body: { ...sample.pack, id: sample.release.id } },
      { type: 'run', id: sample.run.id, digest: '', body: sample.run },
    ]);
    const result = edition.importContainer(edition.serializeContainer(crossType));
    expect(result.accepted).toEqual([]);
    expect(result.issues.some((issue) => issue.code === 'E-IMPORT-CLOSURE')).toBe(true);
    // 外层 ID 与正文 ID 不一致
    const mismatched = edition.buildContainer('edition-backup/1', [{
      type: 'install', id: edition.newEditionId('rel'), digest: '', body: sample.install.package,
    }]);
    expect(edition.importContainer(edition.serializeContainer(mismatched)).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'E-IMPORT-CONTRACT' })]));
  });
});
