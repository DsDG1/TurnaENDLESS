import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildBackup, reserveTicket, updateDisplay } from '@endless/content';
import { validateCloudBackup } from '@endless/content/cloud';
import { AuthService, type AuthContext } from '../../src/cloud/auth/service.js';
import { OutboxMailer, readQueuedMail } from '../../src/cloud/mail.js';
import { ObjectService } from '../../src/cloud/objects/service.js';
import { S3ObjectStorage } from '../../src/cloud/objects/storage.js';
import { ImportService, reserveContentIdentity } from '../../src/cloud/imports/service.js';
import { createCloudServer } from '../../src/cloud/server.js';
import { cloudCapabilities } from '../../src/cloud/capabilities.js';
import { cloudFixture, closeServer, listenLoopback, TEST_MAIL_KEY, TEST_PEPPER } from './fixtures.js';
import { fakeObjectStorage, S3_CREDENTIALS } from './object-storage-fixture.js';
import { cloudTestContent as content, cloudTestWorkspace, cloudTestTime } from '../../../../packages/content/test/cloud-fixture.js';
import { withClient } from './embedded-pg.js';

let fixture: Awaited<ReturnType<typeof cloudFixture>>;
let s3: Awaited<ReturnType<typeof fakeObjectStorage>>;
let storage: S3ObjectStorage;
let objects: ObjectService;
let imports: ImportService;
let server: ReturnType<typeof createCloudServer>;
let base: string;
let a: AuthContext;
let b: AuthContext;
let second: AuthContext;
let cookie: string;
let cookieB: string;
const ORIGIN = 'https://endless.example.test';
const bytes = (value = buildBackup(cloudTestWorkspace())) => Buffer.from(JSON.stringify(value));

beforeAll(async () => {
  fixture = await cloudFixture();
  s3 = await fakeObjectStorage();
  storage = new S3ObjectStorage({ endpoint: s3.endpoint, bucket: 'synthetic-bucket', region: 'test-1', ...S3_CREDENTIALS });
  objects = new ObjectService(fixture.app, storage, fixture.deployment, {
    quotaBytes: 16_777_216, backupValidator: (raw) => { validateCloudBackup(content, raw); },
  });
  imports = new ImportService(fixture.app, objects, content, fixture.deployment);
  const auth = new AuthService(fixture.auth, new OutboxMailer(TEST_MAIL_KEY), TEST_PEPPER);
  const login = async (email = `${randomUUID()}@example.test`, ip = randomUUID()) => {
    const challenge = await auth.issueChallenge({ email, ip }, 'import-test');
    const code = /验证码是 (\d{6})/.exec((await readQueuedMail(fixture.auth, email, TEST_MAIL_KEY))[0]!.body)![1]!;
    const session = await auth.verifyChallenge({ challengeId: challenge.challengeId, email, code }, 'import-test');
    return { ctx: (await auth.resolveSession(session.token))!, cookie: `__Host-endless_session=${session.token}`, email };
  };
  const first = await login();
  const other = await login();
  await withClient(fixture.cluster.adminDsn, (q) => q.query("UPDATE auth_challenges SET created_at = now() - interval '2 minutes'"));
  const another = await login(first.email);
  a = first.ctx; cookie = first.cookie; b = other.ctx; cookieB = other.cookie; second = another.ctx;
  server = createCloudServer({
    auth: fixture.auth, app: fixture.app, pepper: TEST_PEPPER, mailer: new OutboxMailer(TEST_MAIL_KEY),
    origins: [ORIGIN], hosts: ['127.0.0.1'], deployment: fixture.deployment, objects, imports,
    capabilities: cloudCapabilities({ objects: true, imports: true }),
  });
  base = `http://127.0.0.1:${await listenLoopback(server)}`;
}, 120_000);

afterAll(async () => {
  if (server) await closeServer(server);
  storage?.close(); await s3?.close(); await fixture?.close();
}, 60_000);

async function request(path: string, method = 'GET', body?: unknown, session = cookie, key = randomUUID()) {
  const response = await fetch(`${base}/api/cloud/v1${path}`, {
    method, headers: { origin: ORIGIN, cookie: session, 'idempotency-key': key, 'content-type': body instanceof Buffer ? 'application/octet-stream' : 'application/json' },
    body: body === undefined ? undefined : body instanceof Buffer ? new Uint8Array(body) : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any, headers: response.headers };
}

const activateInput = (preview: Awaited<ReturnType<ImportService['preview']>>['preview']) => ({
  previewId: preview.id, snapshotDigest: preview.snapshotDigest, validationBinding: preview.validationBinding,
});

describe('C2 导入与稳定身份：真实 PostgreSQL 和对象协议', () => {
  it('预览不激活；确认后两设备领相同原件/种子/修订 ID，并幂等确认安装', async () => {
    const backup = buildBackup(cloudTestWorkspace(true));
    const original = JSON.stringify(backup);
    const preview = await request('/workspaces/import-previews', 'POST', bytes(backup));
    expect(preview.status).toBe(200);
    expect(preview.body.preview.counts.entries).toBe(4);
    expect((await request('/workspaces')).body.workspaces).toEqual([]);
    expect((await request(`/workspaces/${preview.body.preview.workspaceId}/package`)).status).toBe(404);
    const activated = await request('/workspaces/imports', 'POST', activateInput(preview.body.preview));
    expect(activated.status).toBe(200);
    const receipt = activated.body.receipt;
    const first = await imports.package(a, receipt.workspaceId);
    const next = await imports.package(second, receipt.workspaceId);
    expect(first).toEqual(next);
    expect(first.workspace.entries.map((entry) => entry.id)).toEqual(backup.workspace.data.entries.map((entry) => entry.id));
    expect(first.workspace.revisions.map((entry) => entry.id)).toEqual(backup.workspace.data.revisions.map((entry) => entry.id));
    const installation = await imports.install(second, receipt.workspaceId, { importId: receipt.id, copyDigest: receipt.copyDigest }, randomUUID());
    const repeat = await imports.install(second, receipt.workspaceId, { importId: receipt.id, copyDigest: receipt.copyDigest }, randomUUID());
    expect(repeat).toEqual(installation);
    expect(JSON.stringify(backup)).toBe(original);
    expect(first.workspace.profile.boundAccountId).toBeNull();
  });

  it('相同导入并发/响应丢失复用；重新导出只变 exportedAt 不重复导入', async () => {
    const backup = buildBackup(cloudTestWorkspace());
    const key = randomUUID();
    const [one, two] = await Promise.all([imports.preview(a, bytes(backup), key), imports.preview(a, bytes(backup), key)]);
    expect(one.preview.id).toBe(two.preview.id);
    const other = await imports.preview(a, bytes({ ...backup, exportedAt: '2026-11-02T00:00:00.000Z' }), randomUUID());
    expect(other.preview.id).toBe(one.preview.id);
    const receipts = await Promise.all([
      imports.activate(a, activateInput(one.preview), randomUUID()),
      imports.activate(a, activateInput(one.preview), randomUUID()),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
  });

  it('同幂等键异文或同来源已激活后变更，拒绝覆盖和假成功', async () => {
    const backup = buildBackup(cloudTestWorkspace());
    const key = randomUUID();
    const preview = await imports.preview(a, bytes(backup), key);
    const changed = buildBackup(updateDisplay(backup.workspace.data, backup.workspace.data.entries[0]!.id, { title: 'Changed' }));
    await expect(imports.preview(a, bytes(changed), key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
    await imports.activate(a, activateInput(preview.preview), randomUUID());
    await expect(imports.preview(a, bytes(changed), randomUUID())).rejects.toMatchObject({ code: 'BASIS_CHANGED' });
    await expect(imports.activate(a, { ...activateInput(preview.preview), snapshotDigest: '0'.repeat(64) }, randomUUID())).rejects.toMatchObject({ code: 'BASIS_CHANGED' });
  });

  it('跨账号预览/确认/领取/回执不能读取原件；RLS 和归属外键关闭越权', async () => {
    const preview = await imports.preview(a, bytes(), randomUUID());
    const receipt = (await imports.activate(a, activateInput(preview.preview), randomUUID())).receipt;
    const calls = s3.calls.length;
    await expect(imports.activate(b, activateInput(preview.preview), randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(imports.package(b, receipt.workspaceId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(imports.install(b, receipt.workspaceId, { importId: receipt.id, copyDigest: receipt.copyDigest }, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(s3.calls).toHaveLength(calls);
    expect((await fixture.app.query('SELECT * FROM workspace_imports')).rows).toEqual([]);
    expect((await request(`/workspaces/${receipt.workspaceId}/package`, 'GET', undefined, cookieB)).status).toBe(404);
  });

  it('未完成本机调用只作为来源信息，不产生云任务或自动恢复', async () => {
    const backup = buildBackup(reserveTicket(cloudTestWorkspace(), new Date(cloudTestTime)).workspace);
    const preview = await imports.preview(a, bytes(backup), randomUUID());
    expect(preview.preview.pendingLocalTickets).toBe(1);
    const receipt = (await imports.activate(a, activateInput(preview.preview), randomUUID())).receipt;
    const installed = await imports.package(a, receipt.workspaceId);
    expect(installed.workspace.tickets[0]).toMatchObject({ status: 'failed', failureCategory: 'local-origin-only' });
    expect(backup.workspace.data.tickets[0]!.status).toBe('reserved');
    expect((await request('/capabilities')).body.features.generation).toBe(false);
    // 能力发现与挂载一致：本套件显式启用了对象与导入，二者必须报 true，其余仍为 false
    expect((await request('/capabilities')).body.features).toMatchObject({ objects: true, import: true, sync: false, credits: false });
  });

  it('未知/损坏/额外字段备份验证失败，不上传、不创建云实例', async () => {
    const calls = s3.calls.length;
    for (const data of [
      Buffer.from('not-json'), Buffer.from('{"format":"edition-backup","version":1,"trustRoot":"unknown"}'),
      bytes({ ...buildBackup(cloudTestWorkspace()), sessionToken: 'synthetic' } as any),
    ]) await expect(imports.preview(a, data, randomUUID())).rejects.toMatchObject({ code: 'CONTENT_REJECTED' });
    expect(s3.calls).toHaveLength(calls);
  });

  it('对象成功但最终激活事务失败，保持不可见；沿原请求重试不重复对象', async () => {
    const preview = await imports.preview(a, bytes(), randomUUID());
    const original = fixture.app.withTenant.bind(fixture.app);
    const spy = vi.spyOn(fixture.app, 'withTenant').mockImplementation((account, fn) => original(account, async (q) => fn({
      query: async (sql, params) => {
        if (sql.includes('INSERT INTO workspace_imports')) throw new Error('synthetic-import-commit-failure');
        return q.query(sql, params);
      },
    })));
    try { await expect(imports.activate(a, activateInput(preview.preview), randomUUID())).rejects.toThrow('synthetic-import-commit-failure'); }
    finally { spy.mockRestore(); }
    await expect(imports.package(a, preview.preview.workspaceId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const puts = s3.calls.filter((call) => call.method === 'PUT').length;
    const receipt = await imports.activate(a, activateInput(preview.preview), randomUUID());
    expect(receipt.receipt.workspaceId).toBe(preview.preview.workspaceId);
    expect(s3.calls.filter((call) => call.method === 'PUT')).toHaveLength(puts);
  });

  it('上传中断和过期预览不能伪激活；原 ID 可以恢复已保存的对象', async () => {
    const data = bytes();
    const key = randomUUID();
    s3.faults.putAfterSave = true;
    try { await expect(imports.preview(a, data, key)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' }); }
    finally { s3.faults.putAfterSave = false; }
    const preview = await imports.preview(a, data, key);
    await withClient(fixture.cluster.adminDsn, (q) => q.query(
      "UPDATE import_previews SET expires_at = now() - interval '1 second' WHERE account_id = $1 AND id = $2",
      [a.accountId, preview.preview.id],
    ));
    await expect(imports.activate(a, activateInput(preview.preview), randomUUID())).rejects.toMatchObject({ code: 'UPLOAD_EXPIRED' });
  });

  it('生成结果身份可按交付键只分配一次，但不实现生成或收费', async () => {
    const preview = await imports.preview(a, bytes(), randomUUID());
    const receipt = (await imports.activate(a, activateInput(preview.preview), randomUUID())).receipt;
    const deliveryKey = randomUUID();
    const identities = await Promise.all([1, 2].map(() => fixture.app.withTenant(a.accountId, (q) =>
      reserveContentIdentity(q, a.accountId, receipt.workspaceId, deliveryKey))));
    expect(identities[0]).toEqual(identities[1]);
    expect(identities[0]!.contentId).toMatch(/^ent_/);
    expect(identities[0]!.revisionId).toMatch(/^rev_/);
  });
});
