import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { SqliteConnection } from '../src/db/sqlite.js';
import type { DatabaseConnection } from '../src/types.js';
import { runMigrations } from '../src/migrate/runner.js';
import { TokenService } from '../src/auth/tokens.js';
import { IdentityService } from '../src/auth/identity.js';
import { TokenRepository } from '../src/repositories/tokenRepository.js';
import { UserRepository } from '../src/repositories/userRepository.js';
import { ProfileRepository } from '../src/repositories/profileRepository.js';
import { MinecraftSessionRepository } from '../src/repositories/minecraftSessionRepository.js';
import { BlobRepository } from '../src/repositories/blobRepository.js';
import { AssetRepository } from '../src/repositories/assetRepository.js';
import { FavoriteRepository } from '../src/repositories/favoriteRepository.js';
import { SettingRepository } from '../src/repositories/settingRepository.js';
import { AccountTokenRepository } from '../src/repositories/accountTokenRepository.js';
import { EmailChangeRepository } from '../src/repositories/emailChangeRepository.js';
import { TextureService } from '../src/textures/ingest.js';
import { LibraryService } from '../src/library/libraryService.js';
import { LocalDiskStorage } from '../src/storage/index.js';
import { AssetUrlResolver } from '../src/storage/assetUrl.js';
import { TextureProfileBuilder } from '../src/yggdrasil/textures.js';
import { loadOrCreateKeyPair } from '../src/yggdrasil/keys.js';
import { SecretBox } from '../src/util/secretBox.js';
import { sha256Hex } from '../src/util/crypto.js';
import { MailService } from '../src/mail/mailService.js';
import { SmtpMailer } from '../src/mail/smtpMailer.js';
import { RuntimeSettings } from '../src/site/runtimeSettings.js';
import { SiteUrlResolver } from '../src/site/siteUrl.js';
import { EmailFlow } from '../src/account/emailFlow.js';
import { EmailChangeFlow } from '../src/account/emailChangeFlow.js';
import { createApp, type AppDependencies } from '../src/server/app.js';
import type { AppConfig } from '../src/config.js';

/**
 * 真实 SMTP 端到端 —— 把邮件子系统接到一台**真的** SMTP 服务器上跑一遍。
 *
 * ## 为什么还需要这个文件
 *
 * `tests/emailFlow.test.ts` 注入的是 `MemoryMailer` 替身。它验证的是「业务层决定
 * 发什么」，**验证不到**下面这些只在真实 SMTP 事务里才成立的东西：
 *  - nodemailer 的 transport 能否真正建连（含 AUTH PLAIN/LOGIN）
 *  - RFC 5322 的 `"显示名" <地址>` From 头拼出来对端能否解析
 *  - 模板占位符替换后落进**真实报文**的结果（替身里拿到的是替换前的入参）
 *  - 邮件链接是否真的挂在「站点根」`BASE_URL` 上，而不是「当前请求的 host」
 *
 * 所以本文件把 `SmtpMailer` 接进依赖，投给 INDEV 里的便携 Mailpit，然后**从对端的
 * HTTP API 把报文读回来**做断言。断言的是对端收到的东西，不是我们自己以为发出去的东西。
 *
 * ## 门控
 *
 * 缺任一环境变量则整个文件 skip（默认 `npm test` 不受影响）：
 *
 *   TEST_SMTP_URL=smtp://127.0.0.1:10259
 *   TEST_SMTP_API_URL=http://127.0.0.1:18025
 *
 * 起服务：`INDEV\mailpit\start-mailpit.cmd`（见 INDEV/README.md）
 *
 * ## 为什么只跑 SQLite
 *
 * 邮箱链路与数据库方言无关，`account_tokens` 的 PG 方言已由 `emailFlow.test.ts`
 * 末尾的 PG 块覆盖。这里再跑一遍 PG 只是重复，故 `buildEnv` 固定用 SQLite，
 * 本文件也**不读** `TEST_DATABASE_URL`。
 *
 * ## 未覆盖（本机无法验，留作已知边界）
 *
 * 隐式 TLS（`SMTP_SECURE=true` / 465）。Mailpit 的 TLS 需要另配
 * `--smtp-tls-cert/--smtp-tls-key`，本文件只走明文 + STARTTLS 关闭这条路，
 * 即 `SMTP_SECURE=false`。
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');

const SMTP_URL = process.env['TEST_SMTP_URL']?.trim();
const SMTP_API_URL = process.env['TEST_SMTP_API_URL']?.trim();
const skip = !SMTP_URL || !SMTP_API_URL
  ? '未设置 TEST_SMTP_URL / TEST_SMTP_API_URL，跳过真实 SMTP 端到端（见文件头注释）'
  : false;

const MASTER_SECRET = 'mailpit-test-master-secret-0123456789';
/** 与请求的 host 刻意不同：邮件链接必须用设置里的站点根，不是当前请求的 origin */
const SITE_ORIGIN = 'https://skin.mailpit.test';
const SITE_TITLE = 'Mailpit E2E 皮肤站';
const SMTP_USER = 'mscts-e2e';
const SMTP_PASS = 'mailpit-e2e-password';
const SMTP_FROM = 'noreply@cattavern.local';
const SMTP_FROM_NAME = 'CatTavernSkins E2E';

const PASSWORD = 'password123';
const NEW_PASSWORD = 'newpassword456';

// ---------------------------------------------------------------------------
// Mailpit 客户端（只用到读/清空，投递由 MSCTS 自己完成）
// ---------------------------------------------------------------------------

interface MailpitAddress {
  Name?: string;
  Address: string;
}

interface MailpitSummary {
  ID: string;
  Subject: string;
  From: MailpitAddress;
  To: MailpitAddress[];
}

interface MailpitDetail extends MailpitSummary {
  HTML: string;
  Text: string;
}

class MailpitClient {
  constructor(private readonly apiBase: string) {}

  private async request<T>(path: string, method = 'GET'): Promise<T> {
    const res = await fetch(`${this.apiBase}${path}`, { method });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Mailpit ${method} ${path} → ${res.status}：${text.slice(0, 300)}`);
    }
    // 注意：DELETE /api/v1/messages 回的是纯文本 `ok` 而不是 JSON，
    // 无条件 JSON.parse 会抛 SyntaxError，所以按 content-type 判断。
    const isJson = (res.headers.get('content-type') ?? '').includes('json');
    return (text && isJson ? JSON.parse(text) : null) as T;
  }

  async clear(): Promise<void> {
    await this.request<unknown>('/api/v1/messages', 'DELETE');
  }

  async list(): Promise<MailpitSummary[]> {
    const data = await this.request<{ messages?: MailpitSummary[] }>(
      '/api/v1/messages?limit=100',
    );
    return data.messages ?? [];
  }

  async detail(id: string): Promise<MailpitDetail> {
    return this.request<MailpitDetail>(`/api/v1/message/${id}`);
  }

  /**
   * 等收件箱里出现发给 `to` 的邮件。
   * `send()` 返回前 SMTP 事务其实已经完成，但 Mailpit 落盘与 API 可见之间仍有
   * 毫秒级间隙，所以轮询而不是直接读 —— 直接读会偶发 flaky。
   */
  async waitFor(to: string, timeoutMs = 10_000): Promise<MailpitDetail> {
    const deadline = Date.now() + timeoutMs;
    let seen: MailpitSummary[] = [];
    for (;;) {
      seen = await this.list();
      const hit = seen.find((m) => m.To.some((t) => t.Address === to));
      if (hit) return this.detail(hit.ID);
      if (Date.now() >= deadline) {
        throw new Error(
          `Mailpit 在 ${timeoutMs}ms 内未收到发给 ${to} 的邮件；` +
            `当前邮箱：${JSON.stringify(seen.map((m) => m.To.map((t) => t.Address)))}`,
        );
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

/** `smtp://host:port` → `{ host, port }`；缺省端口按 587 处理 */
function parseSmtpUrl(raw: string): { host: string; port: number } {
  const url = new URL(raw);
  if (url.protocol !== 'smtp:') {
    throw new Error(`TEST_SMTP_URL 协议应为 smtp:，实际为 ${url.protocol}`);
  }
  return {
    host: url.hostname,
    port: url.port === '' ? 587 : Number(url.port),
  };
}

// ---------------------------------------------------------------------------
// 被测环境
// ---------------------------------------------------------------------------

interface Env {
  db: DatabaseConnection;
  baseUrl: string;
  mailpit: MailpitClient;
  /** 解析后的 SMTP 端点，用于拼出「期望的配置」 */
  smtp: { host: string; port: number };
  /** 用于在直接改库之后让设置缓存立即失效 */
  runtime: RuntimeSettings;
  /** 播种超管时构造 IdentityService 用 */
  tokenService: TokenService;
  adminToken: string;
  close: () => Promise<void>;
}

let envRef: Env | undefined;

async function buildEnv(): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), 'mscts-mailpit-'));
  const db = new SqliteConnection(join(dir, 't.db'));
  await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));

  const config: AppConfig = {
    dialect: 'sqlite',
    sqlitePath: join(dir, 't.db'),
    migrationsRoot: SCHEMA_DIR,
    uploadDir: join(dir, 'uploads'),
    // 素材前缀（部署形态）与站点根刻意不同，用来证明邮件链接取的是后者
    publicBaseUrl: 'http://localhost:3000/uploads',
    rsaPrivateKeyPath: join(dir, 'keys', 'yggdrasil.pem'),
    skinDomains: ['localhost'],
  };

  const storage = new LocalDiskStorage(config.uploadDir, config.publicBaseUrl);
  const rsaKeyPair = loadOrCreateKeyPair(config.rsaPrivateKeyPath);
  const users = new UserRepository(db);
  const profiles = new ProfileRepository(db);
  const assets = new AssetRepository(db);
  const blobs = new BlobRepository(db);
  const tokenService = new TokenService(new TokenRepository(db));
  const settings = new SettingRepository(db);
  const identity = new IdentityService({
    db,
    users,
    profiles,
    tokens: tokenService,
    sessions: new MinecraftSessionRepository(db),
  });
  const secretBox = new SecretBox(MASTER_SECRET);
  const runtime = new RuntimeSettings({ settings, secretBox });
  const siteUrl = new SiteUrlResolver({ settings });
  const accountTokens = new AccountTokenRepository(db);

  // 唯一的替身差异：真实 SMTP 而非 MemoryMailer
  const mailer = new SmtpMailer(runtime);
  const mailService = new MailService({ mailer, runtime });
  const emailFlow = new EmailFlow({
    db,
    users,
    tokens: accountTokens,
    tokenService,
    mail: mailService,
    siteUrl,
    passwords: identity,
  });
  const resolver = new AssetUrlResolver(storage);

  // 0003：备用邮箱与改邮箱流程。同样接真实 SMTP —— 本文件存在的意义就是
  // 「邮件真的发出去了」，用替身收信就失去了验证价值
  const emailChangeFlow = new EmailChangeFlow({
    db,
    users,
    changes: new EmailChangeRepository(db),
    mail: mailService,
    siteUrl,
    emails: identity,
  });

  const deps: AppDependencies = {
    config,
    database: db,
    storage,
    tokenService,
    rsaKeyPair,
    identity,
    profileRepository: profiles,
    assetRepository: assets,
    minecraftSessions: new MinecraftSessionRepository(db),
    textureBuilder: new TextureProfileBuilder(rsaKeyPair.privateKeyPem),
    assetUrlResolver: resolver,
    textures: new TextureService({ db, storage, blobs, assets, profiles }),
    library: new LibraryService({
      assets,
      favorites: new FavoriteRepository(db),
      blobs,
      users,
      resolver,
    }),
    settings,
    siteUrlResolver: siteUrl,
    runtimeSettings: runtime,
    emailFlow,
    emailChangeFlow,
    mailService,
    secretBox,
  };

  const server = createApp(deps).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    db,
    baseUrl: `http://127.0.0.1:${port}`,
    mailpit: new MailpitClient(SMTP_API_URL as string),
    smtp: parseSmtpUrl(SMTP_URL as string),
    runtime,
    tokenService,
    adminToken: '',
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await db.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function api(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (init.token) headers['authorization'] = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${env().baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function env(): Env {
  if (!envRef) throw new Error('env not ready');
  return envRef;
}

async function saveSettings(entries: Record<string, unknown>): Promise<void> {
  const res = await api('/api/admin/settings', {
    method: 'PUT',
    token: env().adminToken,
    body: entries,
  });
  assert.equal(res.status, 200, `保存设置失败：${JSON.stringify(res.body)}`);
}

/** 以 SMTP 配置为准拼出「管理员应该填的那一组设置」 */
function smtpSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    BASE_URL: SITE_ORIGIN,
    SITE_TITLE,
    SMTP_HOST: env().smtp.host,
    SMTP_PORT: env().smtp.port,
    SMTP_SECURE: false,
    SMTP_USER,
    SMTP_PASS,
    SMTP_FROM,
    SMTP_FROM_NAME,
    ...overrides,
  };
}

/** 从真实报文的 HTML 里抠出动作令牌（链接查询串在 `#` 之后，必须解析 hash） */
function tokenFromHtml(html: string, hashPath: string): string {
  const hrefs = html.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  const hit = hrefs.find((u) => u.includes(`#${hashPath}`));
  assert.ok(hit, `邮件 HTML 里应当含 ${hashPath} 链接，实际匹配到：${hrefs.join(' | ')}`);
  const hash = new URL(hit).hash;
  const q = hash.indexOf('?');
  assert.ok(q >= 0, `链接应当带查询串：${hit}`);
  const token = new URLSearchParams(hash.slice(q + 1)).get('token');
  assert.ok(token, `链接应当含 token 参数：${hit}`);
  return token;
}

/** 直接查库：断言原始令牌只以 sha256 落库 */
async function tokenHashRows(table: string): Promise<string[]> {
  const rows = await env().db.query<{ token_hash: string }>(
    `SELECT token_hash FROM ${table}`,
  );
  return rows.map((r) => r.token_hash);
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 10)}@test.local`;
}

function uniqueName(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

before(async () => {
  if (skip) return;
  const env = await buildEnv();
  envRef = env;

  // 播种一个超管：注册 → 直接改库提权（没有 setup 端点，这是唯一的引导方式）
  const identity = new IdentityService({
    db: env.db,
    users: new UserRepository(env.db),
    profiles: new ProfileRepository(env.db),
    tokens: env.tokenService,
    sessions: new MinecraftSessionRepository(env.db),
  });
  const res = await identity.register({
    email: 'admin@test.local',
    password: PASSWORD,
    profileName: 'mp_admin',
  });
  assert.ok(res.token, '管理员注册应当签发会话令牌');
  await new UserRepository(env.db).updateAdminFields(
    res.user.id,
    { role: 'super_admin' },
    new Date(),
  );
  env.adminToken = res.token.token;
});

after(async () => {
  await envRef?.close();
});

// ---------------------------------------------------------------------------
// 1. 配置与连通性
// ---------------------------------------------------------------------------

test('SMTP：配好后台设置后 test-smtp 能真正连上 Mailpit', { skip }, async () => {
  await saveSettings(smtpSettings());

  // 口令以密文入库，且对外只回空串 + xxx_SET
  const rows = await env().db.query<{ key: string; value: string }>(
    "SELECT key, value FROM system_settings WHERE key = 'SMTP_PASS'",
  );
  const stored = rows[0]?.value;
  assert.ok(stored, 'SMTP_PASS 应当已落库');
  assert.ok(
    stored.includes('enc:v1:'),
    `SMTP_PASS 必须以 enc:v1: 密文形态存储，实际：${stored.slice(0, 24)}`,
  );
  assert.ok(!stored.includes(SMTP_PASS), '库里不得出现口令明文');

  const masked = await api('/api/admin/settings', { token: env().adminToken });
  assert.equal(masked.body.SMTP_PASS, '', '读回时必须脱敏为空串');
  assert.equal(masked.body.SMTP_PASS_SET, true, '必须告诉前端「已设置」');

  const probe = await api('/api/admin/test-smtp', {
    method: 'POST',
    token: env().adminToken,
  });
  assert.equal(probe.status, 200, JSON.stringify(probe.body));
  assert.equal(probe.body.success, true, `真实 SMTP 握手失败：${JSON.stringify(probe.body)}`);
});

test('SMTP：错的端口不会假装成功（诊断按钮必须说真话）', { skip }, async () => {
  await saveSettings({ SMTP_PORT: 1 });
  const probe = await api('/api/admin/test-smtp', {
    method: 'POST',
    token: env().adminToken,
  });
  // 诊断按钮刻意「失败也回 200」，因此这里不能只断言 status
  assert.equal(probe.status, 200);
  assert.equal(probe.body.success, false, `端口 1 不可能连上，却回了：${JSON.stringify(probe.body)}`);
  assert.ok(probe.body.error, '失败时应给出原因');

  // 还原，后面的用例依赖它
  await saveSettings({ SMTP_PORT: env().smtp.port });
  const again = await api('/api/admin/test-smtp', {
    method: 'POST',
    token: env().adminToken,
  });
  assert.equal(again.body.success, true, '还原端口后应恢复成功');
});

// ---------------------------------------------------------------------------
// 2. 邮箱验证：真实投递 → 回读报文 → 校验令牌
// ---------------------------------------------------------------------------

test('验证邮件：注册触发真实投递，报文头与链接都正确', { skip }, async () => {
  await saveSettings({ ALLOW_REGISTRATION: true, REQUIRE_EMAIL_VERIFICATION: true });

  const email = uniqueEmail('verify');
  await env().mailpit.clear();

  const res = await api('/api/auth/register', {
    method: 'POST',
    body: { email, password: PASSWORD, profileName: uniqueName('v_') },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.token, null, '要求邮箱验证时不得签发会话');
  assert.equal(res.body.requiresVerification, true);
  assert.equal(res.body.verificationEmailSent, true);

  const mail = await env().mailpit.waitFor(email);

  // From：RFC 5322 的 `"显示名" <地址>` 必须能被对端解析成 Name + Address
  assert.equal(mail.From.Address, SMTP_FROM);
  assert.equal(mail.From.Name, SMTP_FROM_NAME);
  assert.ok(mail.Subject.length > 0, '主题不应为空');

  // 链接必须挂在「站点根」上，且是 HashRouter 形态。
  // 注意 SITE_ORIGIN 与请求 host 刻意不同 —— 用请求 host 拼就过不了这一条。
  const token = tokenFromHtml(mail.HTML, '/verify-email');
  assert.ok(
    mail.HTML.includes(SITE_ORIGIN),
    `邮件链接应使用站点根 ${SITE_ORIGIN}`,
  );
  assert.ok(
    mail.HTML.includes(`${SITE_ORIGIN}/#/verify-email?token=`),
    '邮件链接必须是 HashRouter 形态（origin/#/path?query）',
  );
  // 素材前缀不得出现（那是部署形态用的另一个地址）
  assert.ok(
    !mail.HTML.includes('localhost:3000'),
    '邮件里不得出现素材前缀 PUBLIC_BASE_URL',
  );

  // 原文令牌只以 sha256 落库
  const hashes = await tokenHashRows('email_verification_tokens');
  assert.ok(hashes.includes(sha256Hex(token)), '库内应当存该令牌的 sha256');
  assert.ok(!hashes.includes(token), '库内不得存令牌原文');

  // 消费一次成功、第二次 401（真实邮件客户端会预取链接，必须只能生效一次）
  const first = await api('/api/auth/verify-email', {
    method: 'POST',
    body: { token },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.email, email);

  const replay = await api('/api/auth/verify-email', {
    method: 'POST',
    body: { token },
  });
  assert.equal(replay.status, 401, '同一令牌不得二次消费');
  assert.equal(replay.body.error, 'TOKEN_REVOKED');

  // 验证完成后才允许登录
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.user.emailVerified, true);
});

test('验证邮件：未验证账号登录被拒，且与密码错给同一个错码', { skip }, async () => {
  const email = uniqueEmail('unverified');
  await env().mailpit.clear();

  const res = await api('/api/auth/register', {
    method: 'POST',
    body: { email, password: PASSWORD, profileName: uniqueName('u_') },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  await env().mailpit.waitFor(email);

  const blocked = await api('/api/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  assert.equal(blocked.status, 403, JSON.stringify(blocked.body));
  assert.equal(blocked.body.error, 'EMAIL_NOT_VERIFIED');

  // 密码错时不暴露「这个账号存在但没验证」
  const wrong = await api('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'wrong-password-1' },
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, 'INVALID_CREDENTIALS');
});

// ---------------------------------------------------------------------------
// 3. 密码重置：真实投递 + 防枚举 + 一次性
// ---------------------------------------------------------------------------

test('重置邮件：未知邮箱也回 ok 但不发信（防枚举）', { skip }, async () => {
  await env().mailpit.clear();

  const unknown = await api('/api/auth/send-reset-email', {
    method: 'POST',
    body: { email: uniqueEmail('ghost') },
  });
  assert.equal(unknown.status, 200, JSON.stringify(unknown.body));
  assert.deepEqual(unknown.body, { ok: true }, '响应体不得泄露账号是否存在');

  assert.equal(
    (await env().mailpit.list()).length,
    0,
    '未知邮箱不得产生任何邮件',
  );

  // 缺 email 字段则明确 400（这不是枚举问题，是参数问题）
  const bad = await api('/api/auth/send-reset-email', {
    method: 'POST',
    body: {},
  });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
});

test('重置邮件：链接与令牌正确，弱密码被拒且不消耗令牌', { skip }, async () => {
  const email = uniqueEmail('reset');
  await env().mailpit.clear();

  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: { email, password: PASSWORD, profileName: uniqueName('r_') },
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  // 注册本身会发验证信，先清掉，免得 waitFor 抓错封
  await env().mailpit.clear();

  const sent = await api('/api/auth/send-reset-email', {
    method: 'POST',
    body: { email },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));

  const mail = await env().mailpit.waitFor(email);
  const token = tokenFromHtml(mail.HTML, '/reset-password');
  assert.ok(
    mail.HTML.includes(`${SITE_ORIGIN}/#/reset-password?token=`),
    '重置链接必须是 HashRouter 形态',
  );

  const hashes = await tokenHashRows('password_reset_tokens');
  assert.ok(hashes.includes(sha256Hex(token)), '库内应当存该重置令牌的 sha256');
  assert.ok(!hashes.includes(token), '库内不得存重置令牌原文');

  // 弱密码：先 400，且**不得**把令牌吃掉（否则用户改错一次就得重发邮件）
  const weak = await api('/api/auth/reset-password', {
    method: 'POST',
    body: { token, password: 'short' },
  });
  assert.equal(weak.status, 400, JSON.stringify(weak.body));

  const ok = await api('/api/auth/reset-password', {
    method: 'POST',
    body: { token, password: NEW_PASSWORD },
  });
  assert.equal(ok.status, 200, `弱密码被拒后令牌仍应可用：${JSON.stringify(ok.body)}`);

  const withNew = await api('/api/auth/login', {
    method: 'POST',
    body: { email, password: NEW_PASSWORD },
  });
  assert.equal(withNew.status, 200, JSON.stringify(withNew.body));

  const withOld = await api('/api/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  assert.equal(withOld.status, 401, '旧密码必须失效');
});

// ---------------------------------------------------------------------------
// 4. 邮件模板：改了必须影响**下一封真实报文**
// ---------------------------------------------------------------------------

test('模板：自定义主题与正文的占位符在真实报文里被替换', { skip }, async () => {
  const email = uniqueEmail('tpl');
  await env().mailpit.clear();

  const tpl = await api('/api/admin/email-template', {
    method: 'PUT',
    token: env().adminToken,
    body: {
      subject: '[E2E] {{SITE_TITLE}} 重置 {{EMAIL}} ({{YEAR}})',
      html: '<p>HI {{EMAIL}}</p><a href="{{RESET_URL}}">GO</a><p>raw={{NOPE}}</p>',
    },
  });
  assert.equal(tpl.status, 200, JSON.stringify(tpl.body));

  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: { email, password: PASSWORD, profileName: uniqueName('t_') },
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  await env().mailpit.clear();

  const sent = await api('/api/auth/send-reset-email', {
    method: 'POST',
    body: { email },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));

  const mail = await env().mailpit.waitFor(email);

  // 改模板前 saveSettings 已 refresh，所以这一封就应当是新模板 —— 若缓存漏刷，
  // 这里拿到的还是内置模板，主题会是「【…】重置密码」而不是 [E2E] 开头的
  assert.equal(
    mail.Subject,
    `[E2E] ${SITE_TITLE} 重置 ${email} (${new Date().getUTCFullYear()})`,
  );
  assert.ok(mail.HTML.includes(`HI ${email}`), `{{EMAIL}} 未被替换：${mail.HTML}`);
  assert.ok(
    mail.HTML.includes(`${SITE_ORIGIN}/#/reset-password?token=`),
    `{{RESET_URL}} 未被替换：${mail.HTML}`,
  );
  // 未识别的占位符按文档「原样留下」，不得被吞掉
  assert.ok(mail.HTML.includes('{{NOPE}}'), `未知占位符应原样保留：${mail.HTML}`);

  // 清空模板后应回落到内置模板（返回默认值 + isDefault 标记）
  await api('/api/admin/email-template', {
    method: 'PUT',
    token: env().adminToken,
    body: { subject: 'x', html: 'y' },
  });
  const back = await api('/api/admin/email-template', { token: env().adminToken });
  assert.equal(back.status, 200);
  assert.equal(back.body.isDefault, false, '刚存过自定义模板，此时不该是默认');
});

test('模板：只填一半视为未配置，读取接口给带占位符的内置默认', { skip }, async () => {
  // 清掉模板键，模拟「从未配置过」
  await env().db.run("DELETE FROM system_settings WHERE key LIKE 'EMAIL_TEMPLATE_%'");
  // 直接改库绕过了 HTTP 层，缓存里还留着旧模板 —— 手动失效
  await env().runtime.refresh();
  const res = await api('/api/admin/email-template', { token: env().adminToken });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.isDefault, true, '从未配置时应报告用的是内置模板');
  assert.ok(
    String(res.body.html).includes('{{VERIFY_URL}}'),
    '内置默认必须带占位符，管理员才有上手点',
  );
});

// ---------------------------------------------------------------------------
// 5. 0003：备用邮箱与改邮箱 —— 四类新邮件也必须真的发出去
// ---------------------------------------------------------------------------

/**
 * 注册一个注册后**直接拿到会话**的普通用户。
 *
 * 必须显式关掉 REQUIRE_EMAIL_VERIFICATION：本文件里的站点设置是共享的，
 * 前面「验证邮件」那组把它打开过，留着会让注册只回 requiresVerification 而没有会话。
 */
async function registerUser(prefix: string): Promise<{ email: string; token: string }> {
  const email = uniqueEmail(prefix);
  const res = await api('/api/auth/register', {
    method: 'POST',
    body: { email, password: PASSWORD, profileName: uniqueName(`${prefix}_`) },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.token, `注册应直接签发会话：${JSON.stringify(res.body)}`);
  // 注意：HTTP 层把服务返回的 `{ token: { token, expiresAt } }` 摊平成了裸字符串
  return { email, token: res.body.token as string };
}

/** 给某个用户绑好一枚已验证的备用邮箱，返回该地址 */
async function bindVerifiedBackup(userToken: string, prefix: string): Promise<string> {
  const backup = uniqueEmail(prefix);
  const req = await api('/api/me/backup-email', {
    method: 'POST',
    token: userToken,
    body: { email: backup },
  });
  assert.equal(req.status, 200, JSON.stringify(req.body));
  assert.equal(req.body.sent, true, '应当真的发出验证信');

  const mail = await env().mailpit.waitFor(backup);
  const token = tokenFromHtml(mail.HTML, '/verify-backup-email');
  const ok = await api('/api/me/backup-email/verify', {
    method: 'POST',
    body: { token },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  return backup;
}

test('备用邮箱：验证邮件真实投递，令牌只存哈希且只能用一次', { skip }, async () => {
  await saveSettings({ ALLOW_REGISTRATION: true, REQUIRE_EMAIL_VERIFICATION: false });
  const user = await registerUser('bk');
  const backup = uniqueEmail('bkbackup');
  await env().mailpit.clear();

  const req = await api('/api/me/backup-email', {
    method: 'POST',
    token: user.token,
    body: { email: backup },
  });
  assert.equal(req.status, 200, JSON.stringify(req.body));
  assert.equal(req.body.pendingEmail, backup.toLowerCase());
  assert.equal(req.body.alreadyVerified, false);

  const mail = await env().mailpit.waitFor(backup);
  assert.equal(mail.From.Address, SMTP_FROM);
  assert.equal(mail.From.Name, SMTP_FROM_NAME);
  assert.equal(mail.Subject, `【${SITE_TITLE}】请验证你的备用邮箱`);

  // 链接同样必须挂在站点根上，且是 HashRouter 形态
  const token = tokenFromHtml(mail.HTML, '/verify-backup-email');
  assert.ok(
    mail.HTML.includes(`${SITE_ORIGIN}/#/verify-backup-email?token=`),
    `备用邮箱链接形态不对：${mail.HTML.slice(0, 500)}`,
  );
  assert.ok(
    !mail.HTML.includes('localhost:3000'),
    '邮件里不得出现素材前缀 PUBLIC_BASE_URL',
  );

  // 原文令牌只以 sha256 落库
  const hashes = await tokenHashRows('backup_email_tokens');
  assert.ok(hashes.includes(sha256Hex(token)), '库内应当存该令牌的 sha256');
  assert.ok(!hashes.includes(token), '库内不得存令牌原文');

  const status = await api('/api/me/email-status', { token: user.token });
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(status.body.hasVerifiedBackup, false, '未点链接前不算已验证');
  assert.equal(status.body.backupEmailRecommended, true, '未验证时应提示补备用邮箱');

  const ok = await api('/api/me/backup-email/verify', {
    method: 'POST',
    body: { token },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.email, backup.toLowerCase());

  const after = await api('/api/me/email-status', { token: user.token });
  assert.equal(after.body.hasVerifiedBackup, true);
  assert.equal(after.body.backupEmailVerified, true);
  assert.equal(after.body.backupEmailRecommended, false, '已验证后不再提示');

  // 真实邮件客户端会预取链接 —— 同一令牌不得二次生效
  const replay = await api('/api/me/backup-email/verify', {
    method: 'POST',
    body: { token },
  });
  assert.equal(replay.status, 401, '同一令牌不得二次消费');
  assert.equal(replay.body.error, 'TOKEN_REVOKED');
});

test('改邮箱：新址收到确认信、备用邮箱收到授权信、旧地址只收到通知', { skip }, async () => {
  await saveSettings({ ALLOW_REGISTRATION: true, REQUIRE_EMAIL_VERIFICATION: false });
  const user = await registerUser('chg');

  const backup = await bindVerifiedBackup(user.token, 'chgbackup');
  const newEmail = uniqueEmail('chgnew');
  await env().mailpit.clear();

  const req = await api('/api/me/email-change', {
    method: 'POST',
    token: user.token,
    body: { target: 'primary', newEmail },
  });
  assert.equal(req.status, 200, JSON.stringify(req.body));
  // 有已验证备用邮箱 → 由它授权，不回落到自己
  assert.equal(req.body.authorizeVia, 'backup');
  assert.equal(req.body.authorizeEmail, backup);
  assert.equal(req.body.fallbackToSelf, false);
  assert.equal(req.body.backupEmailRecommended, false);

  // 两封真邮件，各自的主题与收件人都要对
  const verifyMail = await env().mailpit.waitFor(newEmail);
  assert.equal(verifyMail.Subject, `【${SITE_TITLE}】请确认新的邮箱地址`);
  assert.ok(
    verifyMail.HTML.includes(`${SITE_ORIGIN}/#/confirm-email-change?token=`),
    '新地址那封的链接形态不对',
  );

  const authMail = await env().mailpit.waitFor(backup);
  assert.equal(authMail.Subject, `【${SITE_TITLE}】请授权邮箱变更`);
  assert.ok(
    authMail.HTML.includes(`${SITE_ORIGIN}/#/confirm-email-change?token=`),
    '授权那封的链接形态不对',
  );

  const verifyToken = tokenFromHtml(verifyMail.HTML, '/confirm-email-change');
  const authToken = tokenFromHtml(authMail.HTML, '/confirm-email-change');
  assert.notEqual(verifyToken, authToken, '两枚令牌必须不同');
  // 两枚都只以哈希落库
  const hashes = await tokenHashRows('email_change_tokens');
  assert.ok(hashes.includes(sha256Hex(verifyToken)));
  assert.ok(hashes.includes(sha256Hex(authToken)));
  assert.ok(!hashes.includes(verifyToken));

  // 只消费一枚不得生效 —— 这是「交叉授权」的核心保证
  const first = await api('/api/me/email-change/confirm', {
    method: 'POST',
    body: { token: verifyToken },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.completed, false, '只点了一侧不得生效');
  assert.equal(first.body.role, 'verify');
  assert.equal(first.body.waitingFor, 'authorize');

  const half = await api('/api/me/email-status', { token: user.token });
  assert.equal(half.body.email, user.email, '未完成时主邮箱不得变化');
  assert.equal(half.body.pendingChange.verifyConfirmed, true);
  assert.equal(half.body.pendingChange.authorizeConfirmed, false);

  // 第二枚到位 → 生效
  const second = await api('/api/me/email-change/confirm', {
    method: 'POST',
    body: { token: authToken },
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.completed, true);
  assert.equal(second.body.role, 'authorize');
  assert.equal(second.body.email, newEmail.toLowerCase());

  const done = await api('/api/me/email-status', { token: user.token });
  assert.equal(done.body.email, newEmail.toLowerCase());
  assert.equal(done.body.pendingChange, null, '完成后不应残留进行中的请求');

  // 通知信：只发往**被替换掉的旧地址**，且新旧地址都在正文里
  const notice = await env().mailpit.waitFor(user.email);
  assert.equal(notice.Subject, `【${SITE_TITLE}】邮箱已变更`);
  assert.ok(notice.HTML.includes(user.email), `通知里应有旧地址：${notice.HTML}`);
  assert.ok(
    notice.HTML.includes(newEmail.toLowerCase()),
    `通知里应有新地址：${notice.HTML}`,
  );
  // 通知是纯告知，不该带任何可点的动作链接
  assert.ok(
    !notice.HTML.includes('/#/confirm-email-change'),
    '通知信不应带动作链接（它只是知情通知）',
  );

  // 新地址只该收到「确认」一封，不该同时收到变更通知
  const toNew = (await env().mailpit.list()).filter((m) =>
    m.To.some((t) => t.Address === newEmail.toLowerCase()),
  );
  assert.equal(
    toNew.length,
    1,
    `新地址应只收到 1 封（确认新地址），实际 ${toNew.length} 封`,
  );

  // 改完之后：旧地址不再能登录，新地址可以
  const oldLogin = await api('/api/auth/login', {
    method: 'POST',
    body: { email: user.email, password: PASSWORD },
  });
  assert.equal(oldLogin.status, 401, '旧邮箱不应还能登录');
  const newLogin = await api('/api/auth/login', {
    method: 'POST',
    body: { email: newEmail, password: PASSWORD },
  });
  assert.equal(newLogin.status, 200, JSON.stringify(newLogin.body));
});

test('改邮箱：没有备用邮箱时授权回落到自己，且明确提示补一个', { skip }, async () => {
  await saveSettings({ ALLOW_REGISTRATION: true, REQUIRE_EMAIL_VERIFICATION: false });
  const user = await registerUser('self');
  const newEmail = uniqueEmail('selfnew');
  await env().mailpit.clear();

  const req = await api('/api/me/email-change', {
    method: 'POST',
    token: user.token,
    body: { target: 'primary', newEmail },
  });
  assert.equal(req.status, 200, JSON.stringify(req.body));
  // 单邮箱账号不能死锁：授权方回落到当前主邮箱自己
  assert.equal(req.body.authorizeVia, 'primary');
  assert.equal(req.body.authorizeEmail, user.email);
  assert.equal(req.body.fallbackToSelf, true);
  assert.equal(req.body.backupEmailRecommended, true, '应提示补一个备用邮箱');

  // 两封邮件：一封给新址（确认），一封给当前主邮箱（授权）
  const verifyMail = await env().mailpit.waitFor(newEmail);
  assert.equal(verifyMail.Subject, `【${SITE_TITLE}】请确认新的邮箱地址`);
  const authMail = await env().mailpit.waitFor(user.email);
  assert.equal(authMail.Subject, `【${SITE_TITLE}】请授权邮箱变更`);

  const verifyToken = tokenFromHtml(verifyMail.HTML, '/confirm-email-change');
  const authToken = tokenFromHtml(authMail.HTML, '/confirm-email-change');
  assert.notEqual(verifyToken, authToken);

  // 回落路径同样必须两枚齐了才生效
  const a = await api('/api/me/email-change/confirm', {
    method: 'POST',
    body: { token: verifyToken },
  });
  assert.equal(a.body.completed, false);
  const b = await api('/api/me/email-change/confirm', {
    method: 'POST',
    body: { token: authToken },
  });
  assert.equal(b.body.completed, true, JSON.stringify(b.body));
  assert.equal(b.body.email, newEmail.toLowerCase());
});

test('模板：自定义验证模板不得污染 0003 的四类邮件', { skip }, async () => {
  const CUSTOM_SUBJECT = '[CUSTOM] 这是管理员自定义的验证主题';

  // 先证明自定义模板对 verify **确实生效**
  const put = await api('/api/admin/email-template', {
    method: 'PUT',
    token: env().adminToken,
    body: {
      subject: CUSTOM_SUBJECT,
      html: '<p>CUSTOM BODY {{EMAIL}}</p><a href="{{ACTION_URL}}">GO</a>',
    },
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  await saveSettings({ ALLOW_REGISTRATION: true, REQUIRE_EMAIL_VERIFICATION: true });

  const regEmail = uniqueEmail('tplverify');
  await env().mailpit.clear();
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: { email: regEmail, password: PASSWORD, profileName: uniqueName('tv_') },
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const regMail = await env().mailpit.waitFor(regEmail);
  assert.equal(regMail.Subject, CUSTOM_SUBJECT, 'verify 应当用自定义主题');
  assert.ok(
    regMail.HTML.includes(`${SITE_ORIGIN}/#/verify-email?token=`),
    '{{ACTION_URL}} 应与 VERIFY_URL 同值',
  );

  // 再证明显式白名单之外的种类**不吃**自定义模板：
  // 管理端只有一个模板槽（verify/reset），0003 的四类走内置正文。
  // 否则管理员改一次验证信文案，会连带把改邮箱流程的措辞也改掉 —— 而他对
  // 那三封的用途与措辞毫不知情。
  await saveSettings({ REQUIRE_EMAIL_VERIFICATION: false });
  const user = await registerUser('tplbk');
  const backup = uniqueEmail('tplbackup');
  await env().mailpit.clear();

  const req = await api('/api/me/backup-email', {
    method: 'POST',
    token: user.token,
    body: { email: backup },
  });
  assert.equal(req.status, 200, JSON.stringify(req.body));
  const backupMail = await env().mailpit.waitFor(backup);
  assert.equal(
    backupMail.Subject,
    `【${SITE_TITLE}】请验证你的备用邮箱`,
    'backup_verify 必须用内置主题，不得被自定义 verify 模板污染',
  );
  assert.ok(
    !backupMail.HTML.includes('CUSTOM BODY'),
    'backup_verify 必须用内置正文，不得被自定义 verify 模板污染',
  );

  // 收尾：把模板槽清空，避免影响后续/重跑
  await env().db.run("DELETE FROM system_settings WHERE key LIKE 'EMAIL_TEMPLATE_%'");
  await env().runtime.refresh();
});
