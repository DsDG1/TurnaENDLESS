import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileJobStore, JobManager, type JobRecord } from '../src/jobs.js';
import { complete, generated } from './fixtures.js';

describe('磁盘任务缓存', () => {
  it('完成的内容可以重新打开，更新通过原子替换写入', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'endless-api-')), 'jobs.json');
    const store = new FileJobStore(path);
    expect(await store.read()).toEqual([]);
    const id = randomUUID();
    const record: JobRecord = {
      id, payloadHash: 'test', status: 'running', phase: '生成中', createdAt: new Date().toISOString(),
    };
    await store.write([record]);
    const result = generated(complete(), `ai-${id}`);
    await store.write([{ ...record, status: 'succeeded', phase: '已完成', result }]);
    const reopened = new FileJobStore(path);
    expect((await reopened.read())[0]?.result).toEqual(result);
  });

  it('损坏的文件不被覆盖，启动失败不会自动重调模型', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'endless-api-')), 'jobs.json');
    await writeFile(path, '{"version":42,"important":"keep-me"}');
    let calls = 0;
    const jobs = new JobManager(new FileJobStore(path), async () => { calls++; throw new Error('unused'); });
    await expect(jobs.initialize()).rejects.toThrow(/不会覆盖/);
    expect(calls).toBe(0);
    expect(await readFile(path, 'utf8')).toBe('{"version":42,"important":"keep-me"}');
  });
});
