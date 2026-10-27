import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { Workspace } from '@endless/content';
import { MeResponseSchema, WorkspaceListResponseSchema } from '@endless/cloud-contracts';
import { cloudTestWorkspace } from '../../../../packages/content/test/cloud-fixture.js';
import { withClient } from '../cloud/embedded-pg.js';
import { browserFixture } from './fixture.js';

let fixture: Awaited<ReturnType<typeof browserFixture>>;
beforeEach(async () => { fixture = await browserFixture(); });
afterEach(async () => { await fixture?.close(); });

async function seedGuest(page: Page, workspace: Workspace) {
  await page.goto(`${fixture.origin}/#home`);
  await page.getByRole('heading', { name: '故事频道。' }).waitFor();
  await page.evaluate(async (workspace) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('endless-workspace', 2);
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['meta', 'revisions', 'branches', 'objects'], 'readwrite');
      for (const key of ['revisions', 'branches', 'objects']) tx.objectStore(key).clear();
      tx.objectStore('meta').put({ key: 'workspace', identity: workspace.identity, profile: workspace.profile,
        entries: workspace.entries, obligations: workspace.obligations, activeBranchId: workspace.activeBranchId, management: workspace.management }, 'workspace');
      for (const r of workspace.revisions) tx.objectStore('revisions').put(r, r.id);
      for (const b of workspace.branches) tx.objectStore('branches').put(b, b.id);
      for (const [kind, rows] of [['volume', workspace.volumes], ['checkpoint', workspace.checkpoints], ['ticket', workspace.tickets]] as const)
        for (const row of rows) tx.objectStore('objects').put({ kind, ...row }, row.id);
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
    }); db.close();
  }, workspace);
  await page.reload();
}

async function login(page: Page, email: string) {
  await page.goto(`${fixture.origin}/#cloud`);
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  const sent = page.waitForResponse((r) => r.url().endsWith('/auth/challenges') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '发送验证码', exact: true }).click();
  expect((await sent).status()).toBe(202);
  await page.getByLabel('验证码', { exact: true }).fill(await fixture.deliverCode());
  await page.getByRole('button', { name: '验证并登录', exact: true }).click();
  await page.getByRole('heading', { name: '账号与设备', exact: true }).waitFor();
  const me = MeResponseSchema.parse(await page.evaluate(async () => { const r = await fetch('/api/cloud/v1/me'); if (!r.ok) throw new Error('me unavailable'); return r.json(); }));
  const cookie = (await page.context().cookies()).find((c) => c.name === '__Host-endless_session');
  expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Lax', path: '/' });
  expect(await page.evaluate(() => document.cookie)).not.toContain('__Host-endless_session');
  return me;
}

async function snapshot(page: Page, namespace: string) {
  return page.evaluate(async (namespace) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(namespace, 2); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const tx = db.transaction(['meta', 'revisions', 'branches', 'objects', 'eventIds', 'outbox', 'sync', 'staging'], 'readonly');
    const requests = { meta: tx.objectStore('meta').get('workspace'), branches: tx.objectStore('branches').getAll(), revisions: tx.objectStore('revisions').getAll(),
      objects: tx.objectStore('objects').getAll(), ids: tx.objectStore('eventIds').getAll(), outbox: tx.objectStore('outbox').getAll(),
      sync: tx.objectStore('sync').get('sync'), pending: tx.objectStore('sync').get('preservation'), staging: tx.objectStore('staging').getAll(),
      revision: tx.objectStore('sync').get('revisions'), metadata: tx.objectStore('sync').get('metadata'), idKeys: tx.objectStore('eventIds').getAllKeys(),
      archive: tx.objectStore('sync').get('archives'), lifecycle: tx.objectStore('sync').get('lifecycle'), installation: tx.objectStore('meta').get('cloud-installation') };
    const result = await new Promise<any>((resolve, reject) => { tx.oncomplete = () => resolve(Object.fromEntries(Object.entries(requests).map(([k, r]) => [k, r.result]))); tx.onerror = tx.onabort = () => reject(tx.error); });
    db.close(); return result;
  }, namespace);
}

async function syncReader(page: Page, namespace: string) {
  const pulled = page.waitForResponse((r) => r.url().includes('/api/cloud/v1/sync/pull?'), { timeout: 15_000 });
  await page.getByRole('button', { name: '立即同步', exact: true }).click();
  expect((await pulled).status()).toBe(200);
  await expect.poll(async () => (await snapshot(page, namespace)).outbox.length, { timeout: 15_000 }).toBe(0);
  await page.getByRole('button', { name: '立即同步', exact: true }).waitFor({ state: 'visible' });
  await expect.poll(() => page.getByRole('button', { name: '立即同步', exact: true }).isEnabled()).toBe(true);
}

async function claim(page: Page, workspaceId: string) {
  const row = page.locator('.cloud-list li').filter({ hasText: workspaceId.slice(0, 8) });
  await row.getByRole('button', { name: '领取到这台设备', exact: true }).click();
  await page.getByText(/安装回执已保存/).waitFor();
  await row.getByRole('button', { name: '打开云端副本', exact: true }).click();
  await page.getByRole('heading', { name: '正在读云端副本', exact: true }).waitFor();
}

describe('C3 actual cloud API + PG + production browser (isolated loopback HTTPS)', () => {
  for (const decision of ['keep-branch', 'discard'] as const) it(`两设备真实登录、导入、离线相反作答与 ${decision} 丢响应恢复`, async () => {
    const deviceA = await fixture.device(decision === 'discard'), deviceB = await fixture.device(decision === 'keep-branch');
    const a = deviceA.context, b = deviceB.context;
    const errors: string[] = [];
    const email = `reader-${randomUUID()}@example.test`, source = cloudTestWorkspace(true);
    const page = await a.newPage(), other = await b.newPage();
    let stage = 'seed';
    for (const p of [page, other]) p.on('pageerror', (e) => errors.push(e.message));
    try {
      await seedGuest(page, source);
      const guestBefore = await snapshot(page, 'endless-workspace');
      stage = 'login/import';
      const me = await login(page, email);
      let currentDeviceId = me.device.id;
      await page.getByRole('button', { name: '生成导入预览', exact: true }).click();
      await page.getByRole('button', { name: '确认导入（激活云端副本）', exact: true }).click();
      await page.locator('[aria-label="云端副本回执"]').waitFor();
      const list = WorkspaceListResponseSchema.parse(await page.evaluate(async () => (await fetch('/api/cloud/v1/workspaces')).json())).workspaces;
      expect(list).toHaveLength(1);
      const workspaceId = list[0]!.id, namespace = `endless-cloud:${me.context.deploymentId}:${me.account.id}:${workspaceId}`;
      await claim(page, workspaceId);
      // Advance the synthetic challenge clock only; both browser sessions still authenticate via SMTP + HTTPS.
      await withClient(fixture.db.cluster.adminDsn, (q) => q.query("UPDATE auth_challenges SET created_at = now() - interval '2 minutes'"));
      const meB = await login(other, email);
      expect(meB.account.id).toBe(me.account.id); expect(meB.device.id).not.toBe(me.device.id);
      await claim(other, workspaceId);
      stage = 'reading common prefix';
      const initialA = await snapshot(page, namespace), initialB = await snapshot(other, namespace);
      expect(initialA.meta.identity.workspaceId).toBe(source.identity.workspaceId);
      expect(initialA.revisions).toEqual(initialB.revisions); expect(initialA.branches).toEqual(initialB.branches);
      const root = source.activeBranchId;
      await page.locator('.episode-card').filter({ hasText: 'Cloud fixture' }).getByRole('button', { name: /播放第 \d 集/ }).click();
      // Reach the first generated practice on A, then install the identical acknowledged prefix on B.
      for (let i = 0; i < 20 && await page.locator('.answer-option').count() === 0; i++) {
        const count = (await snapshot(page, namespace)).branches.find((v: any) => v.id === root).session.events.length;
        await page.getByRole('button', { name: '继续', exact: true }).click();
        await expect.poll(async () => (await snapshot(page, namespace)).branches.find((v: any) => v.id === root).session.events.length).toBe(count + 1);
        await syncReader(page, namespace);
      }
      await syncReader(other, namespace);
      await other.locator('.episode-card').filter({ hasText: 'Cloud fixture' }).getByRole('button', { name: /播放第 \d 集/ }).click();
      await page.locator('.answer-option').first().waitFor(); await other.locator('.answer-option').first().waitFor();
      const prefixA = (await snapshot(page, namespace)).branches.find((v: any) => v.id === root).session.events;
      const prefixB = (await snapshot(other, namespace)).branches.find((v: any) => v.id === root).session.events;
      expect(prefixA).toEqual(prefixB);
      await deviceA.setOffline(true); await page.locator('.answer-option').nth(0).click();
      stage = 'offline opposite answers';
      await expect.poll(async () => (await snapshot(page, namespace)).sync.pendingPush != null).toBe(true);
      const offline = await snapshot(page, namespace);
      await other.locator('.answer-option').nth(1).click();
      await expect.poll(async () => (await snapshot(other, namespace)).branches.find((v: any) => v.id === root).session.events.length).toBe(prefixB.length + 1);
      await syncReader(other, namespace);
      const cloud = await snapshot(other, namespace);
      expect(cloud.branches.find((v: any) => v.id === root).session.events.at(-1).choice).toBe(1);
      if (decision === 'discard') {
        stage = 'rejected push lost across expired identity';
        let rejected = false;
        await page.route('**/api/cloud/v1/sync/push', async (route) => {
          const response = await route.fetch(); expect(response.status()).toBe(409);
          rejected = true; await route.abort();
        });
        await deviceA.setOffline(false);
        await page.getByRole('button', { name: '立即同步', exact: true }).click();
        await expect.poll(() => rejected, { timeout: 15_000 }).toBe(true);
        await page.getByText(/无法连接云服务/).waitFor();
        expect((await snapshot(page, namespace)).sync.pendingPush).toEqual(offline.sync.pendingPush);
        await page.unroute('**/api/cloud/v1/sync/push');
        await withClient(fixture.db.cluster.adminDsn, (q) => q.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE device_id = $1", [currentDeviceId]));
        await page.goto(`${fixture.origin}/#cloud`); await page.getByRole('heading', { name: '用邮箱验证码登录', exact: true }).waitFor();
        await withClient(fixture.db.cluster.adminDsn, (q) => q.query("UPDATE auth_challenges SET created_at = now() - interval '2 minutes'"));
        const next = await login(page, email); currentDeviceId = next.device.id;
        await claim(page, workspaceId);
      }
      await deviceA.setOffline(false);
      await page.getByRole('button', { name: '立即同步', exact: true }).click();
      await expect.poll(async () => (await snapshot(page, namespace)).sync.conflicts.length).toBe(1);
      expect((await snapshot(page, namespace)).branches.find((v: any) => v.id === root).session.events).toEqual(offline.branches.find((v: any) => v.id === root).session.events);
      await page.goto(`${fixture.origin}/#cloud`); await page.getByRole('button', { name: '同步状态', exact: true }).click();
      stage = 'keep lost response';
      let lost = false;
      await page.route('**/api/cloud/v1/sync/conflicts/*/resolve', async (route) => {
        const response = await route.fetch(); expect(response.status()).toBe(200);
        if (!lost) { lost = true; await route.abort(); } else await route.fulfill({ response });
      });
      await page.getByRole('button', { name: decision === 'keep-branch' ? '保留为独立分支' : '放弃本机候选', exact: true }).click();
      await expect.poll(async () => (await snapshot(page, namespace)).pending?.request.decision).toBe(decision);
      await page.getByText(/无法连接云服务/).waitFor();
      const held = (await snapshot(page, namespace)).pending;
      await page.reload(); await page.getByRole('button', { name: '同步状态', exact: true }).click();
      stage = 'resume/receive';
      await page.getByRole('button', { name: '立即同步', exact: true }).click();
      await expect.poll(async () => (await snapshot(page, namespace)).pending).toBeUndefined();
      const recovered = await snapshot(page, namespace);
      expect(recovered.branches.find((v: any) => v.id === root).session.events).toEqual(cloud.branches.find((v: any) => v.id === root).session.events);
      if (decision === 'keep-branch') expect(recovered.branches.find((v: any) => v.id === held.request.streamId).session.events).toEqual(offline.branches.find((v: any) => v.id === root).session.events);
      else {
        expect(recovered.branches).toHaveLength(initialA.branches.length);
        expect(recovered.staging.find((v: any) => v.plan?.request.decision === 'discard').plan.workspace.branches.find((v: any) => v.id === root).session.events)
          .toEqual(offline.branches.find((v: any) => v.id === root).session.events);
      }
      await syncReader(other, namespace);
      const received = await snapshot(other, namespace);
      if (decision === 'keep-branch') expect(received.branches.find((v: any) => v.id === held.request.streamId).session.events).toEqual(offline.branches.find((v: any) => v.id === root).session.events);
      expect(received.meta.activeBranchId).toBe(root);
      await fixture.db.app.withTenant(me.account.id, async (q) => {
        expect(Number((await q.query<{ count: string }>('SELECT count(*) AS count FROM workspace_imports WHERE workspace_id = $1', [workspaceId])).rows[0]!.count)).toBe(1);
        expect(Number((await q.query<{ count: string }>('SELECT count(*) AS count FROM workspace_installations WHERE workspace_id = $1', [workspaceId])).rows[0]!.count)).toBe(decision === 'discard' ? 3 : 2);
        const resolution = (await q.query('SELECT resolution_receipt FROM sync_conflicts WHERE workspace_id = $1', [workspaceId])).rows[0]!.resolution_receipt;
        expect((await q.query('SELECT id FROM sync_conflicts WHERE workspace_id = $1', [workspaceId])).rows).toHaveLength(1);
        if (decision === 'keep-branch') expect(resolution.preserved.streamId).toBe(held.request.streamId);
        else expect(resolution.conflict.status).toBe('discarded');
      });
      const readHash = `/#cloud-read/${me.context.deploymentId}/${me.account.id}/${workspaceId}`;
      stage = 'display conflict';
      await page.goto(`${fixture.origin}${readHash}`); await syncReader(page, namespace);
      await other.goto(`${fixture.origin}${readHash}`); await syncReader(other, namespace);
      const entryId = source.entries.find((e) => e.sourceKind === 'generated')!.id;
      async function editDisplay(target: Page, oldTitle: string, title: string) {
        await target.locator('.episode-card').filter({ hasText: oldTitle }).getByRole('button', { name: '管理此内容' }).click();
        await target.getByRole('menuitem', { name: '编辑展示信息', exact: true }).click();
        await target.getByLabel('显示名称', { exact: true }).fill(title);
        await target.getByRole('button', { name: '保存展示信息', exact: true }).click();
        await expect.poll(async () => (await snapshot(target, namespace)).meta.entries.find((e: any) => e.id === entryId).display.title).toBe(title);
      }
      const localTitle = `Local ${decision}`, remoteTitle = `Remote ${decision}`;
      await deviceA.setOffline(true); await editDisplay(page, 'Cloud fixture', localTitle);
      await editDisplay(other, 'Cloud fixture', remoteTitle); await syncReader(other, namespace);
      await deviceA.setOffline(false); await syncReader(page, namespace);
      await page.getByRole('region', { name: '展示信息冲突' }).waitFor();
      await page.getByRole('button', { name: '保留本机修改并重新提交', exact: true }).click();
      await syncReader(page, namespace); await syncReader(other, namespace);
      expect((await snapshot(other, namespace)).meta.entries.find((e: any) => e.id === entryId).display.title).toBe(localTitle);
      stage = 'complete real reading before revision';
      await page.locator('.episode-card').filter({ hasText: localTitle }).getByRole('button', { name: /(?:播放|查看)第 \d 集/ }).click();
      for (let i = 0; i < 25 && await page.getByRole('heading', { name: '这一段已读完。', exact: true }).count() === 0; i++) {
        const active = (await snapshot(page, namespace)).meta.activeBranchId;
        const choices = page.locator('.answer-option');
        if (await choices.count() && await choices.first().isEnabled()) {
          const count = (await snapshot(page, namespace)).branches.find((b: any) => b.id === active).session.events.length;
          await choices.first().click();
          await expect.poll(async () => (await snapshot(page, namespace)).branches.find((b: any) => b.id === active).session.events.length).toBe(count + 1);
        }
        const count = (await snapshot(page, namespace)).branches.find((b: any) => b.id === active).session.events.length;
        await page.getByRole('button', { name: /^(继续|看完这一集)$/ }).click();
        await expect.poll(async () => (await snapshot(page, namespace)).branches.find((b: any) => b.id === active).session.events.length).toBe(count + 1);
      }
      await page.getByRole('heading', { name: '这一段已读完。', exact: true }).waitFor();
      await syncReader(page, namespace); await syncReader(other, namespace);
      const completedObligations = (await snapshot(page, namespace)).meta.obligations;
      expect(completedObligations.every((o: any) => o.waivedAt !== null)).toBe(true);
      await page.goto(`${fixture.origin}${readHash}`); await syncReader(page, namespace);
      const beforeRevision = await snapshot(page, namespace);
      stage = 'real revision preview/adopt';
      const originalRevision = source.revisions.find((r) => r.origin !== 'bundled')!;
      const revisedTitle = `Revision ${decision}`;
      await page.locator('.episode-card').filter({ hasText: localTitle }).getByRole('button', { name: '管理此内容' }).click();
      await page.getByRole('menuitem', { name: '编辑云端内容', exact: true }).click();
      await page.getByLabel('云端内容草稿', { exact: true }).fill(originalRevision.draft.replace('@title Cloud fixture', `@title ${revisedTitle}`));
      await page.getByRole('button', { name: '提交编译预览', exact: true }).click();
      await page.getByText(/云端与本机编译校验通过/).waitFor();
      await page.getByText(/云端与本机编译校验通过/).filter({ hasText: `标题「${revisedTitle}」` }).waitFor();
      expect((await snapshot(page, namespace)).revisions).toHaveLength(beforeRevision.revisions.length);
      await fixture.db.app.withTenant(me.account.id, async (q) => {
        expect((await q.query('SELECT * FROM revision_registrations WHERE workspace_id = $1', [workspaceId])).rows).toHaveLength(0);
      });
      let lostAdoption = false;
      await page.route('**/api/cloud/v1/sync/revisions/adopt', async (route) => {
        const response = await route.fetch(); expect(response.status()).toBe(200);
        if (!lostAdoption) { lostAdoption = true; await route.abort(); } else await route.fulfill({ response });
      });
      await page.getByRole('button', { name: '确认采用并建立新分支', exact: true }).click();
      await page.getByText(/无法连接云服务/).waitFor();
      const confirming = await snapshot(page, namespace);
      expect(confirming.revision.pending.confirmation).toBeTruthy();
      expect(confirming.revisions).toHaveLength(beforeRevision.revisions.length);
      await page.reload();
      await expect.poll(async () => (await snapshot(page, namespace)).revision.installed.length).toBe(1);
      await page.getByRole('heading', { name: revisedTitle, exact: true }).waitFor();
      await syncReader(other, namespace);
      const adopted = await snapshot(page, namespace), adoptedB = await snapshot(other, namespace);
      const registration = adopted.revision.installed[0];
      expect(adoptedB.revision.installed).toEqual([registration]);
      expect(adopted.meta.obligations).toEqual(completedObligations);
      expect(adoptedB.meta.obligations.map((o: any) => ({ ...o, waivedAt: o.waivedAt !== null }))).toEqual(completedObligations.map((o: any) => ({ ...o, waivedAt: true })));
      expect(adoptedB.meta.activeBranchId).toBe(root);
      for (const before of beforeRevision.branches) expect(adopted.branches.find((v: any) => v.id === before.id).session.events).toEqual(before.session.events);
      for (const state of [adopted, adoptedB]) {
        const prefix = state.idKeys.map((key: string, i: number) => ({ key, value: state.ids[i] }))
          .filter((r: any) => r.key.startsWith(`${registration.stream.streamId}:`))
          .sort((a: any, b: any) => Number(a.key.split(':')[1]) - Number(b.key.split(':')[1]));
        expect(prefix.map((r: any) => r.value.eventId)).toEqual(registration.prefixEventIds);
      }
      await fixture.db.app.withTenant(me.account.id, async (q) => {
        const rows = (await q.query('SELECT body FROM revision_registrations WHERE workspace_id = $1', [workspaceId])).rows;
        expect(rows).toHaveLength(1); expect(rows[0]!.body).toEqual(registration);
      });
      stage = 'archive/lifecycle across devices';
      const beforeManagement = await snapshot(page, namespace);
      await page.goto(`${fixture.origin}${readHash}/library`); await syncReader(page, namespace);
      await page.getByLabel('归档名称', { exact: true }).fill(`Volume ${decision}`);
      await page.getByRole('checkbox', { name: revisedTitle, exact: true }).check();
      const archivedResponse = page.waitForResponse((r) => r.url().endsWith('/api/cloud/v1/sync/archives') && r.request().method() === 'POST');
      await page.getByRole('button', { name: '提交归档请求', exact: true }).click();
      const archived = await archivedResponse;
      expect(archived.status()).toBe(200); expect(await archived.json()).toMatchObject({ outcome: 'applied' });
      await expect.poll(async () => (await snapshot(page, namespace)).objects.filter((o: any) => o.kind === 'volume').length, { timeout: 15_000 }).toBe(1);
      await syncReader(page, namespace); await syncReader(other, namespace);
      const volume = (await snapshot(page, namespace)).objects.find((o: any) => o.kind === 'volume');
      expect((await snapshot(other, namespace)).objects.find((o: any) => o.kind === 'volume')).toEqual(volume);
      await other.locator('.episode-card').filter({ hasText: revisedTitle }).getByRole('button', { name: '管理此内容' }).click();
      await other.getByRole('menuitem', { name: '移入回收站', exact: true }).click();
      await expect.poll(async () => (await snapshot(other, namespace)).meta.entries.find((e: any) => e.id === entryId).lifecycle).toBe('trashed');
      await syncReader(other, namespace); await syncReader(page, namespace);
      const trashed = await snapshot(page, namespace);
      expect(trashed.meta.entries.find((e: any) => e.id === entryId)).toMatchObject({ lifecycle: 'trashed', archiveVolumeId: null });
      expect(trashed.objects.find((o: any) => o.kind === 'volume' && o.id === volume.id).members.some((m: any) => m.contentId === entryId)).toBe(true);
      await other.goto(`${fixture.origin}${readHash}/library`); await syncReader(other, namespace);
      await other.getByRole('button', { name: '恢复', exact: true }).click();
      await expect.poll(async () => (await snapshot(other, namespace)).meta.entries.find((e: any) => e.id === entryId).lifecycle).toBe('active');
      await syncReader(other, namespace); await syncReader(page, namespace);
      expect((await snapshot(page, namespace)).meta.entries.find((e: any) => e.id === entryId)).toMatchObject({ lifecycle: 'active', archiveVolumeId: volume.id });
      await page.getByRole('button', { name: '提交取消归档请求', exact: true }).click();
      await expect.poll(async () => (await snapshot(page, namespace)).meta.entries.find((e: any) => e.id === entryId).archiveVolumeId).toBeNull();
      await syncReader(page, namespace); await syncReader(other, namespace);
      const afterManagement = await snapshot(page, namespace);
      for (const before of beforeManagement.branches) expect(afterManagement.branches.find((v: any) => v.id === before.id).session.events).toEqual(before.session.events);
      expect(afterManagement.meta.obligations).toEqual(beforeManagement.meta.obligations);
      stage = 'paused offline cold start';
      await page.goto(`${fixture.origin}/#cloud`); await page.getByRole('button', { name: '同步状态', exact: true }).click();
      await page.getByRole('button', { name: '暂停同步', exact: true }).click();
      await expect.poll(async () => (await snapshot(page, namespace)).sync.paused).toBe(true);
      await page.goto(`${fixture.origin}${readHash}`);
      await page.locator('.episode-card').filter({ hasText: revisedTitle }).getByRole('button', { name: /播放第 \d 集/ }).click();
      const active = afterManagement.meta.activeBranchId;
      const countBefore = afterManagement.branches.find((v: any) => v.id === active).session.events.length;
      await page.getByRole('button', { name: '继续', exact: true }).click();
      await expect.poll(async () => (await snapshot(page, namespace)).outbox.length).toBe(1);
      await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 15_000 });
      await deviceA.setOffline(true); await page.reload();
      await page.getByRole('heading', { name: '正在读云端副本', exact: true }).waitFor();
      await page.getByRole('button', { name: '继续', exact: true }).click();
      await expect.poll(async () => (await snapshot(page, namespace)).outbox.length).toBe(2);
      const paused = await snapshot(page, namespace);
      expect(paused.sync.pendingPush).toBeUndefined(); expect(paused.sync.paused).toBe(true);
      expect(paused.branches.find((v: any) => v.id === active).session.events.length).toBe(countBefore + 2);
      stage = 'expired identity/reclaim/outbox';
      await deviceA.setOffline(false);
      await withClient(fixture.db.cluster.adminDsn, (q) => q.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE device_id = $1", [currentDeviceId]));
      await page.goto(`${fixture.origin}/#cloud`); await page.getByRole('heading', { name: '用邮箱验证码登录', exact: true }).waitFor();
      expect((await snapshot(page, namespace)).outbox).toEqual(paused.outbox);
      await page.goto(`${fixture.origin}${readHash}/watch`);
      await page.getByRole('heading', { name: '正在读云端副本', exact: true }).waitFor();
      await page.locator('.scene-body').waitFor();
      expect((await snapshot(page, namespace)).outbox).toEqual(paused.outbox);
      await page.goto(`${fixture.origin}/#cloud`);
      await withClient(fixture.db.cluster.adminDsn, (q) => q.query("UPDATE auth_challenges SET created_at = now() - interval '2 minutes'"));
      const renewed = await login(page, email);
      expect(renewed.account.id).toBe(me.account.id); expect(renewed.device.id).not.toBe(currentDeviceId);
      await claim(page, workspaceId);
      expect((await snapshot(page, namespace)).outbox).toEqual(paused.outbox);
      await page.goto(`${fixture.origin}/#cloud`); await page.getByRole('button', { name: '同步状态', exact: true }).click();
      await page.getByRole('button', { name: '恢复同步', exact: true }).click();
      await page.getByRole('button', { name: '立即同步', exact: true }).click();
      await expect.poll(async () => (await snapshot(page, namespace)).outbox.length).toBe(0);
      const restored = await snapshot(page, namespace);
      expect(restored.branches.find((v: any) => v.id === active).session.events).toEqual(paused.branches.find((v: any) => v.id === active).session.events);
      for (const item of paused.outbox) expect(restored.ids.some((i: any) => i.eventId === item.eventId)).toBe(true);
      await expect.poll(() => page.getByRole('button', { name: '立即同步', exact: true }).isEnabled()).toBe(true);
      stage = 'pruned reading snapshot / management epoch recovery';
      const beforeRecovery = await snapshot(other, namespace);
      await withClient(fixture.db.cluster.adminDsn, async (q) => {
        await q.query('DELETE FROM workspace_changes WHERE workspace_id = $1', [workspaceId]);
        await q.query('UPDATE workspace_change_heads SET retained_from = change_seq WHERE workspace_id = $1', [workspaceId]);
        await q.query('UPDATE workspaces SET sync_epoch = sync_epoch + 1 WHERE id = $1', [workspaceId]);
      });
      const recovery = other.waitForResponse((r) => r.url().endsWith('/api/cloud/v1/sync/snapshot'));
      await other.getByRole('button', { name: '立即同步', exact: true }).click();
      expect((await recovery).status()).toBe(200);
      await expect.poll(async () => (await snapshot(other, namespace)).lifecycle.cursor).not.toBe(beforeRecovery.lifecycle.cursor);
      await expect.poll(() => other.getByRole('button', { name: '立即同步', exact: true }).isEnabled()).toBe(true);
      const afterRecovery = await snapshot(other, namespace);
      expect(afterRecovery.sync.cursor).not.toBe(beforeRecovery.sync.cursor);
      expect(afterRecovery.lifecycle.cursor).not.toBe(beforeRecovery.lifecycle.cursor);
      expect(afterRecovery.meta.activeBranchId).toBe(root);
      expect(afterRecovery.branches.find((v: any) => v.id === active).session.events).toEqual(restored.branches.find((v: any) => v.id === active).session.events);
      expect(afterRecovery.branches.find((v: any) => v.id === root).session.events).toEqual(beforeRecovery.branches.find((v: any) => v.id === root).session.events);
      stage = 'fresh installation after journal pruning';
      const freshDevice = await fixture.device(true);
      try {
        const freshPage = await freshDevice.context.newPage();
        freshPage.on('pageerror', (e) => errors.push(e.message));
        await withClient(fixture.db.cluster.adminDsn, (q) => q.query("UPDATE auth_challenges SET created_at = now() - interval '2 minutes'"));
        expect((await login(freshPage, email)).account.id).toBe(me.account.id);
        await claim(freshPage, workspaceId);
        await expect.poll(async () => (await snapshot(freshPage, namespace)).revision?.installed.length).toBe(1);
        await syncReader(freshPage, namespace);
        const fresh = await snapshot(freshPage, namespace);
        expect(fresh.revision.installed).toEqual(afterRecovery.revision.installed);
        expect(fresh.meta.activeBranchId).toBe(root);
        expect(fresh.outbox).toEqual([]);
        for (const branch of afterRecovery.branches) expect(fresh.branches.find((b: any) => b.id === branch.id)?.session.events).toEqual(branch.session.events);
      } finally { await freshDevice.context.close(); }
      stage = 'logout/account isolation';
      const beforeSwitch = await snapshot(page, namespace);
      await page.getByRole('button', { name: '退出登录', exact: true }).click();
      await page.getByRole('heading', { name: '用邮箱验证码登录', exact: true }).waitFor();
      const switched = await login(page, `another-${randomUUID()}@example.test`);
      expect(switched.account.id).not.toBe(me.account.id);
      expect(await page.getByRole('heading', { name: '增量同步', exact: true }).count()).toBe(0);
      expect(await page.getByRole('button', { name: '打开云端副本', exact: true }).count()).toBe(0);
      expect(await page.evaluate(async (workspaceId) => (await fetch(`/api/cloud/v1/sync/bootstrap?workspaceId=${workspaceId}`)).status, workspaceId)).toBe(404);
      expect(await snapshot(page, namespace)).toEqual(beforeSwitch);
      expect(await snapshot(page, 'endless-workspace')).toEqual(guestBefore);
      expect(errors).toEqual([]);
    } catch (cause) {
      console.info('[cloud-browser failure stage]', stage, fixture.artifacts);
      await Promise.allSettled([page.screenshot({ path: join(fixture.artifacts, `${decision}-a.png`), fullPage: true }), other.screenshot({ path: join(fixture.artifacts, `${decision}-b.png`), fullPage: true })]);
      throw cause;
    } finally { await Promise.all([a.close(), b.close()]); }
  });
});
