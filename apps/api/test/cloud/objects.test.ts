import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { ObjectManifestSchema, PrepareObjectRequestSchema, type PrepareObjectRequest } from '@endless/cloud-contracts';
import { AuthService, type AuthContext } from '../../src/cloud/auth/service.js';
import { OutboxMailer, readQueuedMail } from '../../src/cloud/mail.js';
import { createWorkspace } from '../../src/cloud/access/workspaces.js';
import { createCloudServer } from '../../src/cloud/server.js';
import { cloudCapabilities } from '../../src/cloud/capabilities.js';
import { ObjectService, commitObjectGraph } from '../../src/cloud/objects/service.js';
import { S3ObjectStorage } from '../../src/cloud/objects/storage.js';
import { cloudFixture, closeServer, listenLoopback, TEST_MAIL_KEY, TEST_PEPPER } from './fixtures.js';
import { fakeObjectStorage, S3_CREDENTIALS } from './object-storage-fixture.js';
import { withClient } from './embedded-pg.js';

let fixture: Awaited<ReturnType<typeof cloudFixture>>;
let s3: Awaited<ReturnType<typeof fakeObjectStorage>>;
let storage: S3ObjectStorage;
let service: ObjectService;
let server: ReturnType<typeof createCloudServer>;
let base: string;
let a: AuthContext;
let b: AuthContext;
let cookie: string;
let cookieB: string;
let workspaceId: string;
const ORIGIN = 'https://endless.example.test';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const manifest = (objects: { id: string; digest: string; size: number }[] = []) =>
  Buffer.from(JSON.stringify({ format: 'endless-object-manifest', version: 1, objects }));

async function request(path: string, method = 'GET', body?: unknown, session = cookie) {
  const response = await fetch(`${base}/api/cloud/v1${path}`, {
    method, headers: { cookie: session, origin: ORIGIN, 'content-type': body instanceof Buffer ? 'application/octet-stream' : 'application/json' },
    body: body === undefined ? undefined : body instanceof Buffer ? new Uint8Array(body) : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any, headers: response.headers };
}

async function prepare(bytes = manifest(), overrides: Partial<PrepareObjectRequest> = {}) {
  const input: PrepareObjectRequest = {
    id: randomUUID(), workspaceId, domainId: randomUUID(),
    contract: 'endless-object-manifest/1', digest: digest(bytes), size: bytes.length, ...overrides,
  };
  const result = await service.prepare(a, input);
  return { input, bytes, object: result.object };
}

async function verified(bytes = manifest()) {
  const entry = await prepare(bytes);
  await service.upload(a, entry.input.id, bytes);
  await service.verify(a, entry.input.id);
  return entry;
}

beforeAll(async () => {
  fixture = await cloudFixture();
  s3 = await fakeObjectStorage();
  storage = new S3ObjectStorage({ endpoint: s3.endpoint, bucket: 'synthetic-bucket', region: 'test-1', ...S3_CREDENTIALS });
  service = new ObjectService(fixture.app, storage, fixture.deployment, { quotaBytes: 4_194_304 });
  const auth = new AuthService(fixture.auth, new OutboxMailer(TEST_MAIL_KEY), TEST_PEPPER);
  const login = async () => {
    const email = `${randomUUID()}@example.test`;
    const challenge = await auth.issueChallenge({ email, ip: randomUUID() }, 'objects-test');
    const code = /验证码是 (\d{6})/.exec((await readQueuedMail(fixture.auth, email, TEST_MAIL_KEY))[0]!.body)![1]!;
    const session = await auth.verifyChallenge({ challengeId: challenge.challengeId, email, code, deviceName: 'objects-test' }, 'objects-test');
    const ctx = await auth.resolveSession(session.token);
    return { ctx: ctx!, cookie: `__Host-endless_session=${session.token}` };
  };
  const first = await login();
  const second = await login();
  a = first.ctx; cookie = first.cookie;
  b = second.ctx; cookieB = second.cookie;
  workspaceId = (await createWorkspace(fixture.app, a, { contract: 'endless-workspace/1' }, randomUUID(), 'objects-test')).body.workspace.id;
  server = createCloudServer({
    auth: fixture.auth, app: fixture.app, pepper: TEST_PEPPER, mailer: new OutboxMailer(TEST_MAIL_KEY),
    origins: [ORIGIN], hosts: ['127.0.0.1'], capabilities: cloudCapabilities(), deployment: fixture.deployment, objects: service,
  });
  base = `http://127.0.0.1:${await listenLoopback(server)}`;
}, 120_000);

afterAll(async () => {
  if (server) await closeServer(server);
  storage?.close();
  await s3?.close();
  await fixture?.close();
}, 60_000);

describe('C2 对象底座：真实 PG + 签名校验 S3 协议', () => {
  it('只接受明确对象契约、SHA-256 和无重复有界引用', () => {
    expect(ObjectManifestSchema.safeParse({ format: 'endless-object-manifest', version: 1, objects: [] }).success).toBe(true);
    const ref = { id: randomUUID(), digest: 'a'.repeat(64), size: 1 };
    expect(ObjectManifestSchema.safeParse({ format: 'endless-object-manifest', version: 1, objects: [ref, ref] }).success).toBe(false);
    expect(PrepareObjectRequestSchema.safeParse({
      id: randomUUID(), workspaceId, domainId: 'x', contract: 'edition-backup/1', digest: 'a'.repeat(64), size: 1,
    }).success).toBe(false);
  });

  it('上传、验证不开放下载；内部事务提交引用后才能签名领取', async () => {
    const entry = await prepare();
    const prepared = await request('/objects/uploads', 'POST', entry.input);
    expect(prepared.status).toBe(200);
    expect(prepared.body.upload.path).toBe(`/api/cloud/v1/objects/${entry.input.id}/body`);
    expect((await request(`/objects/${entry.input.id}/download`)).status).toBe(404);
    expect((await request(`/objects/${entry.input.id}/body`, 'PUT', entry.bytes)).status).toBe(200);
    expect((await request(`/objects/${entry.input.id}/verify`, 'POST', {})).body.object.status).toBe('verified');
    expect((await request(`/objects/${entry.input.id}/download`)).status).toBe(404);
    await fixture.app.withTenant(a.accountId, (q) => commitObjectGraph(q, a.accountId, workspaceId, entry.input.id));
    const result = await request(`/objects/${entry.input.id}/download`);
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    const download = await fetch(result.body.url);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(entry.bytes);
    expect(download.headers.get('content-disposition')).toContain('attachment');
    expect(download.headers.get('cache-control')).toContain('no-store');
    const forged = new URL(result.body.url);
    forged.searchParams.set('X-Amz-Signature', 'a'.repeat(64));
    expect((await fetch(forged)).status).toBe(403);
    expect((await request(`/objects/${entry.input.id}/commit`, 'POST', {})).status).toBe(404);
    expect((await service.upload(a, entry.input.id, entry.bytes)).object.status).toBe('committed');
  });

  it('同 ID 同文复用；异文、换 workspace/domain 或同 domain 换 ID 拒绝', async () => {
    const entry = await prepare();
    const same = await Promise.all([service.prepare(a, entry.input), service.prepare(a, entry.input)]);
    expect(same.every((value) => value.object.id === entry.input.id)).toBe(true);
    await expect(service.prepare(a, { ...entry.input, digest: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
    await expect(service.prepare(a, { ...entry.input, domainId: randomUUID() })).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
    await expect(service.prepare(a, { ...entry.input, id: randomUUID() })).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
    await service.upload(a, entry.input.id, entry.bytes);
    await service.upload(a, entry.input.id, entry.bytes);
    await expect(service.upload(a, entry.input.id, Buffer.from('tampered'))).rejects.toMatchObject({ code: 'CONTENT_REJECTED' });
  });

  it('跨租户上传/验证/下载先拒绝，不请求对象存储；RLS 默认无上下文关闭', async () => {
    const entry = await verified();
    const before = s3.calls.length;
    for (const [path, method, body] of [
      [`/objects/${entry.input.id}/body`, 'PUT', entry.bytes],
      [`/objects/${entry.input.id}/verify`, 'POST', {}],
      [`/objects/${entry.input.id}/download`, 'GET', undefined],
    ] as const) expect((await request(path, method, body, cookieB)).status).toBe(404);
    expect(s3.calls).toHaveLength(before);
    expect((await fixture.app.query('SELECT * FROM content_objects')).rows).toEqual([]);
    expect((await fixture.app.withTenant(b.accountId, (q) => q.query('SELECT * FROM content_objects'))).rows).toEqual([]);
  });

  it('上传失败保留 staging；无正文不能验证或提交，恢复后沿用同 ID', async () => {
    const entry = await prepare();
    const puts = s3.calls.filter((call) => call.method === 'PUT').length;
    s3.faults.put = true;
    try { await expect(service.upload(a, entry.input.id, entry.bytes)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' }); }
    finally { s3.faults.put = false; }
    expect(s3.calls.filter((call) => call.method === 'PUT')).toHaveLength(puts + 1);
    await expect(service.verify(a, entry.input.id)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(fixture.app.withTenant(a.accountId, (q) => commitObjectGraph(q, a.accountId, workspaceId, entry.input.id))).rejects.toMatchObject({ code: 'CONTENT_REJECTED' });
    await service.upload(a, entry.input.id, entry.bytes);
    expect((await service.verify(a, entry.input.id)).object.status).toBe('verified');
  });

  it('上传已保存但响应失败：不自动重发，用原 ID 显式恢复仍只有一份正文', async () => {
    const entry = await prepare();
    const count = s3.objects.size;
    s3.faults.putAfterSave = true;
    try { await expect(service.upload(a, entry.input.id, entry.bytes)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' }); }
    finally { s3.faults.putAfterSave = false; }
    expect(s3.objects.size).toBe(count + 1);
    expect((await service.upload(a, entry.input.id, entry.bytes)).object.status).toBe('staging');
    expect(s3.objects.size).toBe(count + 1);
    expect((await service.verify(a, entry.input.id)).object.status).toBe('verified');
  });

  it('准备事务失败时不发起对象上传，重试准备仍沿用原请求', async () => {
    const input = { id: randomUUID(), workspaceId, domainId: randomUUID(), contract: 'endless-object-manifest/1' as const, digest: digest(manifest()), size: manifest().length };
    const calls = s3.calls.length;
    const original = fixture.app.withTenant.bind(fixture.app);
    const spy = vi.spyOn(fixture.app, 'withTenant').mockImplementation((account, fn) => original(account, async (q) => fn({
      query: async (sql, params) => {
        if (sql.includes('INSERT INTO content_objects')) throw new Error('synthetic-prepare-failure');
        return q.query(sql, params);
      },
    })));
    try { await expect(service.prepare(a, input)).rejects.toThrow('synthetic-prepare-failure'); }
    finally { spy.mockRestore(); }
    await expect(service.upload(a, input.id, manifest())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(s3.calls).toHaveLength(calls);
    expect((await service.prepare(a, input)).object.id).toBe(input.id);
  });

  it('对象已上传但验证写库失败：正文保留、仍不可见，恢复只重做 DB 验证', async () => {
    const entry = await prepare();
    await service.upload(a, entry.input.id, entry.bytes);
    const original = fixture.app.withTenant.bind(fixture.app);
    const spy = vi.spyOn(fixture.app, 'withTenant').mockImplementation((account, fn) => original(account, async (q) => fn({
      query: async (sql, params) => {
        if (sql.includes("SET status = 'verified'")) throw new Error('synthetic-db-failure');
        return q.query(sql, params);
      },
    })));
    try { await expect(service.verify(a, entry.input.id)).rejects.toThrow('synthetic-db-failure'); }
    finally { spy.mockRestore(); }
    expect((await request(`/objects/${entry.input.id}/download`)).status).toBe(404);
    const puts = s3.calls.filter((call) => call.method === 'PUT').length;
    expect((await service.verify(a, entry.input.id)).object.status).toBe('verified');
    expect(s3.calls.filter((call) => call.method === 'PUT')).toHaveLength(puts);
  });

  it('引用缺失/摘要不符/未验证/跨 workspace 都拒绝，提交引用闭包原子且可重复', async () => {
    const leaf = await verified();
    const missing = await prepare(manifest([{ id: randomUUID(), digest: leaf.input.digest, size: leaf.bytes.length }]));
    await service.upload(a, missing.input.id, missing.bytes);
    await expect(service.verify(a, missing.input.id)).rejects.toMatchObject({ code: 'CONTENT_REJECTED' });
    const mismatch = await prepare(manifest([{ id: leaf.input.id, digest: 'b'.repeat(64), size: leaf.bytes.length }]));
    await service.upload(a, mismatch.input.id, mismatch.bytes);
    await expect(service.verify(a, mismatch.input.id)).rejects.toMatchObject({ code: 'CONTENT_REJECTED' });
    const staging = await prepare();
    const pending = await prepare(manifest([{ id: staging.input.id, digest: staging.input.digest, size: staging.bytes.length }]));
    await service.upload(a, pending.input.id, pending.bytes);
    await expect(service.verify(a, pending.input.id)).rejects.toMatchObject({ code: 'CONTENT_REJECTED' });
    const otherWorkspace = (await createWorkspace(fixture.app, a, { contract: 'endless-workspace/1' }, randomUUID(), 'objects-test')).body.workspace.id;
    const cross = await prepare(manifest([{ id: leaf.input.id, digest: leaf.input.digest, size: leaf.bytes.length }]), { workspaceId: otherWorkspace });
    await service.upload(a, cross.input.id, cross.bytes);
    await expect(service.verify(a, cross.input.id)).rejects.toMatchObject({ code: 'CONTENT_REJECTED' });
    const parent = await verified(manifest([{ id: leaf.input.id, digest: leaf.input.digest, size: leaf.bytes.length }]));
    await fixture.app.withTenant(a.accountId, async (q) => {
      await commitObjectGraph(q, a.accountId, workspaceId, parent.input.id);
      await commitObjectGraph(q, a.accountId, workspaceId, parent.input.id);
    });
    expect((await service.download(a, leaf.input.id)).digest).toBe(leaf.input.digest);
    await expect(fixture.app.withTenant(a.accountId, (q) => q.query(
      'UPDATE content_objects SET digest = $1 WHERE account_id = $2 AND id = $3',
      ['c'.repeat(64), a.accountId, leaf.input.id],
    ))).rejects.toThrow();
  });

  it('DB 提交失败不留半个 root 或 committed 状态', async () => {
    const entry = await verified();
    await expect(fixture.app.withTenant(a.accountId, async (q) => {
      await commitObjectGraph(q, a.accountId, workspaceId, entry.input.id);
      throw new Error('synthetic-commit-failure');
    })).rejects.toThrow('synthetic-commit-failure');
    expect((await request(`/objects/${entry.input.id}/download`)).status).toBe(404);
    expect((await service.verify(a, entry.input.id)).object.status).toBe('verified');
  });

  it('对象存储损坏或不可读不生成有效下载链接', async () => {
    const entry = await verified();
    await fixture.app.withTenant(a.accountId, (q) => commitObjectGraph(q, a.accountId, workspaceId, entry.input.id));
    s3.faults.get = true;
    try { expect((await request(`/objects/${entry.input.id}/download`)).status).toBe(503); }
    finally { s3.faults.get = false; }
    const key = [...s3.objects.keys()].find((value) => value.endsWith(`/objects/${entry.input.id}`));
    expect(key).toBeTruthy();
    const stored = s3.objects.get(key!)!;
    s3.objects.set(key!, Buffer.from('corrupt'));
    try { await expect(service.download(a, entry.input.id)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' }); }
    finally { s3.objects.set(key!, stored); }
  });

  it('过期上传拒绝；空间预留真库串行，不靠过期状态虚减物理占用', async () => {
    const entry = await prepare();
    await withClient(fixture.cluster.adminDsn, (q) => q.query(
      "UPDATE content_objects SET upload_expires_at = now() - interval '1 second' WHERE account_id = $1 AND id = $2",
      [a.accountId, entry.input.id],
    ));
    await expect(service.upload(a, entry.input.id, entry.bytes)).rejects.toMatchObject({ code: 'UPLOAD_EXPIRED' });
    const tiny = new ObjectService(fixture.app, storage, fixture.deployment, { quotaBytes: manifest().length });
    const otherWorkspace = (await createWorkspace(fixture.app, b, { contract: 'endless-workspace/1' }, randomUUID(), 'objects-test')).body.workspace.id;
    const input = { ...entry.input, workspaceId: otherWorkspace, id: randomUUID(), domainId: randomUUID() };
    const results = await Promise.allSettled([
      tiny.prepare(b, input), tiny.prepare(b, { ...input, id: randomUUID(), domainId: randomUUID() }),
    ]);
    expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((value) => value.status === 'rejected')).toHaveLength(1);
    expect((await tiny.usage(b)).totalBytes).toBe(manifest().length);
  });

  it('未知正文、非 JSON 和过大存储响应拒绝；错误响应不泄露凭据', async () => {
    for (const bytes of [Buffer.from('not-json'), Buffer.from(JSON.stringify({ format: 'edition-backup', version: 1 }))]) {
      const entry = await prepare(bytes);
      await service.upload(a, entry.input.id, bytes);
      await expect(service.verify(a, entry.input.id)).rejects.toMatchObject({ code: 'CONTENT_REJECTED' });
    }
    const entry = await verified();
    for (const fault of ['oversized', 'chunkedOversized', 'compressed'] as const) {
      s3.faults[fault] = true;
      try { await expect(service.verify(a, entry.input.id)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' }); }
      finally { s3.faults[fault] = false; }
    }
    const response = await request('/objects/uploads', 'POST', { ...entry.input, storageKey: 'arbitrary' });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain(S3_CREDENTIALS.secretAccessKey);
    expect((await request('/capabilities')).body.features.objects).toBe(true);
  });

  it('变更需要会话和 Origin，拒绝本机 Key、压缩上传和非法 UUID', async () => {
    const entry = await prepare();
    const before = s3.calls.length;
    const path = `${base}/api/cloud/v1/objects/${entry.input.id}/body`;
    for (const [headers, status] of [
      [{ cookie }, 403],
      [{ origin: ORIGIN }, 401],
      [{ origin: ORIGIN, cookie, 'x-endless-provider-key': 'synthetic-provider-key' }, 403],
      [{ origin: ORIGIN, cookie, 'content-encoding': 'gzip' }, 400],
    ] as const) {
      const response = await fetch(path, {
        method: 'PUT', headers: { 'content-type': 'application/octet-stream', ...headers }, body: new Uint8Array(entry.bytes),
      });
      expect(response.status).toBe(status);
    }
    expect((await request(`/objects/${'-'.repeat(36)}/verify`, 'POST', {})).status).toBe(404);
    expect(s3.calls).toHaveLength(before);
  });

  it('跨租户/工作区引用由真库约束阻止；已验证引用图不能修改或倒退', async () => {
    const target = await verified();
    const source = await prepare();
    await expect(fixture.app.withTenant(b.accountId, (q) => q.query(
      'INSERT INTO object_references (account_id, workspace_id, from_object_id, to_object_id) VALUES ($1, $2, $3, $4)',
      [b.accountId, workspaceId, source.input.id, target.input.id],
    ))).rejects.toThrow();
    const otherWorkspace = (await createWorkspace(fixture.app, a, { contract: 'endless-workspace/1' }, randomUUID(), 'objects-test')).body.workspace.id;
    const cross = await prepare(manifest(), { workspaceId: otherWorkspace });
    await expect(fixture.app.withTenant(a.accountId, (q) => q.query(
      'INSERT INTO object_references (account_id, workspace_id, from_object_id, to_object_id) VALUES ($1, $2, $3, $4)',
      [a.accountId, workspaceId, cross.input.id, target.input.id],
    ))).rejects.toThrow();
    await expect(fixture.app.withTenant(a.accountId, (q) => q.query(
      'INSERT INTO workspace_object_roots (account_id, workspace_id, object_id) VALUES ($1, $2, $3)',
      [a.accountId, workspaceId, source.input.id],
    ))).rejects.toThrow();
    await expect(fixture.app.withTenant(a.accountId, (q) => q.query(
      'INSERT INTO object_references (account_id, workspace_id, from_object_id, to_object_id) VALUES ($1, $2, $3, $4)',
      [a.accountId, workspaceId, target.input.id, source.input.id],
    ))).rejects.toThrow();
    await expect(fixture.app.withTenant(a.accountId, (q) => q.query(
      "UPDATE content_objects SET status = 'staging', verified_at = NULL WHERE account_id = $1 AND id = $2",
      [a.accountId, target.input.id],
    ))).rejects.toThrow();
  });

  it('并发验证与提交复用同一闭包；候选查询不删除且被引用对象保留', async () => {
    const leaf = await verified();
    const parent = await prepare(manifest([{ id: leaf.input.id, digest: leaf.input.digest, size: leaf.bytes.length }]));
    await service.upload(a, parent.input.id, parent.bytes);
    const validations = await Promise.all([service.verify(a, parent.input.id), service.verify(a, parent.input.id)]);
    expect(validations.every((value) => value.object.status === 'verified')).toBe(true);
    await Promise.all([
      fixture.app.withTenant(a.accountId, (q) => commitObjectGraph(q, a.accountId, workspaceId, parent.input.id)),
      fixture.app.withTenant(a.accountId, (q) => commitObjectGraph(q, a.accountId, workspaceId, parent.input.id)),
    ]);
    const expiredObject = await verified();
    const uncommittedParent = await verified(manifest([{ id: expiredObject.input.id, digest: expiredObject.input.digest, size: expiredObject.bytes.length }]));
    await withClient(fixture.cluster.adminDsn, (q) => q.query(
      "UPDATE content_objects SET retain_until = now() - interval '1 second' WHERE account_id = $1 AND id = ANY($2::uuid[])",
      [a.accountId, [expiredObject.input.id, uncommittedParent.input.id, parent.input.id]],
    ));
    const before = await service.usage(a);
    const candidates = await service.unreferencedCandidates(a);
    expect(candidates.some((value) => value.id === uncommittedParent.input.id)).toBe(true);
    expect(candidates.some((value) => value.id === expiredObject.input.id || value.id === parent.input.id)).toBe(false);
    expect(await service.usage(a)).toEqual(before);
    await expect(fixture.app.withTenant(a.accountId, (q) => commitObjectGraph(q, a.accountId, workspaceId, uncommittedParent.input.id))).rejects.toMatchObject({ code: 'UPLOAD_EXPIRED' });
    expect((await service.download(a, parent.input.id)).size).toBe(parent.bytes.length);
  });

  it('对象大小和实测摘要必须匹配，无法利用同 key 写入不同字节', async () => {
    const entry = await prepare();
    const key = `cloud/${fixture.deployment.id}/tenants/${a.accountId}/objects/${entry.input.id}`;
    await storage.put(key, entry.bytes);
    await storage.put(key, entry.bytes);
    await expect(storage.put(key, Buffer.alloc(entry.bytes.length, 1))).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(await storage.read(key, entry.bytes.length)).toEqual(entry.bytes);
    const uppercase = await prepare(manifest(), { id: randomUUID().toUpperCase() });
    expect(uppercase.object.id).toBe(uppercase.input.id.toLowerCase());
    const bad = await request('/objects/uploads', 'POST', { ...entry.input, size: 2_097_153 });
    expect(bad.status).toBe(400);
    const large = await fetch(`${base}/api/cloud/v1/objects/${entry.input.id}/body`, {
      method: 'PUT', headers: { origin: ORIGIN, cookie, 'content-type': 'application/octet-stream' }, body: new Uint8Array(2_097_153),
    });
    expect(large.status).toBe(413);
  });

  it('存储服务只返回响应头后挂起，正文读取仍有独立总超时', async () => {
    const entry = await verified();
    s3.faults.stall = true;
    try { await expect(service.verify(a, entry.input.id)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' }); }
    finally { s3.faults.stall = false; }
  }, 20_000);
});
