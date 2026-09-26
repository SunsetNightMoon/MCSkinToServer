import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import { createSetupApp } from '../src/server/setupApp.js';
import { readSetupRecord } from '../src/setup/setupState.js';
import { SqliteConnection } from '../src/db/sqlite.js';
import { SettingRepository } from '../src/repositories/settingRepository.js';
import { UserRepository } from '../src/repositories/userRepository.js';
import type { AppConfig } from '../src/config.js';

/**
 * P5 第十二批：安装向导 HTTP 层。
 *
 * 覆盖三件事：
 * 1. 安装模式下业务接口一律 403 SETUP_REQUIRED（/api/setup 与 /health 放行）
 * 2. /api/setup/status 未装/已装两种返回
 * 3. /api/setup/complete 全流程：连库 → 迁移 → 建超管 → 写设置 → 落 setup.json
 *    + 幂等闸门（装完再 complete → 403）+ DEFAULT_LANGUAGE 落库
 *
 * setup.json 由 DATA_DIR env 定位，before/after 切到临时目录隔离
 * （--test-concurrency=1 串行，安全）。
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');

let dir: string;
let originalDataDir: string | undefined;
let server: Server;
let baseUrl: string;
let dbFile: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcsts-setup-http-'));
  dbFile = join(dir, 'fresh.db');
  // 确保全新：无 setup.json、无 db 文件 → install 模式
  originalDataDir = process.env['DATA_DIR'];
  process.env['DATA_DIR'] = dir;

  const config: AppConfig = {
    dialect: 'sqlite',
    sqlitePath: dbFile,
    migrationsRoot: SCHEMA_DIR,
    uploadDir: join(dir, 'uploads'),
    publicBaseUrl: 'http://localhost:3000/uploads',
    rsaPrivateKeyPath: join(dir, 'keys', 'yggdrasil.pem'),
    skinDomains: ['localhost'],
    installMode: 'installing',
  };
  server = createSetupApp(
    config,
    { dataDir: dir, sqlitePath: dbFile },
  ).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  if (originalDataDir === undefined) delete process.env['DATA_DIR'];
  else process.env['DATA_DIR'] = originalDataDir;
  await rm(dir, { recursive: true, force: true });
});

async function postJson(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function getJson(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ==========================================================================
// A. 安装模式：业务接口 403，setup/health 放行
// ==========================================================================

test('GET /api/setup/status：未安装 → setup_completed=false', async () => {
  const { status, json } = await getJson('/api/setup/status');
  assert.equal(status, 200);
  assert.equal(json.setup_completed, false);
});

test('业务接口 GET /api/me → 403 SETUP_REQUIRED（装完前不可碰）', async () => {
  const { status, json } = await getJson('/api/me');
  assert.equal(status, 403);
  assert.equal(json.error, 'SETUP_REQUIRED');
});

test('业务接口 POST /api/auth/login → 403 SETUP_REQUIRED', async () => {
  const { status, json } = await postJson('/api/auth/login', { email: 'a@b.c', password: 'password123' });
  assert.equal(status, 403);
  assert.equal(json.error, 'SETUP_REQUIRED');
});

test('GET /health/live → 200（安装模式存活探测放行）', async () => {
  const res = await fetch(`${baseUrl}/health/live`);
  assert.equal(res.status, 200);
});

// ==========================================================================
// B. 探测端点
// ==========================================================================

test('POST /api/setup/test-db（sqlite）→ success=true', async () => {
  const { status, json } = await postJson('/api/setup/test-db', { db_type: 'sqlite' });
  assert.equal(status, 200);
  assert.equal(json.success, true);
});

test('POST /api/setup/test-db（mysql）→ success=false（不支持）', async () => {
  const { status, json } = await postJson('/api/setup/test-db', { db_type: 'mysql' });
  assert.equal(status, 200);
  assert.equal(json.success, false);
  assert.match(json.message, /MySQL|不支持/);
});

// ==========================================================================
// C. complete 全流程
// ==========================================================================

test('POST /api/setup/complete → 建超管 + 写设置 + 落 setup.json', async () => {
  const { status, json } = await postJson('/api/setup/complete', {
    site_name: '测试皮肤站',
    default_language: 'JP',
    db_type: 'sqlite',
    mail_host: 'smtp.example.com',
    mail_port: 465,
    mail_user: 'noreply@example.com',
    mail_pass: 'mailpass',
    mail_from: 'noreply@example.com',
    admin_username: 'rootadmin',
    admin_email: 'admin@test.local',
    admin_password: 'adminpass123',
  });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.success, true);
  assert.equal(json.db_type, 'sqlite');
  assert.ok(json.admin_user_uid >= 1);

  // setup.json 落盘，库类型为 sqlite，默认语言 JP
  const rec = readSetupRecord();
  assert.notEqual(rec, null);
  assert.equal(rec!.db.type, 'sqlite');
  assert.equal(rec!.defaultLanguage, 'JP');
  assert.equal(rec!.source, 'wizard');

  // db 已建、迁移已跑、超管已建、设置已写
  assert.ok(existsSync(dbFile), 'SQLite 文件应已创建');
  const db = new SqliteConnection(dbFile);
  try {
    const settings = new SettingRepository(db);
    const all = await settings.getAll();
    assert.equal(all['DEFAULT_LANGUAGE'], 'JP');
    assert.equal(all['SITE_TITLE'], '测试皮肤站');
    assert.equal(all['SMTP_HOST'], 'smtp.example.com');

    const users = new UserRepository(db);
    const admin = await users.findByEmail('admin@test.local');
    assert.notEqual(admin, null);
    assert.equal(admin!.role, 'super_admin');
    assert.ok(admin!.userUid >= 1);
  } finally {
    await db.close();
  }
});

test('status 翻转为 setup_completed=true（装完）', async () => {
  const { json } = await getJson('/api/setup/status');
  assert.equal(json.setup_completed, true);
});

test('幂等闸门：装完再 complete → 403（库类型不可更改）', async () => {
  const { status, json } = await postJson('/api/setup/complete', {
    site_name: '再装一次',
    db_type: 'postgresql',
    db_host: 'h',
    db_port: 5432,
    db_name: 'd',
    db_user: 'u',
    db_password: '',
    admin_username: 'rootadmin',
    admin_email: 'admin@test.local',
    admin_password: 'adminpass123',
  });
  assert.equal(status, 403, JSON.stringify(json));
  // 库类型没被二次安装改成 postgres
  assert.equal(readSetupRecord()!.db.type, 'sqlite');
});

test('complete 参数校验：缺管理员邮箱 → 400', async () => {
  // 用另一个临时 DATA_DIR 回到未安装态，单独测参数校验
  const altDir = await mkdtemp(join(tmpdir(), 'mcsts-setup-verify-'));
  const prev = process.env['DATA_DIR'];
  process.env['DATA_DIR'] = altDir;
  try {
    const altDb = join(altDir, 'alt.db');
    const altConfig: AppConfig = {
      dialect: 'sqlite',
      sqlitePath: altDb,
      migrationsRoot: SCHEMA_DIR,
      uploadDir: join(altDir, 'uploads'),
      publicBaseUrl: 'http://localhost:3000/uploads',
      rsaPrivateKeyPath: join(altDir, 'keys', 'yggdrasil.pem'),
      skinDomains: ['localhost'],
      installMode: 'installing',
    };
    const altServer = createSetupApp(altConfig, { dataDir: altDir, sqlitePath: altDb }).listen(0, '127.0.0.1');
    await new Promise<void>((r) => altServer.once('listening', () => r()));
    const a = altServer.address();
    const altBase = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
    const res = await fetch(`${altBase}/api/setup/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db_type: 'sqlite', admin_username: 'x', admin_password: 'adminpass123' }),
    });
    assert.equal(res.status, 400, '缺邮箱应 400');
    altServer.closeAllConnections();
    await new Promise<void>((r) => altServer.close(() => r()));
  } finally {
    if (prev === undefined) delete process.env['DATA_DIR'];
    else process.env['DATA_DIR'] = prev;
    await rm(altDir, { recursive: true, force: true });
  }
});
