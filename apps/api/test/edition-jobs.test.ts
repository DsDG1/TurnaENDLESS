import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { edition } from '@endless/content';
import { EditionStore } from '../src/edition/store.js';
import { EditionJobError, EditionJobManager, type EditionUnitRunner } from '../src/edition/jobs.js';
import { ExecutionGate } from '../src/execution-gate.js';
import { JobManager } from '../src/jobs.js';

const editionId = 'edn_11111111-1111-4111-8111-111111111111';
const editorialId = 'edr_11111111-1111-4111-8111-111111111111';
const issueId = 'iss_11111111-1111-4111-8111-111111111111';
const digest = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;
const units = (n: number) => Array.from({ length: n }, () => `unt_${randomUUID()}`);

function setup(runner?: EditionUnitRunner) {
  const store = new EditionStore(':memory:');
  store.putEdition({
    id: editionId, title: 't', subtitle: '', description: '', headEditorialRevisionId: editorialId,
    revision: 0, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
    status: 'planned', cefr: 'A2', searchAvailable: false,
  });
  store.addApproval({ editionId, targetType: 'plan', targetId: editorialId, digest: digest('a'), reviewer: 'owner' });
  const manager = new EditionJobManager(store, runner ?? null);
  return { store, manager };
}

function submit(manager: EditionJobManager, input: { requestId?: string; unitIds: string[]; intent?: string; kind?: 'compile_issue' | 'build_plan'; expected?: number; cefr?: 'A2' | 'B1' }) {
  const kind = input.kind ?? 'compile_issue';
  const intent = input.intent ?? 'initial';
  const cefr = input.cefr ?? 'A2';
  const taskDigest = edition.compileTaskDigest({
    kind, editionId, editorialRevisionId: editorialId, issuePlanId: issueId, cefr,
    unitIds: input.unitIds, intent,
  });
  return manager.submit({
    requestId: input.requestId ?? randomUUID(),
    kind,
    editionId,
    editorialRevisionId: editorialId,
    issuePlanId: issueId,
    cefr,
    unitIds: input.unitIds,
    intent,
    expectedProjectRevision: input.expected ?? 1,
    approvedTaskDigest: taskDigest,
  });
}

describe('编纂任务状态机（M2 / J01–J09）', () => {
  it('J01：同 requestId 返回原任务；不同依据 409；客户端摘要不被信任', async () => {
    const { manager } = setup(async ({ unitId }) => ({
      objectType: 'unit', objectId: unitId, objectDigest: digest('b'), body: { unitId },
    }));
    const [unit] = units(1);
    const requestId = 'req-j01';
    const first = submit(manager, { requestId, unitIds: [unit!] });
    await manager.settle(first.job.id);
    const again = submit(manager, { requestId, unitIds: [unit!] });
    expect(again.job.id).toBe(first.job.id);
    expect(() => submit(manager, { requestId, unitIds: [unit!], intent: 'rewrite' })).toThrow(EditionJobError);
    // 客户端伪造「已批准」摘要：服务端重算后拒绝，不创建任务
    expect(() => manager.submit({
      requestId: 'req-forged', kind: 'compile_issue', editionId, editorialRevisionId: editorialId,
      issuePlanId: issueId, cefr: 'A2', unitIds: [unit!], intent: 'initial',
      expectedProjectRevision: 1, approvedTaskDigest: digest('c'),
    })).toThrow(/摘要不一致/);
  });

  it('J03：预留写盘失败 → 零供应商调用', async () => {
    let calls = 0;
    const { store, manager } = setup(async () => {
      calls += 1;
      throw new Error('unused');
    });
    store.reserveAttempt = () => { throw new Error('disk full'); };
    const job = submit(manager, { unitIds: units(2) });
    await manager.settle(job.job.id);
    expect(calls).toBe(0);
    expect(manager.get(job.job.id)?.job.status).toBe('failed');
  });

  it('J04：调用开始后失败 → 记 failed，重启只标记 unknown，不自动重放', async () => {
    let calls = 0;
    const { store, manager } = setup(async () => {
      calls += 1;
      throw new Error('boom');
    });
    const job = submit(manager, { unitIds: units(1) });
    await manager.settle(job.job.id);
    expect(calls).toBe(1);
    const saved = store.listAttempts(job.job.id);
    expect(saved[0]?.status).toBe('failed');
    // 模拟「调用已开始但结果未保存」的崩溃现场
    const attempt = store.reserveAttempt({
      jobId: job.job.id, unitId: 'unt_crash', workKey: 'crash-work',
      status: 'reserved', startedAt: '2026-10-24T00:00:00.000Z', failureCode: null,
    });
    store.markAttempt(attempt.seq, 'call_started');
    store.updateJob({ ...manager.get(job.job.id)!.job, status: 'running' });
    const recovery = manager.initialize();
    expect(recovery.unknown).toBe(1);
    expect(store.listAttempts(job.job.id).find((row) => row.workKey === 'crash-work')?.status).toBe('unknown');
    expect(calls).toBe(1);
  });

  it('J05：部分成功后失败，继续缺失单元时不重复成功单元', async () => {
    const seen: string[] = [];
    let fail = true;
    const { manager } = setup(async ({ unitId }) => {
      if (fail && seen.length === 1) throw new Error('provider down');
      seen.push(unitId);
      return { objectType: 'unit', objectId: unitId, objectDigest: digest('d'), body: { unitId } };
    });
    const [a, b] = units(2);
    const first = submit(manager, { unitIds: [a!, b!] });
    await manager.settle(first.job.id);
    expect(manager.get(first.job.id)?.job.status).toBe('failed');
    expect(seen).toEqual([a]);
    fail = false;
    const second = submit(manager, { unitIds: [a!, b!], intent: 'continue_missing' });
    await manager.settle(second.job.id);
    expect(seen).toEqual([a, b]);
    expect(manager.get(second.job.id)?.job.status).toBe('succeeded');
  });

  it('J06：供应商限流给出安全分类，不自动重试、不回显内部错误', async () => {
    let calls = 0;
    const { manager } = setup(async () => {
      calls += 1;
      throw Object.assign(new Error('429 {"error":"rate limit; key sk-secret"}'), { statusCode: 429 });
    });
    const job = submit(manager, { unitIds: units(1) });
    await manager.settle(job.job.id);
    expect(calls).toBe(1);
    const saved = manager.get(job.job.id)!;
    expect(saved.job.attempts.at(-1)?.failureCode).toBe('rate-limit');
    const failure = manager.describeFailure(saved.job)!;
    expect(failure.message).toMatch(/限流|额度/);
    expect(failure.message).not.toContain('sk-secret');
    expect(JSON.stringify(saved.job)).not.toContain('sk-secret');
  });

  it('J05：去重隔离任务类型和等级，主动再写一版不会被当成继续', async () => {
    const calls: string[] = [];
    const { manager } = setup(async ({ job, unitId }) => {
      calls.push(`${job.kind}:${job.cefr}`);
      return { objectType: 'unit', objectId: unitId, objectDigest: digest('8'), body: { unitId } };
    });
    const unitIds = units(1);
    for (const input of [
      { kind: 'build_plan' as const }, {}, { cefr: 'B1' as const },
      { intent: 'continue_missing' }, { intent: 'rewrite' },
    ]) {
      const row = submit(manager, { ...input, unitIds });
      await manager.settle(row.job.id);
      expect(manager.get(row.job.id)?.job.status).toBe('succeeded');
    }
    expect(calls).toEqual(['build_plan:A2', 'compile_issue:A2', 'compile_issue:B1', 'compile_issue:A2']);
  });

  it('J02：执行槽严格互斥——endless 在跑时 edition 提交直接 429，且不建任务', async () => {
    let calls = 0;
    const gate = new ExecutionGate();
    const { store } = setup(async () => {
      calls += 1;
      throw new Error('unused');
    });
    const gated = new EditionJobManager(store, async () => {
      calls += 1;
      throw new Error('unused');
    }, gate);

    gate.acquire('endless');
    expect(() => submit(gated, { kind: 'build_plan', unitIds: [] })).toThrow(/等待完成后再开始 Edition/);
    expect(store.listJobs(editionId)).toHaveLength(0);
    expect(calls).toBe(0);
    gate.release('endless');

    // 同模式也拒绝：两个 Edition 任务不能同时占用供应商
    gate.acquire('edition');
    expect(() => submit(gated, { kind: 'build_plan', unitIds: [] })).toThrow(/已有一个 Edition 编纂任务/);
    expect(store.listJobs(editionId)).toHaveLength(0);
    gate.release('edition');

    // 反向：Edition 持有槽位时，ENDLESS 提交直接 429
    gate.acquire('edition');
    const endless = new JobManager(
      { read: async () => [], write: async () => {} },
      async () => { throw new Error('unused'); },
      gate,
    );
    await expect(endless.submit({ requestId: randomUUID(), save: { a: 1 } }, { allowNew: true }))
      .rejects.toMatchObject({ status: 429 });
    gate.release('edition');
  });

  it('执行槽：同模式第二次 acquire 也拒绝，释放不清别人的槽', () => {
    const gate = new ExecutionGate();
    gate.acquire('endless');
    expect(() => gate.acquire('endless')).toThrow(/已有生成任务在运行/);
    expect(() => gate.acquire('edition')).toThrow(/故事生成任务正在运行/);
    gate.release('endless');
    expect(gate.busy()).toBeNull();

    gate.acquire('edition');
    expect(gate.busy()).toBe('edition');
    gate.release('endless'); // 不能替别的模式清槽
    expect(gate.busy()).toBe('edition');
    gate.release('edition');
    expect(gate.busy()).toBeNull();
  });

  it('J07：结果写盘失败时停止后续单元，不误报成功', async () => {
    let calls = 0;
    const { store, manager } = setup(async ({ unitId }) => {
      calls += 1;
      return { objectType: 'unit', objectId: unitId, objectDigest: digest('e'), body: { unitId } };
    });
    const [a, b] = units(2);
    let failNext = true;
    const original = store.putObject.bind(store);
    store.putObject = (...args: Parameters<typeof original>) => {
      if (failNext) { failNext = false; throw new Error('disk full'); }
      original(...args);
    };
    const job = submit(manager, { unitIds: [a!, b!] });
    await manager.settle(job.job.id);
    expect(calls).toBe(1);
    expect(manager.get(job.job.id)?.job.status).toBe('failed');
  });

  it('J09：依据版本变化时拒绝提交；执行中改变 head 不会自动采用结果', async () => {
    const { store, manager } = setup(async ({ unitId }) => ({
      objectType: 'unit', objectId: unitId, objectDigest: digest('f'), body: { unitId },
    }));
    expect(() => submit(manager, { unitIds: units(1), expected: 0 })).toThrow(/已更新/);
    const job = submit(manager, { unitIds: units(1) });
    await manager.settle(job.job.id);
    const current = store.getEdition(editionId)!;
    store.putEdition({ ...current, headEditorialRevisionId: 'edr_22222222-2222-4222-8222-222222222222' }, current.revision);
    expect(store.listReleases(editionId)).toEqual([]);
    expect(manager.get(job.job.id)?.job.status).toBe('succeeded');
  });

  it('取消：只停止后续调用，已保存单元保留', async () => {
    let calls = 0;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const setupResult = setup(async ({ unitId }) => {
      calls += 1;
      if (calls === 1) await paused;
      return { objectType: 'unit', objectId: unitId, objectDigest: digest('9'), body: { unitId } };
    });
    const [a, b, c] = units(3);
    const job = submit(setupResult.manager, { unitIds: [a!, b!, c!] });
    setupResult.manager.cancel(job.job.id);
    release();
    await setupResult.manager.settle(job.job.id);
    expect(calls).toBe(1);
    expect(setupResult.manager.get(job.job.id)?.job.status).toBe('cancelled');
    expect(setupResult.store.successfulUnits(job.job.id)).toEqual([a]);
  });

  it('J09：调用中途改变编辑依据，保存原结果后不再开始下一个单元', async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const { store, manager } = setup(async ({ unitId }) => {
      calls += 1;
      await paused;
      return { objectType: 'unit', objectId: unitId, objectDigest: digest('7'), body: { unitId } };
    });
    const row = submit(manager, { unitIds: units(2) });
    const project = store.getEdition(editionId)!;
    store.putEdition({ ...project, headEditorialRevisionId: `edr_${randomUUID()}` }, project.revision);
    release();
    await manager.settle(row.job.id);
    expect(calls).toBe(1);
    expect(store.successfulUnits(row.job.id)).toHaveLength(1);
    expect(manager.describeFailure(manager.get(row.job.id)!.job)?.code).toBe('basis-changed');
  });

  it('最后一个单元进行中取消，保留结果但任务仍是 cancelled', async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const { store, manager } = setup(async ({ unitId }) => {
      await paused;
      return { objectType: 'unit', objectId: unitId, objectDigest: digest('6'), body: { unitId } };
    });
    const row = submit(manager, { unitIds: units(1) });
    manager.cancel(row.job.id);
    release();
    await manager.settle(row.job.id);
    expect(store.successfulUnits(row.job.id)).toHaveLength(1);
    expect(manager.get(row.job.id)?.job.status).toBe('cancelled');
  });
});
