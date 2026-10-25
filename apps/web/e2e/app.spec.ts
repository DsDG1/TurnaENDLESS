import { expect, test } from '@playwright/test';

test('频道界面、窄屏布局和安装清单可用', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '故事频道。' })).toBeVisible();
  await expect(page.getByRole('button', { name: /播放第 \d 集/ })).toHaveCount(3);
  if (testInfo.project.name === 'mobile') {
    const action = await page.getByRole('button', { name: '进入故事', exact: true }).boundingBox();
    const navigation = await page.locator('.mobile-nav').boundingBox();
    expect(action!.y + action!.height).toBeLessThanOrEqual(navigation!.y);
  }
  await page.screenshot({ path: testInfo.outputPath('home.png'), fullPage: true });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width}px 没有横向溢出`).toBe(true);
    if (width <= 680) {
      const copy = await page.locator('.hero-copy').boundingBox();
      const art = await page.locator('.hero-illustration').boundingBox();
      expect(copy!.y + copy!.height).toBeLessThanOrEqual(art!.y + 1);
    }
  }
  const response = await page.request.get('/manifest.webmanifest');
  const manifest = await response.json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.some((icon: { sizes: string }) => icon.sizes === '192x192')).toBe(true);
  expect(manifest.icons.some((icon: { sizes: string }) => icon.sizes === '512x512')).toBe(true);
  expect(errors).toEqual([]);
});

test('真实作答、提示、恢复和回看不会重复刷记录', async ({ page }, testInfo) => {
  await page.goto('/#watch');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '2. Where was your hat last night?', exact: true }).click();
  await expect(page.getByText('回答正确。', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '2. Where was your hat last night?', exact: true })).toBeDisabled();
  await expect(page.getByText('首次独立作答已记入学习记录，复习时间由 FSRS 安排。')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('chat.png'), fullPage: true });
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '需要一点提示？' }).click();
  await page.reload();
  await expect(page.getByText(/看过提示后，这一题会记为练习/)).toBeVisible();
  await page.getByRole('button', { name: '3. under', exact: true }).click();
  await expect(page.getByText('这次是练习，不推进间隔复习记录。')).toBeVisible();
  await page.getByRole('button', { name: '看完这一集' }).click();
  await expect(page.getByRole('heading', { name: '这一段已读完。' })).toBeVisible();
  await page.getByRole('button', { name: '回看本集' }).click();
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '继续回看' }).click();
  await page.goto('/#progress');
  await expect(page.locator('.stat').filter({ hasText: '计入复习的题' }).locator('strong')).toHaveText('1');
  await expect(page.locator('.stat').filter({ hasText: '答题次数' }).locator('strong')).toHaveText('2');
  await expect(page.getByText('你问起了那顶失踪帽子的去向。')).toBeVisible();
});

test('跳过不伪造学习记录，偏好在刷新后保留', async ({ page }) => {
  await page.goto('/#watch');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByRole('button', { name: '继续', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '先跳过' }).click();
  await page.getByRole('button', { name: '先跳过' }).click();
  await expect(page.getByRole('heading', { name: '这一段已读完。' })).toBeVisible();
  await page.goto('/#progress');
  await expect(page.locator('.stat').filter({ hasText: '答题次数' }).locator('strong')).toHaveText('0');
  await page.goto('/#settings');
  await page.getByRole('switch', { name: '更大的文字' }).click();
  await page.reload();
  await expect(page.getByRole('switch', { name: '更大的文字' })).toBeChecked();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出完整备份' }).click();
  expect((await downloaded).suggestedFilename()).toMatch(/^endless-workspace-.*\.endless\.json$/);
  await page.getByRole('button', { name: '安装说明', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '关闭安装说明' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('缓存就绪后断网刷新，仍可播放并保存答题', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: '故事频道。' })).toBeVisible();
  await expect(page.getByText('正在离线体验')).toBeVisible();
  await page.getByRole('button', { name: '进入故事', exact: true }).click();
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '2. Where was your hat last night?', exact: true }).click();
  await page.reload();
  await expect(page.getByText('回答正确。', { exact: true })).toBeVisible();
  await context.setOffline(false);
});

test('损坏存档不会被静默重置或覆盖', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '故事频道。' })).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      // 版本与 WorkspaceRepository 同步（v2 增加 outbox/eventIds/sync）
      const request = indexedDB.open('endless-workspace', 2);
      request.onupgradeneeded = () => {
        for (const name of ['meta', 'revisions', 'branches', 'objects', 'staging', 'outbox', 'eventIds', 'sync']) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve) => {
      const transaction = db.transaction('meta', 'readwrite');
      transaction.objectStore('meta').put({ key: 'workspace', version: 42, important: 'keep-me' }, 'workspace');
      transaction.oncomplete = () => resolve();
    });
    db.close();
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: '先等一下，存档还没准备好。' })).toBeVisible();
  await expect(page.getByRole('button', { name: '下载原始存档' })).toBeVisible();
  expect(await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('endless-workspace', 2);
      request.onsuccess = () => resolve(request.result);
    });
    return new Promise((resolve) => {
      const request = db.transaction('meta', 'readonly').objectStore('meta').get('workspace');
      request.onsuccess = () => { db.close(); resolve(request.result); };
    });
  })).toEqual({ key: 'workspace', version: 42, important: 'keep-me' });
});

test('两个窗口不能互相覆盖进度', async ({ page, context }) => {
  await page.goto('/#watch');
  await expect(page.getByText('每个小谜题都从一句话开始。')).toBeVisible();
  const other = await context.newPage();
  await other.goto('/#watch');
  await expect(other.getByText('每个小谜题都从一句话开始。')).toBeVisible();
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await other.getByRole('button', { name: '继续', exact: true }).click();
  await expect(other.getByRole('alert')).toContainText('另一个窗口已更新进度');
  await other.reload();
  await expect(other.getByRole('button', { name: '2. Where was your hat last night?', exact: true })).toBeVisible();
  await other.close();
});

test('只阅读遇到的新表达也会进入足迹，跳过和未读内容不计入', async ({ page }) => {
  await page.goto('/#progress');
  await expect(page.locator('[data-learning-item]')).toHaveCount(0);
  await page.goto('/#watch');
  await expect(page.getByRole('complementary', { name: '故事里的表达' })).toContainText('behind');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.goto('/#progress');
  const note = page.locator('[data-learning-item="lx:behind#prep.location"]');
  await expect(note).toContainText('已遇见 · 待练习');
  await expect(note).toContainText('已读 1 个片段 · 0 次互动');
  await expect(page.locator('.stat').filter({ hasText: '计入复习的题' }).locator('strong')).toHaveText('0');
  await expect(page.locator('[data-learning-item="lx:borrow#v.take-temporarily"]')).toHaveCount(0);
  await page.reload();
  await expect(note).toContainText('已遇见 · 待练习');
});
