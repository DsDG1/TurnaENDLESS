import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CLOUD_LIMITS, CORRELATION_HEADER } from '@endless/cloud-contracts';
import { badRequest, CloudError } from './errors.js';

/** 关联 ID：沿用客户端合法值或生成新值；只用于日志/错误关联，不是身份。 */
export function correlationId(request: IncomingMessage): string {
  const supplied = request.headers[CORRELATION_HEADER];
  if (typeof supplied === 'string' && /^[\x21-\x7e]{8,64}$/.test(supplied)) return supplied;
  return randomBytes(16).toString('hex');
}

export function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

/** 控制请求上限（§14.3 初值 1 MiB 解码字节）；超限即拒绝，不截断。 */
export async function readJsonBody(request: IncomingMessage, limit = CLOUD_LIMITS.controlBodyBytes): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw new CloudError(413, 'STORAGE_QUOTA', 'storage', '请求超过大小上限');
    chunks.push(chunk);
  }
  if (bytes === 0) throw badRequest('请求体不能为空');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw badRequest('请求不是有效 JSON');
  }
}

export async function readObjectBody(request: IncomingMessage): Promise<Buffer> {
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') {
    throw badRequest('对象上传只接受 identity 编码');
  }
  if (request.headers['content-type'] !== 'application/octet-stream') throw badRequest('对象上传要求 application/octet-stream');
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > CLOUD_LIMITS.uploadObjectBytes) {
    throw new CloudError(413, 'STORAGE_QUOTA', 'storage', '对象超过大小上限');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > CLOUD_LIMITS.uploadObjectBytes) throw new CloudError(413, 'STORAGE_QUOTA', 'storage', '对象超过大小上限');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, bytes);
}

const COOKIE_NAME = '__Host-endless_session' as const;

export function parseCookies(request: IncomingMessage): Map<string, string> {
  const header = request.headers.cookie;
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
}

export function sessionTokenFrom(request: IncomingMessage): string | null {
  return parseCookies(request).get(COOKIE_NAME) ?? null;
}

/** §4.2：高熵不透明令牌、HttpOnly+Secure+SameSite=Lax、__Host- 前缀（无 Domain）。 */
export function sessionCookie(token: string, expiresAt: Date): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
