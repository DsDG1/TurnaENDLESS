import { generate } from 'selfsigned';
import { SMTPServer } from 'smtp-server';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { CloudPool } from '../../src/cloud/db/client.js';
import { bootstrapRoles } from '../../src/cloud/db/roles.js';
import { loadMigrations, migrate } from '../../src/cloud/db/migrate.js';
import { bindCloudDeployment } from '../../src/cloud/deployment.js';
import { startTestCluster, withClient } from './embedded-pg.js';
import { SmtpMailTransport } from '../../src/cloud/smtp.js';
import type { Server } from 'node:http';

export const TEST_MAIL_KEY = Buffer.alloc(32, 7);
export const TEST_PEPPER = Buffer.alloc(32, 8);

export async function cloudFixture() {
  const cluster = await startTestCluster();
  try {
    const deployment = await withClient(cluster.adminDsn, async (q) => {
      await bootstrapRoles(q, { authPassword: 'synthetic-auth', appPassword: 'synthetic-app' });
      await migrate(q, await loadMigrations());
      return bindCloudDeployment(q, 'test');
    });
    const authDsn = `postgres://endless_auth:synthetic-auth@127.0.0.1:${cluster.port}/postgres`;
    const appDsn = `postgres://endless_app:synthetic-app@127.0.0.1:${cluster.port}/postgres`;
    const auth = CloudPool.connect(authDsn);
    const app = CloudPool.connect(appDsn);
    return {
      cluster, auth, app, authDsn, appDsn, deployment,
      async close() {
        await Promise.all([auth.close(), app.close()]);
        await cluster.stop();
      },
    };
  } catch (error) {
    await cluster.stop();
    throw error;
  }
}

export function testCertificate() {
  return generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048, algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 24 * 60 * 60_000),
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] },
    ],
  });
}

export async function fakeSmtp(secure: boolean, trusted = true) {
  const certificate = await testCertificate();
  const messages: string[] = [];
  let tlsConnections = 0;
  const server = new SMTPServer({
    secure, key: certificate.private, cert: certificate.cert,
    logger: false, disableReverseLookup: true,
    onAuth(auth, session, callback) {
      if (!session.secure || auth.username !== 'synthetic' || auth.password !== 'synthetic-smtp') {
        callback(new Error('synthetic auth rejected'));
        return;
      }
      tlsConnections++;
      callback(null, { user: 'synthetic' });
    },
    onData(stream, _session, callback) {
      let message = '';
      stream.on('data', (chunk: Buffer) => { message += chunk.toString('utf8'); });
      stream.on('end', () => { messages.push(message); callback(); });
    },
  });
  server.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const { port } = server.server.address() as { port: number };
  const config = {
    host: 'localhost', port, secure, from: 'endless@example.test',
    user: 'synthetic', password: 'synthetic-smtp', ...(trusted ? { ca: certificate.cert } : {}),
  };
  const transport = new SmtpMailTransport(config);
  return {
    port, certificate, messages, transport,
    get tlsConnections() { return tlsConnections; },
    close: () => {
      transport.close();
      return new Promise<void>((resolve) => server.close(resolve));
    },
  };
}

export async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return (server.address() as { port: number }).port;
}

export async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export function runCloudProcess(entry: 'main' | 'worker', env: NodeJS.ProcessEnv, args: string[] = []) {
  const path = fileURLToPath(new URL(`../../src/cloud/${entry}.ts`, import.meta.url));
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    const child = spawn(process.execPath, ['--import', loader, path, ...args], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, ...env },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output }));
  });
}

export function mailText(raw: string): string {
  const split = raw.indexOf('\r\n\r\n');
  const headers = raw.slice(0, split);
  const body = raw.slice(split + 4);
  if (/content-transfer-encoding:\s*base64/i.test(headers)) return Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8');
  if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
    return Buffer.from(body.replace(/=\r\n/g, '').replace(/=([0-9a-f]{2})/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))), 'latin1').toString('utf8');
  }
  return body;
}
