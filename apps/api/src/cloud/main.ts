import { loadCloudConfig } from './config.js';
import { openCloudRuntime } from './runtime.js';
import { OutboxMailer } from './mail.js';
import { createCloudServer } from './server.js';
import { cloudCapabilities } from './capabilities.js';

/**
 * 云 API 组合根（§3.2）。与本机 main.ts 完全分离：
 * 不 import 本机入口、不读本机 jobs.json/edition.sqlite、不挂 capability 密钥。
 * 启动只校验迁移水位；改库由独立受控命令执行。
 */
let runtime: Awaited<ReturnType<typeof openCloudRuntime>> | undefined;
try {
  const config = loadCloudConfig();
  runtime = await openCloudRuntime(config);
  const { auth, app, deployment } = runtime;
  const server = createCloudServer({
    auth,
    app,
    pepper: Buffer.from(config.sessionPepper, 'utf8'),
    origins: config.origins,
    hosts: config.hosts,
    mailer: new OutboxMailer(Buffer.from(config.mailKey, 'hex')),
    mailEcho: config.mailEcho,
    capabilities: cloudCapabilities(),
    deployment,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  console.log(`ENDLESS Cloud API: http://${config.host}:${config.port}/api/cloud/v1（环境 ${config.env}；未实现能力在 capabilities 中如实为 false）`);
  const shutdown = () => {
    server.close();
    server.closeAllConnections();
    void runtime!.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  await runtime?.close();
  console.error('ENDLESS Cloud 启动失败；请检查配置、数据库角色、环境绑定和迁移水位');
  process.exitCode = 1;
}
