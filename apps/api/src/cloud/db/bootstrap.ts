import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { bootstrapRoles } from './roles.js';

/**
 * 角色引导 CLI（一次性运维步骤）：
 *   ENDLESS_CLOUD_ADMIN_DSN=postgres://管理员 \
 *   ENDLESS_CLOUD_AUTH_PASSWORD=... ENDLESS_CLOUD_APP_PASSWORD=... \
 *   pnpm -C apps/api bootstrap:cloud
 */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dsn = process.env.ENDLESS_CLOUD_ADMIN_DSN;
  const authPassword = process.env.ENDLESS_CLOUD_AUTH_PASSWORD;
  const appPassword = process.env.ENDLESS_CLOUD_APP_PASSWORD;
  if (!dsn || !authPassword || !appPassword) {
    console.error('需要 ENDLESS_CLOUD_ADMIN_DSN / ENDLESS_CLOUD_AUTH_PASSWORD / ENDLESS_CLOUD_APP_PASSWORD');
    process.exitCode = 1;
  } else {
    const client = new pg.Client({ connectionString: dsn });
    try {
      await client.connect();
      await bootstrapRoles(client, { authPassword, appPassword });
      console.log('角色引导完成：endless_auth / endless_app 已就绪（口令不回显）');
    } catch (error) {
      console.error(`角色引导失败：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    } finally {
      await client.end().catch(() => {});
    }
  }
}
