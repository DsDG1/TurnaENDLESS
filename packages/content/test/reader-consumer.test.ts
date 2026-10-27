import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stableStringify } from '@endless/esl';
import { checked, newId, type ContentRevision, type Workspace } from '@endless/content';
import { AsyncCloudReader, projectReaderIndex } from '@endless/content/cloud';
import { cloudTestContent as content, cloudTestWorkspace } from './cloud-fixture.js';

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('内容包的阅读目录消费者', () => {
  it('只请求当前集的正文叶，目录仍列出更晚的一集', async () => {
    const workspace = cloudTestWorkspace(true);
    const revision = workspace.revisions.find((item) => item.origin !== 'bundled') as ContentRevision;
    const entry = workspace.entries.find((item) => item.id === revision.contentId)!;
    const laterId = 'later-episode';
    const sequelRevision = structuredClone(revision);
    const sequelEntry = structuredClone(entry);
    sequelEntry.id = newId('content');
    sequelRevision.id = newId('revision');
    sequelRevision.contentId = sequelEntry.id;
    sequelRevision.episodeId = laterId;
    sequelEntry.revisionIds = [sequelRevision.id];
    sequelEntry.headRevisionId = sequelRevision.id;
    const ws: Workspace = checked({
      ...workspace,
      entries: [...workspace.entries, sequelEntry],
      revisions: [...workspace.revisions, sequelRevision],
      branches: workspace.branches.map((branch, index) => index === 0 ? {
        ...branch,
        session: { ...branch.session, current: revision.episodeId },
        adopted: [...branch.adopted, { contentId: sequelEntry.id, revisionId: sequelRevision.id }],
      } : branch),
    });
    const index = await projectReaderIndex(content, ws, 'consumer', digest);
    const seen: string[] = [];
    const reader = new AsyncCloudReader(content, async (_leaf, revisionId) => {
      seen.push(revisionId);
      return ws.revisions.find((item) => item.id === revisionId);
    }, digest);
    const opened = await reader.prepare({
      ...ws,
      format: 'cloud-reading-view/1',
      scope: 'consumer',
      revisions: index.revisions,
      checkpoints: ws.checkpoints.map(({ state, ...metadata }) => metadata),
      contentRevisions: index.contentRevisions,
      segments: index.segments,
      indexDigest: index.digest,
      cacheToken: index.token,
    });
    const result = {
      catalogue: opened.catalogue.map((item) => ({ episodeId: item.episodeId, revisionId: item.revisionId, bundled: item.bundled })),
      leafReads: seen,
      reportedReads: opened.reads,
      memoryBytes: opened.memoryBytes,
      catalogBytes: opened.catalogBytes,
    };
    expect(result.catalogue.map((item) => item.episodeId)).toContain(laterId);
    expect(result.leafReads).toEqual([revision.id]);
    expect(result.reportedReads.map((item) => item.key)).toEqual([revision.id]);
    const text = `${JSON.stringify(result, null, 2)}\n`;
    console.log(text);
    if (process.env.ENDLESS_READER_CONSUMER_LOG) writeFileSync(process.env.ENDLESS_READER_CONSUMER_LOG, text);
  });
});
