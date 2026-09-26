/**
 * 数据库连接抽象。
 *
 * 设计约束（docs/schema-design.md §1.1/§1.4）：
 * - 时间一律由应用层写入 UTC ISO 字符串，禁止依赖数据库时间函数
 * - 迁移文件的事务边界由 runner 拥有，适配层只提供 transaction 原语
 */

export type Dialect = 'sqlite' | 'postgres';

/** 迁移版本表中的一条记录 */
export interface MigrationRecord {
  version: string;
  checksum: string;
}

/** 适配层必须实现的统一连接接口 */
export interface DatabaseConnection {
  readonly dialect: Dialect;

  /** 执行任意 SQL（可含多条语句、无参数；用于 DDL / 迁移脚本） */
  exec(sql: string): Promise<void>;

  /** 执行带参数的单条查询，返回行数组 */
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;

  /** 执行不返回数据集的单条语句（INSERT/UPDATE/DELETE 等） */
  run(sql: string, params?: unknown[]): Promise<void>;

  /** 在单个事务内执行 fn；fn 抛错则回滚并重新抛出 */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  close(): Promise<void>;
}
