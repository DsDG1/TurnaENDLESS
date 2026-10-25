import { loadCloudConfig } from './config.js';
import { CloudPool } from './db/client.js';
import { assertMigrationLevel } from './db/migrate.js';
import { OutboxMailer } from './mail.js';
import { createCloudServer } from './server.js';
import { cloudCapabilities } from './capabilities.js';

/**
 * 云 API 组合根（§3.2）。与本机 main.ts 完全分离：
 * 不 import 本机入口、不读本机 jobs.json/edition.sqlite、不挂 capability 密钥。
 * 启动只校验迁移水位；改库由独立受控命令执行。
 */
const REQUIRED_MIGRATION = 1;

try {
  const config = loadCloudConfig();
  const auth = CloudPool.connect(config.authDsn);
  const app = CloudPool.connect(config.appDsn);
  await assertMigrationLevel(auth, REQUIRED_MIGRATION);
  const server = createCloudServer({
    auth,
    app,
    pepper: Buffer.from(config.sessionPepper, 'utf8'),
    origins: config.origins,
    hosts: config.hosts,
    mailer: new OutboxMailer(),
    mailEcho: config.mailEcho,
    capabilities: cloudCapabilities(),
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  console.log(`ENDLESS Cloud API: http://${config.host}:${config.port}/api/cloud/v1（环境 ${config.env}；未实现能力在 capabilities 中如实为 false）`);
  const shutdown = () => {
    server.close();
    server.closeAllConnections();
    void Promise.all([auth.close(), app.close()]).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  console.error(`ENDLESS Cloud 启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
