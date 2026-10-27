import { expect, test } from '@playwright/test';

test('本机产物不含云运行模块，云深链不会打开云库或发云请求', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/cloud/')) requests.push(request.url()); });
  await page.goto('/#home');
  await expect(page.getByRole('heading', { name: '故事频道。' })).toBeVisible();
  await expect(page.getByRole('link', { name: '云端副本', exact: true })).toHaveCount(0);
  const manifest = await (await page.request.get('/runtime-modules.json')).json();
  expect(manifest.profile).toBe('local');
  expect(manifest.modules.some((id: string) => /\/src\/cloud\/|\/cloud-contracts\/|\/content\/src\/cloud/.test(id))).toBe(false);
  const namespace = 'endless-cloud:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:00000000-0000-4000-8000-000000000003';
  await page.evaluate(async namespace => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(namespace, 2);
      request.onupgradeneeded = () => request.result.createObjectStore('preserved');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('preserved', 'readwrite');
      tx.objectStore('preserved').put({ format: 'unknown-future/1', outbox: ['retain-me'] }, 'original');
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    db.close();
    const original = indexedDB.open.bind(indexedDB);
    (window as any).openedDatabases = [];
    indexedDB.open = (...args: Parameters<IDBFactory['open']>) => {
      (window as any).openedDatabases.push(args[0]);
      return original(...args);
    };
  }, namespace);
  await page.goto('/#cloud-read/' + namespace.split(':').slice(1).join('/'));
  await expect(page.getByRole('heading', { name: '此版本提供本机阅读' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).openedDatabases.filter((name: string) => name.startsWith('endless-cloud:')))).toEqual([]);
  const retained = await page.evaluate(async namespace => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open(namespace, 2); request.onsuccess = () => resolve(request.result); });
    const value = await new Promise(resolve => { const request = db.transaction('preserved', 'readonly').objectStore('preserved').get('original'); request.onsuccess = () => resolve(request.result); });
    db.close(); return value;
  }, namespace);
  expect(retained).toEqual({ format: 'unknown-future/1', outbox: ['retain-me'] });
  await page.getByRole('link', { name: '返回故事频道' }).click();
  await expect(page.getByRole('heading', { name: '故事频道。' })).toBeVisible();
  expect(requests).toEqual([]);
});
