import { expect, test } from '@playwright/test';

test('显式云产物包含实际云组合根、仓库和客户端', async ({ request }) => {
  const manifest = await (await request.get('/runtime-modules.json')).json();
  expect(manifest.profile).toBe('cloud');
  for (const module of ['integration.tsx', 'repository.ts', 'client.ts', 'use-player.ts']) {
    expect(manifest.modules).toContain(`apps/web/src/cloud/${module}`);
  }
});
