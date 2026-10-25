import pg from 'pg';

/**
 * 数据库访问层（计划 §5.4）。
 *
 * - 连接池只暴露两类入口：租户事务与系统事务；裸 pool.query 不允许，
 *   保证业务查询永远携带 tenant 上下文。
 * - 租户上下文用 `set_config('endless.tenant_id', ..., true)`（事务本地），
 *   连接归还连接池后身份不会残留。
 * - 纯序列化/死锁失败做有界重试并沿用原业务键；调用方传入的 fn
 *   只能是数据库工作，绝不能包网络调用（重试不得二次触发外部副作用）。
 */

export interface Querier {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: readonly unknown[]): Promise<pg.QueryResult<R>>;
}

const RETRYABLE_SQLSTATE = new Set(['40001', '40P01']);
const MAX_TX_ATTEMPTS = 3;

export class CloudPool {
  private constructor(private readonly pool: pg.Pool) {}

  static connect(dsn: string, options: { max?: number } = {}): CloudPool {
    const pool = new pg.Pool({
      connectionString: dsn,
      max: options.max ?? 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // 不在启动时静默改库；连接只执行显式语句。
      allowExitOnIdle: true,
    });
    return new CloudPool(pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** 事务内执行；死锁/序列化失败有界重试（沿用原业务键，纯 DB 工作）。 */
  private async inTx<T>(fn: (q: Querier) => Promise<T>, before?: (q: Querier) => Promise<void>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_TX_ATTEMPTS; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        if (before) await before(client);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        lastError = error;
        const state = (error as { code?: string }).code;
        if (!state || !RETRYABLE_SQLSTATE.has(state) || attempt + 1 >= MAX_TX_ATTEMPTS) throw error;
      } finally {
        client.release();
      }
    }
    throw lastError;
  }

  /** 租户事务：事务本地设置 endless.tenant_id，RLS 据此隔离。 */
  withTenant<T>(accountId: string, fn: (q: Querier) => Promise<T>): Promise<T> {
    return this.inTx(fn, async (q) => {
      await q.query('SELECT set_config($1, $2, true)', ['endless.tenant_id', accountId]);
    });
  }

  /** 系统事务：身份域/预认证/运维路径；不设置租户上下文。 */
  withSystem<T>(fn: (q: Querier) => Promise<T>): Promise<T> {
    return this.inTx(fn);
  }

  /** 单语句只读/写路径（会话解析、迁移版本检查等）；业务查询不得使用。 */
  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: readonly unknown[] = []): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(text, params as unknown[]);
  }
}
