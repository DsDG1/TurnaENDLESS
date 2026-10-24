import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { edition } from '@endless/content';

/**
 * Edition 垂直切片：安装 → 阅读 → 刷新后仍在。
 * 只验证离线可读与真实保存，不做模型调用，也不触碰 ENDLESS 存档。
 */
test('安装样刊、读完一段并在刷新后保留进度', async ({ page }) => {
  await page.goto('/#edition');
  await expect(page.getByRole('heading', { name: /有限专题/ })).toBeVisible();

  const installButton = page.getByRole('button', { name: /安装离线样刊/ });
  if (await installButton.isVisible()) {
    await installButton.click();
  }
  await expect(page.locator('.edition-card')).toBeVisible();
  await expect(page.locator('.edition-unit-list li')).toHaveCount(3);

  await page.getByRole('button', { name: /开始阅读|继续阅读/ }).click();
  await expect(page.locator('.scene-card')).toBeVisible();

  for (let step = 0; step < 4; step++) {
    const next = page.getByRole('button', { name: /读完了，继续|下一题/ });
    if (await next.isEnabled()) {
      await next.click();
    } else {
      const skip = page.getByRole('button', { name: '跳过这一段' });
      if (await skip.isVisible()) await skip.click();
    }
    await page.waitForTimeout(120);
  }

  await page.reload();
  await expect(page.getByRole('button', { name: /继续阅读/ })).toBeVisible();
  await expect(page.locator('.edition-unit-list')).toContainText(/已读|含跳过|进行中/);
  await expect(page.getByRole('heading', { name: /有限专题/ })).toBeVisible();
});

test('已安装期刊断网冷启动后仍可阅读并保存', async ({ page, context }, testInfo) => {
  await page.goto('/#edition');
  await page.getByRole('button', { name: /安装离线样刊/ }).click();
  await expect(page.locator('.edition-card')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
    }
  });
  await context.setOffline(true);
  const cold = await context.newPage();
  await cold.goto('/#edition');
  await expect(cold.locator('.edition-card')).toBeVisible();
  await cold.getByRole('button', { name: '开始阅读', exact: true }).click();
  await expect(cold.locator('.edition-article')).toBeVisible();
  await expect(cold.locator('.edition-source')).not.toBeEmpty();
  expect(await cold.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await cold.screenshot({ path: testInfo.outputPath('edition-offline-reader.png'), fullPage: true });
  await cold.getByRole('button', { name: '读完了，继续', exact: true }).click();
  await expect(cold.locator('.save-status')).toContainText('本地自动保存');
  await cold.reload();
  await expect(cold.locator('.edition-unit-list')).toContainText('进行中');
  await cold.close();
  await context.setOffline(false);
});

test('同一合辑两期可以分别开始阅读，不会总是打开第一期', async ({ page }) => {
  const lexicon = readFileSync(new URL('../../lab/data/lexicon/a1_a2.yaml', import.meta.url), 'utf8');
  const project = edition.createEditionScaleSample(lexicon, { issues: 2, unitsPerIssue: 3 });
  const backup = edition.serializeContainer(edition.buildBackupContainer({
    installs: project.installs.map((install) => install.package), runs: [], reviews: [], cutoff: null,
  }));
  await page.goto('/#edition');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.edition-file input').setInputFiles({
    name: 'two-issues.edition.json', mimeType: 'application/json', buffer: Buffer.from(backup),
  });
  await expect(page.locator('.edition-card')).toHaveCount(2);
  const firstCard = page.locator('.edition-card').filter({
    has: page.getByRole('heading', { name: project.installs[0]!.package.display!.issueTitle, exact: true }),
  });
  const secondCard = page.locator('.edition-card').filter({
    has: page.getByRole('heading', { name: project.installs[1]!.package.display!.issueTitle, exact: true }),
  });
  await secondCard.getByRole('button', { name: '开始阅读', exact: true }).click();
  await expect(page.locator('.watch-title h1')).toHaveText(project.installs[1]!.package.units[0]!.title);
  await page.getByRole('button', { name: '读完了，继续', exact: true }).click();
  await page.getByRole('button', { name: '返回书架', exact: true }).click();
  await firstCard.getByRole('button', { name: '开始阅读', exact: true }).click();
  await expect(page.locator('.watch-title h1')).toHaveText(project.installs[0]!.package.units[0]!.title);
  await page.reload();
  await expect(secondCard).toContainText('进行中');
  await expect(firstCard).not.toContainText('进行中');
});
