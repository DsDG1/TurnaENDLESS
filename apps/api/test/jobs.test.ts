import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { JobManager, MemoryJobStore, type JobRecord } from '../src/jobs.js';

const request = () => ({ requestId: randomUUID(), save: { version: 2, revision: 0, session: {}, generated: [] } });
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('生成任务的幂等性和费用护栏', () => {
  it('并发重复提交和不同 ID 的相同快照只调用一次生成器', async () => {
    const store = new MemoryJobStore();
    let calls = 0;
    let finish!: (value: never) => void;
    const jobs = new JobManager(store, async () => {
      calls++;
      return new Promise((resolve) => { finish = resolve; });
    });
    await jobs.initialize();
    const input = request();
    const [a, b] = await Promise.all([jobs.submit(input), jobs.submit(input)]);
    const c = await jobs.submit({ ...input, requestId: randomUUID() });
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(c.id);
    await flush();
    expect(calls).toBe(1);
    finish({} as never);
    await flush();
    expect(jobs.get(a.id)?.status).toBe('succeeded');
  });

  it('任务跨进程恢复，不对中断任务自动重新付费', async () => {
    const record: JobRecord = {
      id: randomUUID(), payloadHash: 'hash', status: 'running', phase: '生成中',
      createdAt: new Date().toISOString(),
    };
    const store = new MemoryJobStore([record]);
    let calls = 0;
    const jobs = new JobManager(store, async () => { calls++; throw new Error('unused'); });
    await jobs.initialize();
    expect(jobs.get(record.id)?.status).toBe('failed');
    expect(jobs.get(record.id)?.error).toMatch(/中断/);
    expect(calls).toBe(0);
  });

  it('同 ID 不同请求拒绝；无日额度限制，新任务仍可创建', async () => {
    const jobs = new JobManager(new MemoryJobStore(), async () => { throw new Error('provider secret'); });
    await jobs.initialize();
    const input = request();
    await jobs.submit(input);
    await flush();
    await expect(jobs.submit({ ...input, save: { ...input.save, revision: 1 } })).rejects.toThrow(/ID/);
    const another = await jobs.submit({ ...input, requestId: randomUUID() });
    expect(jobs.get(another.id)).toBeTruthy();
    expect(jobs.get(input.requestId)?.error).not.toContain('secret');
  });

  it('持久化预留失败时不发起模型调用', async () => {
    let calls = 0;
    const store = new MemoryJobStore();
    store.write = async () => { throw new Error('disk full'); };
    const jobs = new JobManager(store, async () => { calls++; throw new Error('unused'); });
    await jobs.initialize();
    await expect(jobs.submit(request())).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it('取消等待后只改变文字偏好或所选集数时，仍复用相同剧情的已有结果', async () => {
    let calls = 0;
    const jobs = new JobManager(new MemoryJobStore(), async () => { calls++; return {} as never; });
    await jobs.initialize();
    const save = { version: 2, revision: 1, session: {
      catalog: 'pilot-v1', events: [], revision: 1, current: 'pilot-3', largeText: false,
    }, generated: [] };
    const first = await jobs.submit({ requestId: randomUUID(), save });
    await flush();
    const second = await jobs.submit({ requestId: randomUUID(), save: {
      ...save, revision: 2, session: { ...save.session, revision: 2, largeText: true, current: 'pilot-2' },
    } });
    expect(second.id).toBe(first.id);
    expect(calls).toBe(1);
  });

  it('网页 Key 只传给本次运行，不进入任务记录或持久化缓存', async () => {
    const key = 'synthetic-byok-test-key';
    const store = new MemoryJobStore();
    let received: string | undefined;
    const jobs = new JobManager(store, async (_save, _id, _phase, apiKey) => {
      received = apiKey;
      throw new Error(`provider echoed ${apiKey}`);
    });
    await jobs.initialize();
    const input = request();
    await jobs.submit(input, { apiKey: key, allowNew: true });
    await flush();
    expect(received).toBe(key);
    expect(JSON.stringify(jobs.get(input.requestId))).not.toContain(key);
    expect(JSON.stringify(await store.read())).not.toContain(key);
  });

  it('没有 Key 时拒绝创建新任务，但可复用原任务且不消耗额外额度', async () => {
    let calls = 0;
    const jobs = new JobManager(new MemoryJobStore(), async () => { calls++; return {} as never; });
    await jobs.initialize();
    const input = request();
    await expect(jobs.submit(input, { allowNew: false })).rejects.toThrow(/Key/);
    expect(jobs.count()).toBe(0);
    await jobs.submit(input, { apiKey: 'synthetic-key', allowNew: true });
    await flush();
    expect((await jobs.submit(input, { allowNew: false })).id).toBe(input.requestId);
    expect((await jobs.submit({ ...input, requestId: randomUUID() }, { allowNew: false })).id).toBe(input.requestId);
    expect(calls).toBe(1);
    expect(jobs.count()).toBe(1);
  });

  it('即使供应商在成功结果中回显 Key，也不会将它写入缓存', async () => {
    const key = 'synthetic-echoed-key';
    const store = new MemoryJobStore();
    const jobs = new JobManager(store, async () => ({ title: key }) as never);
    await jobs.initialize();
    const input = request();
    await jobs.submit(input, { apiKey: key });
    await flush();
    expect(jobs.get(input.requestId)?.status).toBe('failed');
    expect(jobs.get(input.requestId)?.error).toMatch(/凭据/);
    expect(JSON.stringify(await store.read())).not.toContain(key);
  });

  it.each([
    [{ statusCode: 429, message: 'raw-provider-body' }, 'rate-limit', '限流'],
    [{ statusCode: 401, message: 'raw-provider-body' }, 'auth', '认证'],
    [{ cause: { name: 'TimeoutError', message: 'raw-provider-body' } }, 'timeout', '超时'],
    [{ name: 'TypeError', message: 'raw-provider-body' }, 'network', '网络'],
  ])('供应商错误分类明确但不保存原始响应 %#', async (error, category, label) => {
    const store = new MemoryJobStore();
    const jobs = new JobManager(store, async () => { throw error; });
    await jobs.initialize();
    const input = request();
    await jobs.submit(input);
    await flush();
    expect(jobs.get(input.requestId)?.failure?.category).toBe(category);
    expect(jobs.get(input.requestId)?.error).toContain(label);
    expect(JSON.stringify(await store.read())).not.toContain('raw-provider-body');
  });
});
