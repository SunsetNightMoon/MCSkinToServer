import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AppConfig } from '../config.js';
import type { DatabaseConnection } from '../types.js';
import { PostgresConnection } from './postgres.js';
import { SqliteConnection } from './sqlite.js';

/** 按配置创建数据库连接（SQLite 时自动确保父目录存在） */
export async function createDatabase(config: AppConfig): Promise<DatabaseConnection> {
  if (config.dialect === 'postgres') {
    return PostgresConnection.connect(config.databaseUrl!);
  }
  const sqlitePath = resolve(config.sqlitePath);
  mkdirSync(dirname(sqlitePath), { recursive: true });
  return new SqliteConnection(sqlitePath);
}
