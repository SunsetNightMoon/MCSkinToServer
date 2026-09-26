// P5 第十二批：安装向导「真实安装」端到端验证。
//
// 目的：证明安装向导**真的能指定并装出一个可用的数据库**（用户硬要求 #3），
//       以及「库类型选定后不可更改」与「默认语言生效」。
//
// 做法：用真实的 main.ts（tsx）起服务，驱动真实 HTTP 端点（不是 mock app）：
//   阶段 1：全新临时数据目录 → 起服务 → 落入安装模式（installing）
//           → 打 /api/setup/* 探测 + complete（指定 SQLite 或 PG）
//           → 验证 setup.json / 库文件 / 迁移 / 超管
//           → **软重启**：complete 后不重启进程，轮询 status 直到 mode=installed，
//             业务接口同进程直接可用（第十二批补充）
//   阶段 2：kill 服务，用同一数据目录再起来 → 必须走 installed 正常模式（硬重启回归）
//           → /api/setup/status=true、/api/settings/public 含 DEFAULT_LANGUAGE、
//             用向导建的超管登录成功（证明库真可用）
//           → 再次 complete → 403（不可更改）
//
// 用法：node scripts/verify-install-live.mjs sqlite   （或 postgresql）
// 清理：跑完自动删除临时数据目录；PG 会 DROP 临时库（--drop-pg 默认开）。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.argv[2] === 'postgresql' ? 'postgresql' : 'sqlite';
const PORT = 3911;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { username: 'liveadmin', email: 'admin@live.local', password: 'livepass123' };
// PG 连接参数可用 env 覆盖（INDEV 便携 PG 在 54329）
const PG_HOST = process.env['PG_HOST'] ?? 'localhost';
const PG_PORT = Number(process.env['PG_PORT'] ?? 5432);
const PG_DB = process.env['PG_DB'] ?? 'mcsts_live_probe';
const PG_USER = process.env['PG_USER'] ?? 'postgres';
const PG_PASS = process.env['PG_PASS'] ?? '';
const DATA_DIR = mkdtempSync(join(tmpdir(), 'mcsts-live-'));
const SQLITE_PATH = join(DATA_DIR, 'live.db');

// ---- PG 临时库：跑前 CREATE（幂等），跑完 DROP（头注释承诺的清理在此落实）----
const { default: pg } = await import('pg');
async function withAdminDb(fn) {
  const c = new pg.Client({
    host: PG_HOST,
    port: PG_PORT,
    database: 'postgres',
    user: PG_USER,
    ...(PG_PASS ? { password: PG_PASS } : {}),
  });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
async function ensurePgDb() {
  const exists = await withAdminDb((c) =>
    c.query('SELECT 1 FROM pg_database WHERE datname = $1', [PG_DB]),
  );
  if (exists.rowCount === 0) {
    await withAdminDb((c) => c.query(`CREATE DATABASE ${pg.escapeIdentifier(PG_DB)}`));
    log(`  [pg] created temp database ${PG_DB}`);
  }
}
async function dropPgDb() {
  await withAdminDb((c) =>
    c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(PG_DB)} WITH (FORCE)`),
  ).catch((e) => log('  [pg] DROP failed (留库无害):', e.message));
  log(`  [pg] dropped temp database ${PG_DB}`);
}

let exitCode = 0;
const log = (...a) => console.log('[verify]', ...a);
const ok = (c, msg) => { if (c) log('  ✓', msg); else { log('  ✗ FAIL:', msg); exitCode = 1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 起真实 main.ts 服务（node --import tsx，与测试同口径；tsx 进程内加载，无孙进程）----
function startServer() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
      SQLITE_PATH,
      MIGRATIONS_DIR: join(ROOT, 'schema'),
      UPLOAD_DIR: join(DATA_DIR, 'uploads'),
      PUBLIC_BASE_URL: `http://localhost:${PORT}/uploads`,
      RSA_PRIVATE_KEY_PATH: join(DATA_DIR, 'keys', 'yggdrasil.pem'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; process.stdout.write(`  [srv] ${d}`); });
  child.stderr.on('data', (d) => { out += d; process.stderr.write(`  [srv!] ${d}`); });
  return { child, getOut: () => out };
}

async function waitForHttp(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`${BASE}/health/live`, { signal: AbortSignal.timeout(1000) }); if (r.status === 200) return true; } catch { /* not yet */ }
    await sleep(400);
  }
  return false;
}

function killChild(child) {
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
}
// node --import tsx 进程内加载，无孙进程；直接杀主进程即可
function killTreeWindows(child) {
  killChild(child);
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
async function get(path, headers) {
  const res = await fetch(`${BASE}${path}`, { headers });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const setupJsonPath = join(DATA_DIR, 'setup.json');

try {
  // ================= 阶段 1：安装模式 =================
  if (DB === 'postgresql') await ensurePgDb();
  log(`== 阶段 1：全新目录启动 → 安装模式（${DB}）==`);
  log('  dataDir =', DATA_DIR);
  const s1 = startServer();
  ok(await waitForHttp(), '服务起来（/health/live 200）');

  // 安装模式下业务接口应 403
  const me0 = await get('/api/me');
  ok(me0.status === 403 && me0.json.error === 'SETUP_REQUIRED', `装前 /api/me → 403 SETUP_REQUIRED（got ${me0.status}/${me0.json.error}）`);
  // 探测未安装
  const st0 = await get('/api/setup/status');
  ok(st0.json.setup_completed === false, '装前 status.setup_completed=false');

  // test-db 探测
  const probe = await post('/api/setup/test-db', DB === 'sqlite' ? { db_type: 'sqlite' } : { db_type: 'postgresql', db_host: PG_HOST, db_port: PG_PORT, db_name: PG_DB, db_user: PG_USER, db_password: PG_PASS });
  ok(probe.status === 200, `test-db 探测端点可达（status ${probe.status}）`);
  log('  test-db →', JSON.stringify(probe.json));

  // 探测 mysql 不支持
  const probeMy = await post('/api/setup/test-db', { db_type: 'mysql' });
  ok(probeMy.json.success === false && /MySQL|不支持/.test(probeMy.json.message), 'test-db(mysql) → 明确不支持');

  // complete
  log('  调用 /api/setup/complete …');
  const completeBody = {
    site_name: 'Live 安装验证站',
    default_language: 'JP',
    db_type: DB,
    admin_username: ADMIN.username,
    admin_email: ADMIN.email,
    admin_password: ADMIN.password,
  };
  if (DB === 'postgresql') Object.assign(completeBody, { db_host: PG_HOST, db_port: PG_PORT, db_name: PG_DB, db_user: PG_USER, db_password: PG_PASS });
  const comp = await post('/api/setup/complete', completeBody);
  log('  complete →', JSON.stringify(comp.json));
  ok(comp.status === 200 && comp.json.success === true, 'complete 成功（200 + success）');
  ok(comp.json.db_type === DB, `complete 返回 db_type=${DB}`);
  ok(typeof comp.json.admin_user_uid === 'number' && comp.json.admin_user_uid >= 1, `超管 user_uid=${comp.json.admin_user_uid}`);

  // setup.json 落盘
  ok(existsSync(setupJsonPath), 'setup.json 已落盘');
  if (existsSync(setupJsonPath)) {
    const rec = JSON.parse(readFileSync(setupJsonPath, 'utf8'));
    log('  setup.json =', JSON.stringify(rec));
    ok(rec.db.type === DB, `setup.json db.type=${DB}`);
    ok(rec.defaultLanguage === 'JP', 'setup.json defaultLanguage=JP');
    ok(rec.source === 'wizard', 'setup.json source=wizard');
  }

  // ---- 软重启（第十二批补充）：complete 后进程自动切换为正常模式 ----
  log('  等待原地软重启（轮询 /api/setup/status → mode=installed）…');
  let live = false;
  const liveT0 = Date.now();
  while (Date.now() - liveT0 < 30000) {
    try {
      const r = await fetch(`${BASE}/api/setup/status`, { signal: AbortSignal.timeout(1500) });
      const j = await r.json().catch(() => null);
      if (j?.mode === 'installed') { live = true; break; }
    } catch { /* 换绑瞬间连接被拒是预期内 */ }
    await sleep(500);
  }
  ok(live, '软重启生效：同一进程未手动重启，status.mode 翻为 installed');

  const pubLive = await get('/api/settings/public');
  ok(
    pubLive.status === 200 && pubLive.json.DEFAULT_LANGUAGE === 'JP',
    `软重启后业务接口已可用（/api/settings/public → ${pubLive.status}）`,
  );

  // 幂等闸门：装完再 complete → 拒绝（403 = 仍被安装 app 拦；404 = 正常 app 已无此路由）
  const comp2 = await post('/api/setup/complete', completeBody);
  ok(comp2.status === 403 || comp2.status === 404, `装完再 complete → 拒绝（got ${comp2.status}）`);

  killTreeWindows(s1.child);
  await sleep(1500);
  s1.child.kill?.('SIGKILL');
  log('  阶段 1 结束，kill 服务');

  // ================= 阶段 2：重启 → installed 正常模式 =================
  log('== 阶段 2：重启（同目录）→ 正常模式，验证库真可用 ==');
  const s2 = startServer();
  ok(await waitForHttp(), '重启后服务起来');

  // 现在是 installed 模式：status=true，业务接口不再 403
  const st1 = await get('/api/setup/status');
  ok(st1.json.setup_completed === true, '重启后 status.setup_completed=true');

  // /api/settings/public 含 DEFAULT_LANGUAGE=JP（多语言默认生效）
  const pub = await get('/api/settings/public');
  log('  /api/settings/public →', JSON.stringify(pub.json));
  ok(pub.status === 200 && pub.json.DEFAULT_LANGUAGE === 'JP', `公开设置 DEFAULT_LANGUAGE=JP（got ${pub.json.DEFAULT_LANGUAGE}）`);
  ok(pub.json.SITE_TITLE === 'Live 安装验证站', `公开设置 SITE_TITLE 正确（got ${pub.json.SITE_TITLE}）`);

  // 用向导建的超管登录（证明迁移+账号真可用）
  const login = await post('/api/auth/login', { email: ADMIN.email, password: ADMIN.password });
  log('  login →', JSON.stringify({ status: login.status, token: login.json.token ? `<set len=${String(login.json.token).length}>` : login.json }));
  ok(login.status === 200 && !!login.json.token, '超管登录成功（拿到 token）');

  // 若登录拿到 token，访问 /api/me 验证身份链路
  if (login.json.token) {
    const me = await get('/api/me', { Authorization: `Bearer ${login.json.token}` });
    log('  /api/me →', JSON.stringify(me.json));
    ok(me.status === 200 && me.json?.role === 'super_admin', `/api/me role=super_admin（got ${me.status} / ${me.json?.role}）`);
  }

  // 不可更改：installed 模式不再挂 /api/setup/complete（正常 app 只留只读 status），
  // 且 setup.json 的库类型未被改动。
  const comp3 = await post('/api/setup/complete', completeBody);
  ok(comp3.status === 404, `installed 模式 complete 路由不再存在 → 404（got ${comp3.status}）`);
  const rec2 = JSON.parse(readFileSync(setupJsonPath, 'utf8'));
  ok(rec2.db.type === DB, `setup.json db.type 重启后仍为 ${DB}（未被改写）`);

  // 库真可用：/health/ready 会真查库 + 写删存储，200 即证明 DB 连接生效
  const ready = await get('/health/ready');
  log('  /health/ready →', JSON.stringify(ready.json));
  ok(ready.status === 200 && ready.json.checks?.database === 'ok', '/health/ready database=ok（DB 真可用）');

  killTreeWindows(s2.child);
  await sleep(1000);
  s2.child.kill?.('SIGKILL');
} catch (e) {
  log('UNCAUGHT', e);
  exitCode = 1;
} finally {
  if (DB === 'postgresql') await dropPgDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  log('== 验证结束，exit', exitCode, '（临时目录已清理）==');
}
process.exit(exitCode);
