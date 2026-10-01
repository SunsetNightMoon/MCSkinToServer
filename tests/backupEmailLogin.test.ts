import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import bcrypt from 'bcryptjs';
import { PostgresConnection } from '../src/db/postgres.js';
import { SqliteConnection } from '../src/db/sqlite.js';
import type { DatabaseConnection } from '../src/types.js';
import { runMigrations } from '../src/migrate/runner.js';
import { IdentityService } from '../src/auth/identity.js';
import { TokenService } from '../src/auth/tokens.js';
import { TokenRepository } from '../src/repositories/tokenRepository.js';
import { UserRepository } from '../src/repositories/userRepository.js';
import { ProfileRepository } from '../src/repositories/profileRepository.js';
import { MinecraftSessionRepository } from '../src/repositories/minecraftSessionRepository.js';
import { AccountTokenRepository } from '../src/repositories/accountTokenRepository.js';
import { MailService } from '../src/mail/mailService.js';
import type { MailMessage, MailPort } from '../src/mail/types.js';
import { RuntimeSettings } from '../src/site/runtimeSettings.js';
import { SiteUrlResolver } from '../src/site/siteUrl.js';
import { EmailFlow } from '../src/account/emailFlow.js';
import { AppError } from '../src/errors.js';
import { bcryptCostOf, DEFAULT_BCRYPT_COST } from '../src/auth/password.js';

/**
 * 备用邮箱参与登录与找回密码（Issue 之外的用户直接需求）。
 *
 * ## 这批要钉住的三条口径
 *
 * 1. **已验证的备用邮箱 = 登录凭据**，网页与启动器同一口径。未验证的一律不算 ——
 *    「绑上但没验证」正是刷号方最喜欢下手的状态，给它认证能力等于开无限量入口。
 * 2. **一个邮箱只绑一个号**。数据库的两个唯一索引各管一列，跨列（A 主 == B 备）
 *    管不到，所以注册侧补了查重；万一历史脏数据已经造出冲突，登录**不任选账号**，
 *    两边都按凭据错误收口。
 * 3. **找回密码交叉投递**：账号有另一个已验证邮箱时，重置信发到那个邮箱。
 *    单个信箱失守（被拖库、被盗、长期不看）不再足以改密码。
 *
 * 双方言：SQLite 恒跑；PostgreSQL 由 `TEST_DATABASE_URL` 门控。
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const SITE_ORIGIN = 'http://backup-login.test:3000';
const PASSWORD = 'password123';

class MemoryMailer implements MailPort {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }

  async verify(): Promise<void> {}

  to(address: string): MailMessage[] {
    return this.sent.filter((m) => m.to === address);
  }

  lastTo(address: string): MailMessage {
    const list = this.to(address);
    const message = list[list.length - 1];
    assert.ok(
      message,
      `应已发往 ${address} 一封邮件（实际收件人：${this.sent.map((m) => m.to).join(', ') || '无'}）`,
    );
    return message;
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/** 从邮件正文里抠出 HashRouter 链接上的 token 参数（链接形如 `…/#/reset-password?token=`） */
function tokenOf(message: MailMessage, hashPath: string): string {
  const path = hashPath.startsWith('/') ? hashPath : `/${hashPath}`;
  const marker = `${SITE_ORIGIN}/#${path}?token=`;
  const index = message.html.indexOf(marker);
  assert.ok(index >= 0, `邮件正文应含 ${marker}`);
  const rest = message.html.slice(index + marker.length);
  const end = rest.search(/["'&\s]/);
  return end < 0 ? rest : rest.slice(0, end);
}

interface Env {
  db: DatabaseConnection;
  users: UserRepository;
  identity: IdentityService;
  emailFlow: EmailFlow;
  mailer: MemoryMailer;
  clock: Date;
}

function buildEnv(db: DatabaseConnection): Env {
  const users = new UserRepository(db);
  const profiles = new ProfileRepository(db);
  const tokenService = new TokenService(new TokenRepository(db));
  const clock = new Date();
  const mailer = new MemoryMailer();
  const runtime = new RuntimeSettings({
    settings: {
      getAll: async () => ({
        SMTP_HOST: 'smtp.backup.test',
        SMTP_PORT: 587,
        SMTP_FROM: 'noreply@backup.test',
        SITE_TITLE: '备用邮箱登录测试站',
      }),
    },
    ttlMs: 0,
  });
  const siteUrl = new SiteUrlResolver({
    settings: { get: async () => null },
    envPublicBaseUrl: `${SITE_ORIGIN}/uploads`,
    ttlMs: 0,
  });
  const mail = new MailService({ mailer, runtime, now: () => clock });
  const identity = new IdentityService({
    db,
    users,
    profiles,
    tokens: tokenService,
    sessions: new MinecraftSessionRepository(db),
    now: () => clock,
  });
  const emailFlow = new EmailFlow({
    db,
    users,
    tokens: new AccountTokenRepository(db),
    tokenService,
    mail,
    siteUrl,
    passwords: identity,
    now: () => clock,
  });
  return { db, users, identity, emailFlow, mailer, clock };
}

const cases: Array<{
  label: 'sqlite' | 'postgres';
  prefix: string;
  skip?: boolean | string;
  setup: (t: TestContext) => Promise<Env>;
}> = [
  {
    label: 'sqlite',
    prefix: 'ble-sq',
    setup: async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'mcsts-ble-'));
      const db = new SqliteConnection(join(dir, 't.db'));
      await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));
      t.after(async () => {
        await db.close().catch(() => undefined);
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      });
      return buildEnv(db);
    },
  },
  TEST_DATABASE_URL
    ? {
        label: 'postgres',
        prefix: 'ble-pg',
        setup: async (t) => {
          const db = PostgresConnection.connect(TEST_DATABASE_URL!);
          await runMigrations(db, join(SCHEMA_DIR, 'postgresql'));
          await db.run("DELETE FROM users WHERE email LIKE 'ble-pg-%'");
          t.after(async () => {
            await db.run("DELETE FROM users WHERE email LIKE 'ble-pg-%'").catch(() => undefined);
            await db.close().catch(() => undefined);
          });
          return buildEnv(db);
        },
      }
    : { label: 'postgres', prefix: 'ble-pg', skip: '未设置 TEST_DATABASE_URL', setup: async () => null as never },
];

/** 注册一个账号并绑好已验证的备用邮箱 */
async function seedAccount(
  env: Env,
  prefix: string,
  tag: string,
): Promise<{ primary: string; backup: string; userId: string }> {
  const primary = `${prefix}-main-${tag}@test.local`;
  const backup = `${prefix}-bak-${tag}@test.local`;
  const reg = await env.identity.register({ email: primary, password: PASSWORD, profileName: `bk_${tag}` });
  const userId = reg.user.id;
  await env.users.setBackupEmail(userId, backup, env.clock);
  await env.users.markBackupEmailVerified(userId, true, env.clock);
  return { primary, backup, userId };
}

for (const c of cases) {
  test(`backupLogin: 已验证备用邮箱能登录网页与启动器（${c.label}）`, { skip: c.skip }, async (t) => {
    const env = await c.setup(t);
    const { primary, backup } = await seedAccount(env, c.prefix, 'a1');

    // 备用邮箱登录网页：大小写混写也要认（唯一索引建在 lower(email) 上）
    const viaBackup = await env.identity.loginWeb({
      email: backup.toUpperCase(),
      password: PASSWORD,
    });
    assert.equal(viaBackup.user.email, primary, '命中的必须是同一个账号');
    assert.ok(viaBackup.token, '备用邮箱登录要签发会话');

    // 启动器 authenticate 同一口径
    const ygg = await env.identity.authenticateYggdrasil({
      email: backup,
      password: PASSWORD,
      clientToken: 'client-1',
    });
    assert.ok(ygg.accessToken);

    // 主邮箱照旧能用（不能因为加了备用而回退）
    const viaPrimary = await env.identity.loginWeb({ email: primary, password: PASSWORD });
    assert.equal(viaPrimary.user.email, primary);

    // 密码错误仍是同一句凭据错误，不区分「地址存在但密码错」
    await assert.rejects(
      () => env.identity.loginWeb({ email: backup, password: 'wrong-password-1' }),
      (err: any) => err?.code === 'INVALID_CREDENTIALS',
    );
  });

  test(`backupLogin: 限流键按账号解析 —— 主/备邮箱落进同一个桶（${c.label}）`, { skip: c.skip }, async (t) => {
    const env = await c.setup(t);
    const { primary, backup, userId } = await seedAccount(env, c.prefix, 'a1rl');

    // 这就是 authBucketKey 依赖的口径：两个提交值解析出同一个账号 id，才算同一个桶
    assert.equal(await env.identity.resolveAuthBucketUserId(primary), userId);
    assert.equal(
      await env.identity.resolveAuthBucketUserId(backup.toUpperCase()),
      userId,
      '备用邮箱（含大小写混写）必须解析到同一个账号 id',
    );

    // 解析不出账号时返回 null，由调用方回落到按提交值取键（否则随机邮箱会共用一个桶）
    assert.equal(
      await env.identity.resolveAuthBucketUserId('nobody@test.local'),
      null,
    );
    // 畸形超长值不值得为它打一次索引查询，也不该整坨进限流键
    assert.equal(
      await env.identity.resolveAuthBucketUserId(`${'a'.repeat(300)}@test.local`),
      null,
    );
    assert.equal(await env.identity.resolveAuthBucketUserId('   '), null);
    assert.equal(await env.identity.resolveAuthBucketUserId(undefined), null);

    // 「绑上但没验证」的备用邮箱不算登录入口，因此也不该参与归桶
    await env.users.markBackupEmailVerified(userId, false, env.clock);
    assert.equal(await env.identity.resolveAuthBucketUserId(backup), null);
  });

  test(`backupLogin: 未验证的备用邮箱不参与认证（${c.label}）`, { skip: c.skip }, async (t) => {
    const env = await c.setup(t);
    const { backup } = await seedAccount(env, c.prefix, 'a2');
    // 造出「绑上但没验证」的状态（正常流程不会留下它，这里模拟旁路写入/历史数据）
    await env.users.markBackupEmailVerified(
      (await env.users.findByBackupEmail(backup))!.id,
      false,
      env.clock,
    );

    await assert.rejects(
      () => env.identity.loginWeb({ email: backup, password: PASSWORD }),
      (err: any) => err?.code === 'INVALID_CREDENTIALS',
      '未验证的备用地址必须与「账号不存在」同一口径',
    );
    await assert.rejects(
      () => env.identity.authenticateYggdrasil({ email: backup, password: PASSWORD }),
      (err: any) => err?.code === 'FORBIDDEN_OPERATION' || err instanceof AppError,
    );
  });

  test(`backupLogin: 同一地址命中两个账号时不任选，两边都拒（${c.label}）`, { skip: c.skip }, async (t) => {
    const env = await c.setup(t);
    const a = await seedAccount(env, c.prefix, 'a3a');
    const b = await seedAccount(env, c.prefix, 'a3b');
    // 人为破坏跨列唯一：把 B 的备用邮箱改成 A 的主邮箱（注册查重补上后正常流程做不出）
    await env.users.setBackupEmail(b.userId, a.primary, env.clock);
    await env.users.markBackupEmailVerified(b.userId, true, env.clock);

    // A 的主邮箱地址现在同时是 A 的主、B 的备 —— 谁都不能用它登录
    await assert.rejects(
      () => env.identity.loginWeb({ email: a.primary, password: PASSWORD }),
      (err: any) => err?.code === 'INVALID_CREDENTIALS',
      '冲突地址不能变成「猜中就登进某个号」的入口',
    );
    // B 自己的备用槽位被占用后也拒；但 B 的主邮箱仍可登录（不牵连无关凭据）
    const bStillWorks = await env.identity.loginWeb({ email: b.primary, password: PASSWORD });
    assert.equal(bStillWorks.user.email, b.primary);
  });

  test(`backupLogin: 备用已验证即满足「要求邮箱验证」门槛（${c.label}）`, { skip: c.skip }, async (t) => {
    const env = await c.setup(t);
    const { primary, backup } = await seedAccount(env, c.prefix, 'a4');
    // 主邮箱保持未验证（注册默认就是未验证）
    const user = await env.users.findByEmail(primary);
    assert.equal(user!.emailVerified, false);

    const ok = await env.identity.loginWeb({
      email: backup,
      password: PASSWORD,
      requireEmailVerified: true,
    });
    assert.ok(ok.token, '主邮箱收不到信时，备用邮箱就是兜底，不该再卡主邮箱门槛');

    await assert.rejects(
      () => env.identity.loginWeb({ email: primary, password: PASSWORD, requireEmailVerified: true }),
      (err: any) => err?.code === 'EMAIL_NOT_VERIFIED',
      '用主邮箱登录仍按原门槛，行为不变',
    );
  });

  test(`backupLogin: 注册不能占用别人已绑定的备用邮箱（${c.label}）`, { skip: c.skip }, async (t) => {
    const env = await c.setup(t);
    const { backup } = await seedAccount(env, c.prefix, 'a5');

    await assert.rejects(
      () =>
        env.identity.register({
          email: backup.toUpperCase(),
          password: PASSWORD,
          profileName: 'bkdupa5',
        }),
      (err: any) => err?.code === 'EMAIL_TAKEN',
      '这是「一个邮箱绑两个号」的真实入口：注册此前只查主邮箱',
    );
  });

  test(`backupLogin: 找回密码交叉投递到另一个已验证邮箱（${c.label}）`, { skip: c.skip }, async (t) => {
    const env = await c.setup(t);
    const { primary, backup } = await seedAccount(env, c.prefix, 'a6');
    env.mailer.clear();

    // 用备用邮箱发起 → 信投主邮箱
    env.mailer.clear();
    await env.emailFlow.sendReset(backup.toUpperCase());
    env.mailer.lastTo(primary);
    assert.equal(env.mailer.to(backup).length, 0);

    // 交叉投递的那一封能真的把密码改掉
    env.mailer.clear();
    await env.emailFlow.sendReset(primary);
    const token = tokenOf(env.mailer.lastTo(backup), 'reset-password');
    const result = await env.emailFlow.resetPassword(token, 'brandnewpass1');
    assert.equal(result.userId, (await env.users.findByEmail(primary))!.id);
    await env.identity.loginWeb({ email: primary, password: 'brandnewpass1' });

    // 但**不**顺带把主邮箱标成已验证：那封信证明的是备用信箱的归属
    assert.equal((await env.users.findByEmail(primary))!.emailVerified, false);
  });

  test(`backupLogin: 没有备用邮箱时回落同槽投递并照旧置位（${c.label}）`, { skip: c.skip }, async (t) => {
    const env = await c.setup(t);
    const reg = await env.identity.register({
      email: `${c.prefix}-solo@test.local`,
      password: PASSWORD,
      profileName: 'bksoloa7',
    });
    env.mailer.clear();

    await env.emailFlow.sendReset(`${c.prefix}-solo@test.local`);
    const msg = env.mailer.lastTo(`${c.prefix}-solo@test.local`);

    const token = tokenOf(msg, 'reset-password');
    await env.emailFlow.resetPassword(token, 'brandnewpass2');
    // 链接确实投在主信箱 → 可以顺带认定主邮箱已验证
    assert.equal((await env.users.findById(reg.user.id))!.emailVerified, true);
  });

  test(`backupLogin: 备用邮箱登录同样承担哈希平滑升级（${c.label}）`, { skip: c.skip }, async (t) => {
    const env = await c.setup(t);
    const { backup, userId } = await seedAccount(env, c.prefix, 'a8');
    // 造一条低强度存量哈希（模拟强度调整之前注册的账号）
    const legacy = await bcrypt.hash(PASSWORD, 4);
    await env.users.updatePassword(userId, legacy, env.clock);
    assert.equal(bcryptCostOf((await env.users.findById(userId))!.passwordHash), 4);

    await env.identity.loginWeb({ email: backup, password: PASSWORD });
    assert.equal(
      bcryptCostOf((await env.users.findById(userId))!.passwordHash),
      DEFAULT_BCRYPT_COST,
      '用备用邮箱登录也要把旧哈希升上来 —— 很多账号只在启动器里登录',
    );
  });
}
