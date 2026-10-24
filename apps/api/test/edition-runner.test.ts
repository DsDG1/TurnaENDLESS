import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { edition } from '@endless/content';
import { EditionStore } from '../src/edition/store.js';
import { EditionJobManager } from '../src/edition/jobs.js';
import { createEditionCompileRunner, putDraftUnit } from '../src/edition/runner.js';

const lexiconText = readFileSync(new URL('../../lab/data/lexicon/a1_a2.yaml', import.meta.url), 'utf8');
const sample = edition.createEditionSample(lexiconText, { now: new Date('2026-10-24T08:00:00.000Z') });

function contextFor(unit: edition.UnitRevision): edition.EditionValidationInput {
  const plan = sample.levelPlans.find((entry) => entry.unitId === unit.unitId)!;
  const passage = sample.corpus.passages.find((entry) => unit.basis.passageRevisionIds.includes(entry.id))!;
  return {
    revision: unit,
    editorial: sample.editorial,
    levelPlan: plan,
    targets: sample.targets[unit.unitId]!,
    pack: sample.pack,
    passages: [{ alias: 'p1', revision: passage }],
    corpus: sample.corpus,
    rights: sample.rights,
    allowedCharacters: ['shopkeeper', 'cat', 'guide'],
  };
}

function setup() {
  const store = new EditionStore(':memory:');
  const editionId = sample.edition.id;
  const editorialId = sample.editorial.id;
  store.putEdition({
    id: editionId, title: 'runner', subtitle: '', description: '', headEditorialRevisionId: editorialId,
    revision: 0, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
    status: 'planned', cefr: 'A2', searchAvailable: false,
  });
  return { store, editionId, editorialId };
}

function submit(manager: EditionJobManager, editionId: string, editorialId: string, unitIds: string[]) {
  const taskDigest = edition.compileTaskDigest({
    kind: 'compile_issue', editionId, editorialRevisionId: editorialId, issuePlanId: sample.release.issueId,
    cefr: 'A2', unitIds, intent: 'initial',
  });
  return manager.submit({
    requestId: randomUUID(), kind: 'compile_issue', editionId, editorialRevisionId: editorialId,
    issuePlanId: sample.release.issueId, cefr: 'A2', unitIds, intent: 'initial',
    expectedProjectRevision: 1, approvedTaskDigest: taskDigest,
  });
}

describe('确定性编译执行器（M2）', () => {
  it('复核已登记草稿后落库为不可变单元；不需要模型调用', async () => {
    const { store, editionId, editorialId } = setup();
    store.addApproval({ editionId, targetType: 'plan', targetId: editorialId, digest: sample.editorial.digest, reviewer: 'owner' });
    const unit = sample.units[0]!;
    putDraftUnit(store, unit.unitId, { revision: unit, context: contextFor(unit) });
    const manager = new EditionJobManager(store, createEditionCompileRunner(store));
    const job = submit(manager, editionId, editorialId, [unit.unitId]);
    await manager.settle(job.job.id);
    expect(manager.get(job.job.id)?.job.status).toBe('succeeded');
    expect(store.getObject(unit.digest)?.id).toBe(unit.id);
  });

  it('复核失败时不落库、不谎报成功', async () => {
    const { store, editionId, editorialId } = setup();
    store.addApproval({ editionId, targetType: 'plan', targetId: editorialId, digest: sample.editorial.digest, reviewer: 'owner' });
    const unit = sample.units[0]!;
    // 改一个字但保留旧摘要：契约层必须拒绝，不能只信对象自述
    const tampered = { ...unit, title: `${unit.title}（改）` };
    putDraftUnit(store, unit.unitId, { revision: tampered, context: contextFor(unit) });
    const manager = new EditionJobManager(store, createEditionCompileRunner(store));
    const job = submit(manager, editionId, editorialId, [unit.unitId]);
    await manager.settle(job.job.id);
    expect(manager.get(job.job.id)?.job.status).toBe('failed');
    expect(store.getObject(unit.digest)).toBeNull();
    expect(manager.get(job.job.id)?.job.attempts.at(-1)?.failureCode).toBe('content');
  });

  it('没有已批准草稿且没有模型时，明确失败而不是伪造单元', async () => {
    const { store, editionId, editorialId } = setup();
    store.addApproval({ editionId, targetType: 'plan', targetId: editorialId, digest: `sha256:${'c'.repeat(64)}`, reviewer: 'owner' });
    const manager = new EditionJobManager(store, createEditionCompileRunner(store));
    const job = submit(manager, editionId, editorialId, [`unt_${randomUUID()}`]);
    await manager.settle(job.job.id);
    expect(manager.get(job.job.id)?.job.status).toBe('failed');
    expect(store.countObjects('unit')).toBe(0);
    expect(manager.describeFailure(manager.get(job.job.id)!.job)?.code).toBe('unconfigured');
  });

  it('拒绝将其他等级的合格草稿用于当前任务', async () => {
    const { store, editionId, editorialId } = setup();
    const unit = sample.units[0]!;
    putDraftUnit(store, unit.unitId, { revision: unit, context: contextFor(unit) });
    store.addApproval({ editionId, targetType: 'plan', targetId: editorialId, digest: sample.editorial.digest, reviewer: 'owner' });
    const manager = new EditionJobManager(store, createEditionCompileRunner(store));
    const input = {
      kind: 'compile_issue' as const, editionId, editorialRevisionId: editorialId,
      issuePlanId: sample.release.issueId, cefr: 'B1' as const, unitIds: [unit.unitId], intent: 'initial',
    };
    const row = manager.submit({
      ...input, requestId: randomUUID(), expectedProjectRevision: 1,
      approvedTaskDigest: edition.compileTaskDigest(input),
    });
    await manager.settle(row.job.id);
    expect(manager.get(row.job.id)?.job.status).toBe('failed');
    expect(store.countObjects('unit')).toBe(0);
  });

  it('目录审批必须绑定真实目录摘要，而不只是存在审批记录', async () => {
    const { store, editionId, editorialId } = setup();
    const unit = sample.units[0]!;
    putDraftUnit(store, unit.unitId, { revision: unit, context: contextFor(unit) });
    store.addApproval({ editionId, targetType: 'plan', targetId: editorialId, digest: `sha256:${'f'.repeat(64)}`, reviewer: 'owner' });
    const manager = new EditionJobManager(store, createEditionCompileRunner(store));
    const row = submit(manager, editionId, editorialId, [unit.unitId]);
    await manager.settle(row.job.id);
    expect(manager.get(row.job.id)?.job.status).toBe('failed');
    expect(store.countObjects('unit')).toBe(0);
  });
});
