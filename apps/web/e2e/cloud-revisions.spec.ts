import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { stableStringify } from '@endless/esl';
import { adoptRevision, applyPlayerCommand, bridge, buildBackup, deriveCloudCopy, previewRevision, type ContentRevision } from '@endless/content';
import { getScenes } from '@endless/player';
import type { RevisionPreviewRequest, RevisionPreviewReceipt, RevisionAdoptionCommand, RevisionAdoptionReceipt, RevisionRegistration } from '@endless/cloud-contracts';
import { cloudTestContent as content, cloudTestTime, cloudTestWorkspace } from '../../../packages/content/test/cloud-fixture.js';
import { workspaceRows } from './workspace-seed.js';

const digest = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex');
const at = new Date('2026-10-27T08:00:00.000Z');

// Production UI + real IndexedDB, with protocol responses compiled by the native content library.
// Server transactions are separately covered with real PostgreSQL; this is not the C3 live-API stage exit.
for (const read of [false, true]) test(`云修订${read ? '已读分叉' : '未读原位'}：显式确认、丢响应刷新与另一设备接收`, async ({ page, browser }) => {
  let original = cloudTestWorkspace(true);
  const originalRevision = original.revisions.find((r) => r.origin !== 'bundled')! as ContentRevision;
  if (read) {
    original = applyPlayerCommand(content, original, { type: 'select', episode: originalRevision.episodeId }, at);
    original = applyPlayerCommand(content, original, { type: 'advance',
      scene: getScenes(bridge(content, original).library.episodes.at(-1)!)[0]!.id, skip: false }, at);
  }
  const copy = deriveCloudCopy(buildBackup(original), cloudTestTime, content);
  const entry = copy.entries.find((e) => e.sourceKind === 'generated')!;
  const deploymentId = crypto.randomUUID(), accountId = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  const deviceId = crypto.randomUUID(), namespace = `endless-cloud:${deploymentId}:${accountId}:${workspaceId}`;
  const ids = copy.branches[0]!.session.events.map(() => crypto.randomUUID());
  const previews = new Map<string, Extract<RevisionPreviewReceipt, { outcome: 'ready' }>>();
  const results = new Map<string, RevisionAdoptionReceipt>(), registrations: RevisionRegistration[] = [];
  const previewCalls: RevisionPreviewRequest[] = [], adoptionCalls: RevisionAdoptionCommand[] = [];
  const display = copy.entries.map((e) => ({ contentId: e.id, version: 0,
    value: { title: e.display.title, tags: e.display.tags, note: e.display.note }, updatedAt: e.updatedAt }));
  const lifecycle = copy.entries.map((e) => ({ contentId: e.id, sourceKind: e.sourceKind, version: 0, updatedAt: e.updatedAt,
    value: { lifecycle: e.lifecycle, trashedAt: e.trashedAt, archiveVolumeId: e.archiveVolumeId } }));
  const streams = copy.branches.map((b) => ({ streamId: b.id, branchId: b.id, eventSeq: b.session.events.length, lastEventId: ids.at(-1) ?? null }));
  let losePreview = true, loseAdopt = true;
  const errors: string[] = [];
  async function setup(target: Page) {
    target.on('pageerror', (error) => errors.push(error.message));
    await target.route('**/api/cloud/v1/**', async (route) => {
      expect(route.request().headers()['x-endless-provider-key']).toBeUndefined();
      const url = new URL(route.request().url());
      let body: unknown;
      if (url.pathname.endsWith('/sync/bootstrap')) body = { workspaceId, cloudVersion: '0', changeSeq: 0, cursor: '0', streams, origin: { cursor: '0', streams } };
      else if (url.pathname.endsWith('/sync/pull')) body = { fromChangeSeq: 0, changeSeq: 0, changes: [], nextCursor: '0', hasMore: false, cloudVersion: String(registrations.length) };
      else if (url.pathname.endsWith('/sync/revisions/catalog')) body = { workspaceId, version: registrations.length, registrations, digest: digest(registrations) };
      else if (url.pathname.endsWith('/sync/revisions/preview')) {
        const request = route.request().postDataJSON() as RevisionPreviewRequest; previewCalls.push(request);
        if (!previews.has(request.requestId)) {
          const p = previewRevision(content, copy, entry, request.draft, at);
          if (!p.ok || !p.revision) throw new Error('fixture compilation');
          const candidate = adoptRevision(content, copy, entry, p.revision, at, `brn_${crypto.randomUUID()}`);
          const b = candidate.workspace.branches.find((b) => b.id === candidate.workspace.activeBranchId)!;
          const artifact = { compiler: 'cloud-revision-preview/1' as const, mode: candidate.mode,
            binding: { sourceDigest: digest(copy), inventoryDigest: 'd'.repeat(64), streamId: request.streamId,
              baseRevisionId: request.baseRevisionId, eventCount: request.baseSeq, lastEventId: request.baseEventId,
              displayVersion: 0, lifecycleVersion: 0, archiveVersion: 0 },
            revision: p.revision, revisionDigest: digest(p.revision), branch: { streamId: b.id, label: b.label, parentBranchId: b.parentBranchId,
              forkAtEventCount: b.forkAtEventCount, adopted: b.adopted, catalog: b.session.catalog, createdAt: b.createdAt,
              commonStreamId: b.parentBranchId, commonPrefixSeq: b.forkAtEventCount ?? 0 } };
          previews.set(request.requestId, { workspaceId, requestId: request.requestId, outcome: 'ready', adoptionAvailable: false,
            artifact: { ...artifact, digest: digest(artifact) } });
        }
        if (losePreview) { losePreview = false; await route.abort(); return; }
        body = previews.get(request.requestId);
      } else if (url.pathname.endsWith('/sync/revisions/adopt')) {
        const command = route.request().postDataJSON() as RevisionAdoptionCommand; adoptionCalls.push(command);
        expect(Object.keys(command).sort()).toEqual(['protocol', 'workspaceId', 'commandId', 'previewRequestId', 'artifactDigest'].sort());
        if (!results.has(command.commandId)) {
          const p = previews.get(command.previewRequestId)!, revision = p.artifact.revision as ContentRevision;
          expect(command.artifactDigest).toBe(p.artifact.digest);
          const candidate = adoptRevision(content, copy, entry, revision, at, p.artifact.branch.streamId).workspace;
          const e = candidate.entries.find((e) => e.id === entry.id)!;
          const count = p.artifact.mode === 'fork' ? p.artifact.branch.commonPrefixSeq : p.artifact.binding.eventCount;
          const registration: RevisionRegistration = { format: 'cloud-revision-registration/1', version: 1, readingChangeSeq: 0,
            commandId: command.commandId, previewRequestId: p.requestId, artifact: p.artifact,
            entry: { contentId: e.id, revisionIds: e.revisionIds, headRevisionId: e.headRevisionId, updatedAt: e.updatedAt }, obligations: candidate.obligations,
            display: { contentId: e.id, version: 1, value: { title: revision.title, tags: [], note: '' }, updatedAt: at.toISOString() },
            stream: { streamId: p.artifact.branch.streamId, branchId: p.artifact.branch.streamId, eventSeq: count, lastEventId: count ? ids[count - 1]! : null },
            prefixEventIds: p.artifact.mode === 'fork' ? ids.slice(0, count) : [] };
          registrations.push(registration); results.set(command.commandId, { workspaceId, commandId: command.commandId, outcome: 'applied', registration });
        }
        if (loseAdopt) { loseAdopt = false; await route.abort(); return; }
        body = results.get(command.commandId);
      } else if (url.pathname.endsWith('/sync/management/bootstrap')) body = { workspaceId, cursor: String(registrations.length), changeSeq: registrations.length,
        display: display.map((e) => registrations.find((r) => r.display.contentId === e.contentId)?.display ?? e), lifecycle,
        archive: { version: 0, volumes: [] }, archiveOrigin: [],
        ...(registrations.length ? { revisionCatalog: { workspaceId, version: registrations.length, registrations, digest: digest(registrations) } } : {}) };
      else if (url.pathname.endsWith('/sync/management/pull')) {
        const cursor = url.searchParams.get('cursor')!;
        body = { workspaceId, fromCursor: cursor, nextCursor: String(registrations.length), hasMore: false,
          changes: registrations.slice(Number(cursor)).map((registration) => ({ seq: registration.version, type: 'revision', registration })) };
      } else { await route.abort(); return; }
      await route.fulfill({ json: body, headers: { 'Cache-Control': 'no-store' } });
    });
    await target.goto('/#home');
    await target.evaluate(async ({ namespace, rows, copy, workspaceId, deviceId }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(namespace, 2);
        r.onupgradeneeded = () => { for (const name of ['meta', 'revisions', 'branches', 'objects', 'staging', 'outbox', 'eventIds', 'sync']) r.result.createObjectStore(name); };
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['meta', 'revisions', 'branches', 'objects'], 'readwrite');
        tx.objectStore('meta').put(rows.meta, 'workspace');
        tx.objectStore('meta').put({ receipt: { id: crypto.randomUUID(), workspaceId, sourceLocalId: copy.identity.workspaceId,
          sourceProfileId: copy.profile.id, sourceRepositoryRevision: 0, sourceObjectId: crypto.randomUUID(), sourceDigest: 'a'.repeat(64),
          snapshotDigest: 'b'.repeat(64), copyDigest: 'c'.repeat(64), copyCreatedAt: copy.profile.createdAt, validationBinding: 'd'.repeat(64),
          copyPolicy: 'endless-cloud-copy/1', contentIds: copy.entries.map((e) => e.id), revisionIds: copy.revisions.map((r) => r.id),
          seedContentIds: copy.entries.filter((e) => e.sourceKind === 'bundled').map((e) => e.id) },
          acknowledgements: [{ deviceId, key: crypto.randomUUID() }] }, 'cloud-installation');
        for (const key of ['revisions', 'branches', 'objects'] as const) for (const row of rows[key]) tx.objectStore(key).put(row, row.id);
        tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
      }); db.close();
    }, { namespace, rows: workspaceRows(copy), copy, workspaceId, deviceId: target === page ? deviceId : crypto.randomUUID() });
    await target.goto(`/#cloud-read/${deploymentId}/${accountId}/${workspaceId}`);
    await expect(target.getByRole('button', { name: '立即同步' })).toBeEnabled();
  }
  async function snapshot(target: Page) {
    return target.evaluate(async (namespace) => {
      const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open(namespace, 2); r.onsuccess = () => resolve(r.result); });
      const tx = db.transaction(['meta', 'branches', 'revisions', 'sync'], 'readonly');
      const meta = tx.objectStore('meta').get('workspace'), branches = tx.objectStore('branches').getAll();
      const revisions = tx.objectStore('revisions').getAll(), state = tx.objectStore('sync').get('revisions');
      const result = await new Promise<any>((resolve, reject) => { tx.oncomplete = () => resolve({ meta: meta.result, branches: branches.result, revisions: revisions.result, state: state.result }); tx.onabort = () => reject(tx.error); });
      db.close(); return result;
    }, namespace);
  }
  const otherContext = await browser.newContext(), other = await otherContext.newPage();
  try {
    await setup(page); await setup(other);
    await page.getByRole('button', { name: '管理此内容' }).last().click();
    await page.getByRole('menuitem', { name: '编辑云端内容' }).click();
    await page.getByLabel('云端内容草稿').fill(originalRevision.draft.replace('Cloud fixture', 'Revised clue'));
    await page.getByRole('button', { name: '提交编译预览' }).click();
    await expect(page.getByText(/无法连接云服务/)).toBeVisible();
    expect(adoptionCalls).toHaveLength(0); expect((await snapshot(page)).revisions).toHaveLength(copy.revisions.length);
    await page.reload();
    await expect(page.getByRole('button', { name: '立即同步' })).toBeEnabled();
    await page.getByRole('button', { name: '管理此内容' }).last().click();
    await page.getByRole('menuitem', { name: '编辑云端内容' }).click();
    await expect(page.getByText(/云端与本机编译校验通过/)).toBeVisible();
    expect(previewCalls).toHaveLength(2); expect(previewCalls[1]).toEqual(previewCalls[0]); expect(adoptionCalls).toHaveLength(0);
    await page.getByRole('button', { name: read ? '确认采用并建立新分支' : '确认采用此修订', exact: true }).click();
    await expect(page.getByRole('heading', { name: '修订确认待恢复' })).toBeVisible();
    await expect(page.getByText(/无法连接云服务/)).toBeVisible();
    expect((await snapshot(page)).revisions).toHaveLength(copy.revisions.length);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Revised clue', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '立即同步' })).toBeEnabled();
    expect(adoptionCalls).toHaveLength(2); expect(adoptionCalls[1]).toEqual(adoptionCalls[0]); expect(registrations).toHaveLength(1);
    await other.getByRole('button', { name: '立即同步' }).click();
    await expect(other.getByRole('heading', { name: 'Revised clue', exact: true })).toBeVisible();
    const a = await snapshot(page), b = await snapshot(other), r = registrations[0]!;
    expect(a.state.pending).toBeNull(); expect(b.state.installed).toEqual([r]);
    expect(a.meta.activeBranchId).toBe(r.stream.streamId); expect(b.meta.activeBranchId).toBe(copy.activeBranchId);
    expect(a.branches).toHaveLength(read ? 2 : 1);
    for (const s of [a, b]) expect(s.branches.find((branch: any) => branch.id === copy.activeBranchId).session.events).toEqual(copy.branches[0]!.session.events);
    expect(errors).toEqual([]);
  } finally { await otherContext.close(); }
});
