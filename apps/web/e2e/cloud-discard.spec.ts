import { expect, test } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { applyPlayerCommand, buildBackup } from '@endless/content';
import { deriveCloudCopy } from '@endless/content/cloud';
import { stableStringify } from '@endless/esl';
import { getScenes } from '@endless/player';
import { CLOUD_LIMITS, type ResolveConflictResponse, type SyncConflict, type SyncEventEntry } from '@endless/cloud-contracts';
import { cloudTestContent as content, cloudTestTime, cloudTestWorkspace } from '../../../packages/content/test/cloud-fixture.js';
import { workspaceRows } from './workspace-seed.js';

// Production UI + real IndexedDB with native player events. PG adjudication is tested separately.
test('放弃离线候选丢响应后刷新续接，原子恢复云端历史并保留原身份备份（协议桩）', async ({ page }) => {
  const copy = deriveCloudCopy(buildBackup(cloudTestWorkspace()), cloudTestTime, content), branch = copy.branches[0]!;
  const scene = getScenes(content.pilot.episodes[0]!)[0]!;
  const left = applyPlayerCommand(content, copy, { type: 'advance', scene: scene.id, skip: false }, new Date('2026-10-27T08:00:00Z'));
  const right = applyPlayerCommand(content, copy, { type: 'advance', scene: scene.id, skip: false }, new Date('2026-10-27T09:00:00Z'));
  const workspaceId = randomUUID(), deviceId = randomUUID(), deploymentId = randomUUID(), accountId = randomUUID(), conflictId = randomUUID();
  const namespace = `endless-cloud:${deploymentId}:${accountId}:${workspaceId}`;
  const event = (workspace: typeof copy): SyncEventEntry => {
    const body = workspace.branches[0]!.session.events[0]!;
    return { eventId: randomUUID(), seq: 1, at: body.at, event: body as SyncEventEntry['event'],
      command: { type: 'advance', scene: scene.id, skip: false }, digest: createHash('sha256').update(stableStringify(body)).digest('hex') };
  };
  const local = event(right), remote = event(left);
  const conflict: SyncConflict = { id: conflictId, workspaceId, streamId: branch.id, deviceId, reason: 'stream-head-changed',
    status: 'open', baseSeq: 0, cloudSeq: 1, createdAt: cloudTestTime, resolvedAt: null, events: [local] };
  const stream = { streamId: branch.id, branchId: branch.id, eventSeq: 1, lastEventId: remote.eventId };
  const result: ResolveConflictResponse = { conflict: { ...conflict, status: 'discarded', resolvedAt: cloudTestTime }, stream,
    history: { stream, branch: { streamId: branch.id, label: branch.label, parentBranchId: null, forkAtEventCount: null,
      adopted: branch.adopted, catalog: branch.session.catalog, createdAt: branch.createdAt, commonStreamId: null, commonPrefixSeq: 0 }, events: [remote] } };
  const calls: unknown[] = [], errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/cloud/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    expect(route.request().headers()['x-endless-provider-key']).toBeUndefined();
    const device = { id: deviceId, name: '本机', createdAt: cloudTestTime, lastSeenAt: cloudTestTime, revokedAt: null, current: true };
    let body: unknown;
    if (path.endsWith('/capabilities')) body = { protocol: 'endless-cloud/1', contracts: { workspace: 'endless-workspace/1' }, limits: CLOUD_LIMITS,
      features: { accounts: true, sessions: true, devices: true, workspaces: true, objects: true, import: true, sync: true,
        generation: false, credits: false, billing: false, payments: false, exports: false, edition: false } };
    else if (path.endsWith('/me')) body = { context: { deploymentId, environment: 'test', localNamespace: `endless-cloud:${deploymentId}:${accountId}` },
      account: { id: accountId, status: 'active', createdAt: cloudTestTime }, device, entitlements: [] };
    else if (path.endsWith('/devices')) body = { devices: [device] };
    else if (path.endsWith('/workspaces')) body = { workspaces: [{ id: workspaceId, sourceLocalId: copy.identity.workspaceId,
      contract: 'endless-workspace/1', cloudVersion: '1', status: 'active', role: 'owner', createdAt: cloudTestTime }] };
    else if (path.endsWith('/resolve')) {
      calls.push(route.request().postDataJSON());
      if (calls.length === 1) { await route.abort(); return; }
      body = result;
    } else if (path.endsWith('/sync/conflicts')) body = { conflicts: [calls.length ? result.conflict : conflict] };
    else if (path.endsWith('/sync/pull')) body = { fromChangeSeq: 0, changeSeq: 1, nextCursor: '1', hasMore: false, cloudVersion: '1',
      changes: [{ seq: 1, batchId: randomUUID(), deviceId: randomUUID(), streamId: branch.id, fromSeq: 0, toSeq: 1, createdAt: cloudTestTime, events: [remote] }] };
    else { await route.abort(); return; }
    await route.fulfill({ json: body, headers: { 'Cache-Control': 'no-store' } });
  });
  await page.goto('/#home');
  await page.evaluate(async ({ namespace, rows, copy, workspaceId, deviceId, conflict, local }) => {
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open(namespace, 2);
      r.onupgradeneeded = () => { for (const s of ['meta', 'revisions', 'branches', 'objects', 'staging', 'outbox', 'eventIds', 'sync']) r.result.createObjectStore(s); };
      r.onsuccess = () => resolve(r.result); });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['meta', 'revisions', 'branches', 'objects', 'outbox', 'eventIds', 'sync'], 'readwrite');
      tx.objectStore('meta').put(rows.meta, 'workspace');
      tx.objectStore('meta').put({ receipt: { id: crypto.randomUUID(), workspaceId, sourceLocalId: copy.identity.workspaceId, sourceProfileId: copy.profile.id,
        sourceRepositoryRevision: 0, sourceObjectId: crypto.randomUUID(), sourceDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64), copyDigest: 'c'.repeat(64),
        copyCreatedAt: copy.profile.createdAt, validationBinding: 'd'.repeat(64), copyPolicy: 'endless-cloud-copy/1', contentIds: copy.entries.map((e) => e.id),
        revisionIds: copy.revisions.map((r) => r.id), seedContentIds: copy.entries.map((e) => e.id) }, acknowledgements: [{ deviceId, key: crypto.randomUUID() }] }, 'cloud-installation');
      for (const key of ['revisions', 'branches', 'objects'] as const) for (const row of rows[key]) tx.objectStore(key).put(row, row.id);
      tx.objectStore('outbox').put({ streamId: conflict.streamId, ...local }, `${conflict.streamId}:1`);
      tx.objectStore('eventIds').put({ eventId: local.eventId, event: local.event }, `${conflict.streamId}:1`);
      tx.objectStore('sync').put({ cursor: '0', cloudVersion: '1', streams: { [conflict.streamId]: { seq: 0, eventId: null } }, paused: false,
        conflicts: [{ id: conflict.id, streamId: conflict.streamId, baseSeq: 0, cloudSeq: 1, createdAt: conflict.createdAt }], needsRebase: [], lastError: null, lastSyncedAt: null }, 'sync');
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
    }); db.close();
  }, { namespace, rows: workspaceRows(right), copy, workspaceId, deviceId, conflict, local });
  const snapshot = () => page.evaluate(async (namespace) => {
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open(namespace, 2); r.onsuccess = () => resolve(r.result); });
    const tx = db.transaction(['branches', 'staging', 'outbox', 'eventIds', 'sync'], 'readonly');
    const requests = { branches: tx.objectStore('branches').getAll(), staging: tx.objectStore('staging').getAll(),
      outbox: tx.objectStore('outbox').getAll(), ids: tx.objectStore('eventIds').getAll(), pending: tx.objectStore('sync').get('preservation') };
    const result = await new Promise<any>((resolve) => { tx.oncomplete = () => resolve(Object.fromEntries(Object.entries(requests).map(([k, r]) => [k, r.result]))); });
    db.close(); return result;
  }, namespace);
  await page.goto('/#cloud'); await page.getByRole('button', { name: '同步状态', exact: true }).click();
  await page.getByRole('button', { name: '放弃本机候选', exact: true }).click();
  await expect(page.getByText(/无法连接云服务/)).toBeVisible();
  const before = await snapshot(); expect(before.pending.request.decision).toBe('discard');
  expect(before.branches[0].session.events).toEqual(right.branches[0]!.session.events); expect(before.ids[0].eventId).toBe(local.eventId);
  await page.reload(); await page.getByRole('button', { name: '同步状态', exact: true }).click();
  await page.getByRole('button', { name: '立即同步', exact: true }).click();
  await expect.poll(async () => (await snapshot()).pending).toBeUndefined();
  const after = await snapshot(); expect(calls).toEqual([{ workspaceId, decision: 'discard' }, { workspaceId, decision: 'discard' }]);
  expect(after.branches[0].session.events).toEqual(left.branches[0]!.session.events); expect(after.outbox).toEqual([]); expect(after.ids[0].eventId).toBe(remote.eventId);
  const retained = after.staging.find((v: any) => v.plan?.request.decision === 'discard');
  expect(retained.plan.workspace.branches[0].session.events).toEqual(right.branches[0]!.session.events); expect(retained.plan.identities[0].eventId).toBe(local.eventId);
  expect(errors).toEqual([]);
});
