import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpsServer } from 'node:https';
import { request } from 'node:http';
import type { Server } from 'node:http';
import { chromium, type Browser, type Page } from 'playwright';
import { ChallengeResponseSchema, MeResponseSchema, VerifyResponseSchema } from '@endless/cloud-contracts';
import { randomUUID } from 'node:crypto';
import { createCloudServer } from '../../src/cloud/server.js';
import { cloudCapabilities } from '../../src/cloud/capabilities.js';
import { OutboxMailer } from '../../src/cloud/mail.js';
import { MailWorker } from '../../src/cloud/mail-worker.js';
import { loadCloudConfig } from '../../src/cloud/config.js';
import { openCloudRuntime } from '../../src/cloud/runtime.js';
import { closeServer, cloudFixture, fakeSmtp, listenLoopback, mailText, TEST_MAIL_KEY, TEST_PEPPER, testCertificate } from './fixtures.js';

let fixture: Awaited<ReturnType<typeof cloudFixture>>;
let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
let api: Server;
let gateway: Server;
let browser: Browser;
let origin = '';

async function call(page: Page, path: string, body?: unknown) {
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(`/api/cloud/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }, { path, body });
}

beforeAll(async () => {
  fixture = await cloudFixture();
  smtp = await fakeSmtp(true);
  const certificate = await testCertificate();
  let apiPort = 0;
  gateway = createHttpsServer({ key: certificate.private, cert: certificate.cert }, (incoming, outgoing) => {
    if (incoming.url === '/') {
      outgoing.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      outgoing.end('<!doctype html><title>C1 isolated HTTPS test</title><body>C1 test</body>');
      return;
    }
    const upstream = request({
      hostname: '127.0.0.1', port: apiPort, path: incoming.url, method: incoming.method,
      headers: incoming.headers,
    }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', () => { outgoing.writeHead(502).end(); });
    incoming.pipe(upstream);
  });
  const port = await listenLoopback(gateway);
  origin = `https://127.0.0.1:${port}`;
  api = createCloudServer({
    auth: fixture.auth, app: fixture.app, pepper: TEST_PEPPER,
    mailer: new OutboxMailer(TEST_MAIL_KEY), deployment: fixture.deployment,
    origins: [origin], hosts: ['127.0.0.1'], capabilities: cloudCapabilities(),
  });
  apiPort = await listenLoopback(api);
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  if (gateway) await closeServer(gateway);
  if (api) await closeServer(api);
  await smtp?.close();
  await fixture?.close();
}, 60_000);

describe('C1 生产等效同源 HTTPS 边界（仅本地）', () => {
  it('浏览器经 SMTP 验证码建立 Secure/HttpOnly 会话，刷新、撤销和换账号有效', async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const other = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const page = await context.newPage();
      await page.goto(origin);
      expect((await call(page, '/me')).status).toBe(401);
      const login = async () => {
        const email = `https-${randomUUID()}@example.test`;
        const challenge = await call(page, '/auth/challenges', { email });
        expect(challenge.status).toBe(202);
        const challengeBody = ChallengeResponseSchema.parse(challenge.body);
        const worker = new MailWorker(fixture.auth, TEST_MAIL_KEY, smtp.transport);
        expect(await worker.runOnce()).toBe(true);
        const text = mailText(smtp.messages.at(-1)!);
        const code = /验证码是 (\d{6})/.exec(text)?.[1];
        expect(code).toMatch(/^\d{6}$/);
        const result = await call(page, '/auth/verify', { email, challengeId: challengeBody.challengeId, code });
        expect(result.status).toBe(200);
        expect(result.body).not.toHaveProperty('token');
        return VerifyResponseSchema.parse(result.body);
      };
      const first = await login();
      const cookies = await context.cookies();
      const cookie = cookies.find((entry) => entry.name === '__Host-endless_session')!;
      expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
      expect(await page.evaluate('document.cookie')).not.toContain('__Host-endless_session');
      await page.reload();
      const firstMe = MeResponseSchema.parse((await call(page, '/me')).body);
      expect(firstMe.account.id).toBe(first.accountId);
      const otherPage = await other.newPage();
      await otherPage.goto(origin);
      expect((await call(otherPage, '/me')).status).toBe(401);
      const csrf = await context.request.post(`${origin}/api/cloud/v1/auth/logout`, { headers: { Origin: 'https://foreign.example.test' } });
      expect(csrf.status()).toBe(403);
      expect((await call(page, '/me')).status).toBe(200);
      const second = await login();
      expect(second.accountId).not.toBe(first.accountId);
      const secondMe = MeResponseSchema.parse((await call(page, '/me')).body);
      expect(secondMe.context.localNamespace).not.toBe(firstMe.context.localNamespace);
      const stale = await context.request.get(`${origin}/api/cloud/v1/me`, {
        headers: { Cookie: `__Host-endless_session=${cookie.value}` },
      });
      expect(stale.status()).toBe(401);
      const revoked = await context.request.delete(`${origin}/api/cloud/v1/devices/${second.deviceId}`, { headers: { Origin: origin } });
      expect(revoked.status()).toBe(200);
      expect((await call(page, '/me')).status).toBe(401);
      expect((await context.cookies()).some((entry) => entry.name === '__Host-endless_session')).toBe(false);
    } finally {
      await context.close();
      await other.close();
    }
  }, 45_000);

  it('启动拒绝测试库冒充生产库，也拒绝管理员 DSN', async () => {
    const base = {
      ENDLESS_CLOUD_ENV: 'test',
      ENDLESS_CLOUD_AUTH_DSN: fixture.authDsn, ENDLESS_CLOUD_APP_DSN: fixture.appDsn,
      ENDLESS_CLOUD_SESSION_PEPPER: TEST_PEPPER.toString('hex'),
      ENDLESS_CLOUD_MAIL_KEY: TEST_MAIL_KEY.toString('hex'),
    };
    const runtime = await openCloudRuntime(loadCloudConfig(base));
    await runtime.close();
    await expect(openCloudRuntime(loadCloudConfig({
      ...base, ENDLESS_CLOUD_ENV: 'production',
      ENDLESS_CLOUD_ORIGINS: origin, ENDLESS_CLOUD_HOSTS: '127.0.0.1',
    }))).rejects.toThrow('环境绑定');
    await expect(openCloudRuntime(loadCloudConfig({
      ...base, ENDLESS_CLOUD_AUTH_DSN: fixture.cluster.adminDsn,
    }))).rejects.toThrow('最小权限');
  });
});
