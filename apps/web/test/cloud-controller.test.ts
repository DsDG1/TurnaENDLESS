import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { buildBackup, deriveCloudCopy, parseBackup, type Workspace } from '@endless/content';
import type {
  CloudCapabilities, CloudImportPreview, CloudImportReceipt, MeResponse, WorkspaceInstallation,
} from '@endless/cloud-contracts';
import { CLOUD_LIMITS } from '@endless/cloud-contracts';
import { CloudController } from '../src/cloud/controller.js';
import { CloudFailure, type CloudApiPort } from '../src/cloud/client.js';
import { cloudDigest, cloudNamespace } from '../src/cloud/local.js';
import { WorkspaceRepository } from '../src/storage.js';
import { cloudTestContent, cloudTestTime, cloudTestWorkspace } from '../../../packages/content/test/cloud-fixture.js';

/**
 * 控制器测试：真实 fake-indexeddb + 假云端，验证「不重复提交、不覆盖、不假装成功」。
 * 假云端只记录调用，不复述服务端业务规则——业务规则由 apps/api 的真 PostgreSQL 测试覆盖。
 */

const deployment = crypto.randomUUID();
const account = crypto.randomUUID();
const device = crypto.randomUUID();
const workspaceId = crypto.randomUUID();
const source = cloudTestWorkspace();
const copy = deriveCloudCopy(buildBackup(source), cloudTestTime);

const capabilities: CloudCapabilities = {
  protocol: 'endless-cloud/1',
  features: {
    accounts: true, sessions: true, devices: true, workspaces: true, import: true, objects: true,
    sync: false, generation: false, credits: false, billing: false, payments: false, exports: false, edition: false,
  },
  contracts: { workspace: 'endless-workspace/1' },
  limits: { ...CLOUD_LIMITS },
};

const me: MeResponse = {
  context: { deploymentId: deployment, environment: 'test', localNamespace: `endless-cloud:${deployment}:${account}` },
  account: { id: account, status: 'active', createdAt: cloudTestTime },
  device: {
    id: device, name: '测试设备', createdAt: cloudTestTime, lastSeenAt: cloudTestTime, revokedAt: null, current: true,
  },
  entitlements: [],
};

const preview: CloudImportPreview = {
  id: crypto.randomUUID(), workspaceId, sourceLocalId: source.identity.workspaceId, sourceProfileId: source.profile.id,
  sourceRepositoryRevision: source.identity.repositoryRevision, sourceDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64),
  objectId: crypto.randomUUID(), size: 1024,
  counts: {
    entries: source.entries.length, revisions: source.revisions.length, branches: source.branches.length,
    volumes: source.volumes.length, checkpoints: source.checkpoints.length, tickets: source.tickets.length,
    management: source.management.length,
  },
  eventCount: 0, pendingLocalTickets: 0, sourceKinds: ['bundled'], relationship: 'new', state: 'ready',
  validationBinding: 'c'.repeat(64), copyPolicy: 'endless-cloud-copy/1', expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};

let cachedReceipt: CloudImportReceipt | null = null;
async function receipt(): Promise<CloudImportReceipt> {
  cachedReceipt ??= {
    id: preview.id, workspaceId, sourceLocalId: preview.sourceLocalId, sourceProfileId: preview.sourceProfileId,
    sourceRepositoryRevision: preview.sourceRepositoryRevision, sourceObjectId: preview.objectId,
    sourceDigest: preview.sourceDigest, snapshotDigest: preview.snapshotDigest,
    copyDigest: await cloudDigest(copy), copyCreatedAt: cloudTestTime, validationBinding: preview.validationBinding,
    copyPolicy: 'endless-cloud-copy/1', contentIds: copy.entries.map((entry) => entry.id),
    revisionIds: copy.revisions.map((entry) => entry.id), seedContentIds: copy.entries.map((entry) => entry.id),
  };
  return cachedReceipt;
}

interface Harness {
  api: CloudApiPort;
  factory: IDBFactory;
  controller: CloudController;
  calls: {
    preview: ReturnType<typeof vi.fn>;
    activate: ReturnType<typeof vi.fn>;
    install: ReturnType<typeof vi.fn>;
    workspacePackage: ReturnType<typeof vi.fn>;
    verify: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
  };
}

function harness(options: { signedIn?: boolean } = {}): Harness {
  const factory = new IDBFactory();
  let counter = 0;
  const calls = {
    preview: vi.fn(async () => preview),
    activate: vi.fn(async () => receipt()),
    install: vi.fn(async (): Promise<WorkspaceInstallation> => ({
      id: crypto.randomUUID(), workspaceId, importId: preview.id, deviceId: device,
      copyDigest: (await receipt()).copyDigest, installedAt: new Date().toISOString(),
    })),
    workspacePackage: vi.fn(async () => ({ receipt: await receipt(), workspace: copy })),
    verify: vi.fn(async () => ({ accountId: account, deviceId: device, sessionExpiresAt: new Date(Date.now() + 86_400_000).toISOString() })),
    logout: vi.fn(async () => {}),
  };
  const api = {
    capabilities: vi.fn(async () => capabilities),
    me: vi.fn(async () => {
      if (!options.signedIn) throw new CloudFailure('UNAUTHENTICATED', 401, '请登录', 'retry_read', 'corr-12345678');
      return me;
    }),
    devices: vi.fn(async () => [me.device]),
    workspaces: vi.fn(async () => []),
    challenge: vi.fn(async () => ({
      challengeId: crypto.randomUUID(), expiresAt: new Date(Date.now() + 600_000).toISOString(), resendAfterSeconds: 30,
    })),
    verify: calls.verify,
    logout: calls.logout,
    preview: calls.preview,
    previewStatus: vi.fn(async () => preview),
    activate: calls.activate,
    workspacePackage: calls.workspacePackage,
    install: calls.install,
  } as unknown as CloudApiPort;
  const controller = new CloudController({
    api,
    openRepository: (namespace) => new WorkspaceRepository(factory, namespace),
    content: cloudTestContent,
    digest: async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    key: () => `idem-key-${String(++counter).padStart(4, '0')}`,
  });
  return { api, factory, controller, calls };
}

const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;

const canon = (workspace: Workspace | null | undefined) => workspace && ({
  ...workspace,
  revisions: [...workspace.revisions].sort((a, b) => a.id.localeCompare(b.id)),
  branches: [...workspace.branches].sort((a, b) => a.id.localeCompare(b.id)),
  volumes: [...workspace.volumes].sort((a, b) => a.id.localeCompare(b.id)),
  checkpoints: [...workspace.checkpoints].sort((a, b) => a.id.localeCompare(b.id)),
  tickets: [...workspace.tickets].sort((a, b) => a.id.localeCompare(b.id)),
});

describe('云端会话', () => {
  it('未登录时保持未登录，不猜测账号，也不把 401 当故障', async () => {
    const h = harness();
    await h.controller.refresh();
    const state = h.controller.getState();
    expect(state.status).toBe('signed-out');
    expect(state.me).toBeNull();
    expect(state.capabilities?.features.accounts).toBe(true);
    expect(state.failure).toBeNull();
  });

  it('能力接口不可达时落在「不可用」，不会一直显示读取中', async () => {
    const h = harness({ signedIn: true });
    (h.api.capabilities as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new CloudFailure('NETWORK', 0, '无法连接云服务'));
    expect(await h.controller.refresh()).toBe(false);
    expect(h.controller.getState()).toMatchObject({ status: 'unavailable', capabilities: null });
    expect(h.controller.getState().failure).toMatchObject({ code: 'NETWORK' });
  });

  it('登录后加载账号、设备与工作区；退出只清会话状态', async () => {
    const h = harness({ signedIn: true });
    await h.controller.refresh();
    expect(h.controller.getState()).toMatchObject({ status: 'signed-in' });
    expect(h.controller.getState().devices).toHaveLength(1);

    expect(await h.controller.login('reader@example.com')).toBe(true);
    expect(h.controller.getState().challenge).not.toBeNull();
    expect(await h.controller.verify('123456', '第二台设备')).toBe(true);
    expect(h.calls.verify.mock.calls[0]![0]).toMatchObject({ email: 'reader@example.com', code: '123456', deviceName: '第二台设备' });

    expect(await h.controller.logout()).toBe(true);
    expect(h.controller.getState()).toMatchObject({ status: 'signed-out', me: null, devices: [], workspaces: [] });
    expect(h.calls.logout).toHaveBeenCalledTimes(1);
  });
});

describe('导入预览与确认', () => {
  it('预览不激活；同一份字节重试沿用同一幂等键，换字节换键', async () => {
    const h = harness({ signedIn: true });
    await h.controller.refresh();
    const bytes = bytesOf(buildBackup(source));
    await h.controller.previewImport(bytes);
    await h.controller.previewImport(bytes);
    expect(h.calls.preview.mock.calls.map((call) => call[1])).toEqual(['idem-key-0001', 'idem-key-0001']);
    expect(h.calls.activate).not.toHaveBeenCalled();
    await h.controller.previewImport(bytesOf(buildBackup(cloudTestWorkspace())));
    expect(h.calls.preview.mock.calls.at(-1)![1]).toBe('idem-key-0002');
    expect(h.controller.getState().preview?.state).toBe('ready');
    expect(h.controller.getState().phase).toContain('尚未写入云端');
  });

  it('确认只提交预览里的摘要与绑定；失败重试沿用同一键，成功后才记录回执', async () => {
    const h = harness({ signedIn: true });
    await h.controller.refresh();
    await h.controller.previewImport(bytesOf(buildBackup(source)));
    h.calls.activate.mockRejectedValueOnce(new CloudFailure('NETWORK', 0, '无法连接云服务'));
    expect(await h.controller.confirmImport()).toBe(false);
    expect(h.controller.getState().receipt).toBeNull();
    expect(h.controller.getState().failure).toMatchObject({ code: 'NETWORK' });
    expect(await h.controller.confirmImport()).toBe(true);
    expect(h.calls.activate.mock.calls[0]).toEqual([
      { previewId: preview.id, snapshotDigest: preview.snapshotDigest, validationBinding: preview.validationBinding },
      'idem-key-0002',
    ]);
    expect(h.calls.activate.mock.calls[1]![1]).toBe('idem-key-0002');
    expect(h.controller.getState().receipt?.workspaceId).toBe(workspaceId);
    expect(h.controller.getState().preview?.state).toBe('activated');
  });

  it('激活成功后列表刷新失败不改变回执结论', async () => {
    const h = harness({ signedIn: true });
    await h.controller.refresh();
    await h.controller.previewImport(bytesOf(buildBackup(source)));
    (h.api.workspaces as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new CloudFailure('NETWORK', 0, '无法连接云服务'));
    expect(await h.controller.confirmImport()).toBe(true);
    expect(h.controller.getState().receipt).not.toBeNull();
    expect(h.controller.getState().failure).toBeNull();
  });

  it('确认时会话失效：退回未登录，不留下回执也不写本地副本', async () => {
    const h = harness({ signedIn: true });
    await h.controller.refresh();
    await h.controller.previewImport(bytesOf(buildBackup(source)));
    h.calls.activate.mockRejectedValueOnce(new CloudFailure('UNAUTHENTICATED', 401, '会话已失效'));
    expect(await h.controller.confirmImport()).toBe(false);
    expect(h.controller.getState()).toMatchObject({ status: 'signed-out', receipt: null });
    expect(h.controller.getState().phase).toContain('会话已失效');
    const probe = new WorkspaceRepository(h.factory, cloudNamespace(deployment, account, workspaceId));
    expect(await probe.load()).toBeNull();
    await probe.close();
  });
});

describe('第二设备领取', () => {
  it('副本写入账号隔离命名空间，游客库原样保留，回执用本机持久键', async () => {
    const h = harness({ signedIn: true });
    await h.controller.refresh();
    const guest = new WorkspaceRepository(h.factory);
    await guest.commit(source);
    expect(await h.controller.claim(workspaceId)).toBe(true);
    const cloud = new WorkspaceRepository(h.factory, cloudNamespace(deployment, account, workspaceId));
    expect(canon(await cloud.load())).toEqual(canon(copy));
    expect(canon(await guest.load())).toEqual(canon(source));
    const stored = await cloud.cloudInstallation();
    const acknowledged = stored?.acknowledgements.find((entry) => entry.deviceId === device);
    expect(acknowledged?.key).toBe(h.calls.install.mock.calls[0]![2]);
    expect(acknowledged?.receipt?.workspaceId).toBe(workspaceId);
    expect(h.controller.getState().installation?.deviceId).toBe(device);
    expect(h.controller.getState().phase).toContain('打开云端副本');
    await Promise.all([guest.close(), cloud.close()]);
  });

  it('回执丢失后重试沿用同一安装键，不重建第二份副本', async () => {
    const h = harness({ signedIn: true });
    await h.controller.refresh();
    h.calls.install.mockRejectedValueOnce(new CloudFailure('NETWORK', 0, '无法连接云服务'));
    expect(await h.controller.claim(workspaceId)).toBe(false);

    const probe = new WorkspaceRepository(h.factory, cloudNamespace(deployment, account, workspaceId));
    const pending = await probe.cloudInstallation();
    expect(pending?.acknowledgements[0]?.receipt).toBeUndefined();
    expect(canon(await probe.load())).toEqual(canon(copy));
    await probe.close();

    expect(await h.controller.claim(workspaceId)).toBe(true);
    const [first, second] = h.calls.install.mock.calls;
    expect(first![2]).toBe(second![2]);
    expect(h.calls.install).toHaveBeenCalledTimes(2);
  });

  it('重复领取已确认的副本只复用本机记录，不再请求安装', async () => {
    const h = harness({ signedIn: true });
    await h.controller.refresh();
    await h.controller.claim(workspaceId);
    expect(await h.controller.claim(workspaceId)).toBe(true);
    expect(h.calls.install).toHaveBeenCalledTimes(1);
    expect(h.controller.getState().phase).toContain('已保存过该云副本');
  });

  it('领取包不符合工作区契约时拒绝安装，不留下云库数据', async () => {
    const h = harness({ signedIn: true });
    await h.controller.refresh();
    h.calls.workspacePackage.mockResolvedValueOnce({ receipt: await receipt(), workspace: { identity: {} } });
    expect(await h.controller.claim(workspaceId)).toBe(false);
    expect(h.controller.getState().failure?.code).toBe('LOCAL_ERROR');
    const probe = new WorkspaceRepository(h.factory, cloudNamespace(deployment, account, workspaceId));
    expect(await probe.load()).toBeNull();
    await probe.close();
  });
});

describe('副本可回放性', () => {
  it('领取的副本能被本地备份解析，内容 ID 与原存档一致且修订号归零', () => {
    const parsed = parseBackup(buildBackup(copy));
    expect(parsed.backup.workspace.data.entries.map((entry) => entry.id)).toEqual(copy.entries.map((entry) => entry.id));
    expect(copy.identity.repositoryRevision).toBe(0);
  });
});

describe('云副本阅读入口', () => {
  const list = [{
    id: workspaceId, sourceLocalId: source.identity.workspaceId, contract: 'endless-workspace/1',
    cloudVersion: '0', status: 'active' as const, role: 'owner' as const, createdAt: cloudTestTime,
  }];

  it('未领取时列表存在但不可打开：只说「可以领取」，不凭空给阅读入口', async () => {
    const h = harness({ signedIn: true });
    (h.api.workspaces as ReturnType<typeof vi.fn>).mockResolvedValue(list);
    await h.controller.refresh();
    expect(h.controller.getState().workspaces).toHaveLength(1);
    expect(h.controller.getState().installed).toEqual([]);
    expect(h.controller.readingHash(workspaceId)).toBe(`cloud-read/${deployment}/${account}/${workspaceId}`);
  });

  it('领取后刷新能看到本机副本；深链带三个云端 ID，刷新后仍指向同一个库', async () => {
    const h = harness({ signedIn: true });
    (h.api.workspaces as ReturnType<typeof vi.fn>).mockResolvedValue(list);
    await h.controller.refresh();
    expect(await h.controller.claim(workspaceId)).toBe(true);
    expect(h.controller.getState().installed).toContain(workspaceId);
    await h.controller.refresh();
    expect(h.controller.getState().installed).toContain(workspaceId);
    expect(h.controller.readingHash(workspaceId)).toBe(`cloud-read/${deployment}/${account}/${workspaceId}`);
  });

  it('未登录不生成深链：没有可靠的部署与账号 ID 就不猜', async () => {
    const h = harness();
    await h.controller.refresh();
    expect(h.controller.getState().me).toBeNull();
    expect(h.controller.readingHash(workspaceId)).toBeNull();
  });
});
