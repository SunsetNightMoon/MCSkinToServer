import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Dialect } from './types.js';
import { resolveBcryptCost } from './auth/password.js';
import { readSetupRecord, validateSetupRecord } from './setup/setupState.js';

/**
 * 安装模式（P5 第十二批）：
 * - `installed`  正常模式：setup.json 存在，连库、迁移、全部端点可用
 * - `auto`       存量环境：无 setup.json 但库已有数据/已配 env，启动后自动补写记录
 * - `installing` 安装模式：全新部署，不连库不迁移，只开 /api/setup/* 与 /health
 */
export type InstallMode = 'installed' | 'auto' | 'installing';

/**
 * 启动时读取一次的配置对象（蓝图 §5.1：运行时不改 .env）。
 * 当前覆盖迁移 runner 与本地存储所需的最小集合，后续 P0 任务再扩展。
 */
export interface AppConfig {
  dialect: Dialect;
  /**
   * 启动分流（P5 第十二批）：由 setup.json / env / 库文件现状三者决定。
   * 可选：测试里手工构造的 AppConfig 不填 = 'installed'（存量行为不变）。
   */
  installMode?: InstallMode;
  /** SQLite 数据库文件路径 */
  sqlitePath: string;
  /** PostgreSQL 连接串 */
  databaseUrl?: string;
  /** 迁移文件根目录（其下按方言分 postgresql/ 与 sqlite/） */
  migrationsRoot: string;
  /** 本地存储根目录（StoragePort 的 local provider 使用） */
  uploadDir: string;
  /**
   * 插件子系统开关与目录，来自 `MCSTS_PLUGINS` / `MCSTS_PLUGIN_DIR`。
   *
   * **默认关闭**：这套接口有做废的可能，默认关就等价于「不存在」—— 不扫盘、不挂
   * /api/plugins、面板不显示入口。目录默认在 `data/` 下（`data/` 已在 .gitignore 里），
   * 所以插件本体天然不进版本库。
   */
  plugins?: { enabled: boolean; dir: string };
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
   * 密码哈希强度（bcrypt cost），来自环境变量 `BCRYPT_COST`。
   *
   * 缺省 10（OWASP 下限），钳制到 10-14；注册 / 改密 / 安装向导三条写入路径共用这一个值。
   * 调高后存量哈希会在用户下次登录成功时自动重算（rehash-on-login），不必强制改密码。
   * 见 `src/auth/password.ts` 的权衡说明（纯 JS 实现，cost +1 ≈ 耗时翻倍）。
   */
  bcryptCost?: number;
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
   * Yggdrasil `POST /api/profiles/minecraft`（批量角色名 → UUID）专用限流参数；
   * 缺省见 DEFAULT_PROFILE_LOOKUP_RATE_LIMIT。
   *
   * 单独一套的原因：它是**匿名可用**的协议端点，不限流就等于允许无限速遍历全站
   * 角色名与 UUID。但阈值必须宽松 —— 真客户端进服时也会打它，按 IP 计还要考虑
   * 宿舍/机房共用出口地址。所以按 IP、60 次/分钟，只压爬虫不挡玩家。
   */
  profileLookupRateLimit?: Partial<RateLimitSettings>;
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
  /**
   * 管理后台趋势图按哪个时区切「一天」，单位分钟（缺省见
   * DEFAULT_STATS_TZ_OFFSET_MINUTES = 480 即 UTC+8）。
   *
   * 必须可配：时间戳一律以 UTC 存储，直接按 UTC 日期分桶会把北京时间
   * 00:00–08:00 的活动算到前一天。整机容器常跑在 UTC，不能靠进程 TZ。
   */
  statsTzOffsetMinutes?: number;
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
 * `POST /api/profiles/minecraft` 的缺省限流：**按来源地址**，60 次/分钟。
 *
 * 取值理由：这个端点匿名可用（角色名 → UUID，单次最多 10 名），不限流就等于允许
 * 无限速遍历全站角色名与 UUID。但阈值不能照抄认证端点 —— 真客户端进服时也会打它，
 * 而且宿舍/机房共用出口地址下多人同时进服会落在同一个键上。60 次/分钟 ≈ 每小时
 * 3600 次 × 10 名 = 每小时 3.6 万个名字的解析量，正常玩家与服务器都碰不到顶，
 * 而脚本爬库会被压到可用带宽的一个零头。
 */
export const DEFAULT_PROFILE_LOOKUP_RATE_LIMIT: RateLimitSettings = {
  enabled: true,
  max: 60,
  windowMs: 60 * 1000,
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

/**
 * 管理后台趋势图「一天」的分界时区偏移，单位分钟。
 *
 * 默认 +480（UTC+8）。理由：时间戳一律以 UTC 存储，而「某天」是给人看的。
 * 按 UTC 日期分桶会让北京时间 00:00–08:00 的活动落到**前一天** ——
 * 管理员晚上提交的东西第二天早上看，会显示在前天的柱子上。
 *
 * 取值范围 -720..840（UTC-12 至 UTC+14）；越界值回落默认。
 */
export const DEFAULT_STATS_TZ_OFFSET_MINUTES = 480;

/** 时区偏移的合法范围（分钟），对应 UTC-12 .. UTC+14 */
const MIN_TZ_OFFSET_MINUTES = -720;
const MAX_TZ_OFFSET_MINUTES = 840;

/**
 * 把时区偏移裁剪到合法范围。
 *
 * 越界不报错而是裁剪：这个值只影响趋势图横轴的日期归属，为一个可配项
 * 让服务起不来不值当。裁剪后仍在合法区，图表最多是日期略偏，不会崩。
 */
function clampTzOffset(minutes: number): number {
  if (minutes < MIN_TZ_OFFSET_MINUTES) return MIN_TZ_OFFSET_MINUTES;
  if (minutes > MAX_TZ_OFFSET_MINUTES) return MAX_TZ_OFFSET_MINUTES;
  return minutes;
}

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
 * 批量角色名查询端点的最终限流值。
 *
 * 与 refresh 同样的规矩：**总开关是 `RATE_LIMIT_DISABLED`**（即 `rateLimit.enabled`），
 * 排障时关一处就该全关。
 */
export function resolveProfileLookupRateLimit(config: AppConfig): RateLimitSettings {
  const master = resolveRateLimit(config);
  const partial = config.profileLookupRateLimit ?? {};
  return {
    enabled:
      master.enabled &&
      (partial.enabled ?? DEFAULT_PROFILE_LOOKUP_RATE_LIMIT.enabled),
    max: partial.max ?? DEFAULT_PROFILE_LOOKUP_RATE_LIMIT.max,
    windowMs: partial.windowMs ?? DEFAULT_PROFILE_LOOKUP_RATE_LIMIT.windowMs,
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

/**
 * 把环境变量解析为**带符号**整数。
 *
 * 单独的辅助函数是必需的：时区偏移的合法值是 -720..840，**0 和负数都合法**，
 * 用 `positiveInt` 会让 `STATS_TZ_OFFSET_MINUTES=0`（UTC）与 `-300`（UTC-5）
 * 被静默换成 +480 —— 图表日期整体偏移一天，且没有任何提示。
 */
function signedInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

export class ConfigError extends Error {}

/** 迁移文件目录名：方言名与目录名不同（postgres → postgresql） */
export function dialectDirName(dialect: Dialect): string {
  return dialect === 'postgres' ? 'postgresql' : 'sqlite';
}

/**
 * Redis 连接串解析：env 显式值优先；否则从 setup.json 的安装选择派生。
 * 向导里选了 Redis 就必须真生效 —— 装完不再靠运维手填 REDIS_URL。
 * 两者都没有 = undefined（限流/缓存降级进程内存，正常行为）。
 */
function envRedisUrl(
  env: NodeJS.ProcessEnv,
  setup: ReturnType<typeof readSetupRecord>,
): string | undefined {
  const explicit = env['REDIS_URL']?.trim();
  if (explicit !== undefined && explicit !== '') return explicit;
  const rec = setup?.redis;
  if (rec && rec.enabled) {
    const auth = rec.password ? `${encodeURIComponent(rec.password)}@` : '';
    return `redis://${auth}${rec.host}:${rec.port}`;
  }
  return undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // ---- 安装分流（P5 第十二批）----
  // setup.json 存在 → 库类型以记录为准（选定后不可更改）；
  // 不存在 → 看现状：env 显式指定了库（存量环境）→ 按 env，启动后自动补写记录；
  // sqlite 文件已存在且有数据 → 存量环境；否则 → 安装模式（不连库，等服务端渲染向导）。
  const setup = readSetupRecord();
  let dialect: Dialect;
  let sqlitePath: string;
  let databaseUrl: string | undefined;
  let installMode: InstallMode;

  if (setup) {
    const invalid = validateSetupRecord(setup);
    if (invalid) throw new ConfigError(`setup.json 无效：${invalid}`);
    if (setup.db.type === 'postgresql') {
      dialect = 'postgres';
      const pg = setup.db.pg!;
      // 环境变量 DATABASE_URL 仍可覆盖连接串（运维临时换连接方式），
      // 但**数据库类型**由 setup.json 锁死，env 改 DB_TYPE 无效。
      const envUrl = env['DATABASE_URL']?.trim();
      databaseUrl =
        envUrl !== undefined && envUrl !== ''
          ? envUrl
          : `postgres://${encodeURIComponent(pg.user)}:${encodeURIComponent(
              pg.password,
            )}@${pg.host}:${pg.port}/${pg.database}`;
    } else {
      dialect = 'sqlite';
    }
    installMode = 'installed';
  } else if (env['DB_TYPE'] === 'postgres') {
    // 存量环境：安装前就配了 DB_TYPE=postgres 的部署，不打回重装
    dialect = 'postgres';
    databaseUrl = env['DATABASE_URL'];
    if (!databaseUrl) {
      throw new ConfigError('DB_TYPE=postgres 需要提供 DATABASE_URL');
    }
    installMode = 'auto';
  } else {
    dialect = 'sqlite';
    installMode = 'installing';
  }

  sqlitePath = env['SQLITE_PATH'] ?? './data/mcsts.db';
  if (installMode === 'installing' && dialect === 'sqlite') {
    // 文件已存在且有内容 = 存量环境（auto）：连接后照常迁移（幂等），启动后补写 setup.json
    const file = resolve(sqlitePath);
    const stat = existsSync(file) ? statSync(file) : null;
    if (stat && stat.size > 0) installMode = 'auto';
  }

  return {
    dialect,
    sqlitePath,
    databaseUrl,
    installMode,
    migrationsRoot: resolve(env['MIGRATIONS_DIR'] ?? './schema'),
    uploadDir: resolve(env['UPLOAD_DIR'] ?? './data/uploads'),
    plugins: {
      enabled: env['MCSTS_PLUGINS'] === '1' || env['MCSTS_PLUGINS'] === 'true',
      dir: resolve(env['MCSTS_PLUGIN_DIR'] ?? './data/plugins'),
    },
    publicBaseUrl: env['PUBLIC_BASE_URL'] ?? 'http://localhost:3000/uploads',
    rsaPrivateKeyPath: resolve(
      env['RSA_PRIVATE_KEY_PATH'] ?? './data/keys/yggdrasil.pem',
    ),
    skinDomains: (env['YGGDRASIL_SKIN_DOMAINS'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    redisUrl: envRedisUrl(env, setup),
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
    profileLookupRateLimit: {
      // enabled 由总开关决定（见 resolveProfileLookupRateLimit），这里不单独读
      max: positiveInt(
        env['PROFILE_LOOKUP_RATE_LIMIT_MAX'],
        DEFAULT_PROFILE_LOOKUP_RATE_LIMIT.max,
      ),
      windowMs: positiveInt(
        env['PROFILE_LOOKUP_RATE_LIMIT_WINDOW_MS'],
        DEFAULT_PROFILE_LOOKUP_RATE_LIMIT.windowMs,
      ),
    },
    // 越界与脏值由 resolveBcryptCost 钳制/回落并打警告，不在这里抛错
    bcryptCost: resolveBcryptCost(env['BCRYPT_COST']),
    settingsCacheTtlMs: positiveInt(
      env['SETTINGS_CACHE_TTL_MS'],
      DEFAULT_SETTINGS_CACHE_TTL_MS,
    ),
    statsTzOffsetMinutes: clampTzOffset(
      signedInt(env['STATS_TZ_OFFSET_MINUTES'], DEFAULT_STATS_TZ_OFFSET_MINUTES),
    ),
  };
}
