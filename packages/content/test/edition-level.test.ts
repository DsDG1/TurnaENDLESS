import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getOptions, getScenes } from '@endless/player';
import { edition } from '../src/index.js';

/**
 * M5：第二等级（B1）与内容质量校准。
 *
 * 同一专题、同一组概念，语言与任务真实分级；旧事件仍绑定旧修订，
 * 不因换等级或装新版重复计数。
 */
const lexiconText = readFileSync(new URL('../../../apps/lab/data/lexicon/a1_a2.yaml', import.meta.url), 'utf8');
const a2 = edition.createEditionSample(lexiconText, { now: new Date('2026-10-24T08:00:00.000Z') });
const b1 = edition.createB1Sample(lexiconText, new Date('2026-10-24T08:00:00.000Z'));
const clock = (index: number) => new Date(Date.parse('2026-10-24T08:00:00.000Z') + index * 1000).toISOString();

function readUnit(
  run: edition.EditionRun,
  installs: readonly edition.EditionInstall[],
  revision: edition.UnitRevision,
) {
  const library = edition.runLibrary(run, installs);
  const episode = library.episodes.find((entry) => entry.id === revision.id)!;
  let next = run;
  let tick = 0;
  for (const scene of getScenes(episode)) {
    const options = getOptions(scene);
    if (options.length) {
      const choice = Math.max(0, options.findIndex((option) => option.correct === true));
      next = edition.appendRunEvent(next, installs, {
        revisionId: revision.id, unitId: revision.unitId, sceneId: scene.id,
        action: 'answer', payload: { choice }, at: clock(tick++),
      }).run;
    }
    next = edition.appendRunEvent(next, installs, {
      revisionId: revision.id, unitId: revision.unitId, sceneId: scene.id,
      action: 'advance', payload: { skip: false }, at: clock(tick++),
    }).run;
  }
  return next;
}

describe('第二等级 B1（M5）', () => {
  it('B1 语言包通过自检，且累积包含 A1–A2 形式而不是替换', () => {
    expect(edition.languagePackIssues(b1.pack)).toEqual([]);
    expect(b1.pack.cefr).toBe('B1');
    expect(edition.isOpenLevel('B1')).toBe(true);
    const b1Forms = new Set(b1.pack.baselineForms);
    const missing = a2.pack.baselineForms.filter((form) => !b1Forms.has(form));
    expect(missing).toEqual([]);
    // 12 个手写 B1 词条进入包内，且等级标注为 B1
    const hand = b1.pack.entries.filter((entry) => entry.sourceRef === 'b1-pack:hand-authored');
    expect(hand).toHaveLength(12);
    expect(hand.every((entry) => entry.cefr === 'B1')).toBe(true);
    expect(hand.every((entry) => entry.forms.length > 0 && entry.example)).toBe(true);
  });

  it('Q01：同一主题的两个等级保持概念与事实，语言和任务真实分级', () => {
    const a2Concepts = new Set(a2.unitPlans.flatMap((unit) => unit.conceptRefs));
    const b1Concepts = new Set(b1.unitPlans.flatMap((unit) => unit.conceptRefs));
    expect([...b1Concepts].sort()).toEqual([...a2Concepts].sort());

    const textOf = (project: edition.EditionSample | edition.B1Sample) =>
      project.corpus.passages.map((passage) => passage.textSegments.map((segment) => segment.text).join(' ')).join(' ');
    const a2Text = textOf(a2);
    const b1Text = textOf(b1);
    expect(b1Text).not.toBe(a2Text);

    const avgWords = (text: string) => {
      const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
      const words = text.split(/\s+/).filter(Boolean).length;
      return words / sentences.length;
    };
    // B1 的句子明显更长；若两者相同，说明只是换了标签
    expect(avgWords(b1Text)).toBeGreaterThan(avgWords(a2Text));

    // 每期只发行一个等级，且两版都通过验收
    expect(a2.release.cefr).toBe('A2');
    expect(b1.releases[0]!.cefr).toBe('B1');
    expect(b1.units.every((unit) => unit.cefr === 'B1' && unit.status === 'validated')).toBe(true);
    expect(edition.publicationIssues(b1.installs[0]!.package)).toEqual([]);
  });

  it('Q02：等级标签不能放行越级正文——B1 批次用 A2 词表衡量被判超纲', () => {
    const unit = b1.units[0]!;
    const plan = b1.levelPlans.find((entry) => entry.unitId === unit.unitId)!;
    const a2Allowed = edition.allowedFormsFor(a2.pack, {
      ...plan,
      cefr: 'A2',
    }, b1.targets[unit.unitId]!.map((target) => target.item));
    const metrics = edition.measureDifficulty(unit.batch, a2Allowed, a2.pack);
    expect(metrics.status).toBe('blocked');
    const issues = edition.difficultyIssues(metrics, a2.pack);
    expect(issues.map((issue) => issue.code)).toContain('E-EDITION-OOV');

    // 用本等级词表衡量则通过，说明阻断来自词表而不是随机阈值
    const b1Allowed = edition.allowedFormsFor(b1.pack, plan, b1.targets[unit.unitId]!.map((target) => target.item));
    expect(edition.difficultyIssues(edition.measureDifficulty(unit.batch, b1Allowed, b1.pack), b1.pack)
      .filter((issue) => issue.level === 'error')).toEqual([]);
  });

  it('P09：已发布的 B1 单元能在恢复后重新编译复核', () => {
    for (const unit of b1.units) {
      const plan = b1.levelPlans.find((entry) => entry.unitId === unit.unitId)!;
      const passage = b1.corpus.passages.find((entry) => unit.basis.passageRevisionIds.includes(entry.id))!;
      const issues = edition.verifyPublishedUnit({
        revision: JSON.parse(JSON.stringify(unit)) as edition.UnitRevision,
        editorial: b1.editorial,
        levelPlan: plan,
        targets: b1.targets[unit.unitId]!,
        pack: b1.pack,
        passages: [{ alias: 'p1', revision: passage }],
        corpus: b1.corpus,
        rights: b1.rights,
      });
      expect(issues.filter((issue) => issue.level === 'error')).toEqual([]);
    }
  });

  it('L08：装上新等级不改变旧事件绑定，也不重复计数', () => {
    const installs = [a2.install, b1.installs[0]!];
    // 同一本合辑同时采用两个等级的发行：事件仍按修订分别绑定
    let run = edition.createRun({
      editionId: a2.edition.id,
      editorialRevisionId: a2.editorial.id,
      releases: [a2.release, b1.releases[0]!],
      now: new Date('2026-10-24T08:00:00.000Z'),
    });
    // 没安装的发行不能切过去：目录会读不出来
    expect(() => edition.scheduleLevel(run, [], a2.release, 'A2')).toThrow(/已安装/);
    const a2Unit = a2.units[0]!;
    run = readUnit(run, installs, a2Unit);
    const before = edition.runExposureCounts(run, installs);
    const beforeCompletion = edition.runCompletion(run, installs, a2.editorial);

    const projection = edition.projectRun(run, installs);
    const a2Ids = new Set(a2.release.orderedUnitRevisionIds);
    expect([...a2Ids].some((id) => projection.view.episodes[id]?.scenes &&
      Object.values(projection.view.episodes[id]!.scenes).some((scene) => scene.completed))).toBe(true);
    expect(run.events.every((event) => a2Ids.has(event.revisionId))).toBe(true);

    const b1Unit = b1.units[0]!;
    run = readUnit(run, installs, b1Unit);
    const mixed = edition.runExposureCounts(run, installs);
    // B1 单元带来自己的目标曝光；A2 既有计数不因换等级翻倍
    for (const [item, count] of before) expect(mixed.get(item)).toBeGreaterThanOrEqual(count);
    const b1Items = new Set(b1.targets[b1Unit.unitId]!.map((target) => target.item));
    expect([...b1Items].some((item) => (mixed.get(item) ?? 0) > (before.get(item) ?? 0))).toBe(true);

    // 两个等级的完成口径分别可算，旧版阅读记录仍在
    const afterCompletion = edition.runCompletion(run, installs, b1.editorial);
    expect(beforeCompletion.reading.unitsRead).toBeGreaterThan(0);
    expect(afterCompletion.reading.unitsRead).toBeGreaterThanOrEqual(beforeCompletion.reading.unitsRead);
  });

  it('两个等级的安装包与运行记录在同一备份容器里往返', () => {
    const run = readUnit(a2.run, [a2.install], a2.units[0]!);
    const container = edition.buildBackupContainer({
      pack: b1.pack,
      installs: [a2.install.package, b1.installs[0]!.package],
      runs: [run],
      reviews: [],
      cutoff: { eventCount: run.events.length, eventHash: edition.eventPrefixHash(run) },
    });
    const text = edition.serializeContainer(container);
    const imported = edition.importContainer(text, { existing: new Map() });
    expect(imported.quarantined).toBe(false);
    expect(imported.issues).toEqual([]);
    expect(imported.accepted.filter((record) => record.type === 'install')).toHaveLength(2);
    expect(imported.accepted.filter((record) => record.type === 'run')).toHaveLength(1);
  });
});
