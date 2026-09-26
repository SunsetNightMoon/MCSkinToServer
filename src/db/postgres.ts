import pg from 'pg';
import type { DatabaseConnection } from '../types.js';

/**
 * PostgreSQL 适配层。
 *
 * 事务实现要点：transaction 期间将 txClient 绑定到实例上，
 * exec/query 在事务内路由到同一个 client —— 否则会走到连接池的其他连接，
 * 导致迁移 SQL 与版本记录不在同一事务里（plan3 的教训之一：隐式连接语义）。
 */
export class PostgresConnection implements DatabaseConnection {
  readonly dialect = 'postgres' as const;
  private readonly pool: pg.Pool;
  private txClient: pg.PoolClient | null = null;

  private constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  static connect(databaseUrl: string): PostgresConnection {
    return new PostgresConnection(new pg.Pool({ connectionString: databaseUrl }));
  }

  private async withClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    if (this.txClient) return fn(this.txClient);
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async exec(sql: string): Promise<void> {
    await this.withClient((client) => client.query(sql));
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.withClient((client) =>
      client.query(sql, params as never[]),
    );
    return result.rows as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.withClient((client) => client.query(sql, params as never[]));
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.txClient) {
      throw new Error('PostgresConnection 不支持嵌套事务');
    }
    const client = await this.pool.connect();
    this.txClient = client;
    try {
      await client.query('BEGIN');
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      this.txClient = null;
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
