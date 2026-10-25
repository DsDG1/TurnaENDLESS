import { expect, test } from '@playwright/test';

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
