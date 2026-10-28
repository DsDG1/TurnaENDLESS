import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

/** 集成测试用真实 PostgreSQL（embedded-postgres 自带 PG 18 二进制，非内存模拟）。 */
export interface TestCluster {
  port: number;
  adminDsn: string;
  stop(): Promise<void>;
}

function windowsAdminProbe(): boolean {
  try {
    // `net session` 只在提升后的令牌下成功；不解析本地化文本，只看退出码。
    execFileSync('net', ['session'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows 上 PostgreSQL 拒绝以管理员权限启动（`postgres.exe` 内部检查令牌后直接退出）。
 * 管理员 shell 里直接跑会挂到 vitest 的 120 秒钩子超时，看不出原因；这里提前失败并给出可执行提示。
 * 注入 platform/probe 以便在任意机器上确定性验证两条分支。
 */
export function assertPostgresCanStart(env: { platform?: NodeJS.Platform; probe?: () => boolean } = {}): void {
  const platform = env.platform ?? process.platform;
  if (platform !== 'win32') return;
  if (!(env.probe ?? windowsAdminProbe)()) return;
  throw new Error('当前 Windows 会话以管理员权限运行，PostgreSQL 拒绝以管理员权限启动；请改用非管理员终端执行 `pnpm -C apps/api test:cloud`（非 PG 用例不受影响）');
}

export async function startTestCluster(): Promise<TestCluster> {
  assertPostgresCanStart();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const dir = mkdtempSync(join(tmpdir(), 'endless-cloud-pg-'));
  const cluster = new EmbeddedPostgres({
    databaseDir: dir, user: 'postgres', password: 'postgres',
    port, persistent: false, onLog: () => {}, onError: () => {},
  });
  try {
    await cluster.initialise();
    await cluster.start();
    return { port, adminDsn: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`, stop: () => cluster.stop() };
  } catch (error) {
    await cluster.stop().catch(() => {});
    throw new Error('真实 PostgreSQL 集成测试环境启动失败，不能用跳过代替验收', { cause: error });
  }
}

export async function withClient<T>(dsn: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: dsn });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}
