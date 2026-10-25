import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { startApplication } from '../src/application.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function options() {
  const root = await mkdtemp(join(tmpdir(), 'endless-api-application-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const modelsPath = join(root, 'models.yaml');
  await writeFile(modelsPath, JSON.stringify({
    provider: { name: 'synthetic', base_url: 'https://provider.invalid/v1', api_key_env: 'ENDLESS_APPLICATION_TEST_KEY_NOT_SET' },
    models: { fast: 'test-model', premium: 'test-model' },
  }));
  return {
    modelsPath,
    lexiconPath: fileURLToPath(new URL('../../lab/data/lexicon/a1_a2.yaml', import.meta.url)),
    dataDirectory: join(root, 'api'),
    port: 0,
    origins: ['http://127.0.0.1:4175'],
    handlePage: async (_request: unknown, response: import('node:http').ServerResponse) => { response.end('test reader'); },
  };
}

it('starts from explicit assets and data paths and shares desktop origins with Edition', async () => {
  const application = await startApplication(await options());
  cleanups.push(application.close);
  const { port } = application.server.address() as { port: number };
  const url = `http://127.0.0.1:${port}`;
  expect(await (await fetch(url)).text()).toBe('test reader');
  expect((await fetch(url, { headers: { Origin: 'https://foreign.example' } })).status).toBe(403);
  const status = await (await fetch(`${url}/api/status`)).json() as { token: string };
  const headers = { Origin: 'http://127.0.0.1:4175', 'X-Endless-Token': status.token };
  expect((await fetch(`${url}/api/edition-status`, { headers })).status).toBe(200);
  expect((await fetch(`${url}/api/edition-status`, { headers: { ...headers, Origin: 'http://127.0.0.1:4173' } })).status).toBe(403);
  expect((await fetch(`${url}/api/unknown`)).status).toBe(403);
});

it('preserves unreadable job records and releases resources after a failed startup', async () => {
  const config = await options();
  await mkdir(config.dataDirectory);
  const jobs = join(config.dataDirectory, 'jobs.json');
  const original = '{"unsupported":';
  await writeFile(jobs, original);
  await expect(startApplication(config)).rejects.toThrow();
  expect(await readFile(jobs, 'utf8')).toBe(original);
  await writeFile(jobs, '{"version":1,"jobs":[]}');
  const application = await startApplication(config);
  cleanups.push(application.close);
});

it('reports an occupied port instead of falling back to a different origin', async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
  const { port } = occupied.address() as { port: number };
  await expect(startApplication({ ...await options(), port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
});
