import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createOfflineServer } from '../src/offline-server.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('keeps offline reading available when the API cannot start, without relaxing origin checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'endless-offline-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<title>Offline reader</title>');
  const server = createOfflineServer(root);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  const url = `http://127.0.0.1:${port}`;
  expect(await (await fetch(url)).text()).toContain('Offline reader');
  const unavailable = await fetch(`${url}/api/status`);
  expect(unavailable.status).toBe(503);
  expect(unavailable.headers.get('cache-control')).toBe('no-store');
  expect((await fetch(url, { headers: { Origin: 'https://foreign.example' } })).status).toBe(403);
  expect((await fetch(url, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
});
