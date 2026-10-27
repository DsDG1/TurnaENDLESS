import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { stableStringify } from '@endless/esl';
import type { ArchiveCommand, ArchiveReceipt, LifecycleCommand, LifecycleEntry, LifecycleReceipt, ManagementChange, MetadataCommand, MetadataReceipt, MetadataSnapshot } from '@endless/cloud-contracts';
import { bridge, buildBackup, buildVolume } from '@endless/content';
import { deriveCloudCopy } from '@endless/content/cloud';
import { cloudReaderIndex, cloudWorkspaceRows } from './workspace-seed.js';
import { cloudTestContent, cloudTestTime, cloudTestWorkspace } from '../../../packages/content/test/cloud-fixture.js';

/**
 * 云端入口在「云 API 不可达」下的表现（默认 e2e 不启动云服务）：
 * 必须如实说明不可用，不能停在「读取中」，也不能出现假同步状态。
 */
test('云 API 不可达时如实说明，不显示假成功，本机阅读不受影响', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/cloud/**', (route) => route.abort());

  await page.goto('/#cloud');
  await expect(page.getByRole('heading', { name: '云端副本' })).toBeVisible();
  await expect(page.getByText('这个部署没有启用云功能')).toBeVisible();
  await expect(page.getByText(/无法连接云服务/)).toBeVisible();
  await expect(page.getByText('已同步')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '领取到这台设备' })).toHaveCount(0);
  await expect(page.getByText('读取中')).toHaveCount(0);

  await page.goto('/#home');
  await expect(page.getByRole('heading', { name: '故事频道' })).toBeVisible();
  await expect(page.getByRole('button', { name: /播放第 \d 集/ })).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('云端页面在窄屏没有横向溢出', async ({ page }) => {
  await page.route('**/api/cloud/**', (route) => route.abort());
  await page.goto('/#cloud');
  await expect(page.getByRole('heading', { name: '云端副本' })).toBeVisible();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width}px 没有横向溢出`).toBe(true);
  }
});

/**
 * 深链打开云副本：这台设备没有领取过时必须如实说明，
 * 而且不能顺手在云命名空间里建一份空存档（那就变成「打开了不存在的东西」）。
 */
test('没有本机云副本时深链如实说明，不新建存档也不影响游客阅读', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const deployment = '00000000-0000-4000-8000-000000000001';
  const account = '00000000-0000-4000-8000-000000000002';
  const workspace = '00000000-0000-4000-8000-000000000003';

  await page.goto(`/#cloud-read/${deployment}/${account}/${workspace}`);
  await expect(page.getByRole('heading', { name: '先等一下，存档还没准备好。' })).toBeVisible();
  await expect(page.getByText(/这台设备还没有这份云副本/)).toBeVisible();
  await expect(page.getByRole('link', { name: '回到云端副本' })).toBeVisible();
  // 没有云副本就不该出现「已保存到云副本」这类状态
  await expect(page.getByText('已保存到云副本')).toHaveCount(0);

  const stored = await page.evaluate(async (namespace) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(namespace);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const has = await new Promise<boolean>((resolve) => {
      const tx = db.transaction('meta', 'readonly');
      const request = tx.objectStore('meta').get('workspace');
      request.onsuccess = () => resolve(!!request.result);
      request.onerror = () => resolve(false);
    });
    db.close();
    return has;
  }, `endless-cloud:${deployment}:${account}:${workspace}`);
  expect(stored).toBe(false);

  await page.goto('/#home');
  await expect(page.getByRole('heading', { name: '故事频道' })).toBeVisible();
  await expect(page.getByRole('button', { name: /播放第 \d 集/ })).toHaveCount(3);
  expect(errors).toEqual([]);
});

/** Production UI + IndexedDB with a protocol stub. This does not replace the real-cloud-API two-device stage exit. */
test('展示信息冲突刷新后可显式保留本机，丢响应后恢复原命令', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const deployment = '00000000-0000-4000-8000-000000000011';
  const account = '00000000-0000-4000-8000-000000000012';
  const workspaceId = '00000000-0000-4000-8000-000000000013';
  const deviceId = '00000000-0000-4000-8000-000000000014';
  const namespace = `endless-cloud:${deployment}:${account}:${workspaceId}`;
  await page.goto('/#home');
  await expect(page.getByRole('heading', { name: '故事频道' })).toBeVisible();
  const seeded = await page.evaluate(async ({ namespace, workspaceId, deviceId }) => {
    const open = (name: string) => new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      request.onupgradeneeded = () => {
        for (const store of ['meta', 'revisions', 'branches', 'objects', 'staging', 'sync', 'outbox', 'eventIds']) {
          if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
        }
      };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const guest = await open('endless-workspace');
    const original = await new Promise<{ meta: any; revisions: any[]; branches: any[]; objects: any[] }>((resolve, reject) => {
      const tx = guest.transaction(['meta', 'revisions', 'branches', 'objects'], 'readonly');
      const meta = tx.objectStore('meta').get('workspace');
      const revisions = tx.objectStore('revisions').getAll();
      const branches = tx.objectStore('branches').getAll();
      const objects = tx.objectStore('objects').getAll();
      tx.oncomplete = () => resolve({ meta: meta.result, revisions: revisions.result, branches: branches.result, objects: objects.result });
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
    guest.close();
    const db = await open(namespace);
    const entries = original.meta.entries.map((e: any) => ({ contentId: e.id, version: 0,
      value: { title: e.display.title, tags: e.display.tags, note: e.display.note }, updatedAt: e.updatedAt }));
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['meta', 'revisions', 'branches', 'objects', 'sync'], 'readwrite');
      tx.objectStore('meta').put(original.meta, 'workspace');
      tx.objectStore('meta').put({ receipt: {
        id: crypto.randomUUID(), workspaceId, sourceLocalId: original.meta.identity.workspaceId, sourceProfileId: original.meta.profile.id,
        sourceRepositoryRevision: 0, sourceObjectId: crypto.randomUUID(), sourceDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64),
        copyDigest: 'c'.repeat(64), copyCreatedAt: entries[0].updatedAt, validationBinding: 'd'.repeat(64), copyPolicy: 'endless-cloud-copy/1',
        contentIds: entries.map((e: any) => e.contentId), revisionIds: original.revisions.map((r: any) => r.id), seedContentIds: entries.map((e: any) => e.contentId),
      }, acknowledgements: [{ deviceId, key: crypto.randomUUID() }] }, 'cloud-installation');
      for (const key of ['revisions', 'branches', 'objects'] as const) for (const row of original[key]) tx.objectStore(key).put(row, row.id);
      tx.objectStore('sync').put({ format: 'metadata-outbox/1', known: Object.fromEntries(entries.map((e: any) => [e.contentId, e])), pending: {} }, 'metadata');
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
    });
    db.close();
    return { original, entries, lifecycle: original.meta.entries.map((e: any) => ({ contentId: e.id, sourceKind: e.sourceKind, version: 0,
      value: { lifecycle: e.lifecycle, trashedAt: e.trashedAt, archiveVolumeId: e.archiveVolumeId }, updatedAt: e.updatedAt })),
      streams: original.branches.map((b: any) => ({ streamId: b.id, branchId: b.id, eventSeq: 0, lastEventId: null })) };
  }, { namespace, workspaceId, deviceId });
  const readerIndex = await cloudReaderIndex(seeded.original, namespace);
  await page.evaluate(async ({ namespace, readerIndex }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(namespace, 2);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put(readerIndex, 'cloud-reader-index');
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { namespace, readerIndex });
  const snapshot: MetadataSnapshot = { workspaceId, entries: seeded.entries };
  const requests: MetadataCommand[] = [];
  const receipts = new Map<string, MetadataReceipt>();
  const changes: ManagementChange[] = [];
  let first = true, loseResponse = false;
  await page.route('**/api/cloud/v1/**', async (route) => {
    const url = new URL(route.request().url());
    let body: unknown;
    if (url.pathname.endsWith('/sync/bootstrap')) body = {
      workspaceId, cloudVersion: '0', changeSeq: 0, cursor: '0', streams: seeded.streams,
      origin: { cursor: '0', streams: seeded.streams },
    };
    else if (url.pathname.endsWith('/sync/pull')) body = { changes: [], nextCursor: '0', hasMore: false, cloudVersion: '0' };
    else if (url.pathname.endsWith('/sync/revisions/catalog')) { await route.fulfill({ status: 404 }); return; }
    else if (url.pathname.endsWith('/sync/management/bootstrap')) body = { workspaceId, cursor: String(changes.length), changeSeq: changes.length, display: snapshot.entries, lifecycle: seeded.lifecycle };
    else if (url.pathname.endsWith('/sync/management/pull')) {
      const fromCursor = url.searchParams.get('cursor')!;
      body = { workspaceId, fromCursor, nextCursor: String(changes.length), changes: changes.slice(Number(fromCursor)), hasMore: false };
    }
    else if (url.pathname.endsWith('/sync/metadata') && route.request().method() === 'GET') body = snapshot;
    else if (url.pathname.endsWith('/sync/metadata')) {
      const command = route.request().postDataJSON() as MetadataCommand;
      requests.push(command);
      let result = receipts.get(command.commandId);
      if (!result) {
        const entry = snapshot.entries.find((e) => e.contentId === command.contentId)!;
        entry.version++;
        entry.value = first ? { title: '云端并发名称', tags: ['云端标签'], note: '云端备注' } : command.value;
        entry.updatedAt = new Date().toISOString();
        changes.push({ seq: changes.length + 1, type: 'display', entry: structuredClone(entry) });
        result = { workspaceId, commandId: command.commandId, outcome: first ? 'conflict' : 'applied', entry: structuredClone(entry) };
        first = false;
        receipts.set(command.commandId, result);
      }
      if (loseResponse) { loseResponse = false; await route.abort(); return; }
      body = result;
    } else { await route.abort(); return; }
    await route.fulfill({ json: body, headers: { 'Cache-Control': 'no-store' } });
  });
  await page.goto(`/#cloud-read/${deployment}/${account}/${workspaceId}`);
  await expect(page.getByRole('heading', { name: '正在读云端副本' })).toBeVisible();
  await expect(page.getByRole('button', { name: '立即同步' })).toBeEnabled();
  await page.getByRole('button', { name: '管理此内容' }).first().click();
  await expect(page.getByRole('menuitem', { name: '编辑内容', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: '编辑展示信息' }).click();
  await page.getByLabel('显示名称').fill('本机候选名称');
  await page.getByLabel('标签（逗号分隔）').fill('本机标签');
  await page.getByLabel('个人备注').fill('本机备注');
  await page.getByRole('button', { name: '保存展示信息' }).click();
  await expect(page.getByRole('heading', { name: '展示信息有并发修改' })).toBeVisible();
  await page.reload();
  const conflict = page.getByRole('region', { name: '展示信息冲突' });
  await expect(conflict).toContainText('本机候选名称');
  await expect(conflict).toContainText('云端并发名称');
  await expect(page.getByRole('button', { name: '立即同步' })).toBeEnabled();
  await page.getByRole('button', { name: '保留本机修改并重新提交' }).click();
  await expect(conflict).toHaveCount(0);
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]!.commandId).not.toBe(requests[0]!.commandId);
  expect(requests[1]!.baseVersion).toBe(1);
  await expect(page.getByRole('button', { name: '立即同步' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '管理此内容' }).first()).toBeEnabled();
  await page.getByRole('button', { name: '管理此内容' }).first().click();
  await expect(page.getByRole('menuitem', { name: '编辑展示信息' })).toBeEnabled();
  await page.getByRole('menuitem', { name: '编辑展示信息' }).click();
  await page.getByLabel('显示名称').fill('响应丢失后恢复');
  loseResponse = true;
  await page.getByRole('button', { name: '保存展示信息' }).click();
  await expect.poll(() => requests.length).toBe(3);
  await expect(page.getByText(/无法连接云服务/)).toBeVisible();
  await page.reload();
  await expect.poll(() => requests.length).toBe(4);
  expect(requests[3]).toEqual(requests[2]);
  await expect(page.getByRole('heading', { name: '响应丢失后恢复' })).toBeVisible();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('两浏览器离线归档、取消归档与回收恢复，丢响应刷新不损失阅读历史（协议桩）', async ({ page, browser }) => {
  test.setTimeout(60_000);
  const deployment = crypto.randomUUID(), account = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  const namespace = `endless-cloud:${deployment}:${account}:${workspaceId}`;
  const copy = deriveCloudCopy(buildBackup(cloudTestWorkspace(true)), cloudTestTime, cloudTestContent);
  const generated = copy.entries.find((e) => e.sourceKind === 'generated')!;
  const title = generated.display.title;
  const display = copy.entries.map((e) => ({ contentId: e.id, version: 0, value: { title: e.display.title, tags: e.display.tags, note: e.display.note }, updatedAt: e.updatedAt }));
  const lifecycle: LifecycleEntry[] = copy.entries.map((e) => ({ contentId: e.id, sourceKind: e.sourceKind, version: 0,
    value: { lifecycle: e.lifecycle, trashedAt: e.trashedAt, archiveVolumeId: e.archiveVolumeId }, updatedAt: e.updatedAt }));
  const changes: ManagementChange[] = [], requests: LifecycleCommand[] = [];
  const receipts = new Map<string, LifecycleReceipt | ArchiveReceipt>();
  const archiveRequests: ArchiveCommand[] = [];
  let archive = { version: 0, volumes: structuredClone(copy.volumes) }, loseArchiveResponse = false;
  const streams = copy.branches.map((b) => ({ streamId: b.id, branchId: b.id, eventSeq: b.session.events.length, lastEventId: crypto.randomUUID() }));
  const rows = await cloudWorkspaceRows(copy, namespace), importId = crypto.randomUUID();
  const offline = new Set<Page>();
  const receipt = { id: importId, workspaceId, sourceLocalId: copy.identity.workspaceId, sourceProfileId: copy.profile.id,
    sourceRepositoryRevision: 0, sourceObjectId: crypto.randomUUID(), sourceDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64),
    copyDigest: createHash('sha256').update(stableStringify(copy)).digest('hex'), copyCreatedAt: cloudTestTime, validationBinding: 'd'.repeat(64),
    copyPolicy: 'endless-cloud-copy/1', contentIds: copy.entries.map((e) => e.id), revisionIds: copy.revisions.map((r) => r.id),
    seedContentIds: copy.entries.filter((e) => e.sourceKind === 'bundled').map((e) => e.id) };
  let loseResponse = false;
  const errors: string[] = [];
  const setup = async (target: Page) => {
    target.on('pageerror', (error) => errors.push(error.message));
    await target.route('**/api/cloud/v1/**', async (route) => {
      // Route fixtures can otherwise fulfill while Chromium is offline; keep the synthetic transport unavailable too.
      if (offline.has(target)) { await route.abort(); return; }
      const url = new URL(route.request().url());
      let body: unknown;
      if (url.pathname.endsWith('/sync/bootstrap')) body = { workspaceId, cloudVersion: '0', changeSeq: 0, cursor: '0', streams, origin: { cursor: '0', streams } };
      else if (url.pathname.endsWith('/sync/pull')) body = { changes: [], nextCursor: '0', hasMore: false, cloudVersion: '0' };
      else if (url.pathname.endsWith('/sync/revisions/catalog')) { await route.fulfill({ status: 404 }); return; }
      else if (url.pathname.endsWith('/sync/management/bootstrap')) body = { workspaceId, cursor: String(changes.length), changeSeq: changes.length, display, lifecycle, archive };
      else if (url.pathname.endsWith('/sync/management/pull')) {
        const fromCursor = url.searchParams.get('cursor')!;
        body = { workspaceId, fromCursor, nextCursor: String(changes.length), changes: changes.slice(Number(fromCursor)), hasMore: false };
      } else if (url.pathname.endsWith('/sync/archives')) {
        const input = route.request().postDataJSON() as ArchiveCommand;
        archiveRequests.push(input);
        let receipt = receipts.get(input.commandId) as ArchiveReceipt | undefined;
        if (!receipt) {
          expect(input.baseVersion).toBe(archive.version);
          if (input.type === 'archive') archive = { version: archive.version + 1, volumes: [...archive.volumes,
            { ...buildVolume(copy, bridge(cloudTestContent, copy), input.members.map((m) => m.contentId), input.title), id: input.volumeId }] };
          else archive = { version: archive.version + 1, volumes: archive.volumes.filter((v) => v.id !== input.volumeId) };
          for (const member of input.members) {
            const entry = lifecycle.find((e) => e.contentId === member.contentId)!;
            expect(member.lifecycleVersion).toBe(entry.version); entry.version++; entry.updatedAt = new Date().toISOString();
            entry.value.archiveVolumeId = archive.volumes.find((v) => v.members.some((m) => m.contentId === member.contentId))?.id ?? null;
          }
          const snapshot = { state: structuredClone(archive), lifecycle: structuredClone(lifecycle) };
          receipt = { workspaceId, commandId: input.commandId, outcome: 'applied', snapshot, display: display.filter((d) => input.members.some((m) => m.contentId === d.contentId)) };
          receipts.set(input.commandId, receipt); changes.push({ seq: changes.length + 1, type: 'archive', snapshot });
        }
        if (loseArchiveResponse) { loseArchiveResponse = false; await route.abort(); return; }
        body = receipt;
      } else if (url.pathname.endsWith('/sync/lifecycle')) {
        const request = route.request().postDataJSON() as LifecycleCommand;
        requests.push(request);
        let result = receipts.get(request.commandId) as LifecycleReceipt | undefined;
        if (!result) {
          const entry = lifecycle.find((e) => e.contentId === request.contentId)!;
          expect(request.baseVersion).toBe(entry.version);
          entry.version++; entry.updatedAt = new Date().toISOString();
          entry.value = request.type === 'trash' ? { lifecycle: 'trashed', trashedAt: entry.updatedAt, archiveVolumeId: null }
            : { lifecycle: 'active', trashedAt: null, archiveVolumeId: null };
          changes.push({ seq: changes.length + 1, type: 'lifecycle', entry: structuredClone(entry) });
          result = { workspaceId, commandId: request.commandId, outcome: 'applied', entry: structuredClone(entry) };
          receipts.set(request.commandId, result);
        }
        if (loseResponse) { loseResponse = false; await route.abort(); return; }
        body = result;
      } else { await route.abort(); return; }
      await route.fulfill({ json: body, headers: { 'Cache-Control': 'no-store' } });
    });
    await target.goto('/#home');
    await expect(target.getByRole('heading', { name: '故事频道' })).toBeVisible();
    await target.evaluate(async ({ namespace, rows, receipt }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(namespace, 2);
        request.onupgradeneeded = () => { for (const name of ['meta', 'revisions', 'branches', 'objects', 'staging', 'sync', 'outbox', 'eventIds']) request.result.createObjectStore(name); };
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['meta', 'revisions', 'branches', 'objects'], 'readwrite');
        tx.objectStore('meta').put(rows.meta, 'workspace');
        tx.objectStore('meta').put(rows.readerIndex, 'cloud-reader-index');
        tx.objectStore('meta').put({ receipt, acknowledgements: [{ deviceId: crypto.randomUUID(), key: crypto.randomUUID() }] }, 'cloud-installation');
        for (const name of ['revisions', 'branches', 'objects'] as const) for (const row of rows[name]) tx.objectStore(name).put(row, row.id);
        tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, { namespace, rows, receipt });
    await target.goto(`/#cloud-read/${deployment}/${account}/${workspaceId}`);
    await expect(target.getByRole('button', { name: '立即同步' })).toBeEnabled();
    await expect(target.getByRole('heading', { name: title, exact: true })).toBeVisible();
  };
  const secondContext = await browser.newContext({ serviceWorkers: 'allow', viewport: { width: 390, height: 844 } });
  const second = await secondContext.newPage();
  try {
    await setup(page); await setup(second);
    await page.goto(`/#cloud-read/${deployment}/${account}/${workspaceId}/library`);
    await page.getByLabel('归档名称').fill('双设备归档');
    await page.getByRole('checkbox', { name: title, exact: true }).check();
    offline.add(page); await page.context().setOffline(true);
    await page.getByRole('button', { name: '提交归档请求', exact: true }).click();
    await expect(page.getByRole('heading', { name: '归档请求待确认' })).toBeVisible();
    await expect(page.getByText('还没有已确认的归档卷。')).toBeVisible();
    expect(archiveRequests).toHaveLength(0);
    await page.context().setOffline(false); offline.delete(page); loseArchiveResponse = true;
    await expect(page.getByRole('button', { name: '立即同步' })).toBeEnabled();
    await page.getByRole('button', { name: '立即同步' }).click();
    await expect.poll(() => archiveRequests.length).toBe(1);
    await expect(page.getByText(/无法连接云服务/)).toBeVisible();
    await page.reload(); await expect.poll(() => archiveRequests.length).toBe(2);
    expect(archiveRequests[1]).toEqual(archiveRequests[0]);
    await expect(page.getByText('双设备归档', { exact: true })).toBeVisible();
    await second.getByRole('button', { name: '立即同步' }).click();
    await second.goto(`/#cloud-read/${deployment}/${account}/${workspaceId}/library`);
    await expect(second.getByText('双设备归档', { exact: true })).toBeVisible();
    await second.getByRole('button', { name: '提交取消归档请求' }).click();
    await expect.poll(() => archiveRequests.length).toBe(3);
    await expect(second.getByText('还没有已确认的归档卷。')).toBeVisible();
    await page.goto(`/#cloud-read/${deployment}/${account}/${workspaceId}`);
    await page.getByRole('button', { name: '立即同步' }).click();
    await expect(page.getByRole('button', { name: '立即同步' })).toBeEnabled();
    const trash = async () => {
      await page.getByRole('button', { name: '管理此内容' }).last().click();
      await page.getByRole('menuitem', { name: '移入回收站' }).click();
    };
    await trash();
    await expect.poll(() => requests.length).toBe(1);
    await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
    await second.getByRole('button', { name: '立即同步' }).click();
    await expect(second.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
    await second.goto(`/#cloud-read/${deployment}/${account}/${workspaceId}/library`);
    await expect(second.getByText('仍有阅读义务')).toBeVisible();
    await expect(second.getByRole('button', { name: '恢复', exact: true })).toBeEnabled();
    await second.getByRole('button', { name: '恢复', exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    await expect(second.getByText('回收站是空的。移入回收站不会移除已有历史。')).toBeVisible();
    await page.getByRole('button', { name: '立即同步' }).click();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    loseResponse = true; await trash();
    await expect.poll(() => requests.length).toBe(3);
    await expect(page.getByText(/无法连接云服务/)).toBeVisible();
    await page.reload(); await expect.poll(() => requests.length).toBe(4);
    expect(requests[3]).toEqual(requests[2]);
    await second.getByRole('button', { name: '立即同步' }).click();
    await expect(second.getByRole('button', { name: '恢复', exact: true })).toBeEnabled();
    offline.add(second); await secondContext.setOffline(true);
    expect(await second.evaluate(() => navigator.onLine)).toBe(false);
    await second.getByRole('button', { name: '恢复', exact: true }).click();
    await expect(second.getByText('回收站是空的。移入回收站不会移除已有历史。')).toBeVisible();
    await expect(second.getByText(/无法连接云服务/)).toBeVisible();
    expect(requests).toHaveLength(4);
    await secondContext.setOffline(false); offline.delete(second);
    await second.getByRole('button', { name: '立即同步' }).click();
    await expect.poll(() => requests.length).toBe(5);
    await page.getByRole('button', { name: '立即同步' }).click();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    for (const target of [page, second]) {
      const saved = await target.evaluate(async (namespace) => {
        const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open(namespace); request.onsuccess = () => resolve(request.result); });
        const result = await new Promise<{ meta: any; branches: any[] }>((resolve) => {
          const tx = db.transaction(['meta', 'branches'], 'readonly'), meta = tx.objectStore('meta').get('workspace'), branches = tx.objectStore('branches').getAll();
          tx.oncomplete = () => resolve({ meta: meta.result, branches: branches.result });
        }); db.close(); return result;
      }, namespace);
      expect(saved.branches).toEqual(copy.branches);
      expect(saved.meta.obligations).toEqual(copy.obligations);
    }
    expect(errors).toEqual([]);
  } finally { await secondContext.close(); }
});
