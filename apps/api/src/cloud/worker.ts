import { readFile } from 'node:fs/promises';
import { loadCloudWorkerConfig } from './config.js';
import { CloudPool } from './db/client.js';
import { assertMigrationLevel } from './db/migrate.js';
import { assertCloudDeployment } from './deployment.js';
import { assertCloudRole } from './runtime.js';
import { SmtpMailTransport } from './smtp.js';
import { MailWorker } from './mail-worker.js';

const abort = new AbortController();
process.on('SIGINT', () => abort.abort());
process.on('SIGTERM', () => abort.abort());
let auth: CloudPool | undefined;
let transport: SmtpMailTransport | undefined;
try {
  const config = loadCloudWorkerConfig();
  auth = CloudPool.connect(config.authDsn);
  await assertMigrationLevel(auth, 2);
  await assertCloudRole(auth, 'endless_auth');
  await assertCloudDeployment(auth, config.env);
  transport = new SmtpMailTransport({
    host: config.smtpHost, port: config.smtpPort, secure: config.smtpMode === 'tls',
    from: config.smtpFrom, user: config.smtpUser, password: config.smtpPassword,
    ...(config.smtpCaFile ? { ca: await readFile(config.smtpCaFile, 'utf8') } : {}),
  });
  const worker = new MailWorker(auth, Buffer.from(config.mailKey, 'hex'), transport);
  console.log(`ENDLESS Cloud Worker ready (${config.env}; mail only)`);
  if (process.argv.includes('--once')) await worker.runOnce();
  else await worker.run(abort.signal);
} catch {
  console.error('ENDLESS Cloud Worker 启动或运行失败；请检查环境、数据库、迁移及 SMTP 配置');
  process.exitCode = 1;
} finally {
  transport?.close();
  await auth?.close();
}
