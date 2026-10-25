import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { GeneratedEpisode, GenerationRequest } from '@endless/content';
import { bridge, parseBackup } from '@endless/content';
import { content } from '../../api/test/fixtures.js';
import { dumpWorkspace, generatedDocV4, playDoc, seed } from './workspace-seed.js';

const status = {
  configured: true, model: 'test-model', token: 'test-token',
};

test('模拟模型连续续写两集，刷新、离线与导出保留原文和真实进度', async ({ page, context }) => {
  const documents: GeneratedEpisode[] = [];
  await page.route('**/api/**', async (route) => {
    if (route.request().url().endsWith('/api/status')) {
      await route.fulfill({ json: status });
      return;
    }
    const input = route.request().postDataJSON() as GenerationRequest;
    const document = generatedDocV4(input.save, `ai-${input.requestId}`);
    documents.push(document);
    await route.fulfill({ json: { id: input.requestId, status: 'succeeded', phase: '已完成', result: document } });
  });
  await seed(page);
  for (let index = 0; index < 2; index++) {
    await page.getByRole('button', { name: 'AI 生成下一集', exact: true }).click();
    await expect(page.getByRole('heading', { name: '新的线索', exact: true, level: 1 })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: '新的线索', exact: true, level: 1 })).toBeVisible();
    await playDoc(page, documents[index]!, 'story');
    const newItem = documents[index]!.batch.scenes.find((scene) => scene.evidence?.type === 'practice')!.evidence!.item;
    await page.goto('/#progress');
    await expect(page.locator(`[data-learning-item="${newItem}"]`)).toContainText('情境练习');
    await expect(page.locator(`[data-learning-item="${newItem}"]`)).toContainText('已读 2 个片段');
    if (index) {
      const firstItem = documents[0]!.batch.scenes.find((scene) => scene.evidence?.type === 'practice')!.evidence!.item;
      await expect(page.locator(`[data-learning-item="${firstItem}"]`)).toContainText('已安排复习');
    }
    await page.goto('/#home');
  }
  await page.goto('/#home');
  await expect(page.getByRole('button', { name: /查看第 \d 集/ })).toHaveCount(5);
  await page.goto('/#settings');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出完整备份' }).click();
  const path = await (await downloading).path();
  const exported = parseBackup(JSON.parse(await readFile(path!, 'utf8')));
  const exportedBatches = new Map(
    exported.backup.workspace.data.revisions
      .filter((r) => r.origin !== 'bundled')
      .map((r) => [r.batch.batch, r.batch] as const),
  );
  for (const d of documents) expect(exportedBatches.get(d.batch.batch)).toEqual(d.batch);
  const runtime = bridge(content, exported.backup.workspace.data);
  expect(content.stateContext(runtime.session, runtime.library).view.world.userFacts().filter((fact: { predicate: string }) => fact.predicate === 'chose')).toHaveLength(2);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) =>
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  });
  await page.unroute('**/api/**');
  await context.setOffline(true);
  await page.goto('/#home');
  await page.reload();
  await expect(page.getByText('正在离线体验')).toBeVisible();
  await expect(page.getByRole('button', { name: /查看第 \d 集/ })).toHaveCount(5);
  await page.getByRole('button', { name: '查看第 5 集：新的线索' }).click();
  await expect(page.getByRole('heading', { name: '这一段已读完。' })).toBeVisible();
  await page.getByRole('button', { name: '回看本集' }).click();
  await expect(page.getByRole('heading', { name: '新的线索', exact: true, level: 1 })).toBeVisible();
  await context.setOffline(false);
});

test('刷新后恢复相同任务 ID，不重复创建模型生成', async ({ page }) => {
  const ids: string[] = [];
  let result: GeneratedEpisode | null = null;
  let completed = false;
  await page.route('**/api/**', async (route) => {
    if (route.request().url().endsWith('/api/status')) return route.fulfill({ json: status });
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON() as GenerationRequest;
      ids.push(input.requestId);
      result ??= generatedDocV4(input.save, `ai-${input.requestId}`);
    }
    await route.fulfill({ json: {
      id: ids[0], status: completed ? 'succeeded' : 'running', phase: '模拟模型正在生成',
      ...(completed ? { result } : {}),
    } });
  });
  await seed(page);
  await page.getByRole('button', { name: 'AI 生成下一集', exact: true }).click();
  await expect(page.getByText('模拟模型正在生成', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '恢复生成任务', exact: true })).toBeVisible();
  completed = true;
  await page.getByRole('button', { name: '恢复生成任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '新的线索', exact: true, level: 1 })).toBeVisible();
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(1);
});

test('客户端拒绝被篡改的 AI 结果，不覆盖已有内容和学习记录', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    if (route.request().url().endsWith('/api/status')) return route.fulfill({ json: status });
    const input = route.request().postDataJSON() as GenerationRequest;
    const document = generatedDocV4(input.save, `ai-${input.requestId}`);
    document.hash = '0000000000000000';
    await route.fulfill({ json: { id: input.requestId, status: 'succeeded', phase: '已完成', result: document } });
  });
  await seed(page);
  await page.getByRole('button', { name: 'AI 生成下一集', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('哈希');
  await page.getByRole('button', { name: '停止等待（不终止服务端调用）' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: /查看第 \d 集/ })).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'AI 生成下一集', exact: true })).toBeEnabled();
});

test('自带 Key 仅保留在页面内存，刷新清空但仍可恢复既有任务', async ({ page }) => {
  const key = 'synthetic-browser-memory-key';
  const ids: string[] = [];
  const submittedKeys: (string | undefined)[] = [];
  let result: GeneratedEpisode | null = null;
  let finished = false;
  await page.route('**/api/**', async (route) => {
    if (route.request().url().endsWith('/api/status')) {
      return route.fulfill({ json: { ...status, configured: false, acceptsUserKey: true } });
    }
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON() as GenerationRequest;
      expect(route.request().postData()).not.toContain(key);
      ids.push(input.requestId);
      submittedKeys.push(route.request().headers()['x-endless-provider-key']);
      result ??= generatedDocV4(input.save, `ai-${input.requestId}`);
    } else {
      expect(route.request().headers()['x-endless-provider-key']).toBeUndefined();
    }
    await route.fulfill({ json: {
      id: ids[0], status: finished ? 'succeeded' : 'running', phase: '模拟模型等待中',
      ...(finished ? { result } : {}),
    } });
  });
  await seed(page);
  const field = page.getByLabel('MiniMax API Key（仅本页内存）', { exact: true });
  await expect(field).toHaveAttribute('type', 'password');
  await expect(page.getByRole('button', { name: 'AI 生成下一集', exact: true })).toBeDisabled();
  await field.fill(key);
  await expect(page.getByRole('button', { name: 'AI 生成下一集', exact: true })).toBeEnabled();
  await page.goto('/#settings');
  await expect(field).toHaveValue(key);
  await page.getByRole('button', { name: '清除 Key', exact: true }).click();
  await expect(field).toHaveValue('');
  await field.fill(key);
  await page.getByRole('button', { name: 'AI 生成下一集', exact: true }).click();
  await expect(page.getByText('模拟模型等待中', { exact: true })).toBeVisible();
  const storage = await dumpWorkspace(page);
  expect(storage).not.toContain(key);
  await page.reload();
  await expect(field).toHaveValue('');
  await expect(page.getByRole('button', { name: '恢复生成任务', exact: true })).toBeEnabled();
  finished = true;
  await page.getByRole('button', { name: '恢复生成任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '新的线索', exact: true, level: 1 })).toBeVisible();
  expect(new Set(ids).size).toBe(1);
  expect(submittedKeys).toEqual([key, undefined]);
  await page.goto('/#settings');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出完整备份' }).click();
  const path = await (await downloading).path();
  expect(await readFile(path!, 'utf8')).not.toContain(key);
  await expect(field).toHaveValue('');
});

test('网页 Key 不跨标签页共享，也不在页面离开和历史恢复后保留', async ({ page, context }) => {
  const key = 'synthetic-navigation-key';
  await context.route('**/api/status', (route) => route.fulfill({
    json: { ...status, configured: false, acceptsUserKey: true },
  }));
  await page.goto('/#settings');
  const field = page.getByLabel('MiniMax API Key（仅本页内存）', { exact: true });
  await field.fill(key);
  const other = await context.newPage();
  await other.goto('/#settings');
  await expect(other.getByLabel('MiniMax API Key（仅本页内存）', { exact: true })).toHaveValue('');
  await page.goto('about:blank');
  await page.goBack();
  await expect(field).toHaveValue('');
  await other.close();
});

test('生成失败在面板内显示具体原因，不再只有泛化的本次未完成', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    if (route.request().url().endsWith('/api/status')) return route.fulfill({ json: status });
    const input = route.request().postDataJSON() as GenerationRequest;
    return route.fulfill({ json: {
      id: input.requestId, status: 'failed', phase: '未完成',
      error: 'AI 内容未通过校验：词表外用词过多（E-OOV-HIGH）。已有进度未改变。',
      failure: { category: 'content', codes: ['E-OOV-HIGH'] },
    } });
  });
  await seed(page);
  await page.getByRole('button', { name: 'AI 生成下一集', exact: true }).click();
  await expect(page.locator('.generation-phase')).toContainText('词表外用词过多');
  await expect(page.getByRole('alert')).toContainText('E-OOV-HIGH');
  await expect(page.getByRole('button', { name: 'AI 生成下一集', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole('button', { name: /查看第 \d 集/ })).toHaveCount(3);
});
