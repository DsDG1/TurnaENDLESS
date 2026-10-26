import { parseWorkspace, type Content, type Workspace } from '@endless/content';
import type {
  ChallengeResponse, CloudCapabilities, CloudImportPreview, CloudImportReceipt,
  CloudWorkspace, Device, MeResponse, WorkspaceInstallation,
} from '@endless/cloud-contracts';
import { CloudFailure, type CloudApiPort } from './client.js';
import { cloudDigest, cloudNamespace, type CloudLocalInstallation } from './local.js';
import { cloudHash } from './routes.js';
import { WorkspaceSync, type SyncRepository } from './sync.js';
import type { CloudSyncState } from './outbox.js';

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
  sync: CloudSyncView | null;
  /** 本机已有安装记录的云工作区；只有这些才能直接打开阅读。 */
  installed: string[];
  busy: boolean;
  phase: string;
  failure: CloudFailureView | null;
}

/** 同步面板只显示本机能证明的事实：条数、游标、冲突、失败原因。 */
export interface CloudSyncView {
  workspaceId: string;
  pending: number;
  paused: boolean;
  cursor: string | null;
  cloudVersion: string | null;
  conflicts: CloudSyncState['conflicts'];
  needsRebase: string[];
  lastError: string | null;
  lastSyncedAt: string | null;
  report: string;
}

export interface CloudRepository extends SyncRepository {
  cloudInstallation(): Promise<CloudLocalInstallation | null>;
  installCloudCopy(workspace: Workspace, receipt: CloudImportReceipt, deviceId: string): Promise<{ existing: boolean; installation: CloudLocalInstallation }>;
  acknowledgeCloudInstallation(receipt: WorkspaceInstallation): Promise<void>;
  rawSnapshot(): Promise<unknown>;
  close(): Promise<void>;
}

export interface CloudControllerDeps {
  api: CloudApiPort;
  openRepository(namespace: string): CloudRepository;
  content: Content;
  /** 用于判断「同一份字节」的重试；不同字节必须换幂等键。 */
  digest(bytes: ArrayBuffer): Promise<string>;
  key(): string;
}

const initial: CloudState = {
  status: 'loading', capabilities: null, me: null, devices: [], workspaces: [],
  challenge: null, preview: null, receipt: null, installation: null, sync: null, installed: [],
  busy: false, phase: '', failure: null,
};

export class CloudController {
  private state: CloudState = initial;
  private readonly listeners = new Set<(state: CloudState) => void>();
  private email = '';
  private previewKey: string | null = null;
  private previewDigest: string | null = null;
  private activateKey: string | null = null;
  private engine: WorkspaceSync | null = null;
  private engineWorkspace: string | null = null;
  private engineRepository: CloudRepository | null = null;

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
    this.patch({ me, devices, workspaces, installed: await this.installedWorkspaces(me, workspaces) });
  }

  /**
   * 本机哪些工作区已经领取过：逐库读安装记录。
   * 读不到就不列进来——「本机有副本」这句话必须由安装记录支撑，不能凭工作区列表猜。
   */
  private async installedWorkspaces(me: MeResponse, workspaces: CloudWorkspace[]): Promise<string[]> {
    const installed: string[] = [];
    for (const workspace of workspaces) {
      const repository = this.deps.openRepository(cloudNamespace(me.context.deploymentId, me.account.id, workspace.id));
      try {
        if (await repository.cloudInstallation()) installed.push(workspace.id);
      } catch {
        // 安装记录损坏时只是不提供「打开阅读」，不影响云端列表本身
      } finally {
        await repository.close().catch(() => {});
      }
    }
    return installed;
  }

  /** 云副本阅读深链；未登录时没有可靠的部署/账号 ID，不生成链接。 */
  readingHash(workspaceId: string): string | null {
    const me = this.state.me;
    if (!me) return null;
    return cloudHash({ deploymentId: me.context.deploymentId, accountId: me.account.id, workspaceId });
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
        this.patch({ installed: Array.from(new Set([...this.state.installed, workspaceId])) });
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
        return '云副本已保存到这台设备的独立云库；可以用「打开云端副本」继续阅读';
      } finally {
        await repository.close().catch(() => {});
      }
    });
  }

  // ---------- 增量同步 ----------

  /** 打开某个云工作区的同步面板：只读本机状态，不触发网络。 */
  async openSync(workspaceId: string): Promise<boolean> {
    const me = this.state.me;
    if (!me) {
      this.patch({ failure: { code: 'UNAUTHENTICATED', message: '请先登录云账号' } });
      return false;
    }
    return this.run('正在读取本机同步状态…', async () => {
      const engine = await this.engineFor(workspaceId);
      this.patch({ sync: await this.view(engine, '') });
      return '';
    });
  }

  async runSync(): Promise<boolean> {
    const workspaceId = this.state.sync?.workspaceId;
    if (!workspaceId) {
      this.patch({ failure: { code: 'BAD_REQUEST', message: '请先选择云工作区' } });
      return false;
    }
    return this.run('正在同步…', async () => {
      const engine = await this.engineFor(workspaceId);
      try {
        const report = await engine.run();
        const notes = [report.note];
        if (report.stopped === 'conflict') {
          const conflicts = await engine.refreshConflicts();
          if (conflicts.length) notes.push(`冲突候选 ${conflicts.length} 条已保留`);
        }
        this.patch({ sync: await this.view(engine, notes.filter(Boolean).join('；')) });
        return report.stopped ? '同步停在一处需要你处理的地方' : '同步完成';
      } catch (error) {
        this.patch({ sync: await this.view(engine, '') });
        throw error;
      }
    });
  }

  async setSyncPaused(paused: boolean): Promise<boolean> {
    const workspaceId = this.state.sync?.workspaceId;
    if (!workspaceId) return false;
    return this.run(paused ? '正在暂停同步…' : '正在恢复同步…', async () => {
      const engine = await this.engineFor(workspaceId);
      await engine.setPaused(paused);
      this.patch({ sync: await this.view(engine, paused ? '已暂停：新事件继续排队，不会丢' : '') });
      return '';
    });
  }

  /** 显式放弃本机这批冲突候选；不删本机内容，只是不再推送该分支。 */
  async discardConflict(conflictId: string): Promise<boolean> {
    const workspaceId = this.state.sync?.workspaceId;
    if (!workspaceId) return false;
    return this.run('正在放弃本机候选…', async () => {
      const engine = await this.engineFor(workspaceId);
      await engine.discard(conflictId);
      await engine.refreshConflicts();
      this.patch({ sync: await this.view(engine, '已放弃本机这批事件；云端保留另一台设备的版本') });
      return '';
    });
  }

  async keepConflict(conflictId: string): Promise<boolean> {
    const workspaceId = this.state.sync?.workspaceId;
    if (!workspaceId) return false;
    return this.run('正在保留独立分支并恢复云端主线…', async () => {
      const engine = await this.engineFor(workspaceId);
      await engine.keep(conflictId);
      await engine.refreshConflicts();
      this.patch({ sync: await this.view(engine, '本机完整历史已保留为独立分支；原分支已恢复到云端历史，后续事件继续排队同步') });
      return '';
    });
  }

  async conflictPackage(): Promise<unknown | null> {
    const workspaceId = this.state.sync?.workspaceId;
    const me = this.state.me;
    if (!workspaceId || !me) return null;
    let snapshot: unknown = null;
    const ok = await this.run('正在读取本机完整冲突包…', async () => {
      await this.engineFor(workspaceId);
      snapshot = {
        format: 'endless-cloud-conflict-package/1',
        namespace: cloudNamespace(me.context.deploymentId, me.account.id, workspaceId),
        data: await this.engineRepository!.rawSnapshot(),
      };
      return '已读取本机完整冲突包（含历史、事件身份与恢复请求）；这不是云端导出，也不会自动覆盖任何存档';
    });
    return ok ? snapshot : null;
  }

  private async engineFor(workspaceId: string): Promise<WorkspaceSync> {
    const me = this.state.me!;
    if (this.engine && this.engineWorkspace === workspaceId) return this.engine;
    if (this.engineRepository) await this.engineRepository.close().catch(() => {});
    const repository = this.deps.openRepository(cloudNamespace(me.context.deploymentId, me.account.id, workspaceId));
    this.engineRepository = repository;
    this.engineWorkspace = workspaceId;
    this.engine = new WorkspaceSync({
      repo: repository, api: this.deps.api, content: this.deps.content,
      workspaceId, deviceId: me.device.id,
      digest: (value) => cloudDigest(value),
      newBatchId: () => globalThis.crypto.randomUUID(),
    });
    return this.engine;
  }

  private async view(engine: WorkspaceSync, report: string): Promise<CloudSyncView> {
    const status = await engine.status();
    return {
      workspaceId: this.engineWorkspace!, pending: status.pending, paused: status.state.paused,
      cursor: status.state.cursor, cloudVersion: status.state.cloudVersion,
      conflicts: status.state.conflicts, needsRebase: status.state.needsRebase,
      lastError: status.state.lastError, lastSyncedAt: status.state.lastSyncedAt, report,
    };
  }
}
