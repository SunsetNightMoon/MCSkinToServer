import { join } from 'node:path';
import { dialectDirName, loadConfig } from '../config.js';
import { createDatabase } from '../db/index.js';
import { runMigrations } from './runner.js';

/**
 * 迁移 CLI 入口（npm run migrate）。
 * 任何迁移失败都会以非零码退出 —— 服务启动脚本应先跑迁移再启动，
 * 从而满足“migration 失败会阻止启动”的 P0 验收条件。
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const db = await createDatabase(config);
  const migrationsDir = join(config.migrationsRoot, dialectDirName(config.dialect));

  try {
    const result = await runMigrations(db, migrationsDir);
    console.log(`[migrate] dialect=${config.dialect} dir=${migrationsDir}`);
    console.log(`[migrate] applied: ${result.applied.join(', ') || '(none)'}`);
    console.log(
      `[migrate] skipped (already applied): ${result.skipped.join(', ') || '(none)'}`,
    );
    console.log(`[migrate] total migration files: ${result.total}`);
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error('[migrate] FAILED:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.cause) {
    console.error('[migrate] cause:', String(err.cause));
  }
  process.exitCode = 1;
});
