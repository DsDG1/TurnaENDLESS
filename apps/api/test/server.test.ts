import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createContent } from '@endless/content';
import { createSession, getScenes, transition } from '@endless/player';
import { JobManager, MemoryJobStore } from '../src/jobs.js';
import { createApiServer } from '../src/server.js';
import { complete, generated } from './fixtures.js';

const content = createContent(readFileSync(new URL('../../lab/data/lexicon/a1_a2.yaml', import.meta.url), 'utf8'));
const servers: ReturnType<typeof createApiServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function start(configured = true, origins?: readonly string[]) {
  const jobs = new JobManager(new MemoryJobStore(), async () => { throw new Error('secret-provider-error'); });
  await jobs.initialize();
  const server = createApiServer({ jobs, content, configured, token: 'test-token', model: 'test-model', origins });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, jobs };
}

const headers = { Origin: 'http://127.0.0.1:4173', 'Content-Type': 'application/json', 'X-Endless-Token': 'test-token' };

it('allows an explicit desktop origin without allowing unrelated browser origins', async () => {
  const origin = 'http://127.0.0.1:4175';
  const { url } = await start(false, [origin]);
  expect((await fetch(`${url}/api/status`, { headers: { Origin: origin } })).status).toBe(200);
  expect((await fetch(`${url}/api/status`, { headers })).status).toBe(403);
  expect((await fetch(`${url}/api/generations`, {
    method: 'POST', headers: { ...headers, Origin: origin, 'X-Endless-Token': 'wrong' }, body: '{}',
  })).status).toBe(403);
  const rejected = await fetch(`${url}/api/generations`, {
    method: 'POST', headers: { ...headers, Origin: origin }, body: JSON.stringify({ requestId: crypto.randomUUID(), save: complete() }),
  });
  expect(rejected.status).toBe(401);
});

describe('本机 API 安全与数据边界', () => {
  it('状态接口不泄露模型密钥，跨站与未知 Host 均被拒绝', async () => {
    const { url } = await start();
    const status = await fetch(`${url}/api/status`);
    expect(status.headers.get('cache-control')).toBe('no-store');
    expect(await status.json()).toMatchObject({ configured: true, model: 'test-model' });
    expect((await fetch(`${url}/api/status`, { headers: { Origin: 'https://foreign.example' } })).status).toBe(403);
    expect(await new Promise<number | undefined>((resolve, reject) => {
      const call = request(`${url}/api/status`, { headers: { Host: 'foreign.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      call.on('error', reject);
      call.end();
    })).toBe(403);
    expect((await fetch(`${url}/api/generations`, { method: 'POST', headers: { ...headers, 'X-Endless-Token': 'wrong' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${url}/api/generations`, { method: 'POST', headers: { ...headers, Origin: '' }, body: '{}' })).status).toBe(403);
  });

  it('未配置密钥或非法存档不会创建计费任务', async () => {
    const missing = await start(false);
    expect((await fetch(`${missing.url}/api/generations`, { method: 'POST', headers, body: JSON.stringify({
      requestId: crypto.randomUUID(), save: complete(),
    }) })).status).toBe(401);
    expect(missing.jobs.count()).toBe(0);
    const { url, jobs } = await start();
    const response = await fetch(`${url}/api/generations`, { method: 'POST', headers, body: JSON.stringify({
      requestId: crypto.randomUUID(), save: content.snapshot(createSession(content.pilot), []),
    }) });
    expect(response.status).toBe(422);
    expect(jobs.count()).toBe(0);
  });

  it('有效任务异步返回，查询错误不含原始供应商响应', async () => {
    const { url } = await start();
    let session = createSession(content.pilot);
    for (const episode of content.pilot.episodes) {
      session = transition(session, { type: 'select', episode: episode.id }, content.pilot);
      for (const scene of getScenes(episode)) session = transition(session, { type: 'advance', scene: scene.id, skip: true }, content.pilot);
    }
    const response = await fetch(`${url}/api/generations`, { method: 'POST', headers, body: JSON.stringify({
      requestId: crypto.randomUUID(), save: content.snapshot(session, []),
    }) });
    expect(response.status).toBe(202);
    const task = await response.json() as { id: string };
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await fetch(`${url}/api/generations/${task.id}`, { headers });
    const job = await result.json() as { status: string; error: string };
    expect(job.status).toBe('failed');
    expect(job.error).not.toContain('secret-provider-error');
  });

  it('无服务端 Key 时可提交网页 Key，刷新后无 Key 也可恢复同一任务', async () => {
    const { url, jobs } = await start(false);
    const key = 'synthetic-byok-header-key';
    const input = { requestId: crypto.randomUUID(), save: complete() };
    const response = await fetch(`${url}/api/generations`, {
      method: 'POST', headers: { ...headers, 'X-Endless-Provider-Key': key }, body: JSON.stringify(input),
    });
    expect(response.status).toBe(202);
    expect(await response.text()).not.toContain(key);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const resumed = await fetch(`${url}/api/generations`, { method: 'POST', headers, body: JSON.stringify(input) });
    expect(resumed.status).toBe(200);
    expect(await resumed.text()).not.toContain(key);
    expect(jobs.count()).toBe(1);
    const status = await fetch(`${url}/api/status`);
    expect(await status.json()).toMatchObject({ configured: false, acceptsUserKey: true });
  });

  it('含旧版生成内容的存档在入口被拒绝，不创建计费任务', async () => {
    const { url, jobs } = await start();
    const save = complete();
    const restored = content.restore(save);
    const legacy = generated(save, `ai-${crypto.randomUUID()}`, new Date(), 3);
    const withLegacy = content.snapshot(restored.session, [...restored.generated, legacy]);
    const response = await fetch(`${url}/api/generations`, { method: 'POST', headers, body: JSON.stringify({
      requestId: crypto.randomUUID(), save: withLegacy,
    }) });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain('只接受 v4');
    expect(jobs.count()).toBe(0);
  });

  it('非法的网页 Key 不进入任务或错误响应', async () => {
    const { url, jobs } = await start(false);
    const response = await fetch(`${url}/api/generations`, {
      method: 'POST', headers: { ...headers, 'X-Endless-Provider-Key': 'synthetic key with spaces' },
      body: JSON.stringify({ requestId: crypto.randomUUID(), save: complete() }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('synthetic key with spaces');
    expect(jobs.count()).toBe(0);
  });
});
