import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request as httpRequest, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bootstrapRoles } from '../../src/cloud/db/roles.js';
import { loadMigrations, migrate } from '../../src/cloud/db/migrate.js';
import { CloudPool } from '../../src/cloud/db/client.js';
import { OutboxMailer, readQueuedMail } from '../../src/cloud/mail.js';
import { createCloudServer } from '../../src/cloud/server.js';
import { cloudCapabilities } from '../../src/cloud/capabilities.js';
import { AuthService } from '../../src/cloud/auth/service.js';
import { assertCloudDeployment, bindCloudDeployment, type CloudDeployment } from '../../src/cloud/deployment.js';
import { accountContext } from '../../src/cloud/deployment.js';
import { consumeAuthLimit } from '../../src/cloud/auth/limits.js';
import { assertCloudRole } from '../../src/cloud/runtime.js';
import { MeResponseSchema } from '@endless/cloud-contracts';
import { createWorkspace } from '../../src/cloud/access/workspaces.js';
import { startTestCluster, withClient, type TestCluster } from './embedded-pg.js';

/**
 * 真实 PostgreSQL 集成测试（C1 出口要求）：
 * 双角色连接、RLS 跨租户拒绝、挑战→会话→设备→工作区全链路、幂等裁决。
 * embedded-postgres 不可用（非 Windows/缺二进制）时整组跳过并明示。
 */

let cluster: TestCluster | null = null;
let server: Server | null = null;
let base = '';
let authPool: CloudPool;
let appPool: CloudPool;
const AUTH_PW = 'authpw-test-32bytes-minimum!';
const APP_PW = 'apppw-test-32bytes-minimum!!';
const PEPPER = 'test-session-pepper-32-bytes-long!!';
const MAIL_KEY = Buffer.from('ab'.repeat(32), 'hex');
const ORIGIN = 'http://127.0.0.1:5173';
let deployment: CloudDeployment;

async function req(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  headers.set('origin', ORIGIN);
  const response = await fetch(`${base}/api/cloud/v1${path}`, { ...init, headers });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

async function codeFor(email: string): Promise<string> {
  const mails = await readQueuedMail(authPool, email, MAIL_KEY);
  const match = /验证码是 (\d{6})/.exec(mails[0]?.body ?? '');
  return match?.[1] ?? '';
}

async function signIn(email: string, deviceName = 'test-device'): Promise<{ cookie: string; accountId: string; deviceId: string }> {
  const challenge = await req('/auth/challenges', { method: 'POST', body: JSON.stringify({ email }) });
  expect(challenge.status).toBe(202);
  const code = await codeFor(email);
  const verify = await req('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: challenge.body.challengeId, email, code, deviceName }),
  });
  expect(verify.status).toBe(200);
  return { cookie: verify.headers.get('set-cookie')!.split(';')[0]!, accountId: verify.body.accountId, deviceId: verify.body.deviceId };
}

beforeAll(async () => {
  cluster = await startTestCluster();
  if (!cluster) return;
  await withClient(cluster.adminDsn, async (client) => {
    await bootstrapRoles(client, { authPassword: AUTH_PW, appPassword: APP_PW });
    await migrate(client, await loadMigrations());
    deployment = await bindCloudDeployment(client, 'test');
  });
  authPool = CloudPool.connect(`postgres://endless_auth:${AUTH_PW}@127.0.0.1:${cluster.port}/postgres`);
  appPool = CloudPool.connect(`postgres://endless_app:${APP_PW}@127.0.0.1:${cluster.port}/postgres`);
  server = createCloudServer({
    auth: authPool, app: appPool, pepper: Buffer.from(PEPPER),
    origins: [ORIGIN], hosts: ['127.0.0.1', 'localhost'],
    mailer: new OutboxMailer(MAIL_KEY), capabilities: cloudCapabilities(), deployment,
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}, 120_000);

afterAll(async () => {
  server?.close();
  await authPool?.close();
  await appPool?.close();
  await cluster?.stop();
}, 60_000);

describe('云 C1 集成（真实 PostgreSQL）', () => {
  it('capabilities 无需会话且不含密钥字段', async () => {
    if (!cluster) return;
    const res = await req('/capabilities');
    expect(res.status).toBe(200);
    expect(res.body.features.accounts).toBe(true);
    expect(res.body.features.sync).toBe(false);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('拒绝本机页面 Key 与非法 Host', async () => {
    if (!cluster) return;
    const key = await req('/capabilities', { headers: { 'x-endless-provider-key': 'sk-test' } });
    expect(key.status).toBe(403);
    // fetch 不能覆写 Host（受限头）：用原始 http.request 发出非法 Host。
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const url = new URL(`${base}/api/cloud/v1/capabilities`);
      const req2 = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname, headers: { Host: 'evil.example' } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req2.on('error', reject);
      req2.end();
    });
    expect(hostStatus).toBe(403);
  });

  it('状态变更缺少 Origin 被拒绝（CSRF）', async () => {
    if (!cluster) return;
    const res = await fetch(`${base}/api/cloud/v1/auth/challenges`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.c' }),
    });
    expect(res.status).toBe(403);
  });

  it('完整链路：挑战→验证码→会话→me→工作区→设备→登出', async () => {
    if (!cluster) return;
    const email = `user-${randomUUID().slice(0, 8)}@test.dev`;
    const session = await signIn(email, 'browser-one');
    const me = await req('/me', { headers: { cookie: session.cookie } });
    expect(me.status).toBe(200);
    expect(me.body.account.id).toBe(session.accountId);
    expect(me.body.device.current).toBe(true);

    // 工作区创建：幂等键重放返回原回执，异摘要 409
    const key = randomUUID();
    const created = await req('/workspaces', {
      method: 'POST', headers: { cookie: session.cookie, 'idempotency-key': key },
      body: JSON.stringify({ contract: 'endless-workspace/1', sourceLocalId: 'local-1', displayName: '我的库' }),
    });
    expect(created.status).toBe(201);
    const replay = await req('/workspaces', {
      method: 'POST', headers: { cookie: session.cookie, 'idempotency-key': key },
      body: JSON.stringify({ contract: 'endless-workspace/1', sourceLocalId: 'local-1', displayName: '我的库' }),
    });
    expect(replay.status).toBe(201);
    expect(replay.body.workspace.id).toBe(created.body.workspace.id);
    const mismatch = await req('/workspaces', {
      method: 'POST', headers: { cookie: session.cookie, 'idempotency-key': key },
      body: JSON.stringify({ contract: 'endless-workspace/1', sourceLocalId: 'other' }),
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_MISMATCH');

    // 同 sourceLocalId 不同幂等键：复用同一云实例，不重复建
    const again = await req('/workspaces', {
      method: 'POST', headers: { cookie: session.cookie, 'idempotency-key': randomUUID() },
      body: JSON.stringify({ contract: 'endless-workspace/1', sourceLocalId: 'local-1' }),
    });
    expect(again.body.workspace.id).toBe(created.body.workspace.id);

    const list = await req('/workspaces', { headers: { cookie: session.cookie } });
    expect(list.body.workspaces).toHaveLength(1);

    // 会话令牌只活在 Cookie：响应体不携带 token
    expect(JSON.stringify(me.body)).not.toContain('token');

    // 设备列表 → 撤销当前设备 → 会话失效
    const devices = await req('/devices', { headers: { cookie: session.cookie } });
    expect(devices.body.devices).toHaveLength(1);
    const revoke = await req(`/devices/${session.deviceId}`, { method: 'DELETE', headers: { cookie: session.cookie } });
    expect(revoke.status).toBe(200);
    const after = await req('/me', { headers: { cookie: session.cookie } });
    expect(after.status).toBe(401);
  });

  it('错误验证码、重放挑战、跨租户 RLS 全拒绝', async () => {
    if (!cluster) return;
    const emailA = `a-${randomUUID().slice(0, 8)}@test.dev`;
    const emailB = `b-${randomUUID().slice(0, 8)}@test.dev`;

    const chA = await req('/auth/challenges', { method: 'POST', body: JSON.stringify({ email: emailA }) });
    const wrong = await req('/auth/verify', {
      method: 'POST', body: JSON.stringify({ challengeId: chA.body.challengeId, email: emailA, code: '999999' }),
    });
    expect(wrong.status).toBe(401);
    // 挑战与接收方绑定：换邮箱同样 401
    const bound = await req('/auth/verify', {
      method: 'POST', body: JSON.stringify({ challengeId: chA.body.challengeId, email: emailB, code: await codeFor(emailA) }),
    });
    expect(bound.status).toBe(401);

    const sessionA = await signIn(emailA);
    const sessionB = await signIn(emailB);
    // 同验证码不能二次消费：signIn 已消费原挑战
    const codeA = await codeFor(emailA);
    const replay = await req('/auth/verify', {
      method: 'POST', body: JSON.stringify({ challengeId: chA.body.challengeId, email: emailA, code: codeA }),
    });
    expect(replay.status).toBe(401);

    // A 建工作区；B 列表不可见；直接 SQL 以 B 租户读 A 的行也返回空（RLS 第二道防线）
    const key = randomUUID();
    await req('/workspaces', {
      method: 'POST', headers: { cookie: sessionA.cookie, 'idempotency-key': key },
      body: JSON.stringify({ contract: 'endless-workspace/1' }),
    });
    const listB = await req('/workspaces', { headers: { cookie: sessionB.cookie } });
    expect(listB.status).toBe(200);
    expect(listB.body.workspaces).toHaveLength(0);

    const accountA = sessionA.accountId;
    const asB = await appPool.withTenant(sessionB.accountId, async (q) =>
      q.query('SELECT id FROM workspaces WHERE account_id = $1', [accountA]));
    expect(asB.rows).toHaveLength(0);
    // 无租户上下文时业务表整体不可见：SELECT 返回零行（fail-closed），写入被拒。
    const noTenant = await appPool.query('SELECT id FROM workspaces');
    expect(noTenant.rows).toHaveLength(0);
    await expect(appPool.query(
      'INSERT INTO workspaces (account_id, contract) VALUES ($1, $2)', [sessionB.accountId, 'endless-workspace/1']))
      .rejects.toThrow();
  });

  it('登出撤销会话；同邮箱再登录仍是同一账号', async () => {
    if (!cluster) return;
    const email = `c-${randomUUID().slice(0, 8)}@test.dev`;
    const first = await signIn(email);
    await req('/auth/logout', { method: 'POST', headers: { cookie: first.cookie } });
    const dead = await req('/me', { headers: { cookie: first.cookie } });
    expect(dead.status).toBe(401);
    const second = await signIn(email);
    expect(second.accountId).toBe(first.accountId);
    expect(second.deviceId).not.toBe(first.deviceId);
  });

  it('错误验证码计数必须提交，耗尽后正确验证码也不能登录', async () => {
    if (!cluster) throw new Error('需要真实 PostgreSQL');
    const email = `attempt-${randomUUID()}@test.dev`;
    const service = new AuthService(authPool, new OutboxMailer(MAIL_KEY), Buffer.from(PEPPER));
    const challenge = await service.issueChallenge({ email, ip: randomUUID() }, 'attempt-limit-test');
    const code = await codeFor(email);
    const wrong = code === '000000' ? '000001' : '000000';
    for (let attempt = 1; attempt <= 8; attempt++) {
      await expect(service.verifyChallenge({ challengeId: challenge.challengeId, email, code: wrong }, 'attempt-limit-test'))
        .rejects.toMatchObject({ status: 401 });
      const row = await authPool.query<{ attempts: number }>('SELECT attempts FROM auth_challenges WHERE id = $1', [challenge.challengeId]);
      expect(row.rows[0]?.attempts).toBe(attempt);
    }
    await expect(service.verifyChallenge({ challengeId: challenge.challengeId, email, code }, 'attempt-limit-test'))
      .rejects.toMatchObject({ status: 401 });
  });

  it('并发相同 sourceLocalId 的不同请求复用同一工作区', async () => {
    if (!cluster) throw new Error('需要真实 PostgreSQL');
    const session = await signIn(`race-${randomUUID()}@test.dev`);
    const results = await Promise.all(Array.from({ length: 8 }, () => req('/workspaces', {
      method: 'POST', headers: { cookie: session.cookie, 'idempotency-key': randomUUID() },
      body: JSON.stringify({ contract: 'endless-workspace/1', sourceLocalId: 'same-source' }),
    })));
    expect(results.map((res) => res.status)).toEqual(expect.arrayContaining([201]));
    expect(results.every((res) => res.status === 200 || res.status === 201)).toBe(true);
    expect(new Set(results.map((res) => res.body.workspace.id)).size).toBe(1);
  });

  it('跨租户不能把自己的 membership 或设备绑定到别人的工作区', async () => {
    if (!cluster) throw new Error('需要真实 PostgreSQL');
    const a = await signIn(`owner-${randomUUID()}@test.dev`);
    const b = await signIn(`outsider-${randomUUID()}@test.dev`);
    const created = await req('/workspaces', {
      method: 'POST', headers: { cookie: a.cookie, 'idempotency-key': randomUUID() },
      body: JSON.stringify({ contract: 'endless-workspace/1' }),
    });
    await expect(appPool.withTenant(b.accountId, (q) => q.query(
      'INSERT INTO workspace_memberships (workspace_id, account_id, role) VALUES ($1, $2, $3)',
      [created.body.workspace.id, b.accountId, 'owner'],
    ))).rejects.toThrow();
    await expect(appPool.withTenant(b.accountId, (q) => q.query(
      'INSERT INTO device_bindings (device_id, account_id, workspace_id) VALUES ($1, $2, $3)',
      [b.deviceId, b.accountId, created.body.workspace.id],
    ))).rejects.toThrow();
    const update = await appPool.withTenant(b.accountId, (q) => q.query(
      "UPDATE workspaces SET display_name = 'tampered' WHERE id = $1", [created.body.workspace.id],
    ));
    expect(update.rowCount).toBe(0);
    await expect(appPool.withTenant(b.accountId, (q) => q.query(
      'INSERT INTO workspaces (account_id, contract) VALUES ($1, $2)', [a.accountId, 'endless-workspace/1'],
    ))).rejects.toThrow();
  });

  it('账号进入注销流程后既有会话不可继续访问', async () => {
    if (!cluster) throw new Error('需要真实 PostgreSQL');
    const session = await signIn(`inactive-${randomUUID()}@test.dev`);
    await withClient(cluster.adminDsn, (q) => q.query(
      "UPDATE accounts SET status = 'deletion_pending' WHERE id = $1", [session.accountId],
    ));
    expect((await req('/me', { headers: { cookie: session.cookie } })).status).toBe(401);
  });

  it('登录旋转会话，切换账号返回隔离命名空间且失败不撤销原会话', async () => {
    if (!cluster) throw new Error('需要真实 PostgreSQL');
    const service = new AuthService(authPool, new OutboxMailer(MAIL_KEY), Buffer.from(PEPPER));
    const login = async (email: string, previousToken?: string) => {
      const challenge = await service.issueChallenge({ email, ip: randomUUID() }, 'rotation-test');
      return service.verifyChallenge({ challengeId: challenge.challengeId, email, code: await codeFor(email) }, 'rotation-test', previousToken);
    };
    const first = await login(`rotation-a-${randomUUID()}@test.dev`);
    const second = await login(`rotation-b-${randomUUID()}@test.dev`, first.token);
    expect(second.token).not.toBe(first.token);
    expect(await service.resolveSession(first.token)).toBeNull();
    expect(await service.resolveSession(second.token)).toMatchObject({ accountId: second.accountId });
    expect(accountContext(deployment, first.accountId).localNamespace).not.toBe(accountContext(deployment, second.accountId).localNamespace);
    const me = await req('/me', { headers: { cookie: `__Host-endless_session=${second.token}` } });
    expect(MeResponseSchema.safeParse(me.body).success).toBe(true);
    const challenge = await service.issueChallenge({ email: `failed-${randomUUID()}@test.dev`, ip: randomUUID() }, 'rotation-test');
    await expect(service.verifyChallenge({ challengeId: challenge.challengeId, email: 'wrong@test.dev', code: '123456' }, 'rotation-test', second.token))
      .rejects.toMatchObject({ status: 401 });
    expect(await service.resolveSession(second.token)).not.toBeNull();
  });

  it('同一验证码并发消费只有一个成功，过期验证码不建会话', async () => {
    if (!cluster) throw new Error('需要真实 PostgreSQL');
    const service = new AuthService(authPool, new OutboxMailer(MAIL_KEY), Buffer.from(PEPPER));
    const email = `single-use-${randomUUID()}@test.dev`;
    const challenge = await service.issueChallenge({ email, ip: randomUUID() }, 'single-use-test');
    const input = { challengeId: challenge.challengeId, email, code: await codeFor(email) };
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.verifyChallenge(input, 'single-use-test')));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const expired = new AuthService(authPool, new OutboxMailer(MAIL_KEY), Buffer.from(PEPPER), false, () => new Date(Date.now() - 11 * 60_000));
    const old = await expired.issueChallenge({ email: `expired-${randomUUID()}@test.dev`, ip: randomUUID() }, 'expired-test');
    await expect(service.verifyChallenge({ challengeId: old.challengeId, email, code: '123456' }, 'expired-test')).rejects.toMatchObject({ status: 401 });
  });

  it('接收方限流在多服务并发签发时仍最多五次', async () => {
    if (!cluster) throw new Error('需要真实 PostgreSQL');
    const email = `recipient-limit-${randomUUID()}@test.dev`;
    const results = await Promise.allSettled(Array.from({ length: 10 }, () =>
      new AuthService(authPool, new OutboxMailer(MAIL_KEY), Buffer.from(PEPPER))
        .issueChallenge({ email, ip: randomUUID() }, 'recipient-limit-test')));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
    expect(results.filter((result) => result.status === 'rejected').every((result) => result.reason.status === 429)).toBe(true);
  });

  it('同账号第二台设备复用工作区时保存显式设备绑定', async () => {
    if (!cluster) throw new Error('需要真实 PostgreSQL');
    const service = new AuthService(authPool, new OutboxMailer(MAIL_KEY), Buffer.from(PEPPER));
    const email = `binding-${randomUUID()}@test.dev`;
    const sessions = [];
    for (let index = 0; index < 2; index++) {
      const challenge = await service.issueChallenge({ email, ip: randomUUID() }, 'binding-test');
      const session = await service.verifyChallenge({ challengeId: challenge.challengeId, email, code: await codeFor(email) }, 'binding-test');
      const ctx = await service.resolveSession(session.token);
      expect(ctx).not.toBeNull();
      sessions.push(ctx!);
    }
    const first = await createWorkspace(appPool, sessions[0]!, {
      contract: 'endless-workspace/1', sourceLocalId: 'binding-source',
    }, randomUUID(), 'binding-test');
    const second = await createWorkspace(appPool, sessions[1]!, {
      contract: 'endless-workspace/1', sourceLocalId: 'binding-source',
    }, randomUUID(), 'binding-test');
    expect(second.body.workspace.id).toBe(first.body.workspace.id);
    const bindings = await appPool.withTenant(sessions[0]!.accountId, (q) => q.query(
      'SELECT device_id FROM device_bindings WHERE workspace_id = $1', [first.body.workspace.id],
    ));
    expect(new Set(bindings.rows.map((row) => row.device_id))).toEqual(new Set(sessions.map((ctx) => ctx.deviceId)));
  });

  it('来源限流跨连接池原子计数且不存明文 IP', async () => {
    if (!cluster) throw new Error('需要真实 PostgreSQL');
    const key = `synthetic-ip-${randomUUID()}`;
    const results = await Promise.allSettled(Array.from({ length: 12 }, () =>
      consumeAuthLimit(authPool, Buffer.from(PEPPER), 'test_ip', key, 3, 60)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    const rows = await authPool.query('SELECT key_digest FROM auth_rate_limits WHERE scope = $1', ['test_ip']);
    expect(JSON.stringify(rows.rows)).not.toContain(key);
  });

  it('连接池成功和回滚后不残留租户身份，角色和审计最小权限有效', async () => {
    if (!cluster) throw new Error('需要真实 PostgreSQL');
    const single = CloudPool.connect(`postgres://endless_app:${APP_PW}@127.0.0.1:${cluster.port}/postgres`, { max: 1 });
    try {
      await assertCloudRole(single, 'endless_app');
      await expect(assertCloudRole(single, 'endless_auth')).rejects.toThrow();
      for (const id of [randomUUID(), randomUUID(), randomUUID()]) {
        await single.withTenant(id, async (q) => {
          const result = await q.query<{ tenant: string }>('SELECT current_tenant_id()::text AS tenant');
          expect(result.rows[0]?.tenant).toBe(id);
        });
        await expect(single.withTenant(id, async () => { throw new Error('synthetic-rollback'); })).rejects.toThrow('synthetic-rollback');
        const result = await single.query<{ tenant: string | null }>('SELECT current_tenant_id()::text AS tenant');
        expect(result.rows[0]?.tenant).toBeNull();
      }
      await expect(single.query('SELECT * FROM audit_events')).rejects.toThrow();
      await expect(single.query("UPDATE audit_events SET action = 'tampered'")).rejects.toThrow();
    } finally {
      await single.close();
    }
  });

  it('环境绑定不允许混用或被运行角色改写，健康检查不暴露配置', async () => {
    if (!cluster) throw new Error('需要真实 PostgreSQL');
    expect(await assertCloudDeployment(authPool, 'test')).toEqual(deployment);
    await expect(assertCloudDeployment(authPool, 'production')).rejects.toThrow('环境绑定');
    await expect(authPool.query("UPDATE cloud_deployment SET environment = 'production'")).rejects.toThrow();
    for (const path of ['/health/live', '/health/ready']) {
      const response = await req(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(Object.keys(response.body)).toEqual(['status']);
      expect(response.headers.get('x-endless-correlation-id')).toBeTruthy();
    }
    expect((await req('/api/status')).status).toBe(404);
    await appPool.close();
    const unavailable = await req('/health/ready');
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error.safeMessage).not.toContain(APP_PW);
    expect((await req('/health/live')).status).toBe(200);
    appPool = CloudPool.connect(`postgres://endless_app:${APP_PW}@127.0.0.1:${cluster.port}/postgres`);
  });

  it('迁移可重复且并发运行，拒绝 checksum 漂移和移除历史迁移', async () => {
    if (!cluster) throw new Error('需要真实 PostgreSQL');
    const { adminDsn } = cluster;
    const files = await loadMigrations();
    const results = await Promise.all(Array.from({ length: 2 }, () => withClient(adminDsn, (q) => migrate(q, files))));
    expect(results.every((result) => result.applied.length === 0 && result.head === files.at(-1)!.version)).toBe(true);
    const drifted = files.map((file, index) => index === 0 ? { ...file, checksum: 'synthetic-drift' } : file);
    await expect(withClient(cluster.adminDsn, (q) => migrate(q, drifted))).rejects.toThrow('checksum');
    await expect(withClient(cluster.adminDsn, (q) => migrate(q, files.slice(1)))).rejects.toThrow('缺失');
    await expect(withClient(cluster.adminDsn, (q) => bindCloudDeployment(q, 'production'))).rejects.toThrow('环境绑定');
    expect(await assertCloudDeployment(authPool, 'test')).toEqual(deployment);
  });
});
