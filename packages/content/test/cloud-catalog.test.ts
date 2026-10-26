import { describe, expect, it } from 'vitest';
import { getScenes } from '@endless/player';
import { checked, newId, openCloudCatalog, type ContentRevision, type Workspace } from '../src/index.js';
import { cloudTestContent as content, cloudTestWorkspace } from './cloud-fixture.js';

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
  return { workspace: checked(ws), firstId: revision.episodeId, laterId };
}

describe('云内容目录按需编译', () => {
  it('试播目录可以查找原文，且不编译生成集', () => {
    const catalog = openCloudCatalog(content, cloudTestWorkspace());
    const episode = content.pilot.episodes[0]!;
    const scene = getScenes(episode)[0]!;
    const source = catalog.lookupSource(`${episode.id}.${scene.id}`);
    expect(source.lines.length).toBeGreaterThan(0);
    expect(source.read).toBe(false);
    expect(catalog.compiledGenerated()).toEqual([]);
  });

  it('未打开的后续生成集不编译，已保存的叙述仍可按引用查找', () => {
    const { workspace, firstId, laterId } = withUnreadSequel(cloudTestWorkspace(true));
    const catalog = openCloudCatalog(content, workspace);
    const first = workspace.revisions.find((item) => item.origin !== 'bundled' && item.episodeId === firstId) as ContentRevision;
    const comic = first.batch.scenes.find((scene) => scene.type === 'comic');
    expect(comic).toBeTruthy();
    expect(catalog.sceneCount(firstId)).toBe(first.batch.scenes.length);
    expect(catalog.sceneCount(laterId)).toBe(first.batch.scenes.length);
    expect(catalog.compiledGenerated()).toEqual([]);

    const source = catalog.lookupSource(`${firstId}.${comic!.id}`);
    expect(source.lines.some((line) => line.includes('is here'))).toBe(true);
    expect(source.read).toBe(false);
    expect(catalog.compiledGenerated()).toEqual([]);

    const loaded = catalog.loadEpisode(firstId);
    expect(getScenes(loaded)).toHaveLength(first.batch.scenes.length);
    expect(catalog.compiledGenerated()).toEqual([firstId]);

    expect(() => catalog.loadEpisode(laterId)).toThrow(/重复/);
    expect(catalog.compiledGenerated()).toEqual([firstId]);
  });
});
