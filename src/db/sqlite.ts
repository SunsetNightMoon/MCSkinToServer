import Database from 'better-sqlite3';
import type { DatabaseConnection } from '../types.js';

/**
 * SQLite 适配层。
 *
 * - 连接时强制 PRAGMA foreign_keys = ON（schema 约定）
 * - better-sqlite3 是同步 API，这里统一包装为异步接口，
 *   与 PostgreSQL 适配层保持同一形状；runner 是顺序执行，不存在并发交错
 */
export class SqliteConnection implements DatabaseConnection {
  readonly dialect = 'sqlite' as const;
  private readonly db: Database.Database;

  constructor(readonly path: string) {
    this.db = new Database(path);
    this.db.pragma('foreign_keys = ON');
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    return (params.length === 0 ? stmt.all() : stmt.all(...params)) as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    const stmt = this.db.prepare(sql);
    if (params.length === 0) {
      stmt.run();
    } else {
      stmt.run(...params);
    }
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    try {
      const result = await fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}
