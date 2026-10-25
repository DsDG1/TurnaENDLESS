import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createStaticHandler } from '../src/static.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start() {
  const root = await mkdtemp(join(tmpdir(), 'endless-desktop-static-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><title>ENDLESS</title>');
  await writeFile(join(root, 'web', 'app.js'), 'export const value = 1;');
  await writeFile(join(root, 'private.json'), '{"private":true}');
  const handle = createStaticHandler(join(root, 'web'));
  const server = createServer((request, response) => {
    void handle(request, response).then(() => response.end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

it('serves only bundled web files, with no-store and browser security headers', async () => {
  const url = await start();
  const page = await fetch(url);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('<title>ENDLESS</title>');
  expect(page.headers.get('cache-control')).toBe('no-store');
  expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'");
  const script = await fetch(`${url}/app.js`);
  expect(script.headers.get('content-type')).toContain('javascript');
  expect(await script.text()).toContain('export const value');
  expect((await fetch(`${url}/app.js`, { method: 'HEAD' })).status).toBe(200);
  expect((await fetch(`${url}/missing.js`)).status).toBe(404);
  expect((await fetch(`${url}/api/status`)).status).toBe(404);
  expect((await fetch(url, { method: 'POST' })).status).toBe(405);
});

it('rejects encoded traversal, Windows separators, malformed URLs and directory requests', async () => {
  const url = await start();
  for (const path of ['/%2e%2e/private.json', '/..%5cprivate.json', '/%00', '/%zz', '/C:%5cWindows', '//private.json']) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const call = request(url, { path }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      call.on('error', reject);
      call.end();
    });
    expect(status, path).toBe(400);
  }
});
