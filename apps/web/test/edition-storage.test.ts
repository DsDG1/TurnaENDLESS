import { readFileSync } from 'node:fs';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { edition } from '@endless/content';
import { exportProjection, getOptions, getScenes } from '@endless/player';
import { EditionRepository } from '../src/edition/storage.js';

const lexiconText = readFileSync(new URL('../../lab/data/lexicon/a1_a2.yaml', import.meta.url), 'utf8');
const sample = edition.createEditionSample(lexiconText, { now: new Date('2026-10-24T08:00:00.000Z') });

function readFirstUnit(run: edition.EditionRun) {
  let current = run;
  let tick = 0;
  const unit = sample.units[0]!;
  const library = edition.runLibrary(current, [sample.install]);
  const episode = library.episodes.find((entry) => entry.id === unit.id)!;
  for (const scene of getScenes(episode)) {
    const options = getOptions(scene);
    if (options.length) {
      current = edition.appendRunEvent(current, [sample.install], {
        revisionId: unit.id, unitId: unit.unitId, sceneId: scene.id, action: 'answer',
        payload: { choice: Math.max(0, options.findIndex((option) => option.correct === true)) },
        at: new Date(Date.parse('2026-10-24T09:00:00.000Z') + tick++ * 1000).toISOString(),
      }).run;
    }
    current = edition.appendRunEvent(current, [sample.install], {
      revisionId: unit.id, unitId: unit.unitId, sceneId: scene.id, action: 'advance', payload: { skip: false },
      at: new Date(Date.parse('2026-10-24T09:00:00.000Z') + tick++ * 1000).toISOString(),
    }).run;
  }
  return current;
}

async function seeded() {
  const factory = new IDBFactory();
  const repo = new EditionRepository(factory);
  const store = await repo.activateInstall(sample.install.package, 0);
  return { factory, repo, store };
}

describe('endless-editions 安装与提交', () => {
  it('安装后重新打开仍可读取出版包与语言包', async () => {
    const { factory, repo, store } = await seeded();
    expect(store.revision).toBe(1);
    expect(store.installs).toHaveLength(1);
    expect(store.packages[0]?.units).toHaveLength(3);
    await repo.close();
    const reopened = new EditionRepository(factory);
    const loaded = await reopened.load();
    expect(loaded.installs[0]?.releaseId).toBe(sample.release.id);
    expect(loaded.packages).toHaveLength(1);
    expect(loaded.revision).toBe(1);
    await reopened.close();
  });

  it('Run 提交保留事件与复习修订，重新打开后事件链仍可复核', async () => {
    const { factory, repo } = await seeded();
    const run = readFirstUnit(sample.run);
    await repo.commitRun(run, 1);
    const store = await repo.load();
    expect(store.revision).toBe(2);
    expect(store.runs[0]?.events.length).toBe(run.events.length);
    expect(edition.runEventIssues(store.runs[0]!)).toEqual([]);
    await repo.close();

    const reopened = new EditionRepository(factory);
    const again = await reopened.load();
    expect(again.runs[0]?.events.at(-1)?.hash).toBe(run.events.at(-1)?.hash);
    await reopened.close();
  });

  it('P03：repositoryRevision 不一致时拒绝提交，不出现最后写入覆盖', async () => {
    const { repo } = await seeded();
    const run = readFirstUnit(sample.run);
    await expect(repo.commitRun(run, 0)).rejects.toThrow(/另一个窗口已更新/);
    const store = await repo.load();
    expect(store.runs).toHaveLength(0);
    await repo.close();
  });

  it('已保存事件不能被截断或改写', async () => {
    const { repo } = await seeded();
    const run = readFirstUnit(sample.run);
    await repo.commitRun(run, 1);
    const shorter = { ...run, events: run.events.slice(0, 2), revision: run.revision + 1 };
    await expect(repo.commitRun(shorter, 2)).rejects.toThrow(/拒绝回退历史/);
    const rewritten = structuredClone(run);
    rewritten.events[0] = { ...rewritten.events[0]!, at: '2026-10-25T00:00:00.000Z' };
    await expect(repo.commitRun(rewritten, 2)).rejects.toThrow(/拒绝提交|摘要|哈希/);
    await repo.close();
  });

  it('P02：安装包摘要被改动时拒绝激活，原有内容不变', async () => {
    const { repo } = await seeded();
    const tampered = structuredClone(sample.install.package);
    tampered.units[0]!.title = '被改过的标题';
    await expect(repo.activateInstall(tampered, 1)).rejects.toThrow(/E-INSTALL-DIGEST/);
    const store = await repo.load();
    expect(store.packages[0]?.units[0]?.title).not.toBe('被改过的标题');
    await repo.close();
  });

  it('暂存区不会出现在已安装目录里', async () => {
    const { repo } = await seeded();
    await repo.stage('pending', { part: 1 });
    expect(await repo.staged<{ part: number }>('pending')).toEqual({ part: 1 });
    const store = await repo.load();
    expect(store.installs).toHaveLength(1);
    await repo.clearStaging();
    expect(await repo.staged('pending')).toBeNull();
    await repo.close();
  });

  it('阅读备份完整恢复复习修订与事件，重复导入幂等', async () => {
    const { repo } = await seeded();
    let run = readFirstUnit(sample.run);
    const basis = edition.buildReviewBasis(run, [sample.install], sample.pack, sample.release.issueId);
    const review = edition.buildReviewRevision(basis, sample.pack).revision;
    const scene = review.batch.scenes[0]!;
    run = edition.appendRunEvent(run, [sample.install], {
      revisionId: review.id, unitId: `review:${review.id}`, sceneId: scene.id,
      action: 'advance', payload: { skip: true },
    }, [review]).run;
    await repo.commitRun(run, 1, { reviews: [review] });
    const text = await repo.exportBackup();
    const target = new EditionRepository(new IDBFactory());
    await expect(target.importBackup(text)).rejects.toThrow(/信任|隔离/);
    expect((await target.load()).revision).toBe(0);
    expect(await target.importBackup(text, { trustReviewed: true })).toMatchObject({ installs: 1, runs: 1, ignored: [] });
    const loaded = await target.load();
    expect(loaded.reviews).toEqual([review]);
    expect(loaded.runs[0]?.events).toEqual(run.events);
    expect(exportProjection(edition.projectRun(loaded.runs[0]!, [sample.install], loaded.reviews).view))
      .toEqual(exportProjection(edition.projectRun(run, [sample.install], [review]).view));
    expect(await target.importBackup(text, { trustReviewed: true })).toMatchObject({ installs: 0, runs: 0, ignored: [] });
    expect((await target.load()).revision).toBe(loaded.revision);
    await repo.close();
    await target.close();
  });

  it('缺少复习对象或容器计数错误时拒绝导入，目标仓库不变', async () => {
    const { repo } = await seeded();
    const text = await repo.exportBackup();
    const parsed = edition.parseContainer(text);
    parsed.manifest.bytes += 1;
    await expect(repo.importBackup(edition.serializeContainer(parsed))).rejects.toThrow(/体积|清单/);
    expect((await repo.load()).revision).toBe(1);
    await repo.close();
  });

  it('P06：两个安装包共享同 ID 异文时整包拒绝，不能留下先安装的一期', async () => {
    const project = edition.createEditionScaleSample(lexiconText, { issues: 2, unitsPerIssue: 3 });
    const packages = project.installs.map((install) => structuredClone(install.package));
    const changed = packages[1]!;
    changed.pack.rights.note = 'different immutable pack';
    changed.pack.digest = edition.languagePackDigest(changed.pack);
    const { digest: _digest, ...body } = changed;
    changed.digest = edition.digestOf(body);
    const text = edition.serializeContainer(edition.buildBackupContainer({
      installs: packages, runs: [], reviews: [], cutoff: null,
    }));
    const repo = new EditionRepository(new IDBFactory());
    await expect(repo.importBackup(text, { trustReviewed: true })).rejects.toThrow(/内容不同|异文|冲突/);
    expect(await repo.load()).toMatchObject({ revision: 0, installs: [], runs: [], management: [] });
    await repo.close();
  });

  it('P05：导入较旧事件前缀保留本地后续记录，新备份只追加缺失后缀', async () => {
    const { repo } = await seeded();
    await repo.commitRun(sample.run, 1);
    const older = await repo.exportBackup();
    const completed = readFirstUnit(sample.run);
    await repo.commitRun(completed, 2);
    const newer = await repo.exportBackup();
    const before = await repo.load();
    await repo.importBackup(older, { trustReviewed: true });
    expect((await repo.load()).runs[0]?.events).toEqual(completed.events);
    expect((await repo.load()).revision).toBe(before.revision);

    const target = new EditionRepository(new IDBFactory());
    await target.importBackup(older, { trustReviewed: true });
    await target.importBackup(newer, { trustReviewed: true });
    expect((await target.load()).runs[0]?.events).toEqual(completed.events);
    const revision = (await target.load()).revision;
    await target.importBackup(newer, { trustReviewed: true });
    expect((await target.load()).revision).toBe(revision);
    await repo.close();
    await target.close();
  });

  it('恢复写入中途配额失败时整个事务回滚，原安装、事件与根不变', async () => {
    const { repo } = await seeded();
    const run = readFirstUnit(sample.run);
    await repo.commitRun(run, 1);
    const before = await repo.load();
    const project = edition.createEditionScaleSample(lexiconText, { issues: 2, unitsPerIssue: 3 });
    const text = edition.serializeContainer(edition.buildBackupContainer({
      installs: project.installs.map((entry) => entry.package), runs: [project.run], reviews: [], cutoff: null,
    }));
    const original = IDBObjectStore.prototype.put;
    let writes = 0;
    const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (++writes === 5) throw new DOMException('synthetic quota failure', 'QuotaExceededError');
      return original.call(this, value, key);
    });
    try {
      await expect(repo.importBackup(text, { trustReviewed: true })).rejects.toThrow(/恢复失败|保持不变/);
    } finally {
      failure.mockRestore();
    }
    expect(writes).toBe(5);
    expect(await repo.load()).toEqual(before);
    await repo.close();
  });

  it('两个仓库并发恢复只允许一个通过 CAS，不交错激活', async () => {
    const factory = new IDBFactory();
    const left = new EditionRepository(factory);
    const right = new EditionRepository(factory);
    const text = edition.serializeContainer(edition.buildBackupContainer({
      installs: [sample.install.package], runs: [sample.run], reviews: [], cutoff: null,
    }));
    const results = await Promise.allSettled([
      left.importBackup(text, { trustReviewed: true }), right.importBackup(text, { trustReviewed: true }),
    ]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
    expect(await left.load()).toMatchObject({ revision: 1 });
    expect((await right.load()).runs).toHaveLength(1);
    await left.close();
    await right.close();
  });

  it('新备份记录全部 Run 截止点与管理记录，旧 v2 仍可原样读取', async () => {
    const { repo } = await seeded();
    await repo.commitRun(readFirstUnit(sample.run), 1);
    const second = edition.createRun({
      editionId: sample.edition.id, editorialRevisionId: sample.editorial.id, releases: [sample.release],
    });
    await repo.commitRun(second, 2);
    const before = await repo.load();
    const exportedAt = new Date('2026-10-24T12:00:00.000Z');
    const container = edition.parseContainer(await repo.exportBackup(exportedAt));
    expect(container.manifest.createdAt).toBe(exportedAt.toISOString());
    expect(container.manifest.format).toBe('edition-backup/1');
    expect(container.manifest.containerVersion).toBe('edition-container-3');
    expect(container.manifest.readerSnapshot).toEqual({
      repositoryRevision: before.revision,
      runs: before.runs.map((run) => ({
        runId: run.id, eventCount: run.events.length, eventHash: edition.eventPrefixHash(run), runDigest: edition.digestOf(run),
      })),
    });
    expect(container.records.filter((entry) => entry.type === 'management').map((entry) => entry.body)).toEqual(before.management);
    const originalCutoffs = structuredClone(container.manifest.readerSnapshot);
    container.manifest.readerSnapshot!.runs[0]!.eventCount += 1;
    await expect(repo.importBackup(edition.serializeContainer(container), { trustReviewed: true })).rejects.toThrow(/截止/);
    container.manifest.readerSnapshot = originalCutoffs;
    const legacy = edition.buildBackupContainer({
      installs: [sample.install.package], runs: before.runs, reviews: [], cutoff: null,
    });
    legacy.manifest.containerVersion = 'edition-container-2';
    delete legacy.manifest.readerSnapshot;
    const target = new EditionRepository(new IDBFactory());
    await target.importBackup(edition.serializeContainer(legacy), { trustReviewed: true });
    expect((await target.load()).runs).toEqual(before.runs);
    await target.close();
    await repo.close();
  });

  it('分叉或不可重放的 Run 在导入与提交两侧都被拒绝，仓库不变', async () => {
    const { repo } = await seeded();
    const completed = readFirstUnit(sample.run);
    await repo.commitRun(completed, 1);
    const before = await repo.load();
    const divergent = structuredClone(completed);
    divergent.events[0]!.payload.skip = true;
    divergent.events[0]!.hash = edition.eventHash(divergent.events[0]!);
    const text = edition.serializeContainer(edition.buildBackupContainer({
      installs: [sample.install.package],
      runs: [{ ...divergent, events: divergent.events.slice(0, 1) }], reviews: [], cutoff: null,
    }));
    await expect(repo.importBackup(text, { trustReviewed: true })).rejects.toThrow(/分叉/);
    const unit = sample.units[0]!;
    const invalid = edition.appendRunEvent(sample.run, [sample.install], {
      revisionId: unit.id, unitId: unit.unitId, sceneId: 'missing-scene', action: 'advance', payload: { skip: false },
    }).run;
    invalid.id = edition.newEditionId('run');
    invalid.events[0]!.runId = invalid.id;
    invalid.events[0]!.hash = edition.eventHash(invalid.events[0]!);
    await expect(repo.commitRun(invalid, before.revision)).rejects.toThrow(/场景|顺序/);
    const badBackup = edition.serializeContainer(edition.buildBackupContainer({
      installs: [sample.install.package], runs: [invalid], reviews: [], cutoff: null,
    }));
    await expect(repo.importBackup(badBackup, { trustReviewed: true })).rejects.toThrow();
    expect(await repo.load()).toEqual(before);
    await repo.close();
  });
});
