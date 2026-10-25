import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { join } from 'node:path';
import { assertCloudDeployment, bindCloudDeployment, CloudEnvironmentSchema } from '../deployment.js';

/**
 * 受控迁移执行（§18.1）：独立步骤，不由 Web 实例启动时竞相改表。
 * 用 advisory lock 串行化；已应用版本校验 checksum，漂移即拒绝继续。
 */

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const LOCK_KEY = 0x454e444c; // 'ENDL'

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  const files: MigrationFile[] = [];
  for (const name of names) {
    const sql = await readFile(join(dir, name), 'utf8');
    files.push({
      version: Number.parseInt(name.slice(0, 4), 10),
      name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return files;
}

async function ensureSchemaTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
}

export interface MigrationReport {
  applied: number[];
  alreadyApplied: number[];
  head: number | null;
}

export async function migrate(client: pg.Client, migrations: MigrationFile[]): Promise<MigrationReport> {
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    await ensureSchemaTable(client);
    const applied = await client.query<{ version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version');
    const appliedByVersion = new Map(applied.rows.map((row) => [row.version, row]));
    for (const row of applied.rows) {
      const file = migrations.find((m) => m.version === row.version);
      if (!file) throw new Error(`已应用迁移 ${row.name} 缺失，拒绝继续`);
      if (file && file.checksum !== row.checksum) {
        throw new Error(`迁移 ${row.name} 的 checksum 漂移（库内 ${row.checksum.slice(0, 12)}… != 文件 ${file.checksum.slice(0, 12)}…），拒绝继续；不要原地改写已应用迁移`);
      }
    }
    const done: number[] = [];
    for (const file of migrations) {
      if (appliedByVersion.has(file.version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [file.version, file.name, file.checksum]);
        await client.query('COMMIT');
        done.push(file.version);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    }
    const head = await client.query<{ max: number | null }>('SELECT max(version) AS max FROM schema_migrations');
    return { applied: done, alreadyApplied: applied.rows.map((row) => row.version), head: head.rows[0]?.max ?? null };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  }
}

/** 服务启动校验：要求迁移水位达到指定版本，不做任何写操作。 */
export async function assertMigrationLevel(querier: { query<R extends pg.QueryResultRow>(text: string, params?: readonly unknown[]): Promise<pg.QueryResult<R>> }, required: number): Promise<void> {
  const result = await querier.query<{ max: number | null }>('SELECT max(version) AS max FROM schema_migrations');
  const head = result.rows[0]?.max ?? null;
  if (head === null || head < required) {
    throw new Error(`云数据库迁移水位不足（当前 ${head ?? '无'}，要求 ${required}）；请先运行受控迁移，服务不会在启动时改库`);
  }
}

// ---------- CLI ----------
// pnpm -C apps/api migrate:cloud —— ENDLESS_CLOUD_MIGRATION_DSN 为迁移角色 DSN。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dsn = process.env.ENDLESS_CLOUD_MIGRATION_DSN;
  if (!dsn) {
    console.error('缺少 ENDLESS_CLOUD_MIGRATION_DSN（迁移角色连接串）');
    process.exitCode = 1;
  } else {
    const client = new pg.Client({ connectionString: dsn });
    try {
      const environment = CloudEnvironmentSchema.parse(process.env.ENDLESS_CLOUD_ENV);
      await client.connect();
      const existing = await client.query<{ present: boolean }>("SELECT to_regclass('public.cloud_deployment') IS NOT NULL AS present");
      if (existing.rows[0]?.present) await assertCloudDeployment(client, environment);
      const migrations = await loadMigrations();
      const report = await migrate(client, migrations);
      await bindCloudDeployment(client, environment);
      console.log(`迁移完成：新应用 ${report.applied.length} 个（${report.applied.join(', ') || '无'}），水位 ${report.head}`);
    } catch (error) {
      console.error(`迁移失败：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    } finally {
      await client.end().catch(() => {});
    }
  }
}
