import type { CloudConfig } from './config.js';
import { CloudPool } from './db/client.js';
import { assertMigrationLevel } from './db/migrate.js';
import { assertCloudDeployment } from './deployment.js';
import type { Querier } from './db/client.js';

export async function assertCloudRole(q: Querier, expected: 'endless_auth' | 'endless_app'): Promise<void> {
  const result = await q.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  const role = result.rows[0];
  if (!role || role.rolname !== expected || role.rolsuper || role.rolbypassrls) {
    throw new Error('云数据库运行角色不符合最小权限要求');
  }
}

export async function openCloudRuntime(config: CloudConfig) {
  const auth = CloudPool.connect(config.authDsn);
  const app = CloudPool.connect(config.appDsn);
  try {
    await Promise.all([
      assertMigrationLevel(auth, 8), assertMigrationLevel(app, 8),
      assertCloudRole(auth, 'endless_auth'), assertCloudRole(app, 'endless_app'),
    ]);
    const [deployment, business] = await Promise.all([
      assertCloudDeployment(auth, config.env), assertCloudDeployment(app, config.env),
    ]);
    if (deployment.id !== business.id) throw new Error('身份域与业务域必须连接同一环境数据库');
    return { auth, app, deployment, close: () => Promise.all([auth.close(), app.close()]) };
  } catch (error) {
    await Promise.all([auth.close(), app.close()]);
    throw error;
  }
}
