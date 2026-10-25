import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  ChallengeRequestSchema, CreateWorkspaceRequestSchema, IdempotencyKeySchema,
  LEGACY_PROVIDER_KEY_HEADER, VerifyRequestSchema, type CloudCapabilities,
  CLOUD_API_PREFIX, PrepareObjectRequestSchema, ActivateImportRequestSchema, InstallWorkspaceRequestSchema, type Device,
} from '@endless/cloud-contracts';
import type { CloudPool } from './db/client.js';
import type { Mailer } from './mail.js';
import { AuthService, type AuthContext } from './auth/service.js';
import { createWorkspace, listWorkspaces } from './access/workspaces.js';
import { badRequest, CloudError, forbidden, unauthorized } from './errors.js';
import { clearSessionCookie, correlationId, readJsonBody, readObjectBody, sendJson, sessionCookie, sessionTokenFrom } from './http.js';
import { accountContext, assertCloudDeployment, type CloudDeployment } from './deployment.js';
import type { ObjectService } from './objects/service.js';
import type { ImportService } from './imports/service.js';

/**
 * 云 API HTTP 层（§14）。与本机 server.ts 完全分离：
 * - 不挂载 /api/status capability 密钥；
 * - 拒绝 X-Endless-Provider-Key（本机页面 Key 不进入云链路）；
 * - Cookie 会话 + 状态变更严格 Origin 校验；不实现 CORS（同站部署经网关/代理）。
 */

interface CloudServerOptions {
  auth: CloudPool;
  app: CloudPool;
  pepper: Buffer;
  origins: readonly string[];
  hosts: readonly string[];
  mailer: Mailer;
  mailEcho?: boolean;
  capabilities: CloudCapabilities;
  deployment: CloudDeployment;
  objects?: ObjectService;
  imports?: ImportService;
}

interface Route {
  method: string;
  /** public：不需要会话；session：需要有效会话。 */
  access: 'public' | 'session';
  pattern: RegExp;
  handle: (ctx: {
    request: IncomingMessage; url: URL; auth: AuthContext;
    params: Record<string, string>; correlation: string;
  }) => Promise<{ status: number; body: unknown; headers?: Record<string, string> }>;
}

const DEVICE_PATH = /^\/devices\/(?<id>[0-9a-f-]{36})$/;

export function createCloudServer(options: CloudServerOptions) {
  const authService = new AuthService(options.auth, options.mailer, options.pepper, options.mailEcho ?? false);
  const origins = new Set(options.origins);
  const hosts = new Set(options.hosts.map((host) => host.toLowerCase()));
  const prefix = CLOUD_API_PREFIX;
  // §14.1：能力发现由「实际挂载了哪些路由」推出，不让声明与实现分叉。
  // 显式启用对象/导入后若仍报 false，客户端会永远看不到入口。
  const capabilities: CloudCapabilities = {
    ...options.capabilities,
    features: { ...options.capabilities.features, objects: !!options.objects, import: !!options.imports },
  };

  function deviceWire(row: { id: string; name: string; created_at: Date; last_seen_at: Date; revoked_at: Date | null }, currentId: string): Device {
    return {
      id: row.id, name: row.name,
      createdAt: row.created_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString(),
      revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
      current: row.id === currentId,
    };
  }

  const routes: Route[] = [
    { method: 'GET', access: 'public', pattern: /^\/health\/live$/,
      handle: async () => ({ status: 200, body: { status: 'live' } }) },
    { method: 'GET', access: 'public', pattern: /^\/health\/ready$/,
      handle: async () => {
        const deployments = await Promise.all([
          assertCloudDeployment(options.auth, options.deployment.environment),
          assertCloudDeployment(options.app, options.deployment.environment),
        ]);
        if (deployments.some((entry) => entry.id !== options.deployment.id)) throw new Error('CLOUD_ENVIRONMENT_MISMATCH');
        return { status: 200, body: { status: 'ready' } };
      } },
    { method: 'GET', access: 'public', pattern: /^\/capabilities$/,
      handle: async () => ({ status: 200, body: capabilities }) },
    { method: 'POST', access: 'public', pattern: /^\/auth\/challenges$/,
      handle: async ({ request, correlation }) => {
        const body = ChallengeRequestSchema.safeParse(await readJsonBody(request));
        if (!body.success) throw badRequest('邮箱格式无效');
        const result = await authService.issueChallenge(
          { email: body.data.email, ip: authService.clientIp(request) }, correlation);
        return { status: 202, body: result };
      } },
    { method: 'POST', access: 'public', pattern: /^\/auth\/verify$/,
      handle: async ({ request, correlation }) => {
        const body = VerifyRequestSchema.safeParse(await readJsonBody(request));
        if (!body.success) throw badRequest('验证请求格式无效');
        const result = await authService.verifyChallenge(
          body.data, correlation, sessionTokenFrom(request), authService.clientIp(request),
        );
        const expires = new Date(result.sessionExpiresAt);
        return {
          status: 200,
          body: { accountId: result.accountId, deviceId: result.deviceId, sessionExpiresAt: result.sessionExpiresAt },
          headers: { 'Set-Cookie': sessionCookie(result.token, expires) },
        };
      } },
    { method: 'POST', access: 'session', pattern: /^\/auth\/logout$/,
      handle: async ({ auth, correlation }) => {
        await authService.logout(auth, correlation);
        return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': clearSessionCookie() } };
      } },
    { method: 'GET', access: 'session', pattern: /^\/me$/,
      handle: async ({ auth }) => {
        const account = await options.auth.query<{ id: string; status: string; created_at: Date }>(
          'SELECT id, status, created_at FROM accounts WHERE id = $1', [auth.accountId]);
        const device = await options.auth.query<{ id: string; name: string; created_at: Date; last_seen_at: Date; revoked_at: Date | null }>(
          'SELECT * FROM devices WHERE id = $1', [auth.deviceId]);
        return {
          status: 200,
          body: {
            account: { id: account.rows[0]!.id, status: account.rows[0]!.status, createdAt: account.rows[0]!.created_at.toISOString() },
            device: deviceWire(device.rows[0]!, auth.deviceId),
            entitlements: [],
            context: accountContext(options.deployment, auth.accountId),
          },
        };
      } },
    { method: 'GET', access: 'session', pattern: /^\/devices$/,
      handle: async ({ auth }) => {
        const rows = await authService.listDevices(auth.accountId);
        return { status: 200, body: { devices: rows.map((row) => deviceWire(row, auth.deviceId)) } };
      } },
    { method: 'GET', access: 'session', pattern: DEVICE_PATH,
      handle: async ({ auth, params }) => {
        const rows = await authService.listDevices(auth.accountId);
        const row = rows.find((entry) => entry.id === params.id);
        if (!row) throw new CloudError(404, 'NOT_FOUND', 'contract', '设备不存在', 'retry_read');
        return { status: 200, body: deviceWire(row, auth.deviceId) };
      } },
    { method: 'DELETE', access: 'session', pattern: DEVICE_PATH,
      handle: async ({ auth, params, correlation }) => {
        const result = await authService.revokeDevice(auth, params.id!, correlation);
        return {
          status: 200, body: { ok: true, revokedSelf: result.revokedSelf },
          ...(result.revokedSelf ? { headers: { 'Set-Cookie': clearSessionCookie() } } : {}),
        };
      } },
    { method: 'POST', access: 'session', pattern: /^\/workspaces$/,
      handle: async ({ request, auth, correlation }) => {
        const parsed = IdempotencyKeySchema.safeParse(request.headers['idempotency-key']);
        if (!parsed.success) throw badRequest('缺少合法 Idempotency-Key 请求头（8-128 位可打印 ASCII）');
        const body = CreateWorkspaceRequestSchema.safeParse(await readJsonBody(request));
        if (!body.success) throw badRequest('工作区请求格式无效');
        return createWorkspace(options.app, auth, body.data, parsed.data, correlation);
      } },
    { method: 'GET', access: 'session', pattern: /^\/workspaces$/,
      handle: async ({ auth }) => ({ status: 200, body: await listWorkspaces(options.app, auth.accountId) }) },
  ];

  if (options.objects) {
    const objects = options.objects;
    routes.push(
      { method: 'POST', access: 'session', pattern: /^\/objects\/uploads$/,
        handle: async ({ request, auth }) => {
          const body = PrepareObjectRequestSchema.safeParse(await readJsonBody(request));
          if (!body.success) throw badRequest('对象准备请求格式无效或契约不支持');
          return { status: 200, body: await objects.prepare(auth, body.data) };
        } },
      { method: 'GET', access: 'session', pattern: /^\/objects\/usage$/,
        handle: async ({ auth }) => ({ status: 200, body: await objects.usage(auth) }) },
      { method: 'PUT', access: 'session', pattern: /^\/objects\/(?<id>[0-9a-f-]{36})\/body$/,
        handle: async ({ request, auth, params }) => ({
          status: 200, body: await objects.upload(auth, params.id!, await readObjectBody(request)),
        }) },
      { method: 'POST', access: 'session', pattern: /^\/objects\/(?<id>[0-9a-f-]{36})\/verify$/,
        handle: async ({ auth, params }) => ({ status: 200, body: await objects.verify(auth, params.id!) }) },
      { method: 'GET', access: 'session', pattern: /^\/objects\/(?<id>[0-9a-f-]{36})\/download$/,
        handle: async ({ auth, params }) => ({ status: 200, body: await objects.download(auth, params.id!) }) },
    );
  }

  if (options.imports) {
    const imports = options.imports;
    const key = (request: IncomingMessage) => {
      const parsed = IdempotencyKeySchema.safeParse(request.headers['idempotency-key']);
      if (!parsed.success) throw badRequest('缺少合法 Idempotency-Key');
      return parsed.data;
    };
    routes.push(
      { method: 'POST', access: 'session', pattern: /^\/workspaces\/import-previews$/,
        handle: async ({ request, auth }) => {
          const id = key(request);
          return { status: 200, body: await imports.preview(auth, await readObjectBody(request), id) };
        } },
      { method: 'GET', access: 'session', pattern: /^\/workspaces\/import-previews\/(?<id>[0-9a-f-]{36})$/,
        handle: async ({ auth, params }) => ({ status: 200, body: await imports.previewStatus(auth, params.id!) }) },
      { method: 'POST', access: 'session', pattern: /^\/workspaces\/imports$/,
        handle: async ({ request, auth }) => {
          const id = key(request);
          const body = ActivateImportRequestSchema.safeParse(await readJsonBody(request));
          if (!body.success) throw badRequest('导入确认格式无效');
          return { status: 200, body: await imports.activate(auth, body.data, id) };
        } },
      { method: 'GET', access: 'session', pattern: /^\/workspaces\/(?<id>[0-9a-f-]{36})\/package$/,
        handle: async ({ auth, params }) => ({ status: 200, body: await imports.package(auth, params.id!) }) },
      { method: 'POST', access: 'session', pattern: /^\/workspaces\/(?<id>[0-9a-f-]{36})\/installations$/,
        handle: async ({ request, auth, params }) => {
          const id = key(request);
          const body = InstallWorkspaceRequestSchema.safeParse(await readJsonBody(request));
          if (!body.success) throw badRequest('安装回执格式无效');
          return { status: 200, body: await imports.install(auth, params.id!, body.data, id) };
        } },
    );
  }

  const server = createServer((request, response) => {
    void (async () => {
      const correlation = correlationId(request);
      response.setHeader('x-endless-correlation-id', correlation);
      try {
        const host = request.headers.host?.split(':')[0]?.toLowerCase();
        if (!host || !hosts.has(host)) throw forbidden('Host 不在允许列表');
        if (request.headers[LEGACY_PROVIDER_KEY_HEADER] !== undefined) {
          throw forbidden('云接口不接受本机页面 Key；本机模式与云端凭据互不通用');
        }
        const url = new URL(request.url ?? '/', 'http://internal');
        const path = url.pathname.slice(prefix.length) || '/';
        if (!url.pathname.startsWith(`${prefix}/`) && url.pathname !== prefix) {
          throw new CloudError(404, 'NOT_FOUND', 'contract', '接口不存在');
        }
        const method = request.method ?? 'GET';
        if (method === 'OPTIONS') {
          response.writeHead(204, { 'Cache-Control': 'no-store' }).end();
          return;
        }
        // CSRF：状态变更必须携带允许列表内的 Origin；浏览器跨站构造不出。
        const origin = request.headers.origin;
        if (method !== 'GET' && method !== 'HEAD' && !(typeof origin === 'string' && origins.has(origin))) {
          throw forbidden('状态变更请求缺少允许的 Origin');
        }
        const candidates = routes
          .map((route) => ({ route, match: route.pattern.exec(path) }))
          .filter((entry): entry is { route: Route; match: RegExpExecArray } => entry.match !== null);
        if (candidates.length === 0) throw new CloudError(404, 'NOT_FOUND', 'contract', '接口不存在');
        const match = candidates.find((entry) => entry.route.method === method);
        if (!match) throw new CloudError(405, 'METHOD_NOT_ALLOWED', 'contract', '该资源不支持此方法');
        let auth: AuthContext;
        if (match.route.access === 'session') {
          const token = sessionTokenFrom(request);
          if (!token) throw unauthorized();
          const resolved = await authService.resolveSession(token);
          if (!resolved) throw unauthorized('会话已失效，请重新登录');
          auth = resolved;
        } else {
          auth = { accountId: '', sessionId: '', deviceId: '' };
        }
        const result = await match.route.handle({
          request, url, auth,
          params: match.match!.groups ?? {}, correlation,
        });
        sendJson(response, result.status, result.body, result.headers);
      } catch (error) {
        if (response.headersSent) { response.end(); return; }
        if (error instanceof CloudError) sendJson(response, error.status, error.toBody(correlation));
        else {
          // 内部错误只给关联 ID；细节进服务端日志，不外发。
            console.error(`[cloud] ${correlation}: INTERNAL`);
          sendJson(response, 503, new CloudError(503, 'INTERNAL', 'internal', '服务暂不可用，请稍后重试', 'retry_read').toBody(correlation));
        }
      }
    })();
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
