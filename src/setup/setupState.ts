import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * 安装状态（P5 第十二批）。
 *
 * **`data/setup.json` 是唯一事实源**：记录站点是否完成安装、用哪种数据库、
 * 以及当时的连接参数。启动时（`loadConfig` 之前）先读它决定「正常模式」还是
 * 「安装模式」，因此它必须放在**数据库之外** —— 安装模式下数据库根本还没建。
 *
 * **选定后不可更改**是产品硬约束（用户拍板）：
 * - 前端没有任何入口改它（管理面板不提供数据库切换）
 * - 后端唯一写入口是 `completeSetup`（且要求文件不存在）
 * - 删除文件 = 手动回滚到安装模式，属于运维操作，不在产品路径里
 *
 * 文件很小、启动期读一次、安装期写一次 —— 不做缓存，每次直接读盘。
 */

export type SetupDbType = 'sqlite' | 'postgresql';

export interface SetupRecord {
  version: 1;
  installedAt: string;
  db: {
    type: SetupDbType;
    /** type=postgresql 时必有 */
    pg?: {
      host: string;
      port: number;
      database: string;
      user: string;
      password: string;
    };
    /** type=sqlite 时记录安装时用的路径（仅信息性；运行时路径以 env 为准，
     *  运维换路径是部署自由 —— 但换库类型不行） */
    sqlitePath?: string;
  };
  /** 安装时选择的默认显示语言（SCH/TCH/EN/JP），写入 DEFAULT_LANGUAGE 设置 */
  defaultLanguage?: string;
  /**
   * 安装时选择的 Redis（可选组件）。未选择 = 缺省，运行时限流/缓存降级为进程内存。
   * 启动时若无 env REDIS_URL，从本字段派生 —— 向导里选了 Redis 就必须真生效。
   */
  redis?: {
    enabled: boolean;
    host: string;
    port: number;
    password: string;
  };
  /** 安装方式：'wizard' = 向导完成；'auto' = 存量环境自动升级（库里已有数据） */
  source: 'wizard' | 'auto';
}

export type InstallState =
  | { kind: 'installed'; record: SetupRecord }
  | { kind: 'installing' };

/** setup.json 的固定位置：<dataDir>/setup.json（dataDir 默认 ./data） */
export function setupRecordPath(dataDir?: string): string {
  const dir = resolve(dataDir ?? process.env['DATA_DIR'] ?? './data');
  return resolve(dir, 'setup.json');
}

/**
 * 读安装记录。
 *
 * 分级处理，语义不同：
 * - **文件不存在 / JSON 解析失败** → 返回 null（按未安装处理）：解析失败多为
 *   全新部署或写盘中断，打回安装向导是恢复路径，不该让服务起不来。
 * - **JSON 能解析但结构非法**（version 不符 / db.type 未知）→ 仍返回记录本身，
 *   交由 `validateSetupRecord` 判定 → `loadConfig` 抛错。**不静默降级**：
 *   一个已解析、version 正确、却声明了未知库类型的文件，是「记录损坏」的强信号，
 *   静默打回安装向导会让已装站点被二次安装、库类型被改，违反「选定后不可更改」。
 */
export function readSetupRecord(dataDir?: string): SetupRecord | null {
  const path = setupRecordPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as SetupRecord;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch (err) {
    console.warn(
      `[setup] 读取 ${path} 失败，按未安装处理:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export function isSetupCompleted(dataDir?: string): boolean {
  return readSetupRecord(dataDir) !== null;
}

/** 写安装记录（原子性：先写临时文件再 rename，避免半截文件） */
export function writeSetupRecord(record: SetupRecord, dataDir?: string): void {
  const path = setupRecordPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/**
 * 校验安装记录内部一致性（启动分流用）。
 *
 * 返回 null = 合法；返回字符串 = 错误描述（`loadConfig` 据此抛 ConfigError）。
 * 未知 db.type 在此显式拦截 —— 记录声明了一种既非 sqlite 也非 postgresql 的库，
 * 说明文件被改坏或版本不兼容，必须响亮报错而不是静默按未安装处理。
 */
export function validateSetupRecord(record: SetupRecord): string | null {
  if (record.db.type !== 'sqlite' && record.db.type !== 'postgresql') {
    return `setup.json 的 db.type 非法：${String(record.db.type)}`;
  }
  if (record.db.type === 'postgresql') {
    const pg = record.db.pg;
    if (!pg) return 'setup.json 缺少 db.pg';
    if (!pg.host || !pg.database || !pg.user) {
      return 'setup.json 的 db.pg 缺少 host/database/user';
    }
    if (!Number.isInteger(pg.port) || pg.port <= 0 || pg.port > 65535) {
      return 'setup.json 的 db.pg.port 非法';
    }
  }
  return null;
}
