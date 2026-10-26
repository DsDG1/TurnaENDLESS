import type { WorkspaceRepository } from '../storage.js';
import { CloudFailure, type CloudApiPort } from './client.js';
import type { Content } from '@endless/content';

export class ManagementSync {
  private running = false;
  constructor(private readonly repo: WorkspaceRepository,
    private readonly api: Pick<CloudApiPort, 'submitMetadata' | 'submitLifecycle' | 'managementBootstrap' | 'managementPull'> & Partial<Pick<CloudApiPort, 'submitArchive'>>,
    private readonly workspaceId: string, private readonly content?: Content) {}

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if ((await this.repo.syncState()).paused) return;
      if (await this.repo.pendingPreservation()) throw new Error('阅读冲突保留请求尚未完成，暂不提交管理命令');
      // Durable commands always go first. An unknown response never becomes a new command or a snapshot overwrite.
      for (const held of Object.values((await this.repo.metadataState()).pending)) {
        if (!held.conflict) await this.repo.updateMetadata({ receipt: await this.api.submitMetadata(held.request) });
      }
      for (const held of Object.values((await this.repo.lifecycleState()).pending)) {
        if (!held.conflict) await this.repo.updateManagement({ receipt: await this.api.submitLifecycle(held.request) });
      }
      const archive = (await this.repo.archiveState()).pending;
      if (archive && !archive.resolution) {
        if (!this.api.submitArchive) throw new Error('当前云服务未接入归档命令，原请求保留');
        await this.repo.updateManagement({ archiveReceipt: await this.api.submitArchive(archive.request) }, this.content);
      }
      if (!(await this.repo.lifecycleState()).cursor || !(await this.repo.archiveState()).known) {
        await this.repo.updateManagement({ bootstrap: await this.api.managementBootstrap(this.workspaceId) }, this.content);
      }
      let rebootstrap = false;
      for (let page = 0; page < 50; page++) {
        const cursor = (await this.repo.lifecycleState()).cursor!;
        let response;
        try { response = await this.api.managementPull(this.workspaceId, cursor); }
        catch (error) {
          if (!(error instanceof CloudFailure) || error.code !== 'CURSOR_EXPIRED' || rebootstrap) throw error;
          rebootstrap = true;
          // Merges only management fields, preserves pending commands and learning history, and rejects unknown/older versions.
          await this.repo.updateManagement({ bootstrap: await this.api.managementBootstrap(this.workspaceId) }, this.content);
          continue;
        }
        await this.repo.updateManagement({ pull: response }, this.content);
        if (!response.hasMore) return;
      }
      throw new Error('管理同步本轮已达分页上限，已保存游标；请继续同步');
    } finally { this.running = false; }
  }
}
