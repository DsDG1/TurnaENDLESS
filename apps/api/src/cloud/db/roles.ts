import pg from 'pg';

/**
 * 角色引导（§5.4）：身份域与业务域分离，API 使用非 owner、非 BYPASSRLS 角色。
 * 由管理员/运维用受控入口执行一次；口令经环境注入，不写进 SQL 文件或日志。
 */

function literal(value: string): string {
  if (value.includes('\0')) throw new Error('口令包含非法字符');
  return `'${value.replace(/'/g, "''")}'`;
}

export function roleBootstrapSql(options: { authPassword: string; appPassword: string }): string {
  return `
CREATE ROLE endless_auth LOGIN PASSWORD ${literal(options.authPassword)};
CREATE ROLE endless_app LOGIN PASSWORD ${literal(options.appPassword)};
`.trim() + `
GRANT USAGE ON SCHEMA public TO endless_auth, endless_app;
`;
}

export async function bootstrapRoles(client: pg.Client, options: { authPassword: string; appPassword: string }): Promise<void> {
  try {
    await client.query(roleBootstrapSql(options));
  } catch (error) {
    const code = (error as { code?: string }).code;
    // 42710 = duplicate_object：角色已存在时改为更新口令（幂等引导）。
    if (code !== '42710') throw error;
    await client.query(`ALTER ROLE endless_auth LOGIN PASSWORD ${literal(options.authPassword)}`);
    await client.query(`ALTER ROLE endless_app LOGIN PASSWORD ${literal(options.appPassword)}`);
  }
}
