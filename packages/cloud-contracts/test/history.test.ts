import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CLOUD_HISTORY_LIMITS, CloudAdoptionManifestSchema, CloudContentRevisionSchema, CloudEventSegmentSchema,
  CloudGenerationBasisSchema, CloudHistoryError, decodeCloudHistoryLine, encodeCloudHistoryLine,
  parseCloudWorkspace, readCloudHistory, scanCloudHistoryLines,
  type CloudAdoptionManifest, type CloudEventSegment, type CloudWorkspaceEnvelope,
} from '../src/index.js';

const sha = 'ab'.repeat(32);
const hash = '0123456789abcdef';
const id = (prefix: string) => `${prefix}_${randomUUID()}`;

function segment(partial: Pick<CloudEventSegment, 'segmentId' | 'streamId' | 'previousSegmentId' | 'fromSeq' | 'toSeq' | 'eventCount'>): CloudEventSegment {
  return CloudEventSegmentSchema.parse({
    contract: 'cloud-event-segment/1', ...partial, segmentHash: hash,
    body: { objectId: randomUUID(), sha256: sha, bytes: 128 },
  });
}

describe('云历史外层契约', () => {
  it('旧工作区和无界数组都不能当成新云工作区', () => {
    expect(() => parseCloudWorkspace({ format: 'endless-workspace', schemaVersion: 1 })).toThrow(CloudHistoryError);
    const workspace = emptyWorkspace();
    expect(() => parseCloudWorkspace({ ...workspace, events: [] })).toThrow(CloudHistoryError);
    expect(parseCloudWorkspace(workspace).contract).toBe('endless-cloud-workspace/1');
  });

  it('事件段超过 1000、采用页超过 500 时拒绝，而不是删掉多出来的部分', () => {
    const streamId = id('brn');
    expect(() => segment({
      segmentId: id('seg'), streamId, previousSegmentId: null, fromSeq: 0, toSeq: 1001, eventCount: 1001,
    })).toThrow();
    expect(() => CloudAdoptionManifestSchema.parse({
      contract: 'cloud-adoption-manifest/1', manifestId: id('adm'), previousManifestId: null, ordinal: 0,
      entries: Array.from({ length: 501 }, () => ({ contentId: id('ent'), revisionId: id('rev') })),
    })).toThrow();
  });

  it('11 段共 11_000 个事件、两页共 501 条采用可以按行读完', () => {
    const streamId = id('brn');
    const segments: CloudEventSegment[] = [];
    for (let index = 0; index < 11; index++) {
      segments.push(segment({
        segmentId: id('seg'), streamId,
        previousSegmentId: segments[index - 1]?.segmentId ?? null,
        fromSeq: index * 1000, toSeq: (index + 1) * 1000, eventCount: 1000,
      }));
    }
    const entries = Array.from({ length: 501 }, () => ({ contentId: id('ent'), revisionId: id('rev') }));
    const first = id('adm');
    const manifests: CloudAdoptionManifest[] = [
      CloudAdoptionManifestSchema.parse({
        contract: 'cloud-adoption-manifest/1', manifestId: first, previousManifestId: null, ordinal: 0,
        entries: entries.slice(0, 500),
      }),
      CloudAdoptionManifestSchema.parse({
        contract: 'cloud-adoption-manifest/1', manifestId: id('adm'), previousManifestId: first, ordinal: 1,
        entries: entries.slice(500),
      }),
    ];
    const workspace: CloudWorkspaceEnvelope = {
      contract: 'endless-cloud-workspace/1', workspaceId: randomUUID(), catalogVersion: 'pilot-v1',
      history: { streamId, eventCount: 11_000, eventHash: hash, headSegmentId: segments.at(-1)!.segmentId },
      adoption: { headManifestId: manifests[1]!.manifestId, entryCount: 501 },
    };
    const lines = [workspace, ...segments, ...manifests].map((record) => encodeCloudHistoryLine(record));
    let pulled = 0;
    function* lazy() {
      for (const line of lines) {
        pulled += 1;
        yield line;
      }
    }
    expect(() => scanCloudHistoryLines(lazy(), () => { throw new Error('stop'); })).toThrow('stop');
    expect(pulled).toBe(1);
    const document = readCloudHistory(lines);
    expect(document.workspace.history.eventCount).toBe(11_000);
    expect(document.segments).toHaveLength(11);
    expect(document.manifests.reduce((sum, manifest) => sum + manifest.entries.length, 0)).toBe(501);
    expect(document.manifests.every((manifest) => manifest.entries.length <= CLOUD_HISTORY_LIMITS.adoptionsPerManifest)).toBe(true);
  });

  it('超长行和陌生契约拒绝写入', () => {
    expect(() => decodeCloudHistoryLine('x'.repeat(CLOUD_HISTORY_LIMITS.lineBytes + 1))).toThrow(/上限/);
    expect(() => decodeCloudHistoryLine(JSON.stringify({ contract: 'nope' }))).toThrow(/无法识别/);
  });

  it('修订的计划时间必须等于生成依据，落稿时间可以不同', () => {
    const workspace = emptyWorkspace();
    const plannedAt = '2026-10-24T08:00:00.000Z';
    const authoredAt = '2026-10-24T09:00:00.000Z';
    const basisId = id('bas');
    const basis = CloudGenerationBasisSchema.parse({
      contract: 'cloud-generation-basis/1', basisId, catalogVersion: 'pilot-v1',
      learningContract: 'endless-draft-v1', projectorVersion: 'player-replay-1',
      history: workspace.history, adoption: workspace.adoption, obligations: [],
      plannedAt, authoredAt,
    });
    const revision = {
      contract: 'cloud-content-revision/1' as const, revisionId: id('rev'), contentId: id('ent'), basisId,
      leaf: { objectId: randomUUID(), sha256: sha, bytes: 32 }, plannedAt, authoredAt,
    };
    const shifted = CloudContentRevisionSchema.parse({ ...revision, plannedAt: '2026-10-25T08:00:00.000Z' });
    expect(() => readCloudHistory([workspace, basis, shifted].map((record) => encodeCloudHistoryLine(record)))).toThrow(/计划时间/);
    const document = readCloudHistory([workspace, basis, revision].map((record) => encodeCloudHistoryLine(record)));
    expect(document.bases[0]).toMatchObject({ plannedAt, authoredAt });
    expect(document.revisions[0]).toMatchObject({ plannedAt, authoredAt });
  });
});

function emptyWorkspace(): CloudWorkspaceEnvelope {
  return {
    contract: 'endless-cloud-workspace/1', workspaceId: randomUUID(), catalogVersion: 'pilot-v1',
    history: { streamId: id('brn'), eventCount: 0, eventHash: hash, headSegmentId: null },
    adoption: { headManifestId: null, entryCount: 0 },
  };
}
