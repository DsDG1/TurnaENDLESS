import { parseWorkspace, type Workspace } from '@endless/content';
import type {
  ChallengeResponse, CloudCapabilities, CloudImportPreview, CloudImportReceipt,
  CloudWorkspace, Device, MeResponse, WorkspaceInstallation,
} from '@endless/cloud-contracts';
import { CloudFailure, type CloudApiPort } from './client.js';
import { cloudNamespace, type CloudLocalInstallation } from './local.js';

/**
 * 云端流程控制器（计划 §8、§15.1 的最小入口）。
 *
 * 不依赖 React，也不直接持有 React 状态：所有副作用都是可注入的
 * （HTTP、IndexedDB 仓库、摘要、幂等键），因此异常路径能在 Node 里直接测。
 *
 * 这里强制执行的纪律：
 * 1. 一次用户操作一个幂等键；重试沿用原键，绝不因为点了两次就换 UUID；
 * 2. 预览不产生云端内容，只有确认（activate）才激活；界面不把两者混成一个「成功」；
 * 3. 领取必须走服务端回执，回执丢失时复用本机持久化的安装键恢复，不新建副本；
 * 4. 会话失效（UNAUTHENTICATED）立即退回未登录，不假装成功，也不清本机任何库。
 */

export type CloudStatus = 'loading' | 'unavailable' | 'signed-out' | 'signed-in';

export interface CloudFailureView {
  code: string;
  message: string;
  retryAction?: string;
  correlationId?: string;
}

export interface CloudState {
  status: CloudStatus;
  capabilities: CloudCapabilities | null;
  me: MeResponse | null;
  devices: Device[];
  workspaces: CloudWorkspace[];
  challenge: ChallengeResponse | null;
  preview: CloudImportPreview | null;
  receipt: CloudImportReceipt | null;
  installation: WorkspaceInstallation | null;
  busy: boolean;
  phase: string;
  failure: CloudFailureView | null;
}

export interface CloudRepository {
  installCloudCopy(workspace: Workspace, receipt: CloudImportReceipt, deviceId: string): Promise<{ existing: boolean; installation: CloudLocalInstallation }>;
  acknowledgeCloudInstallation(receipt: WorkspaceInstallation): Promise<void>;
  close(): Promise<void>;
}

export interface CloudControllerDeps {
  api: CloudApiPort;
  openRepository(namespace: string): CloudRepository;
  /** 用于判断「同一份字节」的重试；不同字节必须换幂等键。 */
  digest(bytes: ArrayBuffer): Promise<string>;
  key(): string;
}

const initial: CloudState = {
  status: 'loading', capabilities: null, me: null, devices: [], workspaces: [],
  challenge: null, preview: null, receipt: null, installation: null,
  busy: false, phase: '', failure: null,
};

export class CloudController {
  private state: CloudState = initial;
  private readonly listeners = new Set<(state: CloudState) => void>();
  private email = '';
  private previewKey: string | null = null;
  private previewDigest: string | null = null;
  private activateKey: string | null = null;

  constructor(private readonly deps: CloudControllerDeps) {}

  readonly getState = () => this.state;

  readonly subscribe = (listener: (state: CloudState) => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private patch(next: Partial<CloudState>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener(this.state);
  }

  private failureOf(error: unknown): CloudFailureView {
    if (error instanceof CloudFailure) {
      return {
        code: error.code, message: error.message,
        ...(error.retryAction ? { retryAction: error.retryAction } : {}),
        ...(error.correlationId ? { correlationId: error.correlationId } : {}),
      };
    }
    return { code: 'LOCAL_ERROR', message: error instanceof Error ? error.message : '操作未完成' };
  }

  /** 统一入口：忙时不并发，失败保留可读原因与下一步；成功由任务返回最终状态说明。 */
  private async run(start: string, task: () => Promise<string>): Promise<boolean> {
    if (this.state.busy) return false;
    this.patch({ busy: true, phase: start, failure: null });
    try {
      const phase = await task();
      this.patch({ phase });
      return true;
    } catch (error) {
      const failure = this.failureOf(error);
      if (failure.code === 'UNAUTHENTICATED') {
        this.patch({ status: 'signed-out', me: null, devices: [], workspaces: [], phase: '' });
      }
      this.patch({ failure, phase: failure.code === 'UNAUTHENTICATED' ? '会话已失效，请重新登录；本机内容不受影响' : '' });
      return false;
    } finally {
      this.patch({ busy: false });
    }
  }

  private async loadAccount(me: MeResponse) {
    const [devices, workspaces] = await Promise.all([this.deps.api.devices(), this.deps.api.workspaces()]);
    this.patch({ me, devices, workspaces });
  }

  async refresh(): Promise<boolean> {
    return this.run('正在读取云端状态…', async () => {
      let capabilities: CloudCapabilities;
      try {
        capabilities = await this.deps.api.capabilities();
      } catch (error) {
        // 连能力都读不到：明确落在「不可用」，不能停在「读取中」让人以为还在干活
        this.patch({ status: 'unavailable', capabilities: null, me: null, devices: [], workspaces: [] });
        throw error;
      }
      this.patch({ capabilities });
      if (!capabilities.features.accounts || !capabilities.features.sessions) {
        this.patch({ status: 'unavailable', me: null, devices: [], workspaces: [] });
        return '这个部署没有启用云端账号';
      }
      try {
        const me = await this.deps.api.me();
        await this.loadAccount(me);
        this.patch({ status: 'signed-in' });
        return '';
      } catch (error) {
        if (error instanceof CloudFailure && error.code === 'UNAUTHENTICATED') {
          this.patch({ status: 'signed-out', me: null, devices: [], workspaces: [] });
          return '';
        }
        throw error;
      }
    });
  }

  async login(email: string): Promise<boolean> {
    return this.run('正在发送验证码…', async () => {
      const challenge = await this.deps.api.challenge(email);
      this.email = email;
      this.patch({ challenge });
      return `验证码已发送，${challenge.resendAfterSeconds} 秒后可重发；若不重发请等待过期`;
    });
  }

  async verify(code: string, deviceName?: string): Promise<boolean> {
    const challenge = this.state.challenge;
    if (!challenge) {
      this.patch({ failure: { code: 'BAD_REQUEST', message: '请先获取验证码' } });
      return false;
    }
    return this.run('正在验证…', async () => {
      await this.deps.api.verify({
        challengeId: challenge.challengeId, email: this.email, code,
        ...(deviceName?.trim() ? { deviceName: deviceName.trim() } : {}),
      });
      const me = await this.deps.api.me();
      await this.loadAccount(me);
      this.patch({ status: 'signed-in', challenge: null });
      return '已登录；本机原有内容没有被上传或改写';
    });
  }

  async logout(): Promise<boolean> {
    return this.run('正在退出…', async () => {
      await this.deps.api.logout();
      this.patch({
        status: 'signed-out', me: null, devices: [], workspaces: [], challenge: null,
        preview: null, receipt: null, installation: null,
      });
      this.previewKey = this.previewDigest = this.activateKey = null;
      return '已退出。本机云副本与游客存档都保留在原地，不会自动上传或删除';
    });
  }

  /** 预览只登记与校验；返回后界面必须显式区分「尚未激活」。 */
  async previewImport(bytes: ArrayBuffer): Promise<boolean> {
    if (!this.state.me) {
      this.patch({ failure: { code: 'UNAUTHENTICATED', message: '请先登录云账号' } });
      return false;
    }
    return this.run('正在上传并校验存档…', async () => {
      const digest = await this.deps.digest(bytes);
      if (this.previewDigest !== digest) {
        this.previewKey = this.deps.key();
        this.previewDigest = digest;
        this.activateKey = null;
      }
      const key = this.previewKey;
      if (!key) throw new Error('导入幂等键缺失，请重试');
      const preview = await this.deps.api.preview(bytes, key);
      this.patch({ preview, receipt: null, installation: null });
      return preview.state === 'activated'
        ? '这份存档已经导入过；可直接在设备上领取'
        : '预览已就绪，尚未写入云端；确认后才会激活';
    });
  }

  async resumePreview(id: string): Promise<boolean> {
    return this.run('正在查询预览状态…', async () => {
      const preview = await this.deps.api.previewStatus(id);
      this.patch({ preview });
      return preview.state === 'activated' ? '这份存档已经导入过' : '预览已就绪，尚未写入云端';
    });
  }

  async confirmImport(): Promise<boolean> {
    const preview = this.state.preview;
    if (!preview) {
      this.patch({ failure: { code: 'BAD_REQUEST', message: '请先生成导入预览' } });
      return false;
    }
    return this.run('正在激活云端副本…', async () => {
      this.activateKey ??= this.deps.key();
      const receipt = await this.deps.api.activate({
        previewId: preview.id, snapshotDigest: preview.snapshotDigest, validationBinding: preview.validationBinding,
      }, this.activateKey);
      this.patch({ receipt, preview: { ...preview, state: 'activated' } });
      // 回执是权威结论；列表刷新只是方便紧接着领取，失败不回滚也不改变结论
      await this.deps.api.workspaces().then((workspaces) => this.patch({ workspaces })).catch(() => {});
      return '云端副本已激活；本机原存档与游客库未被修改';
    });
  }

  /**
   * 领取到本机：服务端下发同一 canonical 副本 → 写入账号隔离命名空间 → 回执。
   * 回执失败时保留本机安装与未确认的键，重试沿原键恢复，不产生第二份副本。
   */
  async claim(workspaceId: string): Promise<boolean> {
    const me = this.state.me;
    if (!me) {
      this.patch({ failure: { code: 'UNAUTHENTICATED', message: '请先登录云账号' } });
      return false;
    }
    return this.run('正在领取云端副本…', async () => {
      const delivered = await this.deps.api.workspacePackage(workspaceId);
      const workspace = parseWorkspace(delivered.workspace);
      const repository = this.deps.openRepository(cloudNamespace(me.context.deploymentId, me.account.id, workspaceId));
      try {
        const local = await repository.installCloudCopy(workspace, delivered.receipt, me.device.id);
        const pending = local.installation.acknowledgements.find((entry) => entry.deviceId === me.device.id && !entry.receipt);
        if (!pending) {
          this.patch({
            receipt: delivered.receipt,
            installation: local.installation.acknowledgements.find((entry) => entry.receipt)?.receipt ?? null,
          });
          return '这台设备已保存过该云副本；没有覆盖本机后续进度';
        }
        const installation = await this.deps.api.install(workspaceId,
          { importId: delivered.receipt.id, copyDigest: delivered.receipt.copyDigest }, pending.key);
        await repository.acknowledgeCloudInstallation(installation);
        this.patch({ receipt: delivered.receipt, installation });
        return '云副本已保存到这台设备的独立云库；云库阅读入口属于后续阶段，当前还不能在这里打开';
      } finally {
        await repository.close().catch(() => {});
      }
    });
  }
}
