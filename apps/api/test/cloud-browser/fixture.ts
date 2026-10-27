import { createServer } from 'node:https';
import { request } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { validateCloudBackup } from '@endless/content';
import { createCloudServer } from '../../src/cloud/server.js';
import { cloudCapabilities } from '../../src/cloud/capabilities.js';
import { OutboxMailer } from '../../src/cloud/mail.js';
import { MailWorker } from '../../src/cloud/mail-worker.js';
import { ObjectService } from '../../src/cloud/objects/service.js';
import { S3ObjectStorage } from '../../src/cloud/objects/storage.js';
import { ImportService } from '../../src/cloud/imports/service.js';
import { SyncService } from '../../src/cloud/sync/service.js';
import { closeServer, cloudFixture, fakeSmtp, listenLoopback, mailText, TEST_MAIL_KEY, TEST_PEPPER, testCertificate } from '../cloud/fixtures.js';
import { fakeObjectStorage, S3_CREDENTIALS } from '../cloud/object-storage-fixture.js';
import { cloudTestContent as content } from '../../../../packages/content/test/cloud-fixture.js';

const webRoot = fileURLToPath(new URL('../../../web/dist/', import.meta.url));
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

/** Real composition root, PG, SMTP/TLS and signed object protocol, serving the production browser bundle. */
export async function browserFixture() {
  await stat(resolve(webRoot, 'index.html')).catch(() => { throw new Error('Production web assets missing: run pnpm -C apps/api test:cloud:browser'); });
  // Hold one built version for the whole journey, even if another workspace runner rebuilds dist.
  const assets = new Map<string, Buffer>();
  const loadAssets = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await loadAssets(path);
      else if (entry.isFile()) assets.set('/' + relative(webRoot, path).split(sep).join('/'), await readFile(path));
    }
  };
  await loadAssets(webRoot);
  const outRoot = fileURLToPath(new URL('../../../../out/', import.meta.url));
  await mkdir(outRoot, { recursive: true });
  const artifacts = await mkdtemp(resolve(outRoot, 'cloud-browser-'));
  const cleanup: (() => unknown | Promise<unknown>)[] = [];
  const close = async () => {
    const failures: unknown[] = [];
    for (const dispose of cleanup.splice(0).reverse()) { try { await dispose(); } catch (cause) { failures.push(cause); } }
    if (failures.length) throw new AggregateError(failures, 'Cloud browser fixture cleanup failed');
  };
  try {
    const db = await cloudFixture(); cleanup.push(() => db.close());
    const smtp = await fakeSmtp(true); cleanup.push(() => smtp.close());
    const s3 = await fakeObjectStorage(); cleanup.push(() => s3.close());
    const storage = new S3ObjectStorage({ endpoint: s3.endpoint, bucket: 'browser-test', region: 'test-1', ...S3_CREDENTIALS });
    cleanup.push(() => storage.close());
    const objects = new ObjectService(db.app, storage, db.deployment, { quotaBytes: 64 * 1024 * 1024, backupValidator: (raw) => { validateCloudBackup(content, raw); } });
    const imports = new ImportService(db.app, objects, content, db.deployment);
    const sync = new SyncService(db.app, async (ctx, id) => (await imports.package(ctx, id)).workspace, content);
    const certificate = await testCertificate();
    let apiPort = 0;
    const gateway = createServer({ key: certificate.private, cert: certificate.cert }, (incoming, outgoing) => {
      if (incoming.url?.startsWith('/api/cloud/v1/')) {
        const upstream = request({ hostname: '127.0.0.1', port: apiPort, path: incoming.url, method: incoming.method, headers: incoming.headers }, (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
        });
        upstream.on('error', () => outgoing.writeHead(502).end()); incoming.pipe(upstream); return;
      }
      void (async () => {
        const pathname = decodeURIComponent(new URL(incoming.url ?? '/', 'https://127.0.0.1').pathname);
        const path = resolve(webRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (!path.startsWith(resolve(webRoot) + sep) || pathname.startsWith('/api/')) { outgoing.writeHead(404).end(); return; }
        try {
          const bytes = assets.get(pathname === '/' ? '/index.html' : pathname);
          if (!bytes) { outgoing.writeHead(404).end(); return; }
          outgoing.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
          outgoing.end(bytes);
        } catch { outgoing.writeHead(404).end(); }
      })().catch(() => outgoing.writeHead(400).end());
    });
    const origin = `https://127.0.0.1:${await listenLoopback(gateway)}`;
    cleanup.push(() => closeServer(gateway));
    const api = createCloudServer({ auth: db.auth, app: db.app, pepper: TEST_PEPPER, mailer: new OutboxMailer(TEST_MAIL_KEY),
      origins: [origin], hosts: ['127.0.0.1'], deployment: db.deployment, objects, imports, sync,
      capabilities: cloudCapabilities({ objects: true, imports: true, sync: true }) });
    apiPort = await listenLoopback(api);
    cleanup.push(() => closeServer(api));
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL });
    cleanup.push(() => browser.close());
    return { db, browser, origin, artifacts,
      async device(mobile = false) {
        const context = await browser.newContext({ ignoreHTTPSErrors: true,
          viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
        let offline = false;
        // Chromium's worker script loader does not inherit its page's certificate exception.
        // Relay actual production asset responses through this context's TLS exception only.
        // Cloud API responses never enter this adapter; offline misses must still fail.
        await context.route(`${origin}/**`, async (route) => {
          if (new URL(route.request().url()).pathname.startsWith('/api/')) { await route.continue(); return; }
          if (offline) { await route.abort('internetdisconnected'); return; }
          const response = await context.request.fetch(route.request(), { ignoreHTTPSErrors: true, maxRetries: 0 });
          await route.fulfill({ response });
        });
        return { context, async setOffline(value: boolean) { offline = value; await context.setOffline(value); } };
      },
      async deliverCode() {
        const worker = new MailWorker(db.auth, TEST_MAIL_KEY, smtp.transport);
        if (!await worker.runOnce()) throw new Error('No queued synthetic OTP');
        const code = /验证码是 (\d{6})/.exec(mailText(smtp.messages.at(-1)!))?.[1];
        if (!code) throw new Error('Synthetic SMTP did not receive OTP'); return code;
      },
      close,
    };
  } catch (cause) { await close().catch(() => {}); throw cause; }
}
