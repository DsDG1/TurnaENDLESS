import { describe, expect, it } from 'vitest';
import { stableStringify } from '@endless/esl';
import { checked, newId, parseWorkspace, type ContentRevision, type Workspace } from '../src/index.js';
import { AsyncCloudReader, projectReaderIndex } from '../src/cloud.js';
import { cloudTestContent as content, cloudTestWorkspace } from './cloud-fixture.js';

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function withUnreadSequel(workspace: Workspace): { workspace: Workspace; firstId: string; laterId: string } {
  const ws = structuredClone(workspace);
  const revision = ws.revisions.find((item) => item.origin !== 'bundled') as ContentRevision;
  const entry = ws.entries.find((item) => item.id === revision.contentId)!;
  const laterId = 'later-episode';
  const sequelRevision = structuredClone(revision);
  const sequelEntry = structuredClone(entry);
  sequelEntry.id = newId('content');
  sequelRevision.id = newId('revision');
  sequelRevision.contentId = sequelEntry.id;
  sequelRevision.episodeId = laterId;
  sequelEntry.revisionIds = [sequelRevision.id];
  sequelEntry.headRevisionId = sequelRevision.id;
  ws.entries.push(sequelEntry);
  ws.revisions.push(sequelRevision);
  ws.branches[0]!.adopted.push({ contentId: sequelEntry.id, revisionId: sequelRevision.id });
  const ready = checked(ws);
  ready.branches[0]!.session = { ...ready.branches[0]!.session, current: revision.episodeId };
  return { workspace: ready, firstId: revision.episodeId, laterId };
}

function viewFrom(workspace: Workspace, index: Awaited<ReturnType<typeof projectReaderIndex>>) {
  return {
    ...workspace,
    format: 'cloud-reading-view/1' as const,
    scope: 'reader-test',
    revisions: index.revisions,
    checkpoints: workspace.checkpoints.map(({ state, ...metadata }) => metadata),
    contentRevisions: index.contentRevisions,
    segments: index.segments,
    indexDigest: index.digest,
    cacheToken: index.token,
  };
}

describe('云阅读目录与正文叶', () => {
  it('目录含更晚一集的元数据，打开当前集时不读取它的正文', async () => {
    const { workspace, firstId, laterId } = withUnreadSequel(cloudTestWorkspace(true));
    const index = await projectReaderIndex(content, workspace, 'reader-test', digest);
    const first = workspace.revisions.find((item) => item.episodeId === firstId && item.origin !== 'bundled') as ContentRevision;
    const later = workspace.revisions.find((item) => item.episodeId === laterId) as ContentRevision;
    expect(index.sourceContract).toBe('endless-cloud-workspace/1');
    expect(index.revisions.every((revision) => !('draft' in revision) && !('batch' in revision))).toBe(true);
    expect(index.contentRevisions.map((revision) => revision.revisionId)).toEqual([first.id, later.id]);
    expect(index.segments.length).toBeGreaterThan(0);
    expect(index.segments.every((segment) => segment.contract === 'cloud-event-segment/1' && !('events' in segment))).toBe(true);
    expect(() => parseWorkspace(viewFrom(workspace, index))).toThrow(/不是完整工作区/);
    expect(parseWorkspace(workspace).revisions.find((item) => item.id === first.id)).toMatchObject({ draft: first.draft });

    const seen: string[] = [];
    let restored = 0;
    const reader = new AsyncCloudReader({ ...content, restore: (raw) => { restored += 1; return content.restore(raw); } }, async (_leaf, revisionId) => {
      seen.push(revisionId);
      return workspace.revisions.find((item) => item.id === revisionId);
    }, digest);
    const opened = await reader.prepare(viewFrom(workspace, index));
    expect(opened.catalogue.map((entry) => entry.episodeId)).toContain(laterId);
    expect(opened.reads.map((item) => item.key)).toEqual([first.id]);
    expect(seen).toEqual([first.id]);
    expect(restored).toBe(1);
    expect(opened.memoryBytes).toBe(opened.reads.reduce((sum, item) => sum + item.bytes, 0));
    expect(opened.catalogBytes).toBeGreaterThan(0);

    const comic = first.batch.scenes.find((scene) => scene.type === 'comic');
    const lines = await reader.lookupSource(opened.view, first.id, comic!.id);
    expect(lines.some((line) => line.includes('is here'))).toBe(true);
    expect(seen).not.toContain(later.id);
    expect(restored).toBeGreaterThan(1);

    seen.length = 0;
    await expect(reader.prepare(viewFrom(workspace, index), { type: 'select', episode: laterId })).rejects.toThrow();
    expect(seen).toEqual([first.id, later.id]);
  });

  it('错误引用、坏摘要、缺叶和未知契约都在原生恢复之前拒绝', async () => {
    const { workspace, firstId } = withUnreadSequel(cloudTestWorkspace(true));
    const index = await projectReaderIndex(content, workspace, 'reader-test', digest);
    const first = workspace.revisions.find((item) => item.episodeId === firstId && item.origin !== 'bundled') as ContentRevision;
    let restored = 0;
    const readBody = async () => workspace.revisions.find((item) => item.id === first.id);
    const watching = { ...content, restore: (raw: unknown) => { restored += 1; return content.restore(raw); } };
    const tamper = async (mutate: (view: ReturnType<typeof viewFrom>) => void, body: () => Promise<unknown>) => {
      restored = 0;
      const view = viewFrom(workspace, structuredClone(index));
      mutate(view);
      view.indexDigest = await digest({ revisions: view.revisions, contentRevisions: view.contentRevisions, segments: view.segments });
      const reader = new AsyncCloudReader(watching, async () => body(), digest);
      await reader.prepare(view);
    };
    await expect(tamper((view) => {
      const header = view.revisions.find((item) => item.id === first.id);
      if (header && header.origin !== 'bundled') header.leaf = { ...header.leaf, sha256: '0'.repeat(64) };
      const linked = view.contentRevisions.find((item) => item.revisionId === first.id)!;
      linked.leaf = { ...linked.leaf, sha256: '0'.repeat(64) };
    }, readBody)).rejects.toThrow(/摘要/);
    expect(restored).toBe(0);

    await expect(tamper((view) => {
      const header = view.revisions.find((item) => item.id === first.id);
      if (header && header.origin !== 'bundled') header.leaf = { ...header.leaf, objectId: crypto.randomUUID() };
      const linked = view.contentRevisions.find((item) => item.revisionId === first.id)!;
      linked.leaf = { ...linked.leaf, objectId: header && header.origin !== 'bundled' ? header.leaf.objectId : linked.leaf.objectId };
    }, readBody)).rejects.toThrow(/身份/);
    expect(restored).toBe(0);

    await expect(tamper(() => undefined, async () => null)).rejects.toThrow(/缺少正文/);
    expect(restored).toBe(0);

    await expect(tamper(() => undefined, async () => ({ ...first, contract: 'foreign/1' }))).rejects.toThrow(/未知契约/);
    expect(restored).toBe(0);
    expect(workspace.revisions.find((item) => item.id === first.id)).toMatchObject({ draft: first.draft, title: first.title });
  });
});
