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

export async function startTestCluster(): Promise<TestCluster | null> {
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
    console.warn('embedded-postgres 不可用，跳过真实数据库集成测试：', error instanceof Error ? error.message : error);
    await cluster.stop().catch(() => {});
    return null;
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
