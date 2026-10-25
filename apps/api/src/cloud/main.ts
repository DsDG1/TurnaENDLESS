import { loadCloudConfig } from './config.js';
import { openCloudRuntime } from './runtime.js';
import { OutboxMailer } from './mail.js';
import { createCloudServer } from './server.js';
import { cloudCapabilities } from './capabilities.js';
import { loadCloudObjectConfig } from './objects/config.js';
import { S3ObjectStorage } from './objects/storage.js';
import { ObjectService } from './objects/service.js';
import { readFile } from 'node:fs/promises';
import { createContent, validateCloudBackup } from '@endless/content';
import { loadCloudImportConfig } from './imports/config.js';
import { ImportService } from './imports/service.js';
import { loadCloudSyncConfig } from './sync/config.js';
import { SyncService } from './sync/service.js';

/**
 * 云 API 组合根（§3.2）。与本机 main.ts 完全分离：
 * 不 import 本机入口、不读本机 jobs.json/edition.sqlite、不挂 capability 密钥。
 * 启动只校验迁移水位；改库由独立受控命令执行。
 */
let runtime: Awaited<ReturnType<typeof openCloudRuntime>> | undefined;
let storage: S3ObjectStorage | undefined;
try {
  const config = loadCloudConfig();
  const objectConfig = loadCloudObjectConfig(process.env, config.env);
  const importConfig = loadCloudImportConfig(process.env, !!objectConfig);
  const content = importConfig ? createContent(await readFile(importConfig.lexiconFile, 'utf8')) : undefined;
  runtime = await openCloudRuntime(config);
  const { auth, app, deployment } = runtime;
  if (objectConfig) storage = new S3ObjectStorage(objectConfig);
  const objects = storage && objectConfig ? new ObjectService(app, storage, deployment, {
    quotaBytes: objectConfig.quotaBytes,
    backupValidator: content ? (raw) => { validateCloudBackup(content, raw); } : undefined,
  }) : undefined;
  const imports = objects && content ? new ImportService(app, objects, content, deployment) : undefined;
  const syncConfig = loadCloudSyncConfig(process.env, !!imports);
  const sync = syncConfig ? new SyncService(app) : undefined;
  const server = createCloudServer({
    auth,
    app,
    pepper: Buffer.from(config.sessionPepper, 'utf8'),
    origins: config.origins,
    hosts: config.hosts,
    mailer: new OutboxMailer(Buffer.from(config.mailKey, 'hex')),
    mailEcho: config.mailEcho,
    capabilities: cloudCapabilities({ objects: !!objects, imports: !!imports, sync: !!sync }),
    deployment,
    objects, imports, sync,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  console.log(`ENDLESS Cloud API: http://${config.host}:${config.port}/api/cloud/v1（环境 ${config.env}；未实现能力在 capabilities 中如实为 false）`);
  const shutdown = () => {
    server.close();
    server.closeAllConnections();
    storage?.close();
    void runtime!.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  storage?.close();
  await runtime?.close();
  console.error('ENDLESS Cloud 启动失败；请检查配置、数据库角色、环境绑定和迁移水位');
  process.exitCode = 1;
}
