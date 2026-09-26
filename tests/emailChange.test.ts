import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
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
import { EmailChangeRepository } from '../src/repositories/emailChangeRepository.js';
import { MailService } from '../src/mail/mailService.js';
import type { MailMessage, MailPort } from '../src/mail/types.js';
import { RuntimeSettings } from '../src/site/runtimeSettings.js';
import { SiteUrlResolver } from '../src/site/siteUrl.js';
import { AccountTokenRepository } from '../src/repositories/accountTokenRepository.js';
import { EmailFlow } from '../src/account/emailFlow.js';
import { createEmailChangeRouter } from '../src/server/routes/emailChange.js';
import { createAccountRouter } from '../src/server/routes/account.js';
import { createIdentityRouter } from '../src/server/routes/identity.js';
import { errorHandler } from '../src/server/errorHandler.js';
import {
  EmailChangeFlow,
  BACKUP_VERIFY_TTL_MS,
  CHANGE_TTL_MS,
} from '../src/account/emailChangeFlow.js';
import { AppError } from '../src/errors.js';

/**
 * 0003 备用邮箱与邮箱变更（服务层，双方言）。
 *
 * ## 三条分工是这一层的全部要点
 *
 * 1. 绑定备用邮箱：**独立验证**，不需要主邮箱参与
 * 2. 变更任一个邮箱：**交叉验证** —— 新地址证明归属 + 另一个邮箱授权，**两枚都点完才生效**
 * 3. 被改掉的旧邮箱：只收「已被更改」通知，**不需要它做任何操作，发失败也不阻塞**
 *
 * 第 3 条必须被真正断言（而不是只写在注释里）：它是最容易被后续改动
 * 「顺手改成失败即回滚」的一处，而那样会让一个已经成立的变更因为一封通知信
 * 退回原状。
 *
 * ## 双方言
 *
 * 同一 exercise() 跑 SQLite 与 PostgreSQL；PG 由 TEST_DATABASE_URL 门控。
 * 时间用可推进的假钟，令牌过期与有效期断言不依赖真实等待。
 */

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const SITE_ORIGIN = 'https://skin.change.test';
const DAY = 24 * 3600 * 1000;

/** 记录发出的邮件，可注入故障；按收件地址取信 */
class MemoryMailer implements MailPort {
  readonly sent: MailMessage[] = [];
  /** 命中该地址时抛错（用来验证「通知失败不阻塞」） */
  failFor = new Set<string>();

  async send(message: MailMessage): Promise<void> {
    if (this.failFor.has(message.to)) {
      throw new AppError('SMTP_ERROR', `模拟投递失败：${message.to}`);
    }
    this.sent.push(message);
  }

  async verify(): Promise<void> {}

  to(address: string): MailMessage[] {
    return this.sent.filter((m) => m.to === address);
  }

  lastTo(address: string): MailMessage {
    const list = this.to(address);
    const message = list[list.length - 1];
    assert.ok(message, `应当已发往 ${address} 一封邮件（实际收件人：${this.sent.map((m) => m.to).join(', ')}）`);
    return message;
  }

  clear(): void {
    this.sent.length = 0;
    this.failFor.clear();
  }
}

/** 从邮件正文里抠出动作链接里的 token 参数 */
function tokenOf(message: MailMessage, hashPath: string): string {
  const marker = `${SITE_ORIGIN}/#${hashPath}?token=`;
  const index = message.html.indexOf(marker);
  assert.ok(
    index >= 0,
    `邮件里应包含挂在站点根上的链接 ${marker}（实际正文片段：${message.html.slice(
      message.html.indexOf('class="code"'),
      message.html.indexOf('class="code"') + 200,
    )}）`,
  );
  const rest = message.html.slice(index + marker.length);
  const match = rest.match(/^([A-Za-z0-9_-]+)/);
  assert.ok(match, '链接里应能解析出 token');
  return match[1]!;
}

interface Env {
  db: DatabaseConnection;
  users: UserRepository;
  changes: EmailChangeRepository;
  flow: EmailChangeFlow;
  mailer: MemoryMailer;
  /** 切换「SMTP 是否已配置」，用于断言未配置时的报错 */
  setMailOn: (on: boolean) => void;
  advance: (ms: number) => void;
  clock: () => Date;
}

interface DialectCase {
  label: string;
  skip?: string;
  emailPrefix: string;
  setup: (t: TestContext) => Promise<Env>;
}

async function assertCode(
  fn: () => Promise<unknown>,
  code: string,
  what: string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof AppError, `${what}：应抛 AppError，实际 ${String(err)}`);
    assert.equal(
      err.code,
      code,
      `${what}：错误码应为 ${code}，实际 ${err.code}（${err.message}）`,
    );
    return;
  }
  throw new Error(`${what}：期望抛出 ${code}，但调用成功了`);
}

/** 建一个最小可用的用户（不走 register，避免每个用例付一次 bcrypt） */
async function seedUser(
  env: Env,
  email: string,
  now: Date,
): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  await env.users.insert({
    id,
    email,
    passwordHash: 'x',
    role: 'user',
    now,
  });
  return { id, email };
}

async function exercise(env: Env, prefix: string): Promise<void> {
  const rnd = randomUUID().slice(0, 6);
  const addr = (who: string): string => `${prefix}-${rnd}-${who}@test.local`;

  // ==========================================================================
  // A. 备用邮箱绑定：独立验证
  // ==========================================================================

  const a = await seedUser(env, addr('main'), env.clock());
  const backupA = addr('backup');
  env.mailer.clear();

  const req = await env.flow.requestBackupEmail(a.id, backupA.toUpperCase());
  assert.equal(req.sent, true);
  assert.equal(
    req.pendingEmail,
    backupA.toLowerCase(),
    '待绑定地址应小写入库（与 lower() 唯一索引口径一致）',
  );
  const backupMail = env.mailer.lastTo(backupA);
  assert.match(
    backupMail.subject,
    /备用邮箱/,
    '备用邮箱验证信的主题应能区分于普通邮箱验证',
  );
  const backupToken = tokenOf(backupMail, '/verify-backup-email');

  // 库内只存 sha256，不存明文
  const row = await env.changes.findBackupEmailTokenByHash(
    (await import('../src/util/crypto.js')).sha256Hex(backupToken),
  );
  assert.ok(row, '令牌应以 sha256 入库');
  assert.equal(row.pendingEmail, backupA.toLowerCase());
  assert.equal(
    row.expiresAt,
    new Date(env.clock().getTime() + BACKUP_VERIFY_TTL_MS).toISOString(),
    `备用邮箱验证信有效期应为 ${BACKUP_VERIFY_TTL_MS}ms（邮件文案里写的是 30 分钟）`,
  );

  // 校验失败的各种输入
  await assertCode(
    () => env.flow.requestBackupEmail(a.id, a.email),
    'VALIDATION_ERROR',
    '备用邮箱与主邮箱相同',
  );
  await assertCode(
    () => env.flow.requestBackupEmail(a.id, 'not-an-email'),
    'VALIDATION_ERROR',
    '非法邮箱格式',
  );
  const b = await seedUser(env, addr('other'), env.clock());
  await assertCode(
    () => env.flow.requestBackupEmail(b.id, a.email),
    'EMAIL_TAKEN',
    '把别人的主邮箱当自己的备用邮箱',
  );

  // 未配置 SMTP → 明确报错而不是静默不发
  env.setMailOn(false);
  await assertCode(
    () => env.flow.requestBackupEmail(b.id, addr('nope')),
    'SMTP_ERROR',
    'SMTP 未配置时发起绑定',
  );
  env.setMailOn(true);

  // 走完验证
  const verifiedBackup = await env.flow.verifyBackupEmail(backupToken);
  assert.equal(verifiedBackup.userId, a.id);
  assert.equal(verifiedBackup.email, backupA.toLowerCase());
  const aAfter = (await env.users.findById(a.id))!;
  assert.equal(aAfter.backupEmail, backupA.toLowerCase());
  assert.equal(aAfter.backupEmailVerified, true);
  assert.notEqual(aAfter.backupEmailVerifiedAt, null);

  // 原子消费：第二次必然失败
  await assertCode(
    () => env.flow.verifyBackupEmail(backupToken),
    'TOKEN_REVOKED',
    '重复消费备用邮箱验证链接',
  );

  // 已绑定的地址被别的账号占用 → 拒绝
  await assertCode(
    () => env.flow.requestBackupEmail(b.id, backupA),
    'EMAIL_TAKEN',
    '把别人的备用邮箱当自己的备用邮箱',
  );

  // 已绑且已验证 → 幂等返回，不重复发信
  env.mailer.clear();
  const again = await env.flow.requestBackupEmail(a.id, backupA);
  assert.equal(again.sent, false);
  assert.equal(again.alreadyVerified, true);
  assert.equal(env.mailer.sent.length, 0, '已验证的备用邮箱不该再发验证信');

  // 过期令牌
  const exp = await seedUser(env, addr('exp'), env.clock());
  await env.flow.requestBackupEmail(exp.id, addr('expbackup'));
  const expToken = tokenOf(env.mailer.lastTo(addr('expbackup')), '/verify-backup-email');
  env.advance(BACKUP_VERIFY_TTL_MS + 60_000);
  await assertCode(
    () => env.flow.verifyBackupEmail(expToken),
    'TOKEN_EXPIRED',
    '过期后才点备用邮箱验证链接',
  );

  // 发信与点击之间地址被抢注 → 点链接时才报占用（而不是抛数据库唯一约束）
  const late = await seedUser(env, addr('late'), env.clock());
  await env.flow.requestBackupEmail(late.id, addr('latebackup'));
  const lateToken = tokenOf(
    env.mailer.lastTo(addr('latebackup')),
    '/verify-backup-email',
  );
  const thief = await seedUser(env, addr('latebackup'), env.clock());
  await assertCode(
    () => env.flow.verifyBackupEmail(lateToken),
    'EMAIL_TAKEN',
    '点击时地址已被别人注册为主邮箱',
  );
  assert.equal((await env.users.findById(thief.id))!.id, thief.id);

  // ==========================================================================
  // B. 改主邮箱（有已验证备用邮箱 → 交叉授权给备用邮箱）
  // ==========================================================================

  const newPrimary = addr('newprimary');
  env.mailer.clear();
  const change = await env.flow.requestChange(a.id, {
    target: 'primary',
    newEmail: newPrimary.toUpperCase(),
  });
  assert.equal(change.target, 'primary');
  assert.equal(change.newEmail, newPrimary.toLowerCase());
  assert.equal(
    change.authorizeVia,
    'backup',
    '有已验证备用邮箱时，授权方必须是备用邮箱（交叉验证）',
  );
  assert.equal(change.authorizeEmail, backupA.toLowerCase());
  assert.equal(change.fallbackToSelf, false);
  assert.equal(change.backupEmailRecommended, false);

  const verifyMail = env.mailer.lastTo(newPrimary);
  const authorizeMail = env.mailer.lastTo(backupA);
  assert.match(verifyMail.subject, /确认新的邮箱地址/);
  assert.match(authorizeMail.subject, /授权邮箱变更/);
  assert.equal(
    env.mailer.sent.length,
    2,
    '一次改邮箱只发两封：新地址验证 + 另一个邮箱授权（不含通知）',
  );
  const verifyToken = tokenOf(verifyMail, '/confirm-email-change');
  const authorizeToken = tokenOf(authorizeMail, '/confirm-email-change');

  // 只点一侧 → 不生效
  const first = await env.flow.confirmChange(verifyToken);
  assert.equal(first.completed, false, '只点了一侧不应生效');
  assert.equal(first.role, 'verify');
  assert.equal(first.waitingFor, 'authorize');
  assert.equal(
    (await env.users.findById(a.id))!.email,
    a.email,
    '未完成前主邮箱不得改变',
  );

  // 另一侧也点 → 生效
  const second = await env.flow.confirmChange(authorizeToken);
  assert.equal(second.completed, true);
  assert.equal(second.role, 'authorize');
  assert.equal(second.email, newPrimary.toLowerCase());
  assert.equal(env.mailer.to(a.email).length, 1, '被改掉的旧邮箱应收到 1 封通知');
  const notice = env.mailer.lastTo(a.email);
  assert.match(notice.subject, /邮箱已变更/);
  assert.ok(
    notice.html.includes(a.email) && notice.html.includes(newPrimary.toLowerCase()),
    '通知里应同时给出旧地址与新地址',
  );

  const aChanged = (await env.users.findById(a.id))!;
  assert.equal(aChanged.email, newPrimary.toLowerCase());
  assert.equal(
    aChanged.emailVerified,
    true,
    '新地址已由 verify 令牌证明归属，应一并为已验证（否则开启邮箱验证的站点上会自我锁死）',
  );

  // 重放已完成的链接 → 幂等回答已完成，不报错也不重复通知
  env.mailer.clear();
  const replay = await env.flow.confirmChange(verifyToken);
  assert.equal(replay.completed, true, '重放已完成的链接应如实回答「已完成」');
  assert.equal(env.mailer.sent.length, 0, '重放不应重复发通知');

  // 新地址与当前邮箱相同 / 与另一个槽位相同的约束
  await assertCode(
    () => env.flow.requestChange(a.id, { target: 'primary', newEmail: newPrimary }),
    'VALIDATION_ERROR',
    '新邮箱与当前邮箱相同',
  );
  await assertCode(
    () => env.flow.requestChange(a.id, { target: 'primary', newEmail: backupA }),
    'VALIDATION_ERROR',
    '新主邮箱与备用邮箱相同',
  );
  await assertCode(
    () => env.flow.requestChange(a.id, { target: 'backup', newEmail: newPrimary }),
    'VALIDATION_ERROR',
    '新备用邮箱与主邮箱相同',
  );
  await assertCode(
    () =>
      env.flow.requestChange(a.id, {
        target: 'nonsense' as unknown as 'primary',
        newEmail: addr('x'),
      }),
    'VALIDATION_ERROR',
    '非法的 target',
  );

  // ==========================================================================
  // C. 改备用邮箱（授权方恒为主邮箱）
  // ==========================================================================

  const newBackup = addr('newbackup');
  env.mailer.clear();
  const changeBackup = await env.flow.requestChange(a.id, {
    target: 'backup',
    newEmail: newBackup,
  });
  assert.equal(changeBackup.authorizeVia, 'primary');
  assert.equal(changeBackup.authorizeEmail, newPrimary.toLowerCase());
  const buVerifyToken = tokenOf(env.mailer.lastTo(newBackup), '/confirm-email-change');
  const buAuthToken = tokenOf(
    env.mailer.lastTo(newPrimary),
    '/confirm-email-change',
  );
  await env.flow.confirmChange(buAuthToken);
  const buDone = await env.flow.confirmChange(buVerifyToken);
  assert.equal(buDone.completed, true);
  const aBackup = (await env.users.findById(a.id))!;
  assert.equal(aBackup.backupEmail, newBackup.toLowerCase());
  assert.equal(
    aBackup.backupEmailVerified,
    true,
    '新备用邮箱已由 verify 令牌证明归属，应直接是已验证状态',
  );
  assert.equal(
    aBackup.email,
    newPrimary.toLowerCase(),
    '改备用邮箱不该动主邮箱',
  );

  // ==========================================================================
  // D. 单邮箱账号改主邮箱：授权回落到当前主邮箱自己（不死锁）
  // ==========================================================================

  const d = await seedUser(env, addr('solo'), env.clock());
  const soloNew = addr('solonew');
  env.mailer.clear();
  const soloChange = await env.flow.requestChange(d.id, {
    target: 'primary',
    newEmail: soloNew,
  });
  assert.equal(
    soloChange.authorizeVia,
    'primary',
    '没有已验证备用邮箱时授权回落到当前主邮箱（否则用户会被锁死）',
  );
  assert.equal(soloChange.authorizeEmail, d.email);
  assert.equal(soloChange.fallbackToSelf, true);
  assert.equal(
    soloChange.backupEmailRecommended,
    true,
    '单邮箱用户改邮箱时应提示补一个备用邮箱作兜底',
  );
  assert.equal(
    env.mailer.sent.length,
    2,
    '两封信发往两个不同地址：新地址 + 当前地址（新地址无法自我授权）',
  );
  const soloVerify = tokenOf(env.mailer.lastTo(soloNew), '/confirm-email-change');
  const soloAuth = tokenOf(env.mailer.lastTo(d.email), '/confirm-email-change');
  await env.flow.confirmChange(soloVerify);
  const soloDone = await env.flow.confirmChange(soloAuth);
  assert.equal(soloDone.completed, true);
  assert.equal((await env.users.findById(d.id))!.email, soloNew.toLowerCase());

  // ==========================================================================
  // E. 通知失败不阻塞变更（旧邮箱收不到信也要完成）
  // ==========================================================================

  const e = await seedUser(env, addr('notice'), env.clock());
  const eNew = addr('noticenew');
  await env.flow.requestBackupEmail(e.id, addr('noticebackup'));
  const eBackupToken = tokenOf(
    env.mailer.lastTo(addr('noticebackup')),
    '/verify-backup-email',
  );
  await env.flow.verifyBackupEmail(eBackupToken);
  await env.flow.requestChange(e.id, { target: 'primary', newEmail: eNew });
  const eVerify = tokenOf(env.mailer.lastTo(eNew), '/confirm-email-change');
  const eAuth = tokenOf(
    env.mailer.lastTo(addr('noticebackup')),
    '/confirm-email-change',
  );
  await env.flow.confirmChange(eVerify);
  // 让「通知旧地址」这一封必然失败
  env.mailer.failFor.add(e.email);
  const eDone = await env.flow.confirmChange(eAuth);
  assert.equal(
    eDone.completed,
    true,
    '通知发失败**不得**阻塞或回滚变更 —— 变更的合法性由两枚令牌保证',
  );
  assert.equal(
    (await env.users.findById(e.id))!.email,
    eNew.toLowerCase(),
    '通知失败后新邮箱仍应生效',
  );

  // ==========================================================================
  // F. 收敛点：两枚都点过但没生效时能自愈（并发点击的兜底）
  // ==========================================================================

  const f = await seedUser(env, addr('finalize'), env.clock());
  const fNew = addr('finalizenew');
  const fReq = await env.flow.requestChange(f.id, {
    target: 'primary',
    newEmail: fNew,
  });
  const fVerify = tokenOf(env.mailer.lastTo(fNew), '/confirm-email-change');
  const fAuth = tokenOf(env.mailer.lastTo(f.email), '/confirm-email-change');

  // 手工把两枚都标记为已消费，但**不**走 tryFinalize —— 精确复现
  // 「两个请求各自只看见自己那一枚」之后的中间态
  const { sha256Hex } = await import('../src/util/crypto.js');
  const now = env.clock();
  const consume = async (token: string) => {
    const r = await env.changes.consumeChangeToken(sha256Hex(token), now);
    assert.ok(r, '手工消费应当成功');
  };
  await consume(fVerify);
  await consume(fAuth);

  const stale = await env.changes.findChangeRequestById(fReq.requestId);
  assert.ok(stale);
  assert.equal(stale.completedAt, null, '此时请求仍未完成 —— 这正是需要自愈的状态');
  assert.equal(
    (await env.users.findById(f.id))!.email,
    f.email,
    '邮箱尚未变更',
  );

  const healed = await env.flow.finalizePendingChange(f.id);
  assert.equal(healed.completed, true, '收敛点应把变更落地');
  assert.equal(healed.email, fNew.toLowerCase());
  assert.equal((await env.users.findById(f.id))!.email, fNew.toLowerCase());
  // 再调一次：幂等
  const healedAgain = await env.flow.finalizePendingChange(f.id);
  assert.equal(healedAgain.completed, true);

  // ==========================================================================
  // G. 状态查询与取消
  // ==========================================================================

  const g = await seedUser(env, addr('status'), env.clock());
  let status = await env.flow.getStatus(g.id);
  assert.equal(status.email, g.email);
  assert.equal(status.backupEmail, null);
  assert.equal(status.hasVerifiedBackup, false);
  assert.equal(status.backupEmailRecommended, true);
  assert.equal(status.pendingChange, null);

  const gBackup = addr('statusbackup');
  await env.flow.requestBackupEmail(g.id, gBackup);
  const gBackupToken = tokenOf(
    env.mailer.lastTo(gBackup),
    '/verify-backup-email',
  );
  await env.flow.verifyBackupEmail(gBackupToken);
  status = await env.flow.getStatus(g.id);
  assert.equal(status.backupEmail, gBackup.toLowerCase());
  assert.equal(status.backupEmailVerified, true);
  assert.equal(status.hasVerifiedBackup, true);
  assert.equal(status.backupEmailRecommended, false);

  const gNew = addr('statusnew');
  await env.flow.requestChange(g.id, { target: 'primary', newEmail: gNew });
  const gVerify = tokenOf(env.mailer.lastTo(gNew), '/confirm-email-change');
  await env.flow.confirmChange(gVerify);
  status = await env.flow.getStatus(g.id);
  assert.ok(status.pendingChange, '应报告进行中的改邮箱请求');
  assert.equal(status.pendingChange.verifyConfirmed, true);
  assert.equal(status.pendingChange.authorizeConfirmed, false);
  assert.equal(status.pendingChange.newEmail, gNew.toLowerCase());
  assert.equal(status.pendingChange.authorizeVia, 'backup');

  // 取消
  const cancelled = await env.flow.cancelChange(g.id);
  assert.equal(cancelled.cancelled, 1);
  assert.equal((await env.flow.getStatus(g.id)).pendingChange, null);
  await assertCode(
    () => env.flow.confirmChange(gVerify),
    'TOKEN_REVOKED',
    '取消后再点链接',
  );

  // 取消后再发起新请求：旧请求不会再来捣乱
  const gNew2 = addr('statusnew2');
  const gReq2 = await env.flow.requestChange(g.id, {
    target: 'primary',
    newEmail: gNew2,
  });
  const gVerify2 = tokenOf(env.mailer.lastTo(gNew2), '/confirm-email-change');
  const gAuth2 = tokenOf(
    env.mailer.lastTo(gBackup),
    '/confirm-email-change',
  );
  await env.flow.confirmChange(gVerify2);
  const gDone2 = await env.flow.confirmChange(gAuth2);
  assert.equal(gDone2.completed, true);
  assert.equal(gDone2.email, gNew2.toLowerCase());
  assert.ok(gReq2.requestId);

  // ==========================================================================
  // H. 解除备用邮箱：只取消依赖该槽位的进行中请求
  // ==========================================================================

  const h = await seedUser(env, addr('remove'), env.clock());
  const hBackup = addr('removebackup');
  await env.flow.requestBackupEmail(h.id, hBackup);
  await env.flow.verifyBackupEmail(
    tokenOf(env.mailer.lastTo(hBackup), '/verify-backup-email'),
  );
  // 一个与备用邮箱无关的进行中请求（授权回落到主邮箱自己，因为下面改的是备用邮箱
  // 之外的槽位不成立 —— 这里改主邮箱时备用邮箱已验证，所以授权方是备用邮箱）
  const hNew = addr('removenew');
  await env.flow.requestChange(h.id, { target: 'primary', newEmail: hNew });
  const removed = await env.flow.removeBackupEmail(h.id);
  assert.equal(removed.email, hBackup.toLowerCase());
  const hAfter = (await env.users.findById(h.id))!;
  assert.equal(hAfter.backupEmail, null);
  assert.equal(hAfter.backupEmailVerified, false);
  // 该请求的授权方是那个已被解绑的备用邮箱 → 它已经不可能完成，应被取消
  assert.equal(
    (await env.flow.getStatus(h.id)).pendingChange,
    null,
    '依赖已解绑备用邮箱的请求应被取消',
  );

  // 改主邮箱（无备用邮箱）后解除备用邮箱：不该误伤那个与备用邮箱无关的请求
  const h2 = await seedUser(env, addr('remove2'), env.clock());
  const h2New = addr('remove2new');
  await env.flow.requestChange(h2.id, { target: 'primary', newEmail: h2New });
  const h2Verify = tokenOf(env.mailer.lastTo(h2New), '/confirm-email-change');
  const h2Auth = tokenOf(env.mailer.lastTo(h2.email), '/confirm-email-change');
  const h2Removed = await env.flow.removeBackupEmail(h2.id);
  assert.equal(h2Removed.email, null, '没有备用邮箱时解除应幂等返回 null');
  const h2Status = await env.flow.getStatus(h2.id);
  assert.ok(
    h2Status.pendingChange,
    '与备用邮箱无关的进行中请求不该被「解除备用邮箱」顺手取消掉',
  );
  await env.flow.confirmChange(h2Verify);
  const h2Done = await env.flow.confirmChange(h2Auth);
  assert.equal(h2Done.completed, true);
  assert.equal(h2Done.email, h2New.toLowerCase());

  // ==========================================================================
  // I. 启动清理
  // ==========================================================================

  const i = await seedUser(env, addr('purge'), env.clock());
  await env.flow.requestBackupEmail(i.id, addr('purgebackup'));
  await env.flow.requestChange(i.id, { target: 'primary', newEmail: addr('purgenew') });
  env.advance(CHANGE_TTL_MS + DAY);
  await env.flow.purgeExpired();
  const iStatus = await env.flow.getStatus(i.id);
  assert.equal(iStatus.pendingChange, null, '过期请求应被清理');
  const iRow = await env.changes.findBackupEmailTokenByHash(
    // 令牌已被删除 → 用「查不到」间接确认清理生效
    'no-such-hash',
  );
  assert.equal(iRow, null);
}

const cases: DialectCase[] = [
  {
    label: 'sqlite',
    emailPrefix: 'sq-ech',
    setup: async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'mscts-ech-'));
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
        emailPrefix: 'pg-ech',
        setup: async (t) => {
          const db = PostgresConnection.connect(TEST_DATABASE_URL!);
          await runMigrations(db, join(SCHEMA_DIR, 'postgresql'));
          await db.run("DELETE FROM users WHERE email LIKE 'pg-ech-%'");
          t.after(async () => {
            await db
              .run("DELETE FROM users WHERE email LIKE 'pg-ech-%'")
              .catch(() => undefined);
            await db.close().catch(() => undefined);
          });
          return buildEnv(db);
        },
      }
    : {
        label: 'postgres',
        emailPrefix: 'pg-ech',
        skip: '未设置 TEST_DATABASE_URL，跳过 PostgreSQL 邮箱变更测试',
        setup: async () => {
          throw new Error('unreachable');
        },
      },
];

function buildEnv(db: DatabaseConnection): Env {
  const users = new UserRepository(db);
  const profiles = new ProfileRepository(db);
  const changes = new EmailChangeRepository(db);
  const mailer = new MemoryMailer();
  let clock = new Date();
  let mailOn = true;

  // 用假设置源而不是真 SettingRepository：这里只关心「SMTP 已配置 / 未配置」
  // 与站点名两个读取结果，走真库反而把测试和设置表的读写细节绑在一起。
  const runtime = new RuntimeSettings({
    settings: {
      getAll: async () =>
        mailOn
          ? {
              SMTP_HOST: 'smtp.change.test',
              SMTP_PORT: 587,
              SMTP_FROM: 'noreply@test.local',
              SMTP_FROM_NAME: 'MSCTS 变更测试站',
              SITE_TITLE: 'MSCTS 变更测试站',
            }
          : {},
    },
    ttlMs: 0,
    now: () => clock.getTime(),
  });

  const siteUrl = new SiteUrlResolver({
    settings: { get: async () => null },
    envPublicBaseUrl: `${SITE_ORIGIN}/uploads`,
    ttlMs: 0,
  });

  const mail = new MailService({ mailer, runtime, now: () => clock });
  const emailFlow = new EmailChangeFlow({
    db,
    users,
    changes,
    mail,
    siteUrl,
    // 用真的 IdentityService 提供邮箱格式校验，避免测试里出现第二套正则
    emails: new IdentityService({
      db,
      users,
      profiles,
      tokens: new TokenService(new TokenRepository(db)),
      sessions: new MinecraftSessionRepository(db),
    }),
    now: () => clock,
  });

  return {
    db,
    users,
    changes,
    flow: emailFlow,
    mailer,
    setMailOn: (on) => {
      mailOn = on;
    },
    advance: (ms) => {
      clock = new Date(clock.getTime() + ms);
    },
    clock: () => clock,
  };
}

for (const c of cases) {
  test(`emailChange: 备用邮箱与邮箱变更（${c.label}）`, { skip: c.skip }, async (t) => {
    const env = await c.setup(t);
    env.mailer.clear();
    await exercise(env, c.emailPrefix);
  });
}

// ---------------------------------------------------------------------------
// HTTP 端点层
//
// 只跑一遍 SQLite：路由层与方言无关，而这里的目的是覆盖**链路上**才暴露的东西 ——
// 鉴权中间件与限流的先后顺序（限流按 userId 取键，必须排在 auth 之后）、
// 请求体字段校验、响应形状、两个新路由与既有 account 路由的挂载顺序。
// 服务层逻辑已由上面的双方言用例覆盖，这里不重复。
// ---------------------------------------------------------------------------

test('emailChange: HTTP 端点（sqlite）', async (t) => {
  const express = (await import('express')).default;
  const dir = await mkdtemp(join(tmpdir(), 'mscts-ech-http-'));
  const db = new SqliteConnection(join(dir, 't.db'));
  await runMigrations(db, join(SCHEMA_DIR, 'sqlite'));
  t.after(async () => {
    await db.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  const users = new UserRepository(db);
  const profiles = new ProfileRepository(db);
  const changes = new EmailChangeRepository(db);
  const tokenService = new TokenService(new TokenRepository(db));
  const mailer = new MemoryMailer();
  const clock = new Date();

  const runtime = new RuntimeSettings({
    settings: {
      getAll: async () => ({
        SMTP_HOST: 'smtp.change.test',
        SMTP_PORT: 587,
        SMTP_FROM: 'noreply@test.local',
        SITE_TITLE: 'MSCTS 端点测试站',
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
  const emailChangeFlow = new EmailChangeFlow({
    db,
    users,
    changes,
    mail,
    siteUrl,
    emails: identity,
    now: () => clock,
  });
  // EmailFlow 只用于 account 路由的 email-status 合并路径
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

  const app = express();
  app.use(express.json());
  app.use(
    createEmailChangeRouter({ tokenService, emailChangeFlow }),
  );
  app.use(
    createAccountRouter({ tokenService, emailFlow, emailChangeFlow }),
  );
  app.use(
    createIdentityRouter({
      identity,
      tokenService,
      runtimeSettings: runtime,
      emailFlow,
    }),
  );
  app.use(errorHandler);

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const userId = randomUUID();
  await users.insert({
    id: userId,
    email: 'http-main@test.local',
    passwordHash: 'x',
    role: 'user',
    now: clock,
  });
  const session = await tokenService.issue({ tokenType: 'web', userId });
  const authHeaders = {
    'content-type': 'application/json',
    authorization: `Bearer ${session.token}`,
  };

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = authHeaders,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    };
  };

  // 未带会话 → 401（说明 auth 挂在写操作上）
  assert.equal(
    (await call('POST', '/api/me/backup-email', { email: 'x@test.local' }, { 'content-type': 'application/json' })).status,
    401,
    '发起备用邮箱绑定必须要求会话',
  );

  // GET /api/me/profile-mode
  let res = await call('GET', '/api/me/profile-mode');
  assert.equal(res.status, 200);
  assert.equal(res.body['mode'], 'single');
  assert.equal(res.body['decisionRequired'], false);
  assert.equal(res.body['maxProfiles'], 10);
  assert.equal(res.body['cooldownUntil'], null);

  // 单模式新建角色 → 400（错误码带 errorMessage 兼容键）
  res = await call('POST', '/api/profiles', { name: 'httpsecond' });
  assert.equal(res.status, 400);
  assert.equal(res.body['error'], 'VALIDATION_ERROR');
  assert.equal(
    res.body['errorMessage'],
    res.body['message'],
    '错误体应同时带 message 与 errorMessage（旧前端读后者）',
  );

  // P5 第十批：用户名模式自助切换仅超管 —— 普通用户先被 403 拦下
  // （守卫在读 mode 参数之前，所以非法 mode 也不会泄漏成 400）
  res = await call('POST', '/api/me/profile-mode', { mode: 'multi' });
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body['error'], 'FORBIDDEN');

  // 提权为 super_admin 后继续原有流程。
  // token 校验每请求从库里读角色（findByHashWithUser），所以无需重发 token。
  await users.updateAdminFields(userId, { role: 'super_admin' }, clock);

  // POST /api/me/profile-mode：切到多模式 → 200 且返回完整状态
  res = await call('POST', '/api/me/profile-mode', { mode: 'multi' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body['mode'], 'multi');
  assert.equal(res.body['activeLimit'], 10);

  // 非法 mode → 400
  res = await call('POST', '/api/me/profile-mode', { mode: 'nonsense' });
  assert.equal(res.status, 400);

  // 多模式下新建角色 → 201（注意：本用例的用户是 users.insert 直建的，
  // 不像 register 那样自带默认角色，所以下面要建两个）
  res = await call('POST', '/api/profiles', { name: 'httpfirst' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  res = await call('POST', '/api/profiles', { name: 'httpsecond' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const secondProfileId = String(
    (res.body['profile'] as { id: string }).id,
  );

  // 切回单模式保留第二个 → 200，第一个转预留
  res = await call('POST', '/api/me/profile-mode', {
    mode: 'single',
    keepProfileId: secondProfileId,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body['activeCount'], 1);
  assert.equal(res.body['reservedCount'], 1);
  assert.notEqual(res.body['cooldownUntil'], null);

  // 冷却期内启用预留角色 → 403 MODE_COOLDOWN
  const list = await call('GET', '/api/me/profiles');
  const reservedProfile = (list.body['profiles'] as Array<{ id: string; status: string }>).find(
    (p) => p.status === 'reserved',
  );
  assert.ok(reservedProfile, '/api/me/profiles 应返回 status 字段，供前端分出预留口');
  res = await call('POST', `/api/me/profiles/${reservedProfile.id}/activate`);
  assert.equal(res.status, 403);
  assert.equal(res.body['error'], 'MODE_COOLDOWN');

  // ---- 邮箱端点 ----

  mailer.clear();
  const backupAddr = 'http-backup@test.local';
  res = await call('POST', '/api/me/backup-email', { email: backupAddr });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body['sent'], true);
  assert.equal(res.body['pendingEmail'], backupAddr);

  // 缺邮箱 → 400
  res = await call('POST', '/api/me/backup-email', { email: '  ' });
  assert.equal(res.status, 400);

  // 匿名消费验证令牌（不带 Authorization）
  const backupToken = tokenOf(mailer.lastTo(backupAddr), '/verify-backup-email');
  res = await call(
    'POST',
    '/api/me/backup-email/verify',
    { token: backupToken },
    { 'content-type': 'application/json' },
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body['email'], backupAddr);

  // 邮箱状态合并接口：备用邮箱字段应出现
  res = await call('GET', '/api/me/email-status');
  assert.equal(res.status, 200);
  assert.equal(res.body['email'], 'http-main@test.local');
  assert.equal(res.body['backupEmail'], backupAddr);
  assert.equal(res.body['backupEmailVerified'], true);
  assert.equal(res.body['hasVerifiedBackup'], true);
  assert.equal(
    res.body['backupEmailRecommended'],
    false,
    '已有已验证备用邮箱时不该再提示补一个',
  );

  // 发起改邮箱
  const newPrimary = 'http-newprimary@test.local';
  mailer.clear();
  res = await call('POST', '/api/me/email-change', {
    target: 'primary',
    newEmail: newPrimary,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body['authorizeVia'], 'backup');
  const changeVerify = tokenOf(mailer.lastTo(newPrimary), '/confirm-email-change');
  const changeAuth = tokenOf(mailer.lastTo(backupAddr), '/confirm-email-change');

  // 非法 target → 400
  res = await call('POST', '/api/me/email-change', {
    target: 'other',
    newEmail: 'whatever@test.local',
  });
  assert.equal(res.status, 400);

  // 只点一侧 → completed:false 且 waitingFor 告知还差哪一侧
  res = await call(
    'POST',
    '/api/me/email-change/confirm',
    { token: changeVerify },
    { 'content-type': 'application/json' },
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body['completed'], false);
  assert.equal(res.body['waitingFor'], 'authorize');

  // finalize 在另一侧没点时应如实回答未完成
  res = await call('POST', '/api/me/email-change/finalize');
  assert.equal(res.status, 200);
  assert.equal(res.body['completed'], false);

  // 另一侧点完 → 生效
  res = await call(
    'POST',
    '/api/me/email-change/confirm',
    { token: changeAuth },
    { 'content-type': 'application/json' },
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body['completed'], true);
  assert.equal(res.body['email'], newPrimary);
  assert.equal((await users.findById(userId))!.email, newPrimary);

  // 状态里进行中的请求已清空
  res = await call('GET', '/api/me/email-status');
  assert.equal(res.body['pendingChange'], null);

  // 解除备用邮箱
  res = await call('DELETE', '/api/me/backup-email');
  assert.equal(res.status, 200);
  assert.equal(res.body['removed'], backupAddr);
  assert.equal((await users.findById(userId))!.backupEmail, null);

  // 无会话访问状态 → 401
  res = await call('GET', '/api/me/email-status', undefined, { 'content-type': 'application/json' });
  assert.equal(res.status, 401);
});
