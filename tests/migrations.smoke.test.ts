import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

const SCHEMA_DIR = resolve('schema');
const CORE_TABLES = [
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

/** 统一清理钩子：先关库再删临时目录（顺序错误会 EBUSY） */
function cleanupSqlite(t: { after: (fn: () => Promise<void>) => void }, db: SqliteConnection, dir: string): void {
  t.after(async () => {
    await db.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
}

test('sqlite: 空库执行全部迁移成功', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mscts-smoke-'));
  const db = new SqliteConnection(join(dir, 'test.db'));
  cleanupSqlite(t, db, dir);

  const result = await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));

  assert.deepEqual(result.applied, ['0001']);
  assert.equal(result.total, 1);

  const tables = await db.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  const names = tables.map((r) => r.name);
  for (const expected of [...CORE_TABLES, 'schema_migrations']) {
    assert.ok(names.includes(expected), `缺少表 ${expected}`);
  }

  const versions = await db.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations',
  );
  assert.equal(versions.length, 1);
  assert.equal(versions[0]?.version, '0001');
  assert.match(versions[0]?.checksum ?? '', /^[0-9a-f]{64}$/);
});

test('sqlite: 重复执行迁移无副作用', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mscts-smoke-'));
  const db = new SqliteConnection(join(dir, 'test.db'));
  cleanupSqlite(t, db, dir);

  await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));
  const second = await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));

  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.skipped, ['0001']);

  const count = await db.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'",
  );
  // 15 张业务表 + schema_migrations，重复执行后不应出现新表
  assert.equal(count[0]?.n, CORE_TABLES.length + 1);

  const versions = await db.query<{ version: string }>(
    'SELECT version FROM schema_migrations',
  );
  assert.equal(versions.length, 1);
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

const PG_DROP_ALL =
  'DROP TABLE IF EXISTS profile_assets, favorites, asset_reviews, minecraft_sessions, ' +
  'login_sessions, tokens, email_verification_tokens, password_reset_tokens, ' +
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
    assert.deepEqual(result.applied, ['0001']);

    const tables = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    const names = tables.map((r) => r.tablename);
    for (const expected of [...CORE_TABLES, 'schema_migrations']) {
      assert.ok(names.includes(expected), `缺少表 ${expected}`);
    }

    const second = await runMigrations(db, join(SCHEMA_DIR, 'postgresql'));
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, ['0001']);

    await db.exec("UPDATE schema_migrations SET checksum = 'deadbeef'");
    await assert.rejects(
      () => runMigrations(db, join(SCHEMA_DIR, 'postgresql')),
      /被修改过|checksum/,
    );

    // 阶段 2：失败回滚 —— 清场后用「0001 + 坏 0002」的临时迁移目录重放
    await db.exec(PG_DROP_ALL);
    const tmpMigrations = await mkdtemp(join(tmpdir(), 'mscts-pg-'));
    t.after(() => rm(tmpMigrations, { recursive: true, force: true }));
    await cp(join(SCHEMA_DIR, 'postgresql'), tmpMigrations, { recursive: true });
    await writeFile(
      join(tmpMigrations, '0002_broken.sql'),
      'CREATE TABLE pg_half_done (id TEXT PRIMARY KEY); CREATE TABLE pg_bad (;',
    );

    await assert.rejects(
      () => runMigrations(db, tmpMigrations),
      /0002/,
      'PG 上失败的迁移必须报错',
    );

    const pgTables = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    const pgNames = pgTables.map((r) => r.tablename);
    assert.ok(!pgNames.includes('pg_half_done'), 'PG 事务内 DDL 必须整体回滚');
    assert.ok(!pgNames.includes('pg_bad'), 'PG 失败的表不应存在');
    for (const expected of CORE_TABLES) {
      assert.ok(pgNames.includes(expected), `0001 的表应保留：${expected}`);
    }
    const pgVersions = await db.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    assert.deepEqual(
      pgVersions.map((v) => v.version),
      ['0001'],
      '失败的 0002 不得记录版本',
    );
  },
);
