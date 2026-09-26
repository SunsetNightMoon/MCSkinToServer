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
  /**
   * Redis 连接串（如 redis://127.0.0.1:63799）。
   * 缺省或连接失败时限流/缓存降级为进程内存实现（P5 可选依赖语义）。
   */
  redisUrl?: string;
  /** 认证端点限流参数；缺省见 DEFAULT_RATE_LIMIT。测试构造 AppConfig 时可省略 */
  rateLimit?: Partial<RateLimitSettings>;
  /** 站点公开设置缓存 TTL（毫秒）；缺省见 DEFAULT_SETTINGS_CACHE_TTL_MS */
  settingsCacheTtlMs?: number;
}

/** 认证端点限流参数 */
export interface RateLimitSettings {
  /** 总开关：false 时不做任何限流（排障/压测用） */
  enabled: boolean;
  /** 窗口内最大尝试次数 */
  max: number;
  /** 窗口毫秒数 */
  windowMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitSettings = {
  enabled: true,
  max: 5,
  windowMs: 5 * 60 * 1000,
};

export const DEFAULT_SETTINGS_CACHE_TTL_MS = 30 * 1000;

/** 补齐缺省值；调用方只关心最终生效值 */
export function resolveRateLimit(config: AppConfig): RateLimitSettings {
  const partial = config.rateLimit ?? {};
  return {
    enabled: partial.enabled ?? DEFAULT_RATE_LIMIT.enabled,
    max: partial.max ?? DEFAULT_RATE_LIMIT.max,
    windowMs: partial.windowMs ?? DEFAULT_RATE_LIMIT.windowMs,
  };
}

/** 把可能为字符串/空的环境变量解析为正整数，非法时回落缺省 */
function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
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
    redisUrl: env['REDIS_URL']?.trim() || undefined,
    rateLimit: {
      enabled: env['RATE_LIMIT_DISABLED'] !== 'true',
      max: positiveInt(env['AUTH_RATE_LIMIT_MAX'], DEFAULT_RATE_LIMIT.max),
      windowMs: positiveInt(
        env['AUTH_RATE_LIMIT_WINDOW_MS'],
        DEFAULT_RATE_LIMIT.windowMs,
      ),
    },
    settingsCacheTtlMs: positiveInt(
      env['SETTINGS_CACHE_TTL_MS'],
      DEFAULT_SETTINGS_CACHE_TTL_MS,
    ),
  };
}
