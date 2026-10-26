import {
  CLOUD_API_PREFIX, CLOUD_LIMITS, ChallengeResponseSchema, CloudCapabilitiesSchema, MetadataReceiptSchema, MetadataSnapshotSchema,
  type MetadataCommand, type MetadataReceipt, type MetadataSnapshot,
  LifecycleReceiptSchema, ManagementBootstrapSchema, ManagementPullSchema,
  type LifecycleCommand, type LifecycleReceipt, type ManagementBootstrap, type ManagementPull,
  ArchiveReceiptSchema, type ArchiveCommand, type ArchiveReceipt,
  CloudErrorBodySchema, CloudImportPreviewResponseSchema, CloudImportResponseSchema,
  CloudPackageResponseSchema, DeviceListResponseSchema, IDEMPOTENCY_KEY_HEADER, MeResponseSchema,
  VerifyResponseSchema, WorkspaceInstallationResponseSchema, WorkspaceListResponseSchema,
  SyncBootstrapSchema, SyncPushResponseSchema, SyncPullResponseSchema, SyncConflictListSchema,
  ResolveConflictResponseSchema, DeviceStreamStateListSchema, RegisterStreamResponseSchema,
  type ActivateImportRequest, type ChallengeResponse, type CloudCapabilities, type CloudErrorCode,
  type CloudImportPreview, type CloudImportReceipt, type CloudWorkspace, type Device,
  type InstallWorkspaceRequest, type MeResponse, type VerifyRequest, type VerifyResponse,
  type WorkspaceInstallation, type SyncBootstrap, type SyncPushRequest, type SyncPushReceipt,
  type SyncPullResponse, type SyncConflict, type SyncStreamBinding, type DeviceStreamState,
  type PutDeviceStreamStateRequest, type RegisterStreamRequest, type ResolveConflictResponse,
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
    /** 同步冲突时服务端给出的候选记录 ID；只有它可以被显式解决。 */
    readonly conflictId?: string,
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
      const { code, safeMessage, retryAction, correlationId, conflictId } = parsed.data.error;
      throw new CloudFailure(code, response.status, safeMessage, retryAction, correlationId, conflictId);
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
  submitArchive(input: ArchiveCommand): Promise<ArchiveReceipt>;
  managementBootstrap(workspaceId: string): Promise<ManagementBootstrap>;
  managementPull(workspaceId: string, cursor: string): Promise<ManagementPull>;
  submitLifecycle(input: LifecycleCommand): Promise<LifecycleReceipt>;
  metadata(workspaceId: string): Promise<MetadataSnapshot>;
  submitMetadata(input: MetadataCommand): Promise<MetadataReceipt>;
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
  bootstrap(workspaceId: string): Promise<SyncBootstrap>;
  registerStream(input: RegisterStreamRequest): Promise<SyncStreamBinding>;
  push(input: SyncPushRequest): Promise<{ receipt: SyncPushReceipt }>;
  pull(workspaceId: string, cursor: string | null, limit?: number): Promise<SyncPullResponse>;
  conflicts(workspaceId: string): Promise<{ conflicts: SyncConflict[] }>;
  resolveConflict(workspaceId: string, conflictId: string, decision: 'discard' | 'keep-branch', preservation?: { streamId: string; baseEventId: string | null }): Promise<ResolveConflictResponse>;
  deviceStates(workspaceId: string): Promise<DeviceStreamState[]>;
  putDeviceStates(input: PutDeviceStreamStateRequest): Promise<DeviceStreamState[]>;
}

export class CloudApi implements CloudApiPort {
  constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  async submitArchive(input: ArchiveCommand) {
    return parse(ArchiveReceiptSchema, await request(this.fetcher, '/sync/archives', {
      method: 'POST', contentType: 'application/json', body: JSON.stringify(input),
    }));
  }

  async managementBootstrap(workspaceId: string) {
    return parse(ManagementBootstrapSchema, await request(this.fetcher, `/sync/management/bootstrap?workspaceId=${encodeURIComponent(workspaceId)}`));
  }
  async managementPull(workspaceId: string, cursor: string) {
    const params = new URLSearchParams({ workspaceId, cursor });
    return parse(ManagementPullSchema, await request(this.fetcher, `/sync/management/pull?${params}`));
  }
  async submitLifecycle(input: LifecycleCommand) {
    return parse(LifecycleReceiptSchema, await request(this.fetcher, '/sync/lifecycle', {
      method: 'POST', contentType: 'application/json', body: JSON.stringify(input),
    }));
  }

  async metadata(workspaceId: string) {
    return parse(MetadataSnapshotSchema, await request(this.fetcher, `/sync/metadata?workspaceId=${encodeURIComponent(workspaceId)}`));
  }

  async submitMetadata(input: MetadataCommand) {
    return parse(MetadataReceiptSchema, await request(this.fetcher, '/sync/metadata', {
      method: 'POST', contentType: 'application/json', body: JSON.stringify(input),
    }));
  }

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

  async bootstrap(workspaceId: string) {
    return parse(SyncBootstrapSchema, await request(this.fetcher, `/sync/bootstrap?workspaceId=${encodeURIComponent(workspaceId)}`));
  }

  /** 注册本机新建分支的事件流：只声明父流与分叉点，前缀由服务端复制。 */
  async registerStream(input: RegisterStreamRequest) {
    return parse(RegisterStreamResponseSchema, await request(this.fetcher, '/sync/streams', {
      method: 'POST', contentType: 'application/json', body: JSON.stringify(input),
    })).stream;
  }

  async push(input: SyncPushRequest) {
    return parse(SyncPushResponseSchema, await request(this.fetcher, '/sync/push', {
      method: 'POST', contentType: 'application/json', body: JSON.stringify(input),
    }));
  }

  async pull(workspaceId: string, cursor: string | null, limit = CLOUD_LIMITS.listPageDefault) {
    const query = new URLSearchParams({ workspaceId, limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    return parse(SyncPullResponseSchema, await request(this.fetcher, `/sync/pull?${query.toString()}`));
  }

  async conflicts(workspaceId: string) {
    return parse(SyncConflictListSchema, await request(this.fetcher, `/sync/conflicts?workspaceId=${encodeURIComponent(workspaceId)}`));
  }

  async resolveConflict(workspaceId: string, conflictId: string, decision: 'discard' | 'keep-branch', preservation?: { streamId: string; baseEventId: string | null }) {
    return parse(ResolveConflictResponseSchema, await request(this.fetcher, `/sync/conflicts/${conflictId}/resolve`, {
      method: 'POST', contentType: 'application/json', body: JSON.stringify({ workspaceId, decision, ...preservation }),
    }));
  }

  async deviceStates(workspaceId: string) {
    return parse(DeviceStreamStateListSchema, await request(this.fetcher, `/sync/device-state?workspaceId=${encodeURIComponent(workspaceId)}`)).states;
  }

  async putDeviceStates(input: PutDeviceStreamStateRequest) {
    return parse(DeviceStreamStateListSchema, await request(this.fetcher, '/sync/device-state', {
      method: 'PUT', contentType: 'application/json', body: JSON.stringify(input),
    })).states;
  }
}
