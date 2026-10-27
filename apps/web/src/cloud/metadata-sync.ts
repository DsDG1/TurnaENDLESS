import type { CloudApiPort } from './client.js';
import type { CloudWorkspaceRepository as WorkspaceRepository } from './repository.js';

/** Each target has at most one durable command. A lost HTTP response or failed IDB acknowledgement retries that exact command. */
export class MetadataSync {
  constructor(private readonly repo: WorkspaceRepository,
    private readonly api: Pick<CloudApiPort, 'metadata' | 'submitMetadata'>, private readonly workspaceId: string) {}

  async run(): Promise<void> {
    if ((await this.repo.syncState()).paused) return;
    const state = await this.repo.metadataState();
    for (const held of Object.values(state.pending)) {
      if (held.conflict) continue;
      const receipt = await this.api.submitMetadata(held.request);
      await this.repo.updateMetadata({ receipt });
    }
    await this.repo.updateMetadata({ snapshot: await this.api.metadata(this.workspaceId) });
  }
}
