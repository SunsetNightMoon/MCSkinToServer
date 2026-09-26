import { resolve } from 'node:path';
import type { Dialect } from './types.js';

/**
 * 启动时读取一次的配置对象（蓝图 §5.1：运行时不改 .env）。
 * 当前覆盖迁移 runner 与本地存储所需的最小集合，后续 P0 任务再扩展。
 */
export interface AppConfig {
  dialect: Dialect;
  /** SQLite 数据库文件路径 */
  sqlitePath: string;
  /** PostgreSQL 连接串 */
  databaseUrl?: string;
  /** 迁移文件根目录（其下按方言分 postgresql/ 与 sqlite/） */
  migrationsRoot: string;
  /** 本地存储根目录（StoragePort 的 local provider 使用） */
  uploadDir: string;
  /** 对外公开 URL 前缀（含静态挂载点，如 https://skin.example/uploads） */
  publicBaseUrl: string;
  /** Yggdrasil RSA 私钥路径；不存在时启动自动生成 */
  rsaPrivateKeyPath: string;
  /** Yggdrasil skinDomains（逗号分隔）；缺省用 publicBaseUrl 的 hostname */
  skinDomains: string[];
}

export class ConfigError extends Error {}

/** 迁移文件目录名：方言名与目录名不同（postgres → postgresql） */
export function dialectDirName(dialect: Dialect): string {
  return dialect === 'postgres' ? 'postgresql' : 'sqlite';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dialect: Dialect =
    env['DB_TYPE'] === 'postgres' ? 'postgres' : 'sqlite';

  const databaseUrl = env['DATABASE_URL'];
  if (dialect === 'postgres' && !databaseUrl) {
    throw new ConfigError('DB_TYPE=postgres 需要提供 DATABASE_URL');
  }

  return {
    dialect,
    sqlitePath: env['SQLITE_PATH'] ?? './data/mscts.db',
    databaseUrl,
    migrationsRoot: resolve(env['MIGRATIONS_DIR'] ?? './schema'),
    uploadDir: resolve(env['UPLOAD_DIR'] ?? './data/uploads'),
    publicBaseUrl: env['PUBLIC_BASE_URL'] ?? 'http://localhost:3000/uploads',
    rsaPrivateKeyPath: resolve(
      env['RSA_PRIVATE_KEY_PATH'] ?? './data/keys/yggdrasil.pem',
    ),
    skinDomains: (env['YGGDRASIL_SKIN_DOMAINS'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };
}
