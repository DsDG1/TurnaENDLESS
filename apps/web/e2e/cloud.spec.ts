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
