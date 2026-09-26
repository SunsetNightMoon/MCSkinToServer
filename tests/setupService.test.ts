import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import {
  readSetupRecord,
  writeSetupRecord,
  isSetupCompleted,
  setupRecordPath,
  validateSetupRecord,
  type SetupRecord,
} from '../src/setup/setupState.js';
import {
  testDatabase,
  assertSetupOpen,
  recordExistingEnvironment,
  type SetupProbeDeps,
} from '../src/setup/setupService.js';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';

/**
 * P5 第十二批：安装向导服务层（setupState + setupService 探测/分流）。
 *
 * setup.json 是唯一事实源：记录是否安装、库类型、连接参数、默认语言、Redis。
 * **库类型选定后不可更改** —— 本测试覆盖「不可更改」的服务层落地：
 * completeSetup 的幂等闸门（assertSetupOpen）、loadConfig 的 installMode 分流。
 *
 * setup.json 路径由 `DATA_DIR` env 决定。node --test 串行（--test-concurrency=1），
 * 故 before/after 里安全地切换 DATA_DIR 到临时目录，不影响其它测试文件。
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');

let dataDir: string;
let originalDataDir: string | undefined;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'mcsts-setup-'));
  originalDataDir = process.env['DATA_DIR'];
  process.env['DATA_DIR'] = dataDir;
});

after(async () => {
  // 还原 env，避免污染同一进程里后续测试文件
  if (originalDataDir === undefined) delete process.env['DATA_DIR'];
  else process.env['DATA_DIR'] = originalDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

function makeRecord(overrides?: Partial<SetupRecord>): SetupRecord {
  return {
    version: 1,
    installedAt: new Date().toISOString(),
    db: { type: 'sqlite', sqlitePath: '/tmp/x.db' },
    defaultLanguage: 'SCH',
    source: 'wizard',
    ...overrides,
  };
}

// ==========================================================================
// A. setupState：读写 / 损坏 / 校验
// ==========================================================================

test('未安装：readSetupRecord 返回 null、isSetupCompleted=false', () => {
  assert.equal(readSetupRecord(), null);
  assert.equal(isSetupCompleted(), false);
});

test('writeSetupRecord 后能读回，isSetupCompleted=true', () => {
  writeSetupRecord(makeRecord());
  const rec = readSetupRecord();
  assert.notEqual(rec, null);
  assert.equal(rec!.db.type, 'sqlite');
  assert.equal(rec!.source, 'wizard');
  assert.equal(isSetupCompleted(), true);
  writeSetupRecord(makeRecord());
});

test('损坏的 setup.json 按未安装处理（不让服务起不来）', () => {
  const path = setupRecordPath(dataDir);
  writeFileSync(path, '{ this is not json', 'utf8');
  assert.equal(readSetupRecord(), null);
  assert.equal(isSetupCompleted(), false);
});

test('version 不匹配 / 非法 db 类型 → 视为未安装', () => {
  writeSetupRecord(makeRecord() as any);
  // 手写非法 version
  const path = setupRecordPath(dataDir);
  writeFileSync(path, JSON.stringify({ version: 99, db: { type: 'sqlite' } }), 'utf8');
  assert.equal(readSetupRecord(), null);
});

test('validateSetupRecord：PG 缺 host/database/user → 报错', () => {
  const bad = makeRecord({ db: { type: 'postgresql', pg: { host: '', port: 5432, database: '', user: '', password: '' } } });
  assert.notEqual(validateSetupRecord(bad), null);
  const good = makeRecord({ db: { type: 'postgresql', pg: { host: 'h', port: 5432, database: 'd', user: 'u', password: '' } } });
  assert.equal(validateSetupRecord(good), null);
});

// ==========================================================================
// B. testDatabase：探测（不依赖已安装状态）
// ==========================================================================

test('testDatabase sqlite：可写目录 ok，嵌套子目录自动创建', async () => {
  const probe: SetupProbeDeps = {
    dataDir,
    sqlitePath: join(dataDir, 'sub', 'deep', 'probe.db'),
  };
  const ok = await testDatabase({ dbType: 'sqlite' }, probe);
  assert.equal(ok.ok, true, ok.message);
  // 探测会建出目录并清理临时探测文件
  assert.ok(existsSync(join(dataDir, 'sub')));
});

test('testDatabase postgresql：信息不完整 → 失败', async () => {
  const probe: SetupProbeDeps = { dataDir, sqlitePath: join(dataDir, 'p.db') };
  const res = await testDatabase({ dbType: 'postgresql', dbHost: 'h', dbName: 'd' }, probe);
  assert.equal(res.ok, false); // 缺 dbUser
});

test('testDatabase：不支持的库类型（mysql）→ 明确拒绝', async () => {
  const probe: SetupProbeDeps = { dataDir, sqlitePath: join(dataDir, 'm.db') };
  const res = await testDatabase({ dbType: 'mysql' }, probe);
  assert.equal(res.ok, false);
  assert.match(res.message, /MySQL|不支持/);
});

// ==========================================================================
// C. assertSetupOpen：幂等闸门（库类型不可更改的服务层落地）
// ==========================================================================

test('未安装时 assertSetupOpen 通过；已安装时抛 FORBIDDEN', () => {
  // 当前 dataDir 无 setup.json
  assert.doesNotThrow(() => assertSetupOpen());
  writeSetupRecord(makeRecord());
  assert.throws(() => assertSetupOpen(), AppError);
  assert.throws(
    () => assertSetupOpen(),
    (e: AppError) => e.code === 'FORBIDDEN' && /安装已完成/.test(e.message),
  );
});

// ==========================================================================
// D. loadConfig：installMode 三态分流
// ==========================================================================

test('loadConfig：无 setup.json + 无 env + 无库文件 → installing', () => {
  // 清掉 setup.json
  const path = setupRecordPath(dataDir);
  if (existsSync(path)) unlinkSync(path);
  const cfg = loadConfig({
    DB_TYPE: 'sqlite',
    SQLITE_PATH: join(dataDir, 'nope.db'), // 不存在的文件
    MIGRATIONS_DIR: SCHEMA_DIR,
    UPLOAD_DIR: join(dataDir, 'uploads'),
    PUBLIC_BASE_URL: 'http://localhost:3000/uploads',
    RSA_PRIVATE_KEY_PATH: join(dataDir, 'keys', 'yggdrasil.pem'),
  });
  assert.equal(cfg.installMode, 'installing');
  assert.equal(cfg.dialect, 'sqlite');
});

test('loadConfig：无 setup.json + 库文件已存在且有数据 → auto', () => {
  const path = setupRecordPath(dataDir);
  if (existsSync(path)) unlinkSync(path);
  const dbFile = join(dataDir, 'exist.db');
  writeFileSync(dbFile, 'SOME DATA');
  const cfg = loadConfig({
    DB_TYPE: 'sqlite',
    SQLITE_PATH: dbFile,
    MIGRATIONS_DIR: SCHEMA_DIR,
    UPLOAD_DIR: join(dataDir, 'uploads'),
    PUBLIC_BASE_URL: 'http://localhost:3000/uploads',
    RSA_PRIVATE_KEY_PATH: join(dataDir, 'keys', 'yggdrasil.pem'),
  });
  assert.equal(cfg.installMode, 'auto');
});

test('loadConfig：setup.json=postgres → dialect=postgres（env DB_TYPE 被忽略，不可更改）', () => {
  writeSetupRecord(
    makeRecord({
      db: {
        type: 'postgresql',
        pg: { host: 'localhost', port: 5432, database: 'mcsts', user: 'postgres', password: '' },
      },
    }),
  );
  const cfg = loadConfig({
    // 即便 env 写 sqlite，setup.json 已锁定为 postgres —— 类型不可更改
    DB_TYPE: 'sqlite',
    MIGRATIONS_DIR: SCHEMA_DIR,
    UPLOAD_DIR: join(dataDir, 'uploads'),
    PUBLIC_BASE_URL: 'http://localhost:3000/uploads',
    RSA_PRIVATE_KEY_PATH: join(dataDir, 'keys', 'yggdrasil.pem'),
  });
  assert.equal(cfg.installMode, 'installed');
  assert.equal(cfg.dialect, 'postgres');
  assert.ok(cfg.databaseUrl?.includes('localhost:5432/mcsts'));
});

test('loadConfig：setup.json=sqlite + Redis 选择 → redisUrl 从记录派生', () => {
  writeSetupRecord(
    makeRecord({
      db: { type: 'sqlite', sqlitePath: join(dataDir, 'x.db') },
      redis: { enabled: true, host: 'redis.internal', port: 6380, password: 'pw' },
    }),
  );
  const cfg = loadConfig({
    MIGRATIONS_DIR: SCHEMA_DIR,
    UPLOAD_DIR: join(dataDir, 'uploads'),
    PUBLIC_BASE_URL: 'http://localhost:3000/uploads',
    RSA_PRIVATE_KEY_PATH: join(dataDir, 'keys', 'yggdrasil.pem'),
  });
  assert.equal(cfg.dialect, 'sqlite');
  assert.equal(cfg.redisUrl, 'redis://pw@redis.internal:6380');
});

test('loadConfig：setup.json 存在但非法 → 启动报错（不静默降级）', () => {
  const path = setupRecordPath(dataDir);
  const rec = makeRecord();
  (rec as any).db.type = 'mysql'; // 非法
  writeFileSync(
    path,
    JSON.stringify(rec),
    'utf8',
  );
  assert.throws(
    () =>
      loadConfig({
        MIGRATIONS_DIR: SCHEMA_DIR,
        UPLOAD_DIR: join(dataDir, 'uploads'),
        PUBLIC_BASE_URL: 'http://localhost:3000/uploads',
        RSA_PRIVATE_KEY_PATH: join(dataDir, 'keys', 'yggdrasil.pem'),
      }),
    /setup\.json/,
  );
});

// ==========================================================================
// E. recordExistingEnvironment：存量环境自动补写
// ==========================================================================

test('recordExistingEnvironment：无 setup.json 时按现状补写（source=auto）', () => {
  const path = setupRecordPath(dataDir);
  if (existsSync(path)) unlinkSync(path);
  recordExistingEnvironment({
    dialect: 'sqlite',
    sqlitePath: join(dataDir, 'legacy.db'),
    migrationsRoot: SCHEMA_DIR,
    uploadDir: join(dataDir, 'uploads'),
    publicBaseUrl: 'http://localhost:3000/uploads',
    rsaPrivateKeyPath: join(dataDir, 'keys', 'yggdrasil.pem'),
    skinDomains: [],
  } as any);
  const rec = readSetupRecord();
  assert.notEqual(rec, null);
  assert.equal(rec!.source, 'auto');
  assert.equal(rec!.db.type, 'sqlite');
  // 幂等：再调一次不报错、不改变
  recordExistingEnvironment({
    dialect: 'sqlite',
    sqlitePath: join(dataDir, 'legacy.db'),
    migrationsRoot: SCHEMA_DIR,
    uploadDir: join(dataDir, 'uploads'),
    publicBaseUrl: 'http://localhost:3000/uploads',
    rsaPrivateKeyPath: join(dataDir, 'keys', 'yggdrasil.pem'),
    skinDomains: [],
  } as any);
  assert.equal(readSetupRecord()!.source, 'auto');
});
