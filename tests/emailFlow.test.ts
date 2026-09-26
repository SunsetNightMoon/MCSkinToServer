import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { PostgresConnection } from '../src/db/postgres.js';
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
import { TextureService } from '../src/textures/ingest.js';
import { LibraryService } from '../src/library/libraryService.js';
import { LocalDiskStorage } from '../src/storage/index.js';
import { AssetUrlResolver } from '../src/storage/assetUrl.js';
import { TextureProfileBuilder } from '../src/yggdrasil/textures.js';
import { loadOrCreateKeyPair } from '../src/yggdrasil/keys.js';
import { SecretBox } from '../src/util/secretBox.js';
import { sha256Hex } from '../src/util/crypto.js';
import { AppError } from '../src/errors.js';
import { MailService } from '../src/mail/mailService.js';
import type { MailMessage, MailPort } from '../src/mail/types.js';
import { MAIL_PLACEHOLDERS } from '../src/mail/templates.js';
import { RuntimeSettings } from '../src/site/runtimeSettings.js';
import { SiteUrlResolver } from '../src/site/siteUrl.js';
import {
  EmailFlow,
  VERIFICATION_TTL_MS,
  RESET_TTL_MS,
} from '../src/account/emailFlow.js';
import { createApp, type AppDependencies } from '../src/server/app.js';
import type { AppConfig } from '../src/config.js';

/**
 * P5 账号辅助流程端到端：三个开关接线 + 邮箱验证 + 密码重置 + 邮件子系统。
 *
 * 刻意**走完整 HTTP 栈**（而不是直接调 EmailFlow），因为本批修的两类缺陷
 * 恰恰只在链路上才暴露：
 *  1. 开关存的是布尔 false、读的是 `!== 'false'` → 「关掉注册仍能注册」
 *  2. 管理端的 `/api/admin/email-template`、`/api/admin/test-smtp` 后端根本不存在
 *     → 前端必然 404
 * 只测服务层的话，上面两条都是绿的。
 *
 * 另一个必须走 HTTP 的理由：`RuntimeSettings` / `SiteUrlResolver` 的缓存 TTL
 * 保持 30 秒默认值，因此下面「改开关 → 立刻生效」的用例其实在验证
 * `PUT /api/admin/settings` 保存后确实调了 refresh()。哪天漏了刷新，
 * 这些用例会在 TTL 窗口内立刻失败，而不是等运维发现「保存了没生效」。
 *
 * 双方言：SQLite 恒跑；PostgreSQL 由 TEST_DATABASE_URL 门控（文件末尾一块）。
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const MASTER_SECRET = 'test-master-secret-0123456789';
const PASSWORD = 'password123';
const NEW_PASSWORD = 'newpassword456';
/** 与后台设置项 BASE_URL 同值：邮件链接必须挂在这个站点根上 */
const SITE_ORIGIN = 'https://skin.test';
const SITE_TITLE = 'MSCTS 测试站';

/** 记录发出的邮件，并可按需模拟故障 */
class MemoryMailer implements MailPort {
  readonly sent: MailMessage[] = [];
  verifyFails = false;
  sendFails = false;

  async send(message: MailMessage): Promise<void> {
    if (this.sendFails) {
      throw new AppError('SMTP_ERROR', '模拟投递失败');
    }
    this.sent.push(message);
  }

  async verify(): Promise<void> {
    if (this.verifyFails) {
      throw new AppError('SMTP_ERROR', '模拟连接失败：ECONNREFUSED');
    }
  }

  /** 取最后一封；没有则直接断言失败（用 assert 而不是 `!`，避免掩盖真实原因） */
  last(): MailMessage {
    const message = this.sent[this.sent.length - 1];
    assert.ok(message, '应当已发出一封邮件');
    return message;
  }

  clear(): void {
    this.sent.length = 0;
  }
}

interface Env {
  db: DatabaseConnection;
  baseUrl: string;
  mailer: MemoryMailer;
  settings: SettingRepository;
  users: UserRepository;
  accountTokens: AccountTokenRepository;
  runtime: RuntimeSettings;
  tokenService: TokenService;
  close: () => Promise<void>;
}

interface Ctx extends Env {
  adminToken: string;
  adminId: string;
}

interface TestUser {
  email: string;
  /** 当前有效的 Web 会话令牌 */
  token: string;
  password: string;
  /** 最近一封验证邮件里的令牌 */
  verificationToken?: string;
  /** 最近一封重置邮件里的令牌 */
  resetToken?: string;
}

const ctx: { sqlite?: Ctx } = {};
/** 单独保存，保证播种失败时 after 仍能关闭 HTTP 服务（否则进程挂住不退出） */
let envRef: Env | undefined;

/** 用例间共享的用户；由用例依次填充 */
let plainUser!: TestUser;
let verifyUser!: TestUser;
let manualUser!: { email: string; id: string };

async function buildEnv(): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), 'mscts-mail-'));
  const db = new SqliteConnection(join(dir, 't.db'));
  await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));

  const config: AppConfig = {
    dialect: 'sqlite',
    sqlitePath: join(dir, 't.db'),
    migrationsRoot: SCHEMA_DIR,
    uploadDir: join(dir, 'uploads'),
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

  // TTL 保持默认 30 秒：见文件头注释，这是刻意的
  const runtime = new RuntimeSettings({ settings, secretBox });
  const siteUrl = new SiteUrlResolver({ settings });
  const accountTokens = new AccountTokenRepository(db);
  const mailer = new MemoryMailer();
  const mailService = new MailService({ mailer, runtime });
  const emailFlow = new EmailFlow({
    db,
    users,
    tokens: accountTokens,
    tokenService,
    mail: mailService,
    siteUrl,
    // 复用 IdentityService 的密码规则与 bcrypt cost
    passwords: identity,
  });
  const resolver = new AssetUrlResolver(storage);

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
    mailer,
    settings,
    users,
    accountTokens,
    runtime,
    tokenService,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await db.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

before(async () => {
  const env = await buildEnv();
  envRef = env;

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
    profileName: 'admin_root',
  });
  assert.ok(res.token, '管理员注册应当签发会话令牌');
  await new UserRepository(env.db).updateAdminFields(
    res.user.id,
    { role: 'super_admin' },
    new Date(),
  );

  ctx.sqlite = { ...env, adminToken: res.token.token, adminId: res.user.id };
});

after(async () => {
  await envRef?.close();
});

function env(): Ctx {
  if (!ctx.sqlite) throw new Error('env not ready');
  return ctx.sqlite;
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

/** 以管理员身份保存站点设置（走真实 HTTP，顺带覆盖加密 / 脱敏 / 缓存刷新三段逻辑） */
async function saveSettings(entries: Record<string, unknown>) {
  const res = await api('/api/admin/settings', {
    method: 'PUT',
    token: env().adminToken,
    body: entries,
  });
  assert.equal(res.status, 200, `保存设置失败: ${JSON.stringify(res.body)}`);
  return res;
}

function uniqueName(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

async function register(
  email: string,
  profileName: string = uniqueName('p_'),
  password: string = PASSWORD,
) {
  return api('/api/auth/register', {
    method: 'POST',
    body: { email, password, profileName },
  });
}

async function login(email: string, password: string = PASSWORD) {
  return api('/api/auth/login', { method: 'POST', body: { email, password } });
}

/**
 * 从邮件正文里抠出动作令牌。
 * 链接形如 `https://skin.test/#/verify-email?token=xxx` —— 查询串在 `#` 之后，
 * 用 `URL.search` 拿不到，必须解析 hash。这正是 HashRouter 的坑。
 */
function tokenFromMail(message: MailMessage, hashPath: string): string {
  const href = message.html.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  const withHash = href.find((u) => u.includes(`#${hashPath}`));
  assert.ok(
    withHash,
    `邮件里应当含 ${hashPath} 链接，实际匹配到: ${href.join(' | ')}`,
  );
  const url = new URL(withHash);
  const hash = url.hash;
  const qIndex = hash.indexOf('?');
  assert.ok(qIndex >= 0, `链接应当带查询串: ${withHash}`);
  const token = new URLSearchParams(hash.slice(qIndex + 1)).get('token');
  assert.ok(token, `链接应当含 token 参数: ${withHash}`);
  return token;
}

async function emailVerifiedOf(email: string): Promise<boolean> {
  const user = await env().users.findByEmail(email);
  assert.ok(user, `用户不存在: ${email}`);
  return user.emailVerified;
}

// ---------------------------------------------------------------------------
// 注册开关（ALLOW_REGISTRATION）
// ---------------------------------------------------------------------------

test('开关：ALLOW_REGISTRATION=false 时注册被拒，且前端能读到该值', async () => {
  await saveSettings({ ALLOW_REGISTRATION: false });

  const email = `blocked-${randomUUID()}@test.local`;
  const res = await register(email);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'REGISTRATION_DISABLED');
  // 拒绝必须发生在建号之前
  assert.equal(await env().users.findByEmail(email), null);

  // 前端靠公开端点决定「显示表单还是提示已关闭」，键必须在白名单里
  const pub = await api('/api/settings/public');
  assert.equal(pub.body.ALLOW_REGISTRATION, false);
});

test('开关：重新开启后注册成功并签发会话', async () => {
  await saveSettings({ ALLOW_REGISTRATION: true });

  const email = `plain-${randomUUID()}@test.local`;
  const res = await register(email);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.token, '未要求邮箱验证时必须直接签发会话');
  assert.equal(res.body.requiresVerification, false);
  assert.equal(res.body.verificationEmailSent, false);
  // 未开启邮箱验证时用户仍是「未验证」状态 —— 后面的「重置即自救」用例依赖这一点
  assert.equal(await emailVerifiedOf(email), false);

  plainUser = { email, token: res.body.token, password: PASSWORD };
});

// ---------------------------------------------------------------------------
// 邮箱验证开关（REQUIRE_EMAIL_VERIFICATION）
// ---------------------------------------------------------------------------

test('开关：要求邮箱验证但 SMTP 未配置 → 注册被 502 拒绝，且不建号', async () => {
  await saveSettings({ REQUIRE_EMAIL_VERIFICATION: true });

  const email = `nosmtp-${randomUUID()}@test.local`;
  const res = await register(email);
  assert.equal(res.status, 502, JSON.stringify(res.body));
  assert.equal(res.body.error, 'SMTP_ERROR');
  // 关键：宁可现在拒绝，也不要把用户建成「登不进去、也收不到信」的账号
  assert.equal(
    await env().users.findByEmail(email),
    null,
    '发信能力不足时不应留下半成品账号',
  );
});

test('邮件设置：SMTP_PASS 加密入库、读回只给 SMTP_PASS_SET，空串不覆盖', async () => {
  await saveSettings({
    BASE_URL: SITE_ORIGIN,
    SITE_TITLE,
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: 587,
    SMTP_SECURE: false,
    SMTP_USER: 'noreply@example.com',
    SMTP_PASS: 'smtp-auth-code',
    SMTP_FROM: 'noreply@example.com',
    SMTP_FROM_NAME: SITE_TITLE,
  });

  // 1) 库里是密文，且不含原值
  const stored = await env().settings.get('SMTP_PASS');
  assert.equal(typeof stored, 'string');
  assert.ok(
    String(stored).startsWith('enc:v1:'),
    `SMTP_PASS 应以 AES 密文入库，实际: ${String(stored).slice(0, 24)}`,
  );
  assert.ok(!String(stored).includes('smtp-auth-code'), '密文里不应出现明文口令');

  // 2) 读回给浏览器的是空串 + 是否已配置的标志（密文回传毫无用处）
  const got = await api('/api/admin/settings', { token: env().adminToken });
  assert.equal(got.status, 200);
  assert.equal(got.body.SMTP_PASS, '');
  assert.equal(got.body.SMTP_PASS_SET, true);
  assert.equal(got.body.BASE_URL, SITE_ORIGIN, 'BASE_URL 应保真回读');
  assert.equal(got.body.SMTP_PORT, 587);

  // 3) 运行期读取器拿到的是明文（邮件实现不必知道密文的存在）
  const smtp = await env().runtime.smtp();
  assert.equal(smtp.pass, 'smtp-auth-code');
  assert.equal(smtp.host, 'smtp.example.com');

  // 4) 管理员改别的字段时，前端会把脱敏字段以空串回传 —— 不能因此清空真口令
  await saveSettings({ SMTP_FROM_NAME: '改个落款' });
  const again = await api('/api/admin/settings', { token: env().adminToken });
  assert.equal(again.body.SMTP_PASS_SET, true, '空串回传不应覆盖已设口令');
  assert.equal((await env().runtime.smtp()).pass, 'smtp-auth-code');
});

test('注册（要求验证）：201 但不签发会话，验证邮件已发出且链接是 HashRouter 形态', async () => {
  env().mailer.clear();
  const email = `verify-${randomUUID()}@test.local`;

  const res = await register(email);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.token, null, '要求验证时不得签发会话，否则「必须验证」形同虚设');
  assert.equal(res.body.expiresAt, null);
  assert.equal(res.body.requiresVerification, true);
  assert.equal(res.body.verificationEmailSent, true);
  assert.equal(await emailVerifiedOf(email), false);

  assert.equal(env().mailer.sent.length, 1);
  const mail = env().mailer.last();
  assert.equal(mail.to, email);
  assert.ok(mail.subject.includes(SITE_TITLE), `主题应含站点名: ${mail.subject}`);
  // 前端是 HashRouter：写成 origin/verify-email 会被静态托管 404
  assert.ok(
    mail.html.includes(`${SITE_ORIGIN}/#/verify-email?token=`),
    '邮件链接必须是 origin/#/verify-email?token=xxx',
  );
  // 内置模板里的占位符必须全部替换，否则用户收到一封点不动的死信
  for (const placeholder of MAIL_PLACEHOLDERS) {
    assert.ok(
      !mail.html.includes(`{{${placeholder}}}`),
      `邮件正文残留未替换的占位符 {{${placeholder}}}`,
    );
  }

  verifyUser = {
    email,
    token: tokenFromMail(mail, '/verify-email'),
    password: PASSWORD,
  };
});

test('令牌：库里只存 sha256，明文永不落库', async () => {
  const hash = sha256Hex(verifyUser.token);
  const row = await env().accountTokens.findByHash('email_verification', hash);
  assert.ok(row, '应能按哈希找到刚签发的验证令牌');
  assert.equal(row.tokenHash, hash);
  assert.notEqual(row.tokenHash, verifyUser.token);
  assert.equal(row.usedAt, null);
  // 有效期与邮件文案「30 分钟内有效」绑定，偏差超过 1 分钟即视为不一致
  const ttlMinutes = (new Date(row.expiresAt).getTime() - Date.now()) / 60000;
  const expected = VERIFICATION_TTL_MS / 60000;
  assert.ok(
    ttlMinutes > expected - 1 && ttlMinutes <= expected,
    `验证令牌有效期应约 ${expected} 分钟，实际 ${ttlMinutes.toFixed(1)} 分钟`,
  );
});

test('登录：凭据正确但邮箱未验证 → 403 EMAIL_NOT_VERIFIED', async () => {
  const res = await login(verifyUser.email);
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body.error, 'EMAIL_NOT_VERIFIED');
  assert.equal(res.body.token, undefined);

  // 检查点必须在密码校验之后：否则未持密码的人也能探出「这个邮箱注册过但没验证」
  const wrongPassword = await login(verifyUser.email, 'wrong-password-123');
  assert.equal(wrongPassword.status, 401);
  assert.equal(
    wrongPassword.body.error,
    'INVALID_CREDENTIALS',
    '密码错误时必须报凭据错误，而不是暴露账号的验证状态',
  );
});

test('验证链接：消费成功即置 email_verified，重复点击 401 TOKEN_REVOKED', async () => {
  const first = await api('/api/auth/verify-email', {
    method: 'POST',
    body: { token: verifyUser.token },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.ok, true);
  assert.equal(first.body.email, verifyUser.email);
  assert.equal(await emailVerifiedOf(verifyUser.email), true);

  // 邮件客户端预取 / 用户连点：第二次必须失败，而不是静默重复成功
  const second = await api('/api/auth/verify-email', {
    method: 'POST',
    body: { token: verifyUser.token },
  });
  assert.equal(second.status, 401);
  assert.equal(second.body.error, 'TOKEN_REVOKED');
});

test('登录：验证完成后放行并签发会话', async () => {
  const res = await login(verifyUser.email);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.token, '验证完成后应能登录');
  verifyUser = { ...verifyUser, token: res.body.token };
});

test('验证链接：缺失或伪造的令牌 → 401 TOKEN_INVALID', async () => {
  const missing = await api('/api/auth/verify-email', { method: 'POST', body: {} });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error, 'TOKEN_INVALID');

  const forged = await api('/api/auth/verify-email', {
    method: 'POST',
    body: { token: 'not-a-real-token' },
  });
  assert.equal(forged.status, 401);
  assert.equal(forged.body.error, 'TOKEN_INVALID');
});

test('令牌：过期后既不能被消费，也不能通过 HTTP 使用', async () => {
  const owner = await env().users.findByEmail(plainUser.email);
  assert.ok(owner);

  const plain = `expired-token-${randomUUID()}`;
  const past = new Date(Date.now() - 60_000);
  await env().accountTokens.insert('email_verification', {
    id: randomUUID(),
    userId: owner.id,
    tokenHash: sha256Hex(plain),
    expiresAt: past,
    createdAt: new Date(past.getTime() - VERIFICATION_TTL_MS),
  });

  // 仓储层：consume 的 WHERE 里带 expires_at 判定，所以拿不到行
  const consumed = await env().accountTokens.consume(
    'email_verification',
    sha256Hex(plain),
    new Date(),
  );
  assert.equal(consumed, null, '过期令牌不应被消费');

  // HTTP 层：给出「已过期、请重新获取」而不是含糊的失败
  const res = await api('/api/auth/verify-email', {
    method: 'POST',
    body: { token: plain },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'TOKEN_EXPIRED');
  assert.equal(await emailVerifiedOf(plainUser.email), false, '过期令牌不得改变验证状态');
});

test('重发验证：匿名按邮箱（防枚举），已登录按会话身份', async () => {
  // 未知邮箱：必须与「已发送」同形，否则这个免认证端点就成了账号枚举工具
  env().mailer.clear();
  const unknown = await api('/api/auth/send-verification', {
    method: 'POST',
    body: { email: `ghost-${randomUUID()}@test.local` },
  });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body, { ok: true });
  assert.equal(env().mailer.sent.length, 0, '未知邮箱不应真的发信');

  // 缺少邮箱 → 400（这是请求格式问题，可以明确报错）
  const noEmail = await api('/api/auth/send-verification', {
    method: 'POST',
    body: {},
  });
  assert.equal(noEmail.status, 400);
  assert.equal(noEmail.body.error, 'VALIDATION_ERROR');

  // 已登录且已验证：不发信，并如实告知（该字段只对会话本人可见，不构成枚举）
  env().mailer.clear();
  const mine = await api('/api/auth/send-verification', {
    method: 'POST',
    token: verifyUser.token,
    body: { email: 'someone-else@test.local' },
  });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.alreadyVerified, true);
  assert.equal(env().mailer.sent.length, 0);

  // 已登录但未验证（plainUser）：应真的发出新链接
  env().mailer.clear();
  const resend = await api('/api/auth/send-verification', {
    method: 'POST',
    token: plainUser.token,
    body: {},
  });
  assert.equal(resend.status, 200);
  assert.equal(env().mailer.sent.length, 1);
  assert.equal(env().mailer.last().to, plainUser.email);
  plainUser = {
    ...plainUser,
    verificationToken: tokenFromMail(env().mailer.last(), '/verify-email'),
  };

  const status = await api('/api/me/email-status', { token: plainUser.token });
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, { email: plainUser.email, emailVerified: false });
});

// ---------------------------------------------------------------------------
// 密码重置
// ---------------------------------------------------------------------------

test('重置密码：未知邮箱静默成功，已知邮箱收到链接', async () => {
  env().mailer.clear();
  const unknown = await api('/api/auth/send-reset-email', {
    method: 'POST',
    body: { email: `ghost-${randomUUID()}@test.local` },
  });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body, { ok: true });
  assert.equal(env().mailer.sent.length, 0);

  const sent = await api('/api/auth/send-reset-email', {
    method: 'POST',
    body: { email: plainUser.email },
  });
  assert.equal(sent.status, 200);
  assert.equal(env().mailer.sent.length, 1);
  const mail = env().mailer.last();
  assert.equal(mail.to, plainUser.email);
  assert.ok(mail.subject.includes('重置'), `主题应表明是重置邮件: ${mail.subject}`);
  assert.ok(
    mail.html.includes(`${SITE_ORIGIN}/#/reset-password?token=`),
    '重置链接必须是 origin/#/reset-password?token=xxx',
  );
  assert.ok(
    !mail.html.includes('{{RESET_URL}}') && !mail.html.includes('{{VERIFY_URL}}'),
    '重置邮件里不应残留占位符',
  );

  const token = tokenFromMail(mail, '/reset-password');
  const row = await env().accountTokens.findByHash('password_reset', sha256Hex(token));
  assert.ok(row, '重置令牌应已入库');
  const ttlMinutes = (new Date(row.expiresAt).getTime() - Date.now()) / 60000;
  const expected = RESET_TTL_MS / 60000;
  assert.ok(
    ttlMinutes > expected - 1 && ttlMinutes <= expected,
    `重置令牌有效期应约 ${expected} 分钟，实际 ${ttlMinutes.toFixed(1)} 分钟`,
  );

  plainUser = { ...plainUser, resetToken: token };
});

test('重置密码：改密成功、顺带完成邮箱验证、并吊销全部会话', async () => {
  // 前提：plainUser 未验证且站点要求邮箱验证 → 正常登录是被拒的
  assert.equal((await login(plainUser.email)).status, 403);

  const res = await api('/api/auth/reset-password', {
    method: 'POST',
    body: { token: plainUser.resetToken, password: NEW_PASSWORD },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.email, plainUser.email);

  // 能点开这封邮件就已证明邮箱归属，因此顺带置为已验证 ——
  // 这也是「管理员没配好 SMTP、用户卡在未验证」时的自救路径
  assert.equal(await emailVerifiedOf(plainUser.email), true);

  // 旧密码失效、新密码可用
  const oldPassword = await login(plainUser.email, PASSWORD);
  assert.equal(oldPassword.status, 401);
  assert.equal(oldPassword.body.error, 'INVALID_CREDENTIALS');

  const newPassword = await login(plainUser.email, NEW_PASSWORD);
  assert.equal(newPassword.status, 200, JSON.stringify(newPassword.body));
  assert.ok(newPassword.body.token);

  // 改密后旧会话必须立刻失效（含 Yggdrasil 令牌）
  const stale = await api('/api/me', { token: plainUser.token });
  assert.equal(stale.status, 401, '改密后旧会话应失效');

  plainUser = { ...plainUser, token: newPassword.body.token, password: NEW_PASSWORD };
});

test('重置链接：只能消费一次', async () => {
  const again = await api('/api/auth/reset-password', {
    method: 'POST',
    body: { token: plainUser.resetToken, password: 'another-pass-789' },
  });
  assert.equal(again.status, 401);
  assert.equal(again.body.error, 'TOKEN_REVOKED');
  // 密码没有被第二次改写
  assert.equal((await login(plainUser.email, NEW_PASSWORD)).status, 200);
});

test('重置密码：弱密码被拒且不消耗令牌', async () => {
  env().mailer.clear();
  await api('/api/auth/send-reset-email', {
    method: 'POST',
    body: { email: plainUser.email },
  });
  const token = tokenFromMail(env().mailer.last(), '/reset-password');

  const weak = await api('/api/auth/reset-password', {
    method: 'POST',
    body: { token, password: 'short' },
  });
  assert.equal(weak.status, 400);
  assert.equal(weak.body.error, 'VALIDATION_ERROR');

  // 校验发生在消费之前 —— 令牌仍然可用，否则用户会被自己的一次手滑锁在门外
  const recovered = 'recovered-pass-1';
  const ok = await api('/api/auth/reset-password', {
    method: 'POST',
    body: { token, password: recovered },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  // 上面这次改密又吊销了旧会话，重新登录拿一个可用令牌给后续用例
  const relogin = await login(plainUser.email, recovered);
  assert.equal(relogin.status, 200);
  plainUser = { ...plainUser, token: relogin.body.token, password: recovered };
});

// ---------------------------------------------------------------------------
// 管理端邮箱相关端点
// ---------------------------------------------------------------------------

test('管理端：放行 / 收回邮箱验证', async () => {
  const email = `manual-${randomUUID()}@test.local`;
  const created = await register(email, uniqueName('m_'));
  // 站点此刻要求邮箱验证 → 注册后未验证
  assert.equal(created.body.requiresVerification, true);
  const user = await env().users.findByEmail(email);
  assert.ok(user);
  assert.equal(user.emailVerified, false);

  // 收回（对未验证用户是幂等的）
  const off = await api(`/api/admin/users/${user.id}/verify-email`, {
    method: 'PUT',
    token: env().adminToken,
    body: { verified: false },
  });
  assert.equal(off.status, 200);
  assert.equal(off.body.emailVerified, false);
  assert.equal(await emailVerifiedOf(email), false);
  assert.equal((await login(email)).status, 403);

  // 不传 verified 即视为放行
  const on = await api(`/api/admin/users/${user.id}/verify-email`, {
    method: 'PUT',
    token: env().adminToken,
    body: {},
  });
  assert.equal(on.status, 200);
  assert.equal(on.body.emailVerified, true);
  assert.equal((await login(email)).status, 200);

  // 不存在的用户 → 404
  const missing = await api(`/api/admin/users/${randomUUID()}/verify-email`, {
    method: 'PUT',
    token: env().adminToken,
    body: {},
  });
  assert.equal(missing.status, 404);

  // 普通用户无权操作
  const forbidden = await api(`/api/admin/users/${user.id}/verify-email`, {
    method: 'PUT',
    token: plainUser.token,
    body: {},
  });
  assert.equal(forbidden.status, 403);

  manualUser = { email, id: user.id };
});

test('管理端：代发验证邮件，已验证者如实返回 alreadyVerified 且不发信', async () => {
  env().mailer.clear();

  // 已验证用户（manualUser 刚被手动放行）
  const already = await api(`/api/admin/users/${manualUser.id}/send-verification`, {
    method: 'POST',
    token: env().adminToken,
  });
  assert.equal(already.status, 200);
  assert.equal(already.body.alreadyVerified, true);
  assert.equal(env().mailer.sent.length, 0, '已验证者不该再收到验证邮件');

  // 未验证用户 → 真的代发（用户反馈收不到信时的兜底手段）
  const unverifiedEmail = `resend-${randomUUID()}@test.local`;
  await register(unverifiedEmail, uniqueName('r_'));
  // 注册本身就会发出第一封验证邮件，这里清掉才算得准「代发了第二封」
  env().mailer.clear();
  const target = await env().users.findByEmail(unverifiedEmail);
  assert.ok(target);
  const sent = await api(`/api/admin/users/${target.id}/send-verification`, {
    method: 'POST',
    token: env().adminToken,
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.alreadyVerified, false);
  assert.equal(env().mailer.sent.length, 1);
  assert.equal(env().mailer.last().to, unverifiedEmail);

  // 不存在的用户 → 404
  const missing = await api(`/api/admin/users/${randomUUID()}/send-verification`, {
    method: 'POST',
    token: env().adminToken,
  });
  assert.equal(missing.status, 404);
});

test('管理端：邮件模板默认值带占位符，保存后立即用于下一封信', async () => {
  const initial = await api('/api/admin/email-template', { token: env().adminToken });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.isDefault, true);
  // 编辑器必须拿到「占位符原文」而不是渲染成品，否则管理员改完就废了
  assert.ok(initial.body.html.includes('{{VERIFY_URL}}'));
  assert.ok(initial.body.html.includes('{{SITE_TITLE}}'));
  assert.ok(initial.body.subject.includes(SITE_TITLE));

  const saved = await api('/api/admin/email-template', {
    method: 'PUT',
    token: env().adminToken,
    body: {
      subject: '自定义主题 {{SITE_TITLE}}',
      html: '<p>{{EMAIL}}</p><a href="{{VERIFY_URL}}">点我验证</a><i>{{YEAR}}</i>',
    },
  });
  assert.equal(saved.status, 200);

  const after = await api('/api/admin/email-template', { token: env().adminToken });
  assert.equal(after.body.isDefault, false);
  assert.equal(after.body.subject, '自定义主题 {{SITE_TITLE}}');

  // 主题 / 正文为空 → 400（要回内置模板需显式清空，不能默默存成空模板）
  const empty = await api('/api/admin/email-template', {
    method: 'PUT',
    token: env().adminToken,
    body: { subject: '', html: '' },
  });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, 'VALIDATION_ERROR');

  // 下一封验证邮件应当用上自定义模板，且占位符全被替换
  await api(`/api/admin/users/${manualUser.id}/verify-email`, {
    method: 'PUT',
    token: env().adminToken,
    body: { verified: false },
  });
  env().mailer.clear();
  const sent = await api(`/api/admin/users/${manualUser.id}/send-verification`, {
    method: 'POST',
    token: env().adminToken,
  });
  assert.equal(sent.status, 200);
  const mail = env().mailer.last();
  assert.equal(mail.subject, `自定义主题 ${SITE_TITLE}`);
  assert.ok(mail.html.includes(manualUser.email));
  assert.ok(mail.html.includes(`${SITE_ORIGIN}/#/verify-email?token=`));
  assert.ok(!mail.html.includes('{{'));

  // 清空即回内置模板；后续用例依赖内置模板的措辞
  await saveSettings({ EMAIL_TEMPLATE_SUBJECT: '', EMAIL_TEMPLATE_HTML: '' });
  const restored = await api('/api/admin/email-template', { token: env().adminToken });
  assert.equal(restored.body.isDefault, true);
});

test('管理端：test-smtp 失败也回 200，把真实原因交给前端', async () => {
  const ok = await api('/api/admin/test-smtp', {
    method: 'POST',
    token: env().adminToken,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.success, true);

  env().mailer.verifyFails = true;
  const failed = await api('/api/admin/test-smtp', {
    method: 'POST',
    token: env().adminToken,
  });
  // 用 4xx/5xx 表达「连不上」会被 fetch 层压成通用报错，管理员就看不到真正的原因
  assert.equal(failed.status, 200);
  assert.equal(failed.body.success, false);
  assert.ok(
    String(failed.body.error).includes('ECONNREFUSED'),
    `应回传底层原因: ${failed.body.error}`,
  );
  env().mailer.verifyFails = false;

  // 普通用户无权
  const forbidden = await api('/api/admin/test-smtp', {
    method: 'POST',
    token: plainUser.token,
  });
  assert.equal(forbidden.status, 403);
});

test('回归：管理端界面上展示的占位符必须都被后端支持', async () => {
  const src = await readFile(
    join(REPO_ROOT, 'web', 'src', 'pages', 'Admin', 'SystemSettings.tsx'),
    'utf8',
  );
  const shown = new Set(
    [...src.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1] as string),
  );
  assert.ok(
    shown.size >= 3,
    `应能提取到界面展示的占位符，实际 ${shown.size} 个（提取逻辑或界面文案变了？）`,
  );
  for (const name of shown) {
    assert.ok(
      (MAIL_PLACEHOLDERS as readonly string[]).includes(name),
      `界面展示了后端不支持的占位符 {{${name}}}，管理员按提示写出来会渲染出字面文本`,
    );
  }
});

// ---------------------------------------------------------------------------
// PostgreSQL（由 TEST_DATABASE_URL 门控）
// ---------------------------------------------------------------------------

test(
  'emailFlow: PostgreSQL 方言下 AccountTokenRepository 全流程',
  { skip: TEST_DATABASE_URL ? false : '未设置 TEST_DATABASE_URL' },
  async () => {
    const db = PostgresConnection.connect(TEST_DATABASE_URL!);
    await runMigrations(db, join(SCHEMA_DIR, 'postgresql'));
    // 只清理本用例自己造的 `pg-token-*` 用户：token 表对 users 有外键且 ON DELETE
    // CASCADE，删用户即可连带清掉其令牌。**不要**无差别 DELETE 整张 token 表 ——
    // 这些表是多个测试文件共用的，全表删除会把别的用例的数据一起抹掉。
    await db.run("DELETE FROM users WHERE email LIKE 'pg-token-%'");

    const users = new UserRepository(db);
    const userId = randomUUID();
    await users.insert({
      id: userId,
      email: `pg-token-${randomUUID()}@test.local`,
      passwordHash: 'x',
      role: 'user',
      now: new Date(),
    });

    const tokens = new AccountTokenRepository(db);
    const plain = `pg-plain-${randomUUID()}`;
    const hash = sha256Hex(plain);
    const now = new Date();
    await tokens.insert('email_verification', {
      id: randomUUID(),
      userId,
      tokenHash: hash,
      expiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS),
      createdAt: now,
    });

    const found = await tokens.findByHash('email_verification', hash);
    assert.ok(found);
    assert.equal(found.userId, userId);
    // TIMESTAMPTZ 读回来必须可解析成 ISO，而不是被字符串化成怪格式
    assert.ok(
      !Number.isNaN(new Date(found.expiresAt).getTime()),
      `expiresAt 应可解析: ${found.expiresAt}`,
    );

    // 原子消费：第一次拿到行，第二次拿不到
    const consumed = await tokens.consume('email_verification', hash, new Date());
    assert.ok(consumed, '首次消费应当成功');
    assert.equal(consumed.userId, userId);
    assert.equal(await tokens.consume('email_verification', hash, new Date()), null);

    // 过期令牌：PG 侧比较依赖 ::timestamptz 转型，这里是最容易踩的地方
    const expiredHash = sha256Hex(`pg-expired-${randomUUID()}`);
    await tokens.insert('password_reset', {
      id: randomUUID(),
      userId,
      tokenHash: expiredHash,
      expiresAt: new Date(now.getTime() - 60_000),
      createdAt: new Date(now.getTime() - 120_000),
    });
    assert.equal(
      await tokens.consume('password_reset', expiredHash, new Date()),
      null,
      'PG 下过期令牌同样不应被消费',
    );

    // 重发即作废旧令牌
    const keeperHash = sha256Hex(`pg-keep-${randomUUID()}`);
    await tokens.insert('email_verification', {
      id: randomUUID(),
      userId,
      tokenHash: keeperHash,
      expiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS),
      createdAt: now,
    });
    await tokens.invalidateUnusedForUser('email_verification', userId, new Date());
    const invalidated = await tokens.findByHash('email_verification', keeperHash);
    assert.ok(invalidated);
    assert.notEqual(invalidated.usedAt, null, '旧令牌应被作废');
    assert.equal(
      await tokens.consume('email_verification', keeperHash, new Date()),
      null,
    );

    // 清理（deleteExpired 走的是同一套时间比较）
    await tokens.deleteExpired('password_reset', new Date());
    assert.equal(
      await tokens.findByHash('password_reset', expiredHash),
      null,
      '过期令牌应被清理',
    );
    // 删用户即级联清掉上面所有令牌
    await db.run("DELETE FROM users WHERE email LIKE 'pg-token-%'");
    assert.equal(
      await tokens.findByHash('email_verification', keeperHash),
      null,
      '删用户应级联清掉其令牌',
    );
    await db.close();
  },
);
