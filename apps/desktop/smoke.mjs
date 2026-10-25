import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, access, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect } from '@playwright/test';

const root = fileURLToPath(new URL('.', import.meta.url));
const packaged = process.argv.includes('--packaged');
const executablePath = packaged
  ? JSON.parse(await readFile(new URL('../../out/desktop/latest.json', import.meta.url), 'utf8')).executable
  : createRequire(import.meta.url)('electron');
await access(executablePath);
const data = await mkdtemp(join(tmpdir(), 'endless-desktop-smoke-'));
const env = { ...process.env, ENDLESS_DESKTOP_TEST_DATA: data, ENDLESS_API_KEY: '' };
delete env.ELECTRON_RUN_AS_NODE;
let application;
let launches = 0;

async function launch() {
  console.log(`Desktop smoke: launch ${++launches}`);
  application = await electron.launch({
    executablePath, args: packaged ? [] : [join(root, 'dist', 'main.cjs')], cwd: data, env, timeout: 45_000,
  });
  const diagnostic = setTimeout(() => {
    void application.evaluate(({ app, BrowserWindow }) => ({
      windows: BrowserWindow.getAllWindows().map((window) => ({
        url: window.webContents.getURL(), loading: window.webContents.isLoading(),
      })),
      processes: app.getAppMetrics().map((process) => ({ type: process.type, name: process.name })),
    })).then((state) => console.log('Desktop startup diagnostics:', JSON.stringify(state)))
      .catch(() => console.log('Desktop startup diagnostics unavailable.'));
    void fetch('http://127.0.0.1:4175/api/status', { signal: AbortSignal.timeout(2000) })
      .then((response) => console.log('Desktop startup API status:', response.status))
      .catch(() => console.log('Desktop startup API did not respond.'));
  }, 12_000);
  let page;
  try {
    page = await application.firstWindow({ timeout: 45_000 });
  } finally {
    clearTimeout(diagnostic);
  }
  await expect(page.locator('.page-heading h1')).toBeVisible();
  return page;
}

async function close() {
  await application.close();
  application = undefined;
  await assert.rejects(fetch('http://127.0.0.1:4175/api/status', { signal: AbortSignal.timeout(1500) }));
}

try {
  let page = await launch();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  assert.deepEqual(await page.evaluate(() => ({
    node: typeof window.require, process: typeof window.process,
  })), { node: 'undefined', process: 'undefined' });
  const preferences = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  const status = await (await page.request.get('http://127.0.0.1:4175/api/status')).json();
  assert.equal(status.configured, false);
  assert.equal(status.acceptsUserKey, true);
  assert.equal((await page.request.get('http://127.0.0.1:4175/api/status', {
    headers: { Origin: 'https://foreign.example' },
  })).status(), 403);
  assert.equal((await page.request.post('http://127.0.0.1:4175/api/generations', {
    headers: { Origin: 'http://127.0.0.1:4175', 'X-Endless-Token': 'wrong' }, data: {},
  })).status(), 403);
  const duplicate = spawn(executablePath, packaged ? [] : [join(root, 'dist', 'main.cjs')], { cwd: data, env, stdio: 'ignore' });
  const duplicateExit = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      duplicate.kill();
      reject(new Error('The second instance did not exit.'));
    }, 15_000);
    duplicate.on('error', reject);
    duplicate.on('exit', (code) => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(duplicateExit, 0);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  const syntheticKey = 'synthetic-desktop-page-key';
  await page.getByRole('textbox', { name: 'MiniMax API Key（仅本页内存）' }).fill(syntheticKey);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'MiniMax API Key（仅本页内存）' })).toHaveValue('');
  await page.goto('http://127.0.0.1:4175/#settings');
  await page.getByRole('switch', { name: '更大的文字' }).click();
  await expect(page.getByRole('switch', { name: '更大的文字' })).toBeChecked();
  const backupPath = join(data, 'test-backup.endless.json');
  await application.evaluate(({ session }, path) => {
    globalThis.endlessTestDownload = new Promise((resolve) => {
      const timeout = setTimeout(() => resolve('timeout'), 15_000);
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(path);
        item.once('done', (_event, state) => { clearTimeout(timeout); resolve(state); });
      });
    });
  }, backupPath);
  await page.getByRole('button', { name: '导出完整备份' }).click();
  assert.equal(await application.evaluate(() => globalThis.endlessTestDownload), 'completed');
  const backup = await readFile(backupPath, 'utf8');
  assert.ok(backup.includes('endless-workspace'));
  assert.ok(!backup.includes(syntheticKey));
  await page.goto('http://127.0.0.1:4175/#watch');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByRole('button', { name: '2. Where was your hat last night?', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((resolve) =>
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: '2. Where was your hat last night?', exact: true })).toBeVisible();
  await page.context().setOffline(false);
  assert.deepEqual(errors, []);
  await close();
  page = await launch();
  await page.goto('http://127.0.0.1:4175/#settings');
  await expect(page.getByRole('switch', { name: '更大的文字' })).toBeChecked();
  await page.goto('http://127.0.0.1:4175/#watch');
  await expect(page.getByRole('button', { name: '2. Where was your hat last night?', exact: true })).toBeVisible();
  await close();
  await access(join(data, 'api', 'edition.sqlite'));
  const corrupt = '{"unsupported-test-fixture":';
  await writeFile(join(data, 'api', 'jobs.json'), corrupt);
  page = await launch();
  assert.equal((await page.request.get('http://127.0.0.1:4175/api/status')).status(), 503);
  await page.goto('http://127.0.0.1:4175/#watch');
  await expect(page.getByRole('button', { name: '2. Where was your hat last night?', exact: true })).toBeVisible();
  await close();
  assert.equal(await readFile(join(data, 'api', 'jobs.json'), 'utf8'), corrupt);
  console.log(`Desktop smoke passed (${packaged ? 'packaged exe' : 'development runtime'}): startup, single instance, sandbox, API security, transient key, backup export, offline reading, restart persistence, degraded API, shutdown.`);
} finally {
  if (application) await application.close();
  await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
