import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PostgresConnection } from '../src/db/postgres.js';
import { SqliteConnection } from '../src/db/sqlite.js';
import { runMigrations } from '../src/migrate/runner.js';

/**
 * 迁移 smoke test（蓝图 §11 任务 2 / P0 验收）：
 *  1. 空库执行全部迁移成功
 *  2. 重复执行迁移无副作用
 *  3. 已应用迁移被修改后拒绝执行（checksum 漂移）
 *  4. 迁移失败时整体回滚且不记录版本；修复后可续跑
 *  5. PostgreSQL 全套（需 TEST_DATABASE_URL，指向可随意销毁的空临时库）
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');

/**
 * `0001_init.sql` 建的表。**回滚用例只重放版本号最小的那条迁移**，所以那里
 * 只能期望这些表存在；把后续迁移新增的表混进来会让断言失败。
 */
const TABLES_FROM_0001 = [
  'users',
  'profiles',
  'blobs',
  'assets',
  'profile_assets',
  'tokens',
  'minecraft_sessions',
  'login_sessions',
  'favorites',
  'asset_reviews',
  'email_verification_tokens',
  'password_reset_tokens',
  'oauth_accounts',
  'blacklist_entries',
  'system_settings',
];

/**
 * 后续迁移新增的表。**新增迁移建了新表就加到这里**（同时别忘了 `PG_DROP_ALL`）。
 */
const TABLES_ADDED_LATER = [
  // 0003_username_mode_and_backup_email
  'backup_email_tokens',
  'email_change_requests',
  'email_change_tokens',
];

/** 全部迁移跑完后应当存在的业务表 */
const CORE_TABLES = [...TABLES_FROM_0001, ...TABLES_ADDED_LATER];

/** 统一清理钩子：先关库再删临时目录（顺序错误会 EBUSY） */
function cleanupSqlite(t: { after: (fn: () => Promise<void>) => void }, db: SqliteConnection, dir: string): void {
  t.after(async () => {
    await db.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
}

/**
 * schema/<dialect>/ 下真实存在的迁移版本清单。
 * 新增迁移时只需在这里加一项（下方断言数处共用，避免漏改）。
 */
const EXPECTED_MIGRATIONS = ['0001', '0002', '0003'];

test('sqlite: 空库执行全部迁移成功', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mscts-smoke-'));
  const db = new SqliteConnection(join(dir, 'test.db'));
  cleanupSqlite(t, db, dir);

  const result = await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));

  assert.deepEqual(result.applied, EXPECTED_MIGRATIONS);
  assert.equal(result.total, EXPECTED_MIGRATIONS.length);

  const tables = await db.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  const names = tables.map((r) => r.name);
  for (const expected of [...CORE_TABLES, 'schema_migrations']) {
    assert.ok(names.includes(expected), `缺少表 ${expected}`);
  }

  const versions = await db.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  );
  assert.deepEqual(
    versions.map((v) => v.version),
    EXPECTED_MIGRATIONS,
  );
  for (const v of versions) {
    assert.match(v.checksum, /^[0-9a-f]{64}$/);
  }
});

test('sqlite: 重复执行迁移无副作用', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mscts-smoke-'));
  const db = new SqliteConnection(join(dir, 'test.db'));
  cleanupSqlite(t, db, dir);

  await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));
  const second = await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));

  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.skipped, EXPECTED_MIGRATIONS);

  const count = await db.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'",
  );
  // 15 张业务表 + schema_migrations，重复执行后不应出现新表
  assert.equal(count[0]?.n, CORE_TABLES.length + 1);

  const versions = await db.query<{ version: string }>(
    'SELECT version FROM schema_migrations',
  );
  assert.equal(versions.length, EXPECTED_MIGRATIONS.length);
});

test('sqlite: 已应用的迁移被修改后拒绝执行（checksum 漂移）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mscts-smoke-'));
  const db = new SqliteConnection(join(dir, 'test.db'));
  cleanupSqlite(t, db, dir);

  await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));

  await db.exec("UPDATE schema_migrations SET checksum = 'deadbeef'");
  await assert.rejects(
    () => runMigrations(db, join(SCHEMA_DIR, 'sqlite')),
    /被修改过|checksum/,
  );
});

test('sqlite: 迁移失败时整体回滚且不记录版本', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mscts-smoke-'));
  const migrationsDir = join(dir, 'migrations');
  await mkdir(migrationsDir);
  const db = new SqliteConnection(join(dir, 'test.db'));
  cleanupSqlite(t, db, dir);

  // 第一步：只有健康的 0001，正常应用
  await writeFile(
    join(migrationsDir, '0001_probe.sql'),
    'CREATE TABLE probe (id TEXT PRIMARY KEY);',
  );
  const first = await runMigrations(db, migrationsDir);
  assert.deepEqual(first.applied, ['0001']);

  // 第二步：加入「前半段成功、后半段语法错误」的 0002 —— 必须整体回滚
  await writeFile(
    join(migrationsDir, '0002_broken.sql'),
    'CREATE TABLE half_done (id TEXT PRIMARY KEY); CREATE TABLE syntax_error (;',
  );
  await assert.rejects(() => runMigrations(db, migrationsDir), /0002/);

  const tables = await db.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  const names = tables.map((r) => r.name);
  assert.ok(names.includes('probe'), '0001 的表应保留');
  assert.ok(!names.includes('half_done'), '0002 已执行的部分必须被回滚');
  assert.ok(!names.includes('syntax_error'), '0002 失败的表不应存在');

  const versions = await db.query<{ version: string }>(
    'SELECT version FROM schema_migrations',
  );
  assert.deepEqual(
    versions.map((v) => v.version),
    ['0001'],
    '失败的迁移不得记录版本',
  );

  // 第三步：修复 0002 后重跑 —— 0001 跳过，0002 成功（可恢复性）
  await writeFile(
    join(migrationsDir, '0002_broken.sql'),
    'CREATE TABLE half_done (id TEXT PRIMARY KEY);',
  );
  const fixed = await runMigrations(db, migrationsDir);
  assert.deepEqual(fixed.applied, ['0002']);
  assert.deepEqual(fixed.skipped, ['0001']);
});

// ---------------------------------------------------------------------------
// PostgreSQL：需要 TEST_DATABASE_URL 指向一个可随意销毁的空临时库
// 本机无 docker/psql 时自动跳过；测试自身负责前后清场，可重复执行
// ---------------------------------------------------------------------------
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

/**
 * 清场语句。**新增迁移建了新表就必须加进这里** —— 漏加的表不会被 DROP，
 * 下一次运行 0003 之类的 CREATE TABLE 会直接撞 "already exists"。
 */
const PG_DROP_ALL =
  'DROP TABLE IF EXISTS profile_assets, favorites, asset_reviews, minecraft_sessions, ' +
  'login_sessions, tokens, email_verification_tokens, password_reset_tokens, ' +
  'backup_email_tokens, email_change_requests, email_change_tokens, ' +
  'oauth_accounts, blacklist_entries, system_settings, assets, blobs, profiles, users, ' +
  'schema_migrations CASCADE';

test(
  'postgres: 全量迁移 / 幂等 / checksum 漂移 / 失败回滚（需要 TEST_DATABASE_URL）',
  { skip: !TEST_DATABASE_URL && '未设置 TEST_DATABASE_URL，跳过 PostgreSQL smoke test' },
  async (t) => {
    const db = PostgresConnection.connect(TEST_DATABASE_URL!);
    t.after(async () => {
      await db.exec(PG_DROP_ALL).catch(() => undefined);
      await db.close().catch(() => undefined);
    });

    // 阶段 0：清场（保证可重复执行）
    await db.exec(PG_DROP_ALL);

    // 阶段 1：空库全量迁移 + 幂等重跑 + checksum 漂移
    const result = await runMigrations(db, join(SCHEMA_DIR, 'postgresql'));
    assert.deepEqual(result.applied, EXPECTED_MIGRATIONS);

    const tables = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    const names = tables.map((r) => r.tablename);
    for (const expected of [...CORE_TABLES, 'schema_migrations']) {
      assert.ok(names.includes(expected), `缺少表 ${expected}`);
    }

    const second = await runMigrations(db, join(SCHEMA_DIR, 'postgresql'));
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, EXPECTED_MIGRATIONS);

    await db.exec("UPDATE schema_migrations SET checksum = 'deadbeef'");
    await assert.rejects(
      () => runMigrations(db, join(SCHEMA_DIR, 'postgresql')),
      /被修改过|checksum/,
    );

    // 阶段 2：失败回滚 —— 清场后重放「真实的第一个迁移 + 一个必然失败的后续迁移」。
    //
    // 这里**不能整目录 cp**：schema 下已有多条迁移，若再塞一个与现有版本号重复的文件，
    // runMigrations 会在「版本号重复」处直接抛错——那是在应用任何迁移之前，
    // 于是「0001 的表应保留」变成空转断言，真实回滚行为根本没被验证到。
    // 因此只取版本号最小的真实迁移，失败用例用 9999 这样不可能撞号的版本。
    await db.exec(PG_DROP_ALL);
    const tmpMigrations = await mkdtemp(join(tmpdir(), 'mscts-pg-'));
    t.after(() => rm(tmpMigrations, { recursive: true, force: true }));

    const realFiles = (await readdir(join(SCHEMA_DIR, 'postgresql'))).sort();
    const baseFile = realFiles[0];
    assert.ok(baseFile, 'schema/postgresql 下必须至少有一条迁移');
    const baseVersion = baseFile.split('_')[0]!;
    await cp(
      join(SCHEMA_DIR, 'postgresql', baseFile),
      join(tmpMigrations, baseFile),
    );
    await writeFile(
      join(tmpMigrations, '9999_broken.sql'),
      'CREATE TABLE pg_half_done (id TEXT PRIMARY KEY); CREATE TABLE pg_bad (;',
    );

    await assert.rejects(
      () => runMigrations(db, tmpMigrations),
      /9999/,
      'PG 上失败的迁移必须报错',
    );

    const pgTables = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    const pgNames = pgTables.map((r) => r.tablename);
    assert.ok(!pgNames.includes('pg_half_done'), 'PG 事务内 DDL 必须整体回滚');
    assert.ok(!pgNames.includes('pg_bad'), 'PG 失败的表不应存在');
    for (const expected of TABLES_FROM_0001) {
      assert.ok(pgNames.includes(expected), `首个迁移的表应保留：${expected}`);
    }
    const pgVersions = await db.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    assert.deepEqual(
      pgVersions.map((v) => v.version),
      [baseVersion],
      '失败的后续迁移不得记录版本',
    );
  },
);
