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
const ORIGIN = 'http://127.0.0.1:5173';

async function req(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  headers.set('origin', ORIGIN);
  const response = await fetch(`${base}/api/cloud/v1${path}`, { ...init, headers });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

async function codeFor(email: string): Promise<string> {
  const mails = await readQueuedMail(authPool, email);
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
  });
  authPool = CloudPool.connect(`postgres://endless_auth:${AUTH_PW}@127.0.0.1:${cluster.port}/postgres`);
  appPool = CloudPool.connect(`postgres://endless_app:${APP_PW}@127.0.0.1:${cluster.port}/postgres`);
  server = createCloudServer({
    auth: authPool, app: appPool, pepper: Buffer.from(PEPPER),
    origins: [ORIGIN], hosts: ['127.0.0.1', 'localhost'],
    mailer: new OutboxMailer(), capabilities: cloudCapabilities(),
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
});
