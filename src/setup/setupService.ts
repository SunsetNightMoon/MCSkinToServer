import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createTransport } from 'nodemailer';
import { createClient } from 'redis';
import bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { ConfigError } from '../config.js';
import type { AppConfig } from '../config.js';
import type { DatabaseConnection } from '../types.js';
import { AppError } from '../errors.js';
import { createDatabase } from '../db/index.js';
import { runMigrations } from '../migrate/runner.js';
import { dialectDirName } from '../config.js';
import {
  isSetupCompleted,
  writeSetupRecord,
  type SetupDbType,
  type SetupRecord,
} from './setupState.js';
import { SettingRepository } from '../repositories/settingRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { ProfileRepository } from '../repositories/profileRepository.js';
import type { SecretBox } from '../util/secretBox.js';

/** bcrypt cost —— 与 src/auth/identity.ts 的 BCRYPT_COST 保持一致（10） */
const BCRYPT_COST = 10;

const SUPPORTED_LANGUAGES = new Set(['SCH', 'TCH', 'EN', 'JP']);

/**
 * 安装向导后端（P5 第十二批）。
 *
 * 三个探测端点（test-db / test-email / test-redis）都是「装前体检」：
 * **不依赖已安装状态**（那时数据库可能还不存在），参数全部来自请求体。
 *
 * `completeSetup` 是唯一写入口：现场按所选类型连接目标库 → 跑该方言的
 * 迁移 → 建超管（含默认角色）→ 把 SMTP/站名/默认语言写进 system_settings
 * → 最后落 setup.json。最后一步是关键顺序：**库就绪、账号可用之后再落标记**，
 * 中途失败可以重跑（complete 幂等：已落标记的再调 → 410）。
 *
 * **数据库类型选定后不可更改**：没有第二个写入口，管理面板也不暴露切换。
 */

export interface SetupProbeDeps {
  /** SQLite 探测用的数据目录（与运行时 SQLITE_PATH 同目录，取 dirname） */
  dataDir: string;
  /** 目标 SQLite 文件路径（探测写测试文件用） */
  sqlitePath: string;
}

export interface CompleteSetupInput {
  siteName: string;
  dbType: SetupDbType;
  dbHost?: string;
  dbPort?: number;
  dbName?: string;
  dbUser?: string;
  dbPassword?: string;
  redisEnabled?: boolean;
  redisHost?: string;
  redisPort?: number;
  redisPassword?: string;
  mailHost?: string;
  mailPort?: number;
  mailUser?: string;
  mailPass?: string;
  mailFrom?: string;
  defaultLanguage?: string;
  adminUsername: string;
  adminEmail: string;
  adminPassword: string;
}

export interface CompleteSetupResult {
  dbType: SetupDbType;
  adminUserId: string;
  adminUserUid: number;
}

export function assertSetupOpen(): void {
  if (isSetupCompleted()) {
    throw new AppError('FORBIDDEN', '安装已完成，无法重复执行安装向导');
  }
}

/** POST /api/setup/test-db 的入参 */
export interface TestDbInput {
  dbType: string;
  dbHost?: string;
  dbPort?: number | string;
  dbName?: string;
  dbUser?: string;
  dbPassword?: string;
}

/**
 * 探测数据库可达性。返回 ok + 人类可读消息（前端直接展示）。
 * 探测失败不是 5xx：对前端而言「连不上」是有效的探测结果，不是服务端故障。
 */
export async function testDatabase(
  input: TestDbInput,
  deps: SetupProbeDeps,
): Promise<{ ok: boolean; message: string }> {
  if (input.dbType === 'sqlite') {
    try {
      const target = resolve(deps.sqlitePath);
      mkdirSync(dirname(target), { recursive: true });
      // 写一个临时文件验证目录可写（SQLite 建库就是往这个目录写文件）
      const probe = join(dirname(target), `.setup-probe-${Date.now()}`);
      writeFileSync(probe, 'ok');
      rmSync(probe);
      return { ok: true, message: 'SQLite 数据目录可写，可以安装' };
    } catch (err) {
      return {
        ok: false,
        message: `SQLite 数据目录不可写：${err instanceof Error ? err.message : err}`,
      };
    }
  }

  if (input.dbType === 'postgresql') {
    if (!input.dbHost || !input.dbName || !input.dbUser) {
      return { ok: false, message: 'PostgreSQL 信息不完整（需要主机 / 库名 / 用户）' };
    }
    // 空密码不传 password 字段：让 pg 走无认证（trust/local），而不是带空串去
    // SCRAM 协商。生产环境密码非空时行为不变。
    const probePoolConfig: Record<string, unknown> = {
      host: input.dbHost,
      port: Number(input.dbPort || 5432),
      database: input.dbName,
      user: input.dbUser,
      connectionTimeoutMillis: 5000,
      max: 1,
    };
    if (input.dbPassword) probePoolConfig['password'] = input.dbPassword;
    const pool = new Pool(probePoolConfig);
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      return { ok: true, message: 'PostgreSQL 连接成功' };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      let message = `PostgreSQL 连接失败：${e.message ?? '未知错误'}`;
      if (e.code === 'ECONNREFUSED') {
        message = 'PostgreSQL 连接被拒绝：主机或端口不对，或服务未启动';
      } else if (e.code === '28P01') {
        message = 'PostgreSQL 认证失败：用户或密码不正确';
      } else if (e.code === '3D000') {
        message = '数据库不存在：请先创建目标数据库再安装';
      }
      return { ok: false, message };
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  return { ok: false, message: '不支持的数据库类型：仅支持 SQLite 与 PostgreSQL（不支持 MySQL）' };
}

/** POST /api/setup/test-email：真实建连 + verify（不发送） */
export async function testSmtp(input: {
  mailHost: string;
  mailPort?: number | string;
  mailUser?: string;
  mailPass?: string;
  mailFrom?: string;
}): Promise<{ ok: boolean; message: string }> {
  if (!input.mailHost) {
    return { ok: false, message: '请填写 SMTP 主机' };
  }
  const port = Number(input.mailPort || 465);
  const transporter = createTransport({
    host: input.mailHost,
    port,
    secure: port === 465,
    auth: input.mailUser
      ? { user: input.mailUser, pass: input.mailPass ?? '' }
      : undefined,
  });
  try {
    await transporter.verify();
    return { ok: true, message: 'SMTP 连接成功' };
  } catch (err) {
    return {
      ok: false,
      message: `SMTP 连接失败：${err instanceof Error ? err.message : err}`,
    };
  } finally {
    void transporter.close();
  }
}

/** POST /api/setup/test-redis：PING 一次即断 */
export async function testRedis(input: {
  redisHost: string;
  redisPort?: number | string;
  redisPassword?: string;
}): Promise<{ ok: boolean; message: string }> {
  if (!input.redisHost) {
    return { ok: false, message: '请填写 Redis 主机' };
  }
  const url = `redis://${input.redisPassword ? `${encodeURIComponent(input.redisPassword)}@` : ''}${input.redisHost}:${Number(input.redisPort || 6379)}`;
  const client = createClient({ url, socket: { connectTimeout: 5000, reconnectStrategy: false } });
  try {
    await client.connect();
    await client.ping();
    return { ok: true, message: 'Redis 连接成功' };
  } catch (err) {
    return {
      ok: false,
      message: `Redis 连接失败：${err instanceof Error ? err.message : err}`,
    };
  } finally {
    await client.quit().catch(() => client.disconnect().catch(() => undefined));
  }
}

export interface CompleteSetupDeps {
  config: AppConfig;
  /** SMTP_PASS 加密（未注入主密钥时按明文落库，与管理端 settings 同语义） */
  secretBox?: SecretBox;
}

/**
 * 完成安装：连库 → 迁移 → 建超管 → 写设置 → 落 setup.json。
 *
 * 仓储在这一刻对**临时连接**现场构造：安装模式下运行时根本没有数据库连接
 * （main.ts 不连库），等安装完成、进程重启后才会有运行时连接。
 *
 * 建超管不走 IdentityService.register：那条路径要 token/限流/全局模式读取，
 * 安装期都不存在；这里直接建用户 + 默认角色（与 register 的字段语义一致，
 * 角色名取管理员用户名，role 提权为 super_admin）。
 */
export async function completeSetup(
  input: CompleteSetupInput,
  deps: CompleteSetupDeps,
): Promise<CompleteSetupResult> {
  assertSetupOpen();

  const adminEmail = String(input.adminEmail ?? '').trim().toLowerCase();
  const adminUsername = String(input.adminUsername ?? '').trim();
  const adminPassword = String(input.adminPassword ?? '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    throw new AppError('VALIDATION_ERROR', '管理员邮箱格式不正确');
  }
  if (!adminUsername || adminUsername.length < 2 || adminUsername.length > 32) {
    throw new AppError('VALIDATION_ERROR', '管理员用户名须为 2-32 个字符');
  }
  if (adminPassword.length < 8 || adminPassword.length > 128) {
    throw new AppError('VALIDATION_ERROR', '管理员密码须为 8-128 位');
  }
  const language = input.defaultLanguage && SUPPORTED_LANGUAGES.has(input.defaultLanguage)
    ? input.defaultLanguage
    : 'SCH';

  // ---- 1. 现场连目标库（探测过一遍，这里失败说明探测后环境变了）----
  const targetConfig: AppConfig =
    input.dbType === 'postgresql'
      ? {
          ...deps.config,
          dialect: 'postgres',
          databaseUrl: buildPgUrl(input),
        }
      : deps.config;

  const db: DatabaseConnection = await createDatabase(targetConfig).catch((err) => {
    throw new AppError(
      'VALIDATION_ERROR',
      `数据库连接失败：${err instanceof Error ? err.message : err}`,
    );
  });

  // 提升到 try 外：finally 后的 return 要引用它们
  const userId = randomUUID();
  let adminUserUid = 0;

  try {
    // ---- 2. 跑该方言的迁移（全新库 = 全量应用）----
    await runMigrations(db, join(deps.config.migrationsRoot, dialectDirName(db.dialect))).catch(
      (err) => {
        throw new AppError(
          'VALIDATION_ERROR',
          `数据库初始化失败：${err instanceof Error ? err.message : err}`,
        );
      },
    );

    // ---- 2.5 对临时连接现场构造仓储（安装模式下运行时无连接，只能在此自给自足）----
    const repos = {
      settings: new SettingRepository(db),
      users: new UserRepository(db),
      profiles: new ProfileRepository(db),
    };

    const now = new Date();

    // ---- 3. 建超管 + 默认角色（同一事务：要么都有要么都没有）----
    const passwordHash = await bcrypt.hash(adminPassword, BCRYPT_COST);
    const profileName = adminUsername.slice(0, 16);
    const profileId = randomUUID();

    await db.transaction(async () => {
      adminUserUid = await repos.users.insert({
        id: userId,
        email: adminEmail,
        passwordHash,
        role: 'super_admin',
        now,
        profileMode: 'single',
      });
      if (!Number.isInteger(adminUserUid)) {
        throw new AppError('STORAGE_ERROR', '创建管理员用户失败');
      }
      await repos.profiles.insert({
        id: profileId,
        userId,
        name: profileName,
        now,
      });
    }).catch((err) => {
      throw new AppError(
        'VALIDATION_ERROR',
        `创建管理员失败：${err instanceof Error ? err.message : err}`,
      );
    });

    // ---- 4. 写站点设置（SMTP / 站名 / 默认语言）----
    const settingsToWrite: Record<string, unknown> = {};
    if (String(input.siteName ?? '').trim() !== '') {
      settingsToWrite['SITE_TITLE'] = String(input.siteName).trim();
    }
    if (input.mailHost) {
      settingsToWrite['SMTP_HOST'] = input.mailHost;
      settingsToWrite['SMTP_PORT'] = Number(input.mailPort || 465);
      settingsToWrite['SMTP_SECURE'] = Number(input.mailPort || 465) === 465;
      if (input.mailUser) settingsToWrite['SMTP_USER'] = input.mailUser;
      if (input.mailPass) {
        settingsToWrite['SMTP_PASS'] = deps.secretBox
          ? deps.secretBox.encryptIfNeeded(input.mailPass)
          : input.mailPass;
      }
      if (input.mailFrom) settingsToWrite['SMTP_FROM'] = input.mailFrom;
    }
    settingsToWrite['DEFAULT_LANGUAGE'] = language;
    if (Object.keys(settingsToWrite).length > 0) {
      await repos.settings.setMany(settingsToWrite, now);
    }

    // ---- 5. 最后落 setup.json（库就绪、账号可用之后）----
    const record: SetupRecord = {
      version: 1,
      installedAt: now.toISOString(),
      db:
        input.dbType === 'postgresql'
          ? {
              type: 'postgresql',
              pg: {
                host: input.dbHost ?? '',
                port: Number(input.dbPort || 5432),
                database: input.dbName ?? '',
                user: input.dbUser ?? '',
                password: input.dbPassword ?? '',
              },
            }
          : { type: 'sqlite', sqlitePath: resolve(deps.config.sqlitePath) },
      defaultLanguage: language,
      redis: input.redisEnabled
        ? {
            enabled: true,
            host: input.redisHost ?? 'localhost',
            port: Number(input.redisPort || 6379),
            password: input.redisPassword ?? '',
          }
        : undefined,
      source: 'wizard',
    };
    writeSetupRecord(record);
  } finally {
    // setup.json 落盘前的任何失败都必须断开这次临时连接 —— 它不是运行时连接
    await db.close().catch(() => undefined);
  }

  return {
    dbType: input.dbType,
    adminUserId: userId,
    adminUserUid: adminUserUid,
  };
}

/**
 * 存量环境自动补写 setup.json（installMode=auto 时由 main.ts 调用）。
 * 库已存在且有数据、但还没有 setup.json —— 按「当前实际在用的库」记录，
 * 而不是问用户：问也问不出来（部署者没装过，只是按老方式跑的）。
 */
export function recordExistingEnvironment(config: AppConfig): void {
  if (isSetupCompleted()) return;
  const record: SetupRecord =
    config.dialect === 'postgres' && config.databaseUrl
      ? {
          version: 1,
          installedAt: new Date().toISOString(),
          db: { type: 'postgresql', pg: parsePostgresUrl(config.databaseUrl) },
          source: 'auto',
        }
      : {
          version: 1,
          installedAt: new Date().toISOString(),
          db: { type: 'sqlite', sqlitePath: resolve(config.sqlitePath) },
          source: 'auto',
        };
  writeSetupRecord(record);
  console.log(`[setup] 检测到存量数据库环境，已按现状记录安装状态（source=auto）`);
}

function parsePostgresUrl(url: string): SetupRecord['db']['pg'] {
  // postgres://user:pass@host:port/dbname
  const m = url.match(
    /^postgres(ql)?:\/\/(?:(?:([^:@]+)(?::([^@]*))?@)?)([^:/]+)(?::(\d+))?\/(.+)$/,
  );
  if (!m) {
    throw new ConfigError(`无法解析 DATABASE_URL：${url}`);
  }
  return {
    host: m[4]!,
    port: Number(m[5] ?? 5432),
    database: m[6]!,
    user: m[2] ?? 'postgres',
    password: m[3] ?? '',
  };
}

/**
 * 由安装输入构造 PostgreSQL 连接串（`completeSetup` 用）。
 *
 * 关键点：**空密码不写 `:password` 段**。`postgres://user:@host` 形式会带一个空串密码
 * 去 SCRAM 协商，部分 PG 版本会直接拒绝（"client password must be a string"），
 * 而 `postgres://user@host`（无冒号）才是真正的不带密码 —— trust/无认证连接可靠。
 * 密码非空时正常 URL-encode 进去，行为不变。
 */
function buildPgUrl(input: CompleteSetupInput): string {
  const host = String(input.dbHost ?? '');
  const port = Number(input.dbPort || 5432);
  const database = String(input.dbName ?? '');
  const user = encodeURIComponent(String(input.dbUser ?? ''));
  const pass = String(input.dbPassword ?? '');
  const auth = pass === '' ? `${user}@` : `${user}:${encodeURIComponent(pass)}@`;
  return `postgres://${auth}${host}:${port}/${database}`;
}
