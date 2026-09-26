import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../errors.js';
import type { DatabaseConnection, MigrationRecord } from '../types.js';
import { sha256Hex } from '../util/crypto.js';

/**
 * 版本化迁移 runner（蓝图 P0：消灭 plan3 的四套 schema 来源）。
 *
 * 规则：
 * - 合法 schema 来源只有 schema/<dialect>/NNNN_name.sql
 * - 版本表 schema_migrations 记录 version、checksum、applied_at
 * - 每个迁移在单个事务内执行（迁移文件内禁止自带事务控制语句）
 * - 已应用的迁移：校验 checksum 一致则跳过；不一致则报错（schema 漂移检测）
 * - 任何失败都会抛出错误 → CLI 以非零码退出 → 阻止服务启动
 */

const MIGRATION_FILE_RE = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

export interface MigrationFile {
  /** 版本号，如 '0001' */
  version: string;
  /** 文件名（不含路径） */
  filename: string;
  sql: string;
  /** sha256(sql) 小写 hex */
  checksum: string;
}

export interface MigrationResult {
  /** 本次实际应用的版本号（按顺序） */
  applied: string[];
  /** 已存在且 checksum 校验通过的版本号 */
  skipped: string[];
  /** 发现的迁移文件总数 */
  total: number;
}

export class MigrationError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('MIGRATION_ERROR', message, options);
  }
}

function checksumOf(sql: string): string {
  return sha256Hex(sql);
}

/** 读取迁移目录，解析并按版本号排序；命名不合法 / 版本重复直接报错 */
export async function loadMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files: MigrationFile[] = [];

  for (const filename of entries.sort()) {
    const match = MIGRATION_FILE_RE.exec(filename);
    if (match?.[1] && match[2]) {
      const sql = await readFile(join(dir, filename), 'utf8');
      files.push({ version: match[1], filename, sql, checksum: checksumOf(sql) });
    } else if (filename.toLowerCase().endsWith('.sql')) {
      throw new MigrationError(
        `迁移文件命名不合法（应为 NNNN_name.sql）: ${filename}`,
      );
    }
  }

  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.version)) {
      throw new MigrationError(`迁移版本号重复: ${file.version}`);
    }
    seen.add(file.version);
  }

  files.sort((a, b) => a.version.localeCompare(b.version));
  return files;
}

/** 版本表 bootstrap DDL：PG 用 TIMESTAMPTZ，SQLite 用 TEXT（ISO-8601 UTC） */
function bootstrapVersionTableSql(dialect: DatabaseConnection['dialect']): string {
  const appliedAt = dialect === 'postgres' ? 'TIMESTAMPTZ' : 'TEXT';
  return `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  checksum   TEXT NOT NULL,
  applied_at ${appliedAt} NOT NULL
)`;
}

function insertVersionSql(dialect: DatabaseConnection['dialect']): string {
  const placeholders =
    dialect === 'postgres' ? '($1, $2, $3)' : '(?, ?, ?)';
  return `INSERT INTO schema_migrations (version, checksum, applied_at) VALUES ${placeholders}`;
}

/**
 * 执行迁移。幂等：已应用且 checksum 一致的迁移被跳过；
 * checksum 漂移或执行失败时抛出 MigrationError。
 */
export async function runMigrations(
  db: DatabaseConnection,
  migrationsDir: string,
): Promise<MigrationResult> {
  await db.exec(bootstrapVersionTableSql(db.dialect));

  const files = await loadMigrationFiles(migrationsDir);
  const appliedRows = await db.query<MigrationRecord>(
    'SELECT version, checksum FROM schema_migrations',
  );
  const appliedMap = new Map(appliedRows.map((row) => [row.version, row]));

  const result: MigrationResult = { applied: [], skipped: [], total: files.length };

  for (const file of files) {
    const existing = appliedMap.get(file.version);
    if (existing) {
      if (existing.checksum !== file.checksum) {
        throw new MigrationError(
          `迁移 ${file.version}（${file.filename}）在应用后被修改过，拒绝继续：` +
            `记录的 checksum=${existing.checksum}，当前文件 checksum=${file.checksum}`,
        );
      }
      result.skipped.push(file.version);
      continue;
    }

    try {
      await db.transaction(async () => {
        await db.exec(file.sql);
        await db.run(insertVersionSql(db.dialect), [
          file.version,
          file.checksum,
          new Date().toISOString(),
        ]);
      });
    } catch (err) {
      throw new MigrationError(
        `迁移 ${file.version}（${file.filename}）执行失败，已回滚：${String(err)}`,
        { cause: err },
      );
    }
    result.applied.push(file.version);
  }

  return result;
}
