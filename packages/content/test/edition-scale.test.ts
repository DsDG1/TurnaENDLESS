import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getOptions, getScenes } from '@endless/player';
import { edition } from '../src/index.js';

/**
 * M4 规模与可靠性：20 期 × 10 单元的合成项目走完整链路。
 *
 * 夹具是**合成语料**（同一批自有句子按单元轮换），验收的是引擎、体积与恢复，
 * 不是编辑质量。测得的数字写进 `docs/edition-design.md` §21，不编未验证的承诺。
 */
const lexiconText = readFileSync(new URL('../../../apps/lab/data/lexicon/a1_a2.yaml', import.meta.url), 'utf8');
const scale = edition.createEditionScaleSample(lexiconText, {
  issues: 20,
  unitsPerIssue: 10,
  now: new Date('2026-10-24T00:00:00.000Z'),
});
const clock = (index: number) => new Date(Date.parse('2026-10-24T00:00:00.000Z') + index * 1000).toISOString();

function unitInput(revision: edition.UnitRevision): edition.EditionValidationInput {
  const plan = scale.levelPlans.find((entry) => entry.unitId === revision.unitId)!;
  const passage = scale.corpus.passages.find((entry) => revision.basis.passageRevisionIds.includes(entry.id))!;
  return {
    revision,
    editorial: scale.editorial,
    levelPlan: plan,
    targets: scale.targets[revision.unitId]!,
    pack: scale.pack,
    passages: [{ alias: 'p1', revision: passage }],
    corpus: scale.corpus,
    rights: scale.rights,
    allowedCharacters: ['shopkeeper', 'cat', 'guide'],
  };
}

describe('规模夹具（M4）', () => {
  it('20 期 × 10 单元全部通过验收并逐期发布，安装包自足', () => {
    expect(scale.units).toHaveLength(200);
    expect(scale.releases).toHaveLength(20);
    expect(scale.installs).toHaveLength(20);
    for (const unit of scale.units) expect(unit.status).toBe('validated');
    for (const install of scale.installs) {
      expect(edition.publicationIssues(install.package)).toEqual([]);
      expect(install.package.units).toHaveLength(10);
      expect(install.release.orderedUnitRevisionIds).toHaveLength(10);
    }
    // 体积边界：单期安装包 < 150 KB，全刊安装包 < 3 MB；超出说明正文或素材被重复打包
    expect(scale.measurement.issuePackageBytes).toBeLessThan(150_000);
    expect(scale.measurement.packagesBytes).toBeLessThan(3_000_000);
    expect(scale.measurement.scenes).toBeGreaterThan(700);
  });

  it('任意单元都能重新编译复核（抽查首期、第 10 期、第 20 期）', () => {
    for (const index of [0, 3, 95, 199]) {
      const unit = scale.units[index]!;
      const issues = edition.verifyPublishedUnit(unitInput(unit));
      expect(issues.filter((issue) => issue.level === 'error')).toEqual([]);
    }
  });

  it('只读一个单元：完成与曝光只统计该单元的真实场景', () => {
    const unit = scale.units[0]!;
    const library = edition.runLibrary(scale.run, scale.installs);
    const episode = library.episodes.find((entry) => entry.id === unit.id)!;
    let run = scale.run;
    let tick = 0;
    for (const scene of getScenes(episode)) {
      const options = getOptions(scene);
      if (options.length) {
        const choice = Math.max(0, options.findIndex((option) => option.correct === true));
        run = edition.appendRunEvent(run, scale.installs, {
          revisionId: unit.id, unitId: unit.unitId, sceneId: scene.id,
          action: 'answer', payload: { choice }, at: clock(tick++),
        }).run;
      }
      run = edition.appendRunEvent(run, scale.installs, {
        revisionId: unit.id, unitId: unit.unitId, sceneId: scene.id,
        action: 'advance', payload: { skip: false }, at: clock(tick++),
      }).run;
    }
    const completion = edition.runCompletion(run, scale.installs, scale.editorial);
    const exposures = edition.runExposureCounts(run, scale.installs);
    expect(completion.reading.unitsRead).toBe(1);
    expect(completion.publication.issues).toHaveLength(20);
    expect(completion.publication.issues.every((entry) => entry.state === 'published')).toBe(true);
    // 只统计本单元的目标：其他 199 个单元的条目曝光为 0（不凭空产生学习记录）
    const touched = [...exposures.keys()];
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.length).toBeLessThanOrEqual(3);
    expect(edition.projectRun(run, scale.installs).view.exposed.size).toBeLessThanOrEqual(3);
  });

  it('20 期安装包 + Run 的备份容器可导出、可校验、可去重导入', () => {
    const container = edition.buildBackupContainer({
      pack: scale.pack,
      installs: scale.installs.map((install) => install.package),
      runs: [scale.run],
      reviews: [],
      cutoff: { eventCount: 0, eventHash: edition.eventPrefixHash(scale.run) },
    });
    const text = edition.serializeContainer(container);
    const parsed = edition.parseContainer(text);
    expect(parsed.records.filter((record) => record.type === 'install')).toHaveLength(20);
    const first = edition.importContainer(text, { existing: new Map() });
    expect(first.quarantined).toBe(false);
    expect(first.issues).toEqual([]);
    expect(first.accepted.filter((record) => record.type === 'install')).toHaveLength(20);
    const existing = new Map<string, string>();
    for (const record of parsed.records) existing.set(`${record.type}:${record.id}`, record.digest);
    const second = edition.importContainer(text, { existing });
    expect(second.accepted.filter((record) => record.type === 'install')).toHaveLength(0);
    expect(second.skipped.length).toBeGreaterThanOrEqual(20);
    // 体积测量：备份文本量与测量结果同数量级，便于报告存储边界
    expect(text.length).toBeGreaterThan(scale.measurement.packagesBytes * 0.9);
  });

  it('跨 20 期写入 300+ 事件后，事件链与投影仍可复算', () => {
    let run = scale.run;
    let tick = 0;
    let events = 0;
    const library = edition.runLibrary(run, scale.installs);
    for (const unit of scale.units) {
      const episode = library.episodes.find((entry) => entry.id === unit.id)!;
      for (const scene of getScenes(episode)) {
        run = edition.appendRunEvent(run, scale.installs, {
          revisionId: unit.id, unitId: unit.unitId, sceneId: scene.id,
          action: 'advance', payload: { skip: true }, at: clock(tick++),
        }).run;
        events += 1;
        if (events >= 320) break;
      }
      if (events >= 320) break;
    }
    expect(run.events.length).toBeGreaterThanOrEqual(320);
    expect(edition.runEventIssues(run)).toEqual([]);
    const restored = edition.assertRun(JSON.parse(JSON.stringify(run)));
    expect(restored.events.length).toBe(run.events.length);
    expect(edition.eventPrefixHash(restored)).toBe(edition.eventPrefixHash(run));
    expect(edition.runCompletion(restored, scale.installs, scale.editorial).reading).toEqual(edition.runCompletion(run, scale.installs, scale.editorial).reading);

    // 300+ 事件也走容器导出/导入：不只做 JSON 往返
    const container = edition.buildBackupContainer({
      pack: scale.pack,
      installs: scale.installs.map((install) => install.package),
      runs: [run],
      reviews: [],
      cutoff: { eventCount: run.events.length, eventHash: edition.eventPrefixHash(run) },
    });
    const text = edition.serializeContainer(container);
    const imported = edition.importContainer(text, { existing: new Map() });
    expect(imported.quarantined).toBe(false);
    expect(imported.issues).toEqual([]);
    const exportedRun = imported.accepted.find((record) => record.type === 'run')!.body as edition.EditionRun;
    expect(exportedRun.events).toHaveLength(run.events.length);
    expect(edition.eventPrefixHash(exportedRun)).toBe(edition.eventPrefixHash(run));
  });
});
