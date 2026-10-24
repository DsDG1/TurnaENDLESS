import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EditionConflictError, EditionStorageLowError, EditionStore } from '../src/edition/store.js';
import { EditionJobManager } from '../src/edition/jobs.js';
import { edition } from '@endless/content';

const baseEdition = {
  id: 'edn_11111111-1111-4111-8111-111111111111',
  title: '测试项目',
  subtitle: '',
  description: '',
  headEditorialRevisionId: null,
  revision: 0,
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z',
  status: 'research' as const,
  cefr: 'A2' as const,
  searchAvailable: false,
};

const sample = edition.createEditionSample(readFileSync(new URL('../../lab/data/lexicon/a1_a2.yaml', import.meta.url), 'utf8'));

const jobOf = (id: string, requestId: string, digest: string): edition.CompileJob => ({
  id,
  requestId,
  kind: 'compile_issue',
  editionId: baseEdition.id,
  editorialRevisionId: 'edr_11111111-1111-4111-8111-111111111111',
  issuePlanId: 'iss_11111111-1111-4111-8111-111111111111',
  cefr: 'A2',
  taskDigest: digest,
  status: 'queued',
  attempts: [],
  resultRefs: [],
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z',
});

describe('Edition 本机数据库（M2）', () => {
  it('schema 版本固定，不可变对象按摘要去重', () => {
    const store = new EditionStore(':memory:');
    expect(store.schemaVersion()).toBe(1);
    store.putObject('unit', 'unt_11111111-1111-4111-8111-111111111111', 'sha256:' + 'a'.repeat(64), { ok: 1 });
    store.putObject('unit', 'unt_11111111-1111-4111-8111-111111111111', 'sha256:' + 'a'.repeat(64), { ok: 2 });
    const record = store.getObject('sha256:' + 'a'.repeat(64));
    expect(record?.body).toEqual({ ok: 1 });
    expect(store.countObjects('unit')).toBe(1);
    store.close();
  });

  it('编辑项目用 CAS 版本号防覆盖', () => {
    const store = new EditionStore(':memory:');
    const first = store.putEdition({ ...baseEdition });
    expect(first.revision).toBe(1);
    const second = store.putEdition({ ...first, title: '改过' }, 1);
    expect(second.revision).toBe(2);
    expect(() => store.putEdition({ ...second, title: '并发覆盖' }, 1)).toThrow(EditionConflictError);
    expect(store.getEdition(first.id)?.title).toBe('改过');
    store.close();
  });

  it('同一 requestId 不同依据必须 409，相同依据返回原任务', () => {
    const store = new EditionStore(':memory:');
    store.putEdition({ ...baseEdition });
    const row = {
      job: jobOf('job_11111111-1111-4111-8111-111111111111', 'req-1', 'sha256:' + 'b'.repeat(64)),
      expectedProjectRevision: 1,
      intent: 'initial',
      unitIds: ['unt_a'],
      approvalDigest: 'sha256:' + 'c'.repeat(64),
    };
    expect(store.createJob(row).job.id).toBe(row.job.id);
    expect(store.createJob(row).job.id).toBe(row.job.id);
    expect(() => store.createJob({
      ...row,
      job: { ...row.job, taskDigest: 'sha256:' + 'd'.repeat(64) },
    })).toThrow(EditionConflictError);
    store.close();
  });

  it('超过 200 条尝试仍可恢复；任务体只保留最近 200 条窗口', async () => {
    const store = new EditionStore(':memory:');
    store.putEdition({ ...baseEdition });
    const unitIds = Array.from({ length: 250 }, (_, index) =>
      `unt_${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`);
    const digest = 'sha256:' + 'e'.repeat(64);
    const requestId = 'req-many';
    store.createJob({
      job: jobOf('job_22222222-2222-4222-8222-222222222222', requestId, digest),
      expectedProjectRevision: 1, intent: 'initial', unitIds, approvalDigest: 'sha256:' + 'f'.repeat(64),
    });
    let calls = 0;
    const manager = new EditionJobManager(store, async ({ unitId }) => {
      calls += 1;
      return { objectType: 'unit', objectId: unitId, objectDigest: digest, body: { unitId } };
    });
    // 直接驱动执行，避免依赖后台任务的时序
    const row = manager.get('job_22222222-2222-4222-8222-222222222222')!;
    const execute = (manager as unknown as { execute: (id: string, key?: string) => Promise<void> }).execute.bind(manager);
    await execute(row.job.id);
    expect(calls).toBe(250);
    expect(store.countAttempts()).toBe(250);
    const saved = manager.get(row.job.id)!;
    expect(saved.job.status).toBe('succeeded');
    expect(saved.job.attempts.length).toBeLessThanOrEqual(200);
    expect(store.successfulUnits(row.job.id)).toHaveLength(250);
    store.close();
  });

  it('关闭再打开后任务与尝试仍在；崩溃状态只标记不重放', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'edition-db-')), 'edition.sqlite');
    const first = new EditionStore(path);
    first.putEdition({ ...baseEdition });
    const digest = 'sha256:' + '1'.repeat(64);
    first.createJob({
      job: jobOf('job_33333333-3333-4333-8333-333333333333', 'req-crash', digest),
      expectedProjectRevision: 1, intent: 'initial', unitIds: ['unt_crash'], approvalDigest: digest,
    });
    const attempt = first.reserveAttempt({
      jobId: 'job_33333333-3333-4333-8333-333333333333',
      unitId: 'unt_crash', workKey: 'work-1', status: 'reserved', startedAt: '2026-10-24T00:00:00.000Z', failureCode: null,
    });
    first.markAttempt(attempt.seq, 'call_started');
    first.close();

    const reopened = new EditionStore(path);
    let calls = 0;
    const manager = new EditionJobManager(reopened, async () => {
      calls += 1;
      throw new Error('must not be called');
    });
    const recovery = manager.initialize();
    expect(recovery.interrupted).toBe(1);
    expect(recovery.unknown).toBe(1);
    expect(calls).toBe(0);
    expect(manager.get('job_33333333-3333-4333-8333-333333333333')?.job.status).toBe('interrupted');
    expect(reopened.listAttempts('job_33333333-3333-4333-8333-333333333333')[0]?.status).toBe('unknown');
    // J08：历史仍在，且不占用 ENDLESS 的 jobs.json
    expect(reopened.stats().attempts).toBe(1);
    reopened.close();
  });

  it('磁盘水位读真实可用空间；本机磁盘不足时拒绝新任务', async () => {
    expect(new EditionStore(':memory:').assertWritable()).toEqual({ freeBytes: null });
    const path = join(await mkdtemp(join(tmpdir(), 'edition-disk-')), 'edition.sqlite');
    const store = new EditionStore(path);
    const { freeBytes } = store.assertWritable();
    expect(freeBytes).toBeGreaterThan(0);
    expect(() => store.assertWritable(Number.MAX_SAFE_INTEGER)).toThrow(EditionStorageLowError);
    store.close();
  });

  it('任务级失败码持久化：没有尝试记录时也能解释原因', async () => {
    const store = new EditionStore(':memory:');
    store.putEdition({ ...baseEdition });
    const digest = 'sha256:' + '7'.repeat(64);
    store.createJob({
      job: jobOf('job_55555555-5555-4555-8555-555555555555', 'req-storage', digest),
      expectedProjectRevision: 1, intent: 'initial', unitIds: ['unt_x'], approvalDigest: digest,
    });
    store.reserveAttempt = () => { throw new Error('disk full'); };
    const manager = new EditionJobManager(store, async () => { throw new Error('must not run'); });
    const execute = (manager as unknown as { execute: (id: string) => Promise<void> }).execute.bind(manager);
    await execute('job_55555555-5555-4555-8555-555555555555');
    const saved = manager.get('job_55555555-5555-4555-8555-555555555555')!;
    expect(saved.job.status).toBe('failed');
    expect(store.jobFailureCode(saved.job.id)).toBe('storage');
    expect(manager.describeFailure(saved.job)?.message).toMatch(/存储|磁盘/);
    store.close();
  });

  it('同一 workKey 不允许两个未结束的尝试', () => {
    const store = new EditionStore(':memory:');
    const attempt = {
      jobId: 'job_44444444-4444-4444-8444-444444444444', unitId: 'unt_a', workKey: 'same-work',
      status: 'reserved' as const, startedAt: '2026-10-24T00:00:00.000Z', failureCode: null,
    };
    store.reserveAttempt(attempt);
    expect(() => store.reserveAttempt(attempt)).toThrow();
    store.close();
  });

  it('同一期 A2 与 B1 独立发行；更正只取代同等级且不可覆盖旧正文', () => {
    const store = new EditionStore(':memory:');
    const a2 = sample.release;
    const b1 = { ...a2, id: `rel_${randomUUID()}`, cefr: 'B1' as const };
    store.putRelease(a2);
    store.putRelease(b1);
    expect(store.getRelease(a2.id)?.status).toBe('published');
    expect(store.getRelease(b1.id)?.status).toBe('published');
    const correction = { ...a2, id: `rel_${randomUUID()}`, supersedes: a2.id };
    store.putRelease(correction);
    expect(store.getRelease(a2.id)).toMatchObject({ status: 'superseded', supersededBy: correction.id });
    expect(store.getRelease(b1.id)?.status).toBe('published');
    expect(() => store.putRelease(a2)).toThrow(EditionConflictError);
    expect(() => store.putRelease({ ...correction, publishedBy: 'changed' })).toThrow(EditionConflictError);
    expect(() => store.putRelease({ ...correction, id: `rel_${randomUUID()}`, supersedes: null })).toThrow(EditionConflictError);
    store.close();
  });

  it('旧单等级唯一索引升级后仍保留所有发行记录', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'edition-index-')), 'edition.sqlite');
    const first = new EditionStore(path);
    first.putRelease(sample.release);
    first.db.exec("CREATE UNIQUE INDEX releases_current_issue ON releases (issue_id) WHERE status = 'published'");
    first.close();
    const reopened = new EditionStore(path);
    reopened.putRelease({ ...sample.release, id: `rel_${randomUUID()}`, cefr: 'B1' });
    expect(reopened.listReleases(sample.release.editionId)).toHaveLength(2);
    expect(reopened.getRelease(sample.release.id)?.status).toBe('published');
    reopened.close();
  });
});
