import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getOptions, getScenes } from '@endless/player';
import { edition } from '../src/index.js';

const lexiconText = readFileSync(new URL('../../../apps/lab/data/lexicon/a1_a2.yaml', import.meta.url), 'utf8');
const sample = edition.createEditionSample(lexiconText, { now: new Date('2026-10-24T08:00:00.000Z') });

const clock = (index: number) => new Date(Date.parse('2026-10-24T08:00:00.000Z') + index * 1000).toISOString();

function unitInput(index: number, revision = sample.units[index]!): edition.EditionValidationInput {
  const levelPlan = sample.levelPlans[index]!;
  const passage = sample.corpus.passages.find((entry) => revision.basis.passageRevisionIds.includes(entry.id))!;
  return {
    revision,
    editorial: sample.editorial,
    levelPlan,
    targets: sample.targets[revision.unitId]!,
    pack: sample.pack,
    passages: [{ alias: 'p1', revision: passage }],
    corpus: sample.corpus,
    rights: sample.rights,
    allowedCharacters: ['shopkeeper', 'cat', 'guide'],
  };
}

/** 逐场推进：complete = 答对并真实读完；skip = 明确跳过。 */
function readUnits(indexes: readonly number[], mode: 'complete' | 'skip', start = sample.run) {
  let run = start;
  let tick = 0;
  for (const index of indexes) {
    const unit = sample.units[index]!;
    const library = edition.runLibrary(run, [sample.install]);
    const episode = library.episodes.find((entry) => entry.id === unit.id)!;
    for (const scene of getScenes(episode)) {
      const options = getOptions(scene);
      if (options.length && mode === 'complete') {
        const choice = options.findIndex((option) => option.correct === true);
        run = edition.appendRunEvent(run, [sample.install], {
          revisionId: unit.id, unitId: unit.unitId, sceneId: scene.id,
          action: 'answer', payload: { choice: Math.max(0, choice) }, at: clock(tick++),
        }).run;
      }
      run = edition.appendRunEvent(run, [sample.install], {
        revisionId: unit.id, unitId: unit.unitId, sceneId: scene.id,
        action: 'advance', payload: { skip: mode === 'skip' }, at: clock(tick++),
      }).run;
    }
  }
  return run;
}

describe('样刊闭环（M1）', () => {
  it('安装包即使重算外层摘要，也不能复制单元凑数量或替换语言包', () => {
    const pkg = structuredClone(sample.install.package);
    pkg.units[1] = pkg.units[0]!;
    const { digest: _digest, ...body } = pkg;
    pkg.digest = edition.digestOf(body);
    expect(edition.publicationIssues(pkg).some((issue) => issue.code === 'E-INSTALL-ORDER')).toBe(true);
    const wrongPack = structuredClone(sample.install.package);
    wrongPack.pack.id = edition.newEditionId('lpk');
    wrongPack.pack.digest = edition.languagePackDigest(wrongPack.pack);
    const { digest: _other, ...otherBody } = wrongPack;
    wrongPack.digest = edition.digestOf(otherBody);
    expect(edition.publicationIssues(wrongPack).some((issue) => issue.code === 'E-INSTALL-PACK')).toBe(true);
  });

  it('容器按 UTF-8 字节限额，并复核 manifest 清单、版本和解码体积', () => {
    expect(() => edition.buildContainer('edition-backup/1', [{
      type: 'edition', id: sample.edition.id, digest: '', body: { text: '中'.repeat(400_000) },
    }])).toThrow(/单条上限/);
    const container = edition.buildContainer('edition-backup/1', [{
      type: 'edition', id: sample.edition.id, digest: '', body: sample.edition,
    }]);
    for (const manifest of [
      { ...container.manifest, bytes: container.manifest.bytes + 1 },
      { ...container.manifest, objects: [] },
      { ...container.manifest, containerVersion: 'future' },
    ]) {
      expect(() => edition.parseContainer(edition.serializeContainer({ ...container, manifest }))).toThrow();
    }
    const legacy = {
      ...container,
      manifest: {
        ...container.manifest, containerVersion: 'edition-container-1',
        bytes: container.records.reduce((sum, record) => sum + edition.canonicalJson(record.body).length, 0),
      },
    };
    delete legacy.manifest.readerSnapshot;
    expect(edition.parseContainer(edition.serializeContainer(legacy)).records).toEqual(container.records);
  });

  it('3 个单元通过验收，一期原子发布，安装包自足', () => {
    expect(sample.units).toHaveLength(3);
    expect(sample.units.every((unit) => unit.status === 'validated')).toBe(true);
    expect(sample.release.status).toBe('published');
    expect(sample.release.manifest.counts.units).toBe(3);
    expect(sample.release.manifest.sourceAcks.length).toBeGreaterThan(0);
    expect(edition.publicationIssues(sample.install.package)).toEqual([]);
  });

  it('C01：相同草稿 + 相同依据重新编译，正文、选项、来源完全一致', () => {
    const unit = sample.units[0]!;
    const input = unitInput(0);
    const first = edition.compileEditionDraft(unit.draft, {
      seed: unit.id, batchId: unit.batch.batch, unitId: unit.unitId, cefr: unit.cefr,
      plan: input.levelPlan, pack: input.pack, passages: input.passages, targets: input.targets,
      readingBackground: 'cafe', allowedCharacters: input.allowedCharacters,
    });
    const second = edition.compileEditionDraft(unit.draft, {
      seed: unit.id, batchId: unit.batch.batch, unitId: unit.unitId, cefr: unit.cefr,
      plan: input.levelPlan, pack: input.pack, passages: input.passages, targets: input.targets,
      readingBackground: 'cafe', allowedCharacters: input.allowedCharacters,
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(edition.canonicalJson(first.batch)).toBe(edition.canonicalJson(second.batch));
    expect(edition.canonicalJson(first.creation)).toBe(edition.canonicalJson(second.creation));
  });

  it('C02：篡改正文并重算外层摘要，重编译比较仍拒绝', () => {
    const unit = structuredClone(sample.units[0]!);
    const comic = unit.batch.scenes.find((scene) => scene.type === 'comic' && scene.panels.some((panel) => panel.bubbles.length));
    if (!comic || comic.type !== 'comic') throw new Error('样刊缺少对话场景');
    comic.panels[0]!.bubbles[0]!.text = 'The coffee is cold.';
    const { digest: _ignored, ...rest } = unit;
    unit.digest = edition.unitRevisionDigest(rest);
    const result = edition.validateEditionUnit({ ...unitInput(0), revision: unit });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'E-EDITION-RECOMPILE')).toBe(true);
  });

  it('C03：替换语言包/正文/等级会因依据不匹配被拒绝', () => {
    const unit = structuredClone(sample.units[1]!);
    unit.basis = { ...unit.basis, languagePackRevisionId: 'lpk_00000000-0000-4000-8000-000000000099' };
    const { digest: _ignored, ...rest } = unit;
    unit.digest = edition.unitRevisionDigest(rest);
    const result = edition.validateEditionUnit({ ...unitInput(1), revision: unit });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'E-EDITION-BASIS')).toBe(true);
  });

  it('C05：两句一模一样不算两处语境', () => {
    const passage = sample.corpus.passages[0]!;
    const repetitive = {
      ...passage,
      id: 'psg_00000000-0000-4000-8000-0000000000aa',
      textSegments: [
        { ...passage.textSegments[0]!, text: 'The coffee is hot.' },
        { ...passage.textSegments[1]!, text: 'The coffee is hot.' },
      ],
    };
    const levelPlan = sample.levelPlans[0]!;
    const target = sample.targets[levelPlan.unitId]!.find((entry) => entry.introduce)!;
    const result = edition.compileEditionDraft([
      'EDITION-DRAFT/1',
      '@title 重复',
      '@subtitle Repeat',
      '@description 重复句子',
      '@reading p1',
      '@end',
      '@quiz meaning t1',
      '@end',
    ].join('\n'), {
      seed: 'urv_00000000-0000-4000-8000-0000000000bb',
      batchId: 'urv_00000000-0000-4000-8000-0000000000bb',
      unitId: levelPlan.unitId,
      cefr: 'A2',
      plan: levelPlan,
      pack: sample.pack,
      passages: [{ alias: 'p1', revision: repetitive }],
      targets: [{ ...target, alias: 't1' }],
      readingBackground: 'cafe',
      allowedCharacters: ['shopkeeper', 'cat', 'guide'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => /两处语义不同/.test(issue.message))).toBe(true);
  });

  it('C06：翻词卡与例句不能凑曝光，缺练习仍然阻断', () => {
    const passage = sample.corpus.passages[0]!;
    const levelPlan = sample.levelPlans[0]!;
    const target = sample.targets[levelPlan.unitId]!.find((entry) => entry.introduce)!;
    const result = edition.compileEditionDraft([
      'EDITION-DRAFT/1',
      '@title 只有卡片',
      '@subtitle Cards only',
      '@description 卡片不算练习',
      '@reading p1',
      '@end',
      '@card t1',
      '@end',
      '@fact t1',
      '@end',
    ].join('\n'), {
      seed: 'urv_00000000-0000-4000-8000-0000000000cc',
      batchId: 'urv_00000000-0000-4000-8000-0000000000cc',
      unitId: levelPlan.unitId,
      cefr: 'A2',
      plan: levelPlan,
      pack: sample.pack,
      passages: [{ alias: 'p1', revision: passage }],
      targets: [{ ...target, alias: 't1' }],
      readingBackground: 'cafe',
      allowedCharacters: ['shopkeeper', 'cat', 'guide'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => /缺少练习互动/.test(issue.message))).toBe(true);
  });
});

describe('阅读与学习证据（L01–L03、L06–L08）', () => {
  it('L01：生成与目录预览不产生曝光或完成记录', () => {
    const projection = edition.projectRun(sample.run, [sample.install]);
    expect(projection.view.exposed.size).toBe(0);
    expect(projection.units.every((unit) => unit.status === 'unread')).toBe(true);
    expect(edition.runExposureCounts(sample.run, [sample.install]).size).toBe(0);
  });

  it('L02：完成正文计曝光，跳过不计', () => {
    const read = readUnits([0], 'complete');
    const counts = edition.runExposureCounts(read, [sample.install]);
    expect(counts.get('lx:hot#adj.temperature')).toBeGreaterThanOrEqual(2);
    expect(counts.get('lx:cheap#adj.inexpensive')).toBeGreaterThanOrEqual(2);
    const skipped = readUnits([1], 'skip');
    const after = edition.runExposureCounts(skipped, [sample.install]);
    expect(after.get('lx:expensive#adj.costly') ?? 0).toBe(0);
    const projection = edition.projectRun(skipped, [sample.install]);
    expect(projection.units[1]?.status).toBe('finished_with_skips');
  });

  it('L03：单元内四选一答对只记 practice，不写 FSRS', () => {
    const read = readUnits([0], 'complete');
    const projection = edition.projectRun(read, [sample.install]);
    expect(projection.view.answers.length).toBeGreaterThan(0);
    for (const answer of projection.view.answers) {
      expect(answer.evidence).toBe('practice');
      expect(answer.grade).toBeNull();
      expect(answer.qualified).toBe(false);
    }
    expect(projection.view.srs.allCards()).toHaveLength(0);
  });

  it('L06：同一 eventId 重发去重，不同内容则拒绝', () => {
    const unit = sample.units[0]!;
    const scene = getScenes(edition.runLibrary(sample.run, [sample.install]).episodes.find((entry) => entry.id === unit.id)!)[0]!;
    const first = edition.appendRunEvent(sample.run, [sample.install], {
      eventId: 'evt_00000000-0000-4000-8000-000000000001',
      revisionId: unit.id, unitId: unit.unitId, sceneId: scene.id, action: 'advance', payload: { skip: false }, at: clock(1),
    });
    expect(first.duplicate).toBe(false);
    const second = edition.appendRunEvent(first.run, [sample.install], {
      eventId: 'evt_00000000-0000-4000-8000-000000000001',
      revisionId: unit.id, unitId: unit.unitId, sceneId: scene.id, action: 'advance', payload: { skip: false }, at: clock(1),
    });
    expect(second.duplicate).toBe(true);
    expect(second.run.events).toHaveLength(1);
    expect(() => edition.appendRunEvent(first.run, [sample.install], {
      eventId: 'evt_00000000-0000-4000-8000-000000000001',
      revisionId: unit.id, unitId: unit.unitId, sceneId: scene.id, action: 'advance', payload: { skip: true }, at: clock(1),
    })).toThrow(/不同内容/);
  });

  it('L07：全部跳过是 finished_with_skips，不是读完', () => {
    const run = readUnits([0, 1, 2], 'skip');
    const completion = edition.runCompletion(run, [sample.install], sample.editorial);
    expect(completion.reading.complete).toBe(false);
    expect(completion.reading.finishedWithSkips).toBe(true);
    expect(completion.publication.complete).toBe(true);
  });

  it('L08：已有真实阅读记录后不能在同一 Run 换等级版本', () => {
    const read = readUnits([0], 'complete');
    expect(() => edition.scheduleLevel(read, [sample.install], sample.release, 'A2')).toThrow(/真实阅读记录/);
  });
});

describe('独立复习轨（L04/L05）', () => {
  it('合格条目进入 4 选 1 评分轨，答对写 FSRS', () => {
    const read = readUnits([0, 1], 'complete');
    const basis = edition.buildReviewBasis(read, [sample.install], sample.pack, sample.release.issueId);
    expect(basis.dueItems.some((entry) => entry.item === 'lx:hot#adj.temperature' && entry.exposures >= 2)).toBe(true);
    const review = edition.buildReviewRevision(basis, sample.pack);
    expect(review.hasGradedItems).toBe(true);
    expect(edition.reviewIssues(review.revision, sample.pack)).toEqual([]);
    const gradedScene = review.revision.batch.scenes.find((scene) => scene.evidence?.type === 'recognition-4')!;
    const choice = gradedScene.type === 'quiz' ? gradedScene.options.findIndex((option) => option.correct) : -1;
    const answered = edition.appendRunEvent(read, [sample.install], {
      revisionId: review.revision.id,
      unitId: `review:${review.revision.id}`,
      sceneId: gradedScene.id,
      action: 'answer',
      payload: { choice },
      at: clock(50),
    }, [review.revision]);
    const projection = edition.projectRun(answered.run, [sample.install], [review.revision]);
    const answer = projection.view.answers.at(-1)!;
    expect(answer.grade).not.toBeNull();
    expect(answer.qualified).toBe(true);
  });

  it('提示后作答降级为 practice，不写 FSRS', () => {
    const read = readUnits([0], 'complete');
    const basis = edition.buildReviewBasis(read, [sample.install], sample.pack, sample.release.issueId);
    const review = edition.buildReviewRevision(basis, sample.pack);
    const gradedScene = review.revision.batch.scenes.find((scene) => scene.evidence?.type === 'recognition-4')!;
    const revealed = edition.appendRunEvent(read, [sample.install], {
      revisionId: review.revision.id, unitId: `review:${review.revision.id}`,
      sceneId: gradedScene.id, action: 'reveal', payload: {}, at: clock(60),
    }, [review.revision]);
    const choice = gradedScene.type === 'quiz' ? gradedScene.options.findIndex((option) => option.correct) : -1;
    const answered = edition.appendRunEvent(revealed.run, [sample.install], {
      revisionId: review.revision.id, unitId: `review:${review.revision.id}`,
      sceneId: gradedScene.id, action: 'answer', payload: { choice }, at: clock(61),
    }, [review.revision]);
    const projection = edition.projectRun(answered.run, [sample.install], [review.revision]);
    const answer = projection.view.answers.at(-1)!;
    expect(answer.evidence).toBe('practice');
    expect(answer.grade).toBeNull();
  });

  it('没有真实曝光时不凑成绩：只有练习', () => {
    const basis = edition.buildReviewBasis(sample.run, [sample.install], sample.pack, sample.release.issueId);
    const review = edition.buildReviewRevision(basis, sample.pack);
    expect(review.hasGradedItems).toBe(false);
    expect(review.revision.gradedItems).toEqual([]);
    expect(edition.reviewIssues(review.revision, sample.pack)).toEqual([]);
  });
});

describe('发布门禁与备份（P01/P06/Q04）', () => {
  it('P01：缺少单元的期不能发布', () => {
    expect(() => edition.createIssueRelease({
      editionId: sample.edition.id,
      issueId: sample.release.issueId,
      cefr: 'A2',
      editorial: sample.editorial,
      corpus: sample.corpus,
      rights: sample.rights,
      pack: sample.pack,
      units: [sample.units[0]!],
      sources: sample.release.manifest.sourceAcks,
      publishedBy: 'owner',
    })).toThrow(/E-RELEASE-MISSING/);
  });

  it('P06：备份容器往返一致，重复导入去重，未知信任根隔离', () => {
    const container = edition.buildBackupContainer({
      edition: sample.edition,
      editorial: sample.editorial,
      corpus: sample.corpus,
      rights: sample.rights,
      pack: sample.pack,
      releases: [sample.release],
      units: sample.units,
      runs: [readUnits([0], 'complete')],
      reviews: [],
      cutoff: null,
    });
    const text = edition.serializeContainer(container);
    const imported = edition.importContainer(text);
    expect(imported.quarantined).toBe(false);
    expect(imported.issues).toEqual([]);
    expect(imported.accepted.length).toBe(container.records.length);

    const existing = new Map(imported.accepted.map((record) => [`${record.type}:${record.id}`, record.digest]));
    const again = edition.importContainer(text, { existing });
    expect(again.accepted).toHaveLength(0);
    expect(again.skipped.length).toBe(container.records.length);

    const foreign = edition.importContainer(edition.serializeContainer(
      edition.buildContainer('edition-backup/1', container.records, { trustRoot: 'someone-else' }),
    ));
    expect(foreign.quarantined).toBe(true);
    expect(foreign.accepted).toHaveLength(0);
  });

  it('P06：同 ID 不同内容判为冲突，不采用最后覆盖', () => {
    const container = edition.buildBackupContainer({
      edition: sample.edition, editorial: sample.editorial, corpus: sample.corpus, rights: sample.rights,
      pack: sample.pack, releases: [sample.release], units: sample.units, runs: [], reviews: [], cutoff: null,
    });
    const text = edition.serializeContainer(container);
    const existing = new Map([[`release:${sample.release.id}`, edition.digestOf('different')]]);
    const result = edition.importContainer(text, { existing });
    expect(result.conflicts.some((entry) => entry.id === sample.release.id)).toBe(true);
    expect(result.accepted).toHaveLength(0);
  });

  it('Q04：审阅批准绑定当前摘要，正文改动后失效', () => {
    const approval = { targetId: sample.release.id, digest: sample.release.digest, reviewer: 'owner', approvedAt: clock(0) };
    expect(() => edition.assertApproval(approval, sample.release.id, sample.release.digest)).not.toThrow();
    expect(() => edition.assertApproval(approval, sample.release.id, edition.digestOf('changed'))).toThrow(/E-APPROVAL-STALE/);
  });

  it('发行对象与事件链可复核（E01：不触碰 ENDLESS 历史）', () => {
    expect(() => edition.assertIssueRelease(sample.release, sample.units)).not.toThrow();
    const read = readUnits([0], 'complete');
    expect(edition.runEventIssues(read)).toEqual([]);
    const tampered = structuredClone(read);
    tampered.events[0]!.payload = { skip: true };
    expect(edition.runEventIssues(tampered).some((issue) => issue.code === 'E-EVENT-HASH')).toBe(true);
  });
});
