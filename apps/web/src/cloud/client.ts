import {
  CLOUD_API_PREFIX, CLOUD_LIMITS, ChallengeResponseSchema, CloudCapabilitiesSchema,
  CloudErrorBodySchema, CloudImportPreviewResponseSchema, CloudImportResponseSchema,
  CloudPackageResponseSchema, DeviceListResponseSchema, IDEMPOTENCY_KEY_HEADER, MeResponseSchema,
  VerifyResponseSchema, WorkspaceInstallationResponseSchema, WorkspaceListResponseSchema,
  type ActivateImportRequest, type ChallengeResponse, type CloudCapabilities, type CloudErrorCode,
  type CloudImportPreview, type CloudImportReceipt, type CloudWorkspace, type Device,
  type InstallWorkspaceRequest, type MeResponse, type VerifyRequest, type VerifyResponse,
  type WorkspaceInstallation,
} from '@endless/cloud-contracts';

/**
 * 云 API 客户端（计划 §14、§15）。
 *
 * 边界：
 * - 只用同源 Cookie 会话（`credentials: 'same-origin'`），令牌从不进入 JS 可见状态；
 * - 一律 no-store；认证、账单、导入、下载不进 Service Worker 缓存；
 * - 稳定错误只依赖 `code`/`retryAction`，不解析服务端文案；
 * - 本机页面 Key 绝不发往云域名（该请求头在云侧恒被拒绝，这里也不提供入口）。
 */

export type CloudFailureCode = CloudErrorCode | 'NETWORK' | 'INVALID_RESPONSE';

export class CloudFailure extends Error {
  constructor(
    readonly code: CloudFailureCode,
    readonly status: number,
    message: string,
    readonly retryAction?: string,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'CloudFailure';
  }
}

interface CallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: BodyInit;
  contentType?: string;
  key?: string;
  signal?: AbortSignal;
}

const timeoutMs = 30_000;

async function request(fetcher: typeof fetch, path: string, options: CallOptions = {}): Promise<unknown> {
  const headers = new Headers({ Accept: 'application/json' });
  if (options.key) headers.set(IDEMPOTENCY_KEY_HEADER, options.key);
  if (options.contentType) headers.set('Content-Type', options.contentType);
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetcher(`${CLOUD_API_PREFIX}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: options.body }),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch {
    // 网络失败与「服务端没收到」不能混为一谈：只报告未收到响应，不推断业务结果
    throw new CloudFailure('NETWORK', 0, '无法连接云服务。已读内容不受影响；稍后可用同一请求重试');
  }
  let payload: unknown = null;
  if ((response.headers.get('content-type') ?? '').includes('application/json')) {
    try { payload = await response.json(); } catch { payload = null; }
  }
  if (!response.ok) {
    const parsed = CloudErrorBodySchema.safeParse(payload);
    if (parsed.success) {
      const { code, safeMessage, retryAction, correlationId } = parsed.data.error;
      throw new CloudFailure(code, response.status, safeMessage, retryAction, correlationId);
    }
    throw new CloudFailure('INVALID_RESPONSE', response.status, `云服务返回了无法识别的结果（HTTP ${response.status}），未做任何变更`);
  }
  return payload;
}

function parse<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw new CloudFailure('INVALID_RESPONSE', 200, '云服务响应与共享契约不一致，客户端未采用该结果');
  }
}

export interface CloudApiPort {
  capabilities(): Promise<CloudCapabilities>;
  me(): Promise<MeResponse>;
  devices(): Promise<Device[]>;
  workspaces(): Promise<CloudWorkspace[]>;
  challenge(email: string): Promise<ChallengeResponse>;
  verify(input: VerifyRequest): Promise<VerifyResponse>;
  logout(): Promise<void>;
  preview(bytes: ArrayBuffer, key: string): Promise<CloudImportPreview>;
  previewStatus(id: string): Promise<CloudImportPreview>;
  activate(input: ActivateImportRequest, key: string): Promise<CloudImportReceipt>;
  workspacePackage(workspaceId: string): Promise<{ receipt: CloudImportReceipt; workspace: unknown }>;
  install(workspaceId: string, input: InstallWorkspaceRequest, key: string): Promise<WorkspaceInstallation>;
}

export class CloudApi implements CloudApiPort {
  constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  async capabilities() {
    return parse(CloudCapabilitiesSchema, await request(this.fetcher, '/capabilities'));
  }

  async me() {
    return parse(MeResponseSchema, await request(this.fetcher, '/me'));
  }

  async devices() {
    return parse(DeviceListResponseSchema, await request(this.fetcher, '/devices')).devices;
  }

  async workspaces() {
    return parse(WorkspaceListResponseSchema, await request(this.fetcher, '/workspaces')).workspaces;
  }

  async challenge(email: string) {
    return parse(ChallengeResponseSchema, await request(this.fetcher, '/auth/challenges', {
      method: 'POST', contentType: 'application/json', body: JSON.stringify({ email }),
    }));
  }

  async verify(input: VerifyRequest) {
    return parse(VerifyResponseSchema, await request(this.fetcher, '/auth/verify', {
      method: 'POST', contentType: 'application/json', body: JSON.stringify(input),
    }));
  }

  async logout() {
    await request(this.fetcher, '/auth/logout', { method: 'POST' });
  }

  async preview(bytes: ArrayBuffer, key: string) {
    if (!bytes.byteLength || bytes.byteLength > CLOUD_LIMITS.uploadObjectBytes) {
      throw new CloudFailure('STORAGE_QUOTA', 413, `存档超过单个对象上限（${CLOUD_LIMITS.uploadObjectBytes} 字节），未上传`);
    }
    return parse(CloudImportPreviewResponseSchema, await request(this.fetcher, '/workspaces/import-previews', {
      method: 'POST', key, body: bytes, contentType: 'application/octet-stream',
    })).preview;
  }

  async previewStatus(id: string) {
    return parse(CloudImportPreviewResponseSchema, await request(this.fetcher, `/workspaces/import-previews/${id}`)).preview;
  }

  async activate(input: ActivateImportRequest, key: string) {
    return parse(CloudImportResponseSchema, await request(this.fetcher, '/workspaces/imports', {
      method: 'POST', key, contentType: 'application/json', body: JSON.stringify(input),
    })).receipt;
  }

  async workspacePackage(workspaceId: string) {
    const body = parse(CloudPackageResponseSchema, await request(this.fetcher, `/workspaces/${workspaceId}/package`));
    return { receipt: body.receipt, workspace: body.workspace };
  }

  async install(workspaceId: string, input: InstallWorkspaceRequest, key: string) {
    return parse(WorkspaceInstallationResponseSchema, await request(this.fetcher, `/workspaces/${workspaceId}/installations`, {
      method: 'POST', key, contentType: 'application/json', body: JSON.stringify(input),
    })).installation;
  }
}
