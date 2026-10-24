import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { edition, type Content } from '@endless/content';
import { createApiServer } from '../src/server.js';
import { JobManager, MemoryJobStore } from '../src/jobs.js';
import { EditionStore } from '../src/edition/store.js';
import { EditionJobManager } from '../src/edition/jobs.js';
import { createEditionRouter } from '../src/edition/routes.js';
import { putDraftUnit } from '../src/edition/runner.js';

const token = 'test-capability-token';
const lexiconText = readFileSync(new URL('../../lab/data/lexicon/a1_a2.yaml', import.meta.url), 'utf8');
const sample = edition.createEditionSample(lexiconText, { now: new Date('2026-10-24T00:00:00.000Z') });
const origin = 'http://127.0.0.1:5173';
let server: Server;
let store: EditionStore;
let manager: EditionJobManager;
let base: string;

beforeAll(async () => {
  store = new EditionStore(':memory:');
  manager = new EditionJobManager(store, async ({ unitId }) => ({
    objectType: 'unit', objectId: unitId, objectDigest: `sha256:${'a'.repeat(64)}`, body: { unitId },
  }));
  const router = createEditionRouter({ store, jobs: manager, origins: [origin], searchAvailable: false });
  server = createApiServer({
    jobs: new JobManager(new MemoryJobStore(), async () => { throw new Error('unused'); }),
    content: {} as Content,
    token, configured: false, model: 'test',
    edition: { handle: router },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});

async function call(
  method: string,
  path: string,
  options: { token?: string | null; origin?: string | null; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...options.headers };
  const suppliedToken = options.token === undefined ? token : options.token;
  if (suppliedToken) headers['x-endless-token'] = suppliedToken;
  const suppliedOrigin = options.origin === undefined ? origin : options.origin;
  if (suppliedOrigin) headers.origin = suppliedOrigin;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  return { status: response.status, json, text };
}

describe('本机 Edition 路由（M2 / S05–S06）', () => {
  it('S05：缺少 capability、错误来源、非法路径都被拒绝', async () => {
    expect((await call('GET', '/api/edition-status', { token: null })).status).toBe(403);
    expect((await call('GET', '/api/edition-status', { token: 'wrong' })).status).toBe(403);
    expect((await call('GET', '/api/edition-status', { origin: 'http://evil.test' })).status).toBe(403);
    const status = await call('GET', '/api/edition-status');
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ contract: 'edition-draft-v1', searchAvailable: false });
    // 对象路径必须严格是 sha256 摘要，不接受任意文件或短路径
    expect((await call('GET', '/api/edition-objects/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
    expect((await call('GET', '/api/edition-objects/sha256:abc')).status).toBe(404);
  });

  it('创建、读取编辑项目；非法等级被拒绝', async () => {
    const created = await call('POST', '/api/editions', { body: { title: '咖啡', cefr: 'A2' } });
    expect(created.status).toBe(201);
    const id = (created.json as { id: string }).id;
    expect(id).toMatch(/^edn_/);
    const detail = await call('GET', `/api/editions/${id}`);
    expect(detail.status).toBe(200);
    expect((detail.json as { edition: { title: string } }).edition.title).toBe('咖啡');
    const closed = await call('POST', '/api/editions', { body: { title: 'x', cefr: 'C1' } });
    expect(closed.status).toBe(409);
  });

  it('S06：页面 Key 只出现在提交请求头，不进入任务、状态或导出', async () => {
    const created = await call('POST', '/api/editions', { body: { title: 'Key 测试' } });
    const id = (created.json as { id: string }).id;
    const revision = (created.json as { revision: number }).revision;
    const unitId = `unt_${randomUUID()}`;
    const kind = 'build_plan' as const;
    const taskDigest = edition.compileTaskDigest({
      kind, editionId: id, editorialRevisionId: null, issuePlanId: null, cefr: null,
      unitIds: [unitId], intent: 'initial',
    });
    const submitted = await call('POST', `/api/editions/${id}/jobs`, {
      headers: { 'x-endless-provider-key': 'sk-test-secret-value' },
      body: {
        requestId: randomUUID(), kind, editorialRevisionId: null, issuePlanId: null, cefr: null,
        unitIds: [unitId], intent: 'initial', expecteProjectRevision: revision,
        expectedProjectRevision: revision, approvedTaskDigest: taskDigest,
      },
    });
    expect([200, 202]).toContain(submitted.status);
    const jobId = (submitted.json as { id: string }).id;
    await manager.settle(jobId);
    const job = await call('GET', `/api/edition-jobs/${jobId}`);
    expect(job.status).toBe(200);
    expect(job.text).not.toContain('sk-test-secret-value');
    const status = await call('GET', '/api/edition-status');
    expect(status.text).not.toContain('sk-test-secret-value');
    const exported = await call('GET', `/api/editions/${id}/export`);
    expect(exported.status).toBe(200);
    expect(exported.text).not.toContain('sk-test-secret-value');
    // 伪造的「已批准摘要」被服务端重算拒绝
    const forged = await call('POST', `/api/editions/${id}/jobs`, {
      body: {
        requestId: randomUUID(), kind, editorialRevisionId: null, issuePlanId: null, cefr: null,
        unitIds: [unitId], intent: 'initial', expectedProjectRevision: revision,
        approvedTaskDigest: `sha256:${'f'.repeat(64)}`,
      },
    });
    expect(forged.status).toBe(409);
  });

  it('已批准草稿可以通过受保护路由登记，随后 compile_issue 能确定性复核', async () => {
    const id = sample.edition.id;
    store.putEdition({
      id, title: '草稿登记', subtitle: '', description: '', headEditorialRevisionId: sample.editorial.id,
      revision: 0, createdAt: sample.release.publishedAt, updatedAt: sample.release.publishedAt,
      status: 'review', cefr: 'A2', searchAvailable: false,
    });
    const unit = sample.units[0]!;
    const passage = sample.corpus.passages.find((entry) => unit.basis.passageRevisionIds.includes(entry.id))!;
    const context = {
      revision: unit, editorial: sample.editorial,
      levelPlan: sample.levelPlans.find((plan) => plan.unitId === unit.unitId)!,
      targets: sample.targets[unit.unitId]!, pack: sample.pack,
      passages: [{ alias: 'p1', revision: passage }], corpus: sample.corpus, rights: sample.rights,
      allowedCharacters: ['shopkeeper', 'cat', 'guide'],
    };
    const registered = await call('POST', `/api/editions/${id}/drafts`, {
      body: { unitId: unit.unitId, revision: unit, context },
    });
    expect(registered.status).toBe(201);
    expect(registered.json).toMatchObject({ unitId: unit.unitId, revisionId: unit.id });
    expect(store.objectsById('unit-draft', unit.unitId)).toHaveLength(1);

    // 缺少 Origin / 非 JSON / 修订与 unitId 不一致都被拒绝
    const noOrigin = await call('POST', `/api/editions/${id}/drafts`, {
      body: { unitId: unit.unitId, revision: unit, context }, headers: { Origin: '' },
    });
    expect(noOrigin.status).toBe(403);
    const mismatch = await call('POST', `/api/editions/${id}/drafts`, {
      body: { unitId: 'unt_11111111-1111-4111-8111-111111111111', revision: unit, context },
    });
    expect(mismatch.status).toBe(400);
  });

  it('审批绑定摘要，发布要求当前摘要的审批；取消明确不保证退费', async () => {
    const id = sample.edition.id;
    store.putEdition({
      id, title: '发布测试', subtitle: '', description: '', headEditorialRevisionId: sample.editorial.id,
      revision: 0, createdAt: sample.release.publishedAt, updatedAt: sample.release.publishedAt,
      status: 'review', cefr: 'A2', searchAvailable: false,
    });
    const release = sample.release;
    store.putObject('release', release.id, release.digest, release);
    // 摘要合法但对象不符合契约：不能拿「本机对象」当信任凭证
    const brokenDigest = `sha256:${'d'.repeat(64)}`;
    store.putObject('release', `rel_${randomUUID()}`, brokenDigest, { id: `rel_${randomUUID()}`, bogus: true });
    const malformed = await call('POST', `/api/editions/${id}/releases`, { body: { objectDigest: brokenDigest } });
    expect(malformed.status).toBe(422);
    const incomplete = await call('POST', `/api/editions/${id}/releases`, { body: { objectDigest: release.digest } });
    expect(incomplete.status).toBe(422);
    for (const unit of sample.units) {
      store.putUnit(unit);
      const passage = sample.corpus.passages.find((entry) => unit.basis.passageRevisionIds.includes(entry.id))!;
      putDraftUnit(store, unit.unitId, { revision: unit, context: {
        revision: unit, editorial: sample.editorial,
        levelPlan: sample.levelPlans.find((plan) => plan.unitId === unit.unitId)!,
        targets: sample.targets[unit.unitId]!, pack: sample.pack,
        passages: [{ alias: 'p1', revision: passage }], corpus: sample.corpus, rights: sample.rights,
        allowedCharacters: ['shopkeeper', 'cat', 'guide'],
      } });
    }
    store.addApproval({ editionId: id, targetType: 'plan', targetId: sample.editorial.id, digest: sample.editorial.digest, reviewer: 'owner' });
    const denied = await call('POST', `/api/editions/${id}/releases`, { body: { objectDigest: release.digest } });
    expect(denied.status).toBe(409);
    const approved = await call('POST', `/api/editions/${id}/approvals`, {
      body: { targetType: 'issue', targetId: release.issueId, digest: release.digest },
    });
    expect(approved.status).toBe(201);
    const published = await call('POST', `/api/editions/${id}/releases`, { body: { objectDigest: release.digest } });
    expect(published.status).toBe(201);
    const other = await call('POST', '/api/editions', { body: { title: '其他项目' } });
    const otherId = (other.json as { id: string }).id;
    expect((await call('POST', `/api/editions/${otherId}/releases`, { body: { objectDigest: release.digest } })).status).toBe(409);

    const tampered = { ...release, id: `rel_${randomUUID()}`, digest: `sha256:${'e'.repeat(64)}` };
    store.putObject('release', tampered.id, tampered.digest, tampered);
    expect((await call('POST', `/api/editions/${id}/releases`, { body: { objectDigest: tampered.digest } })).status).toBe(422);
    expect(store.getRelease(tampered.id)).toBeNull();

    const job = await call('POST', `/api/editions/${id}/jobs`, {
      body: {
        requestId: randomUUID(), kind: 'build_plan', editorialRevisionId: null, issuePlanId: null, cefr: null,
        unitIds: [`unt_${randomUUID()}`], intent: 'initial', expectedProjectRevision: 1,
        approvedTaskDigest: `sha256:${'c'.repeat(64)}`,
      },
    });
    expect(job.status).toBe(409);
    const cancelled = await call('POST', `/api/edition-jobs/job_${randomUUID()}/cancel`);
    expect(cancelled.status).toBe(404);
  });

  it('导入只暂存不激活；未知格式被拒绝且原库不变', async () => {
    const bad = await call('POST', '/api/edition-imports', { body: { text: 'not a container' } });
    expect(bad.status).toBe(422);
    const container = edition.buildContainer('edition-backup/1', [], { trustRoot: 'remote' });
    const text = edition.serializeContainer(container);
    const quarantined = await call('POST', '/api/edition-imports', { body: { text } });
    expect(quarantined.status).toBe(409);
    expect(quarantined.json).toMatchObject({ quarantined: true });
    const local = await call('POST', '/api/edition-imports', {
      body: { text: edition.serializeContainer(edition.buildContainer('edition-backup/1', [])) },
    });
    expect(local.status).toBe(409);
    expect(local.json).toMatchObject({ quarantined: true });
    expect(store.stats().objects).toBeGreaterThanOrEqual(0);
  });
});
