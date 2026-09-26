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
  /**
   * **素材**对外前缀（含静态挂载点，如 https://skin.example/uploads）。
   *
   * 注意这里不是「站点根」：站点根由后台设置 `BASE_URL` 决定，见 site/siteUrl.ts。
   * 本字段只作为站点根不可用时的兜底，以及素材前缀的部署形态来源。
   */
  publicBaseUrl: string;
  /** Yggdrasil RSA 私钥路径；不存在时启动自动生成 */
  rsaPrivateKeyPath: string;
  /**
   * Yggdrasil skinDomains（逗号分隔），来自环境变量 YGGDRASIL_SKIN_DOMAINS。
   *
   * **留空是正常状态**：空数组表示「未显式配置」，此时由 SiteUrlResolver
   * 取站点根的 hostname 派生（buildMetadataDto 也有兜底）。
   * 改动前的注释写成「缺省用 publicBaseUrl 的 hostname」，但实现只做了 split，
   * 派生逻辑其实在元数据构建处 —— 注释与实现不符，已在此更正。
   */
  skinDomains: string[];
  /**
   * Redis 连接串（如 redis://127.0.0.1:63799）。
   * 缺省或连接失败时限流/缓存降级为进程内存实现（P5 可选依赖语义）。
   */
  redisUrl?: string;
  /** 认证端点限流参数；缺省见 DEFAULT_RATE_LIMIT。测试构造 AppConfig 时可省略 */
  rateLimit?: Partial<RateLimitSettings>;
  /**
   * Yggdrasil `POST /refresh` 专用限流参数；缺省见 DEFAULT_REFRESH_RATE_LIMIT。
   *
   * 单独一套的原因：refresh 是**启动器的后台定期行为**，不是登录尝试。
   * 用认证端点的 5 次/5 分钟会让长时间挂机的启动器被误伤（表现为「挂机一阵
   * 后突然掉线」），所以它按 IP 计、且上限更宽松。
   */
  refreshRateLimit?: Partial<RateLimitSettings>;
  /**
   * 验证码出题端点（`GET /api/captcha/generate`）专用限流参数；
   * 缺省见 DEFAULT_CAPTCHA_GENERATE_RATE_LIMIT。
   *
   * 单独一套的原因：它复用认证端点的 5 次/5 分钟时**实测被正常用户打满** ——
   * 页面挂载取一题、答错点「换一道」、React 严格模式还会重复挂载一次，
   * 几步就到顶；而耗尽后的表现是题干空白、用户完全无法注册。且它按 IP 计，
   * 共用出口地址（宿舍/机房 NAT）下多人会互相误伤。
   */
  captchaGenerateRateLimit?: Partial<RateLimitSettings>;
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

/**
 * `POST /refresh` 的缺省限流：**按来源地址**、比认证端点宽松。
 *
 * 取值理由：启动器在 accessToken 临近过期时自动刷新。单个账号正常使用远达不到
 * 30 次/5 分钟；而一个共用出口地址（宿舍/机房 NAT）下十几台机器同时刷新时，
 * 5 次/5 分钟会立刻误伤。这里的目标是压掉「脚本式高频刷新」，不是限制正常用户。
 */
export const DEFAULT_REFRESH_RATE_LIMIT: RateLimitSettings = {
  enabled: true,
  max: 30,
  windowMs: 5 * 60 * 1000,
};

/**
 * 验证码出题端点的缺省限流：**按来源地址**，10 次/5 分钟。
 *
 * 取值理由分两层：
 *
 * 1. **它需要一套自己的参数，不能复用认证端点的 5 次/5 分钟。** 实测正常用户
 *    就能打满：进入注册页取一题、答错点「换一道」、React 严格模式下挂载被调用
 *    两次 …… 而打满之后的症状是**题干空白且没有任何提示**，用户根本无从判断，
 *    连注册都做不了。
 * 2. **上限放到 10 而不是像 refresh 那样 30。** 这里要挡的是「脚本一次性领走
 *    大量题目、把答案全存下来慢慢用」。真正的批量闸门其实是按 IP 的**注册**与
 *    **登录**限流（每个账号还得配一个自己算对的答案），出题端点只是收紧预生成
 *    的速度；10 次足够真人正常流程，也让共用出口地址下的多人不至于立刻互相误伤。
 */
export const DEFAULT_CAPTCHA_GENERATE_RATE_LIMIT: RateLimitSettings = {
  enabled: true,
  max: 10,
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

/**
 * refresh 专用限流的最终值。
 *
 * **总开关仍然是 `RATE_LIMIT_DISABLED`**（即 `rateLimit.enabled`）：排障/压测时
 * 关一处就该全关，不能出现「关掉了限流但 refresh 还在挡」这种情况。
 */
export function resolveRefreshRateLimit(config: AppConfig): RateLimitSettings {
  const master = resolveRateLimit(config);
  const partial = config.refreshRateLimit ?? {};
  return {
    enabled: master.enabled && (partial.enabled ?? DEFAULT_REFRESH_RATE_LIMIT.enabled),
    max: partial.max ?? DEFAULT_REFRESH_RATE_LIMIT.max,
    windowMs: partial.windowMs ?? DEFAULT_REFRESH_RATE_LIMIT.windowMs,
  };
}

/**
 * 验证码出题端点的最终限流值。
 *
 * 与 refresh 同样的规矩：**总开关仍然是 `RATE_LIMIT_DISABLED`**（即 `rateLimit.enabled`）。
 * 排障时关一处就该全关，不能出现「关掉了限流但验证码还在挡」。
 */
export function resolveCaptchaGenerateRateLimit(config: AppConfig): RateLimitSettings {
  const master = resolveRateLimit(config);
  const partial = config.captchaGenerateRateLimit ?? {};
  return {
    enabled:
      master.enabled && (partial.enabled ?? DEFAULT_CAPTCHA_GENERATE_RATE_LIMIT.enabled),
    max: partial.max ?? DEFAULT_CAPTCHA_GENERATE_RATE_LIMIT.max,
    windowMs: partial.windowMs ?? DEFAULT_CAPTCHA_GENERATE_RATE_LIMIT.windowMs,
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
    refreshRateLimit: {
      // enabled 由总开关决定（见 resolveRefreshRateLimit），这里不单独读
      max: positiveInt(
        env['REFRESH_RATE_LIMIT_MAX'],
        DEFAULT_REFRESH_RATE_LIMIT.max,
      ),
      windowMs: positiveInt(
        env['REFRESH_RATE_LIMIT_WINDOW_MS'],
        DEFAULT_REFRESH_RATE_LIMIT.windowMs,
      ),
    },
    captchaGenerateRateLimit: {
      // enabled 由总开关决定（见 resolveCaptchaGenerateRateLimit），这里不单独读
      max: positiveInt(
        env['CAPTCHA_GENERATE_RATE_LIMIT_MAX'],
        DEFAULT_CAPTCHA_GENERATE_RATE_LIMIT.max,
      ),
      windowMs: positiveInt(
        env['CAPTCHA_GENERATE_RATE_LIMIT_WINDOW_MS'],
        DEFAULT_CAPTCHA_GENERATE_RATE_LIMIT.windowMs,
      ),
    },
    settingsCacheTtlMs: positiveInt(
      env['SETTINGS_CACHE_TTL_MS'],
      DEFAULT_SETTINGS_CACHE_TTL_MS,
    ),
  };
}
