import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../types.js';
import { AppError } from '../errors.js';
import { sha256Hex } from '../util/crypto.js';
import type { IdentityService } from '../auth/identity.js';
import type { TokenService } from '../auth/tokens.js';
import type { UserRepository, UserRow } from '../repositories/userRepository.js';
import type {
  AccountTokenKind,
  AccountTokenRepository,
  AccountTokenRow,
} from '../repositories/accountTokenRepository.js';
import type { MailService } from '../mail/mailService.js';
import type { SiteUrlResolver } from '../site/siteUrl.js';

/**
 * 邮箱验证与密码重置的业务流程（P5）。
 *
 * ## 一次性令牌的两条铁律
 *
 * 1. **明文只出现在邮件里**：库里存 sha256(明文)。数据库被读走也无法反推出可用链接。
 *    令牌用 32 字节随机（256 bit）而非自增 ID，杜绝枚举。
 * 2. **消费必须原子**：判定与置位写进同一条 UPDATE（见 AccountTokenRepository.consume），
 *    避免「邮件客户端预取链接 + 用户点击」并发命中导致重置密码被执行两次。
 *
 * ## 有效期
 *
 * 验证链接 30 分钟 —— 与站点自带的邮件模板文案「此链接 30 分钟内有效」一致，
 * 改这里就必须同步改文案，否则邮件在骗用户。
 * 重置链接 1 小时 —— 密码重置往往发生在「想起来才去收信」的场景，30 分钟太紧。
 *
 * ## 静默返回的场合
 *
 * 发送重置邮件时账号不存在也返回成功：否则「填个邮箱看有没有反应」就成了
 * 账号枚举接口。这个取舍在登录、找回两处必须一致，不能一处防一处不防。
 */

/** 验证链接有效期；与 web/src/i18n 的 emailTemplateLinkValid 文案绑定 */
export const VERIFICATION_TTL_MS = 30 * 60 * 1000;
/** 重置链接有效期 */
export const RESET_TTL_MS = 60 * 60 * 1000;

const MAIL_NOT_CONFIGURED =
  '站点尚未配置 SMTP，无法发送邮件。请联系管理员配置邮件设置。';

export interface EmailFlowDependencies {
  db: DatabaseConnection;
  users: UserRepository;
  tokens: AccountTokenRepository;
  /** 改密后吊销全部会话 */
  tokenService: TokenService;
  mail: MailService;
  siteUrl: SiteUrlResolver;
  /** 密码校验与哈希（复用 IdentityService 的规则与 cost） */
  passwords: Pick<IdentityService, 'assertValidPassword' | 'hashPassword'>;
  now?: () => Date;
}

export interface SendVerificationResult {
  /** 本次是否真的发出了邮件 */
  sent: boolean;
  /** 邮箱此前已经验证过（幂等调用，不重复发信） */
  alreadyVerified: boolean;
}

export interface AccountActionResult {
  userId: string;
  email: string;
}

export class EmailFlow {
  private readonly db: DatabaseConnection;
  private readonly users: UserRepository;
  private readonly tokens: AccountTokenRepository;
  private readonly tokenService: TokenService;
  private readonly mail: MailService;
  private readonly siteUrl: SiteUrlResolver;
  private readonly passwords: Pick<IdentityService, 'assertValidPassword' | 'hashPassword'>;
  private readonly now: () => Date;

  constructor(deps: EmailFlowDependencies) {
    this.db = deps.db;
    this.users = deps.users;
    this.tokens = deps.tokens;
    this.tokenService = deps.tokenService;
    this.mail = deps.mail;
    this.siteUrl = deps.siteUrl;
    this.passwords = deps.passwords;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * SMTP 未配置时给出可执行的提示，而不是让 nodemailer 报一串底层错误。
   * 公开出来供注册端点在**创建账号之前**预检：需要邮箱验证但发不出信时，
   * 应当在建号前就拒绝，而不是把用户建成一个登不进去又收不到信的账号。
   */
  async assertMailReady(): Promise<void> {
    if (!(await this.mail.configured())) {
      throw new AppError('SMTP_ERROR', MAIL_NOT_CONFIGURED);
    }
  }

  /**
   * 签发令牌并作废该用户同类旧令牌。
   * 作废旧链接是必要的：否则管理员连点几次「重发」，所有历史邮件里的链接同时有效，
   * 有效链接的数量只增不减，等于把攻击面交给时间。
   */
  private async issueToken(
    kind: AccountTokenKind,
    userId: string,
    ttlMs: number,
  ): Promise<string> {
    const now = this.now();
    await this.tokens.invalidateUnusedForUser(kind, userId, now);

    const token = randomBytes(32).toString('base64url');
    await this.tokens.insert(kind, {
      id: randomUUID(),
      userId,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(now.getTime() + ttlMs),
      createdAt: now,
    });
    return token;
  }

  /**
   * 取出并校验令牌（不消费）。三种失败各有精确文案，
   * 让用户知道该「重新获取」还是「别重复点」。
   */
  private async loadToken(
    kind: AccountTokenKind,
    token: string,
  ): Promise<AccountTokenRow> {
    if (typeof token !== 'string' || token.trim() === '') {
      throw new AppError('TOKEN_INVALID', '链接缺少令牌参数');
    }
    const row = await this.tokens.findByHash(kind, sha256Hex(token));
    if (!row) {
      throw new AppError('TOKEN_INVALID', '链接无效或已被清理，请重新获取');
    }
    if (row.usedAt !== null) {
      throw new AppError('TOKEN_REVOKED', '该链接已被使用，或已被更新的链接替换');
    }
    if (new Date(row.expiresAt).getTime() <= this.now().getTime()) {
      throw new AppError('TOKEN_EXPIRED', '链接已过期，请重新获取');
    }
    return row;
  }

  // ---- 邮箱验证 ----

  /** 发送验证邮件（已登录用户主动触发，或注册后自动触发） */
  async sendVerification(userId: string): Promise<SendVerificationResult> {
    const user = await this.users.findById(userId);
    if (!user || user.purgedAt !== null) {
      throw new AppError('NOT_FOUND', '用户不存在');
    }
    // 已验证过就不必再发：反复点「重发验证」不该产生一堆邮件
    if (user.emailVerified) {
      return { sent: false, alreadyVerified: true };
    }

    await this.assertMailReady();
    const token = await this.issueToken(
      'email_verification',
      user.id,
      VERIFICATION_TTL_MS,
    );
    const url = await this.siteUrl.link('/verify-email', { token });
    await this.mail.sendVerification({ to: user.email, url });
    return { sent: true, alreadyVerified: false };
  }

  /**
   * 未登录状态下按邮箱重发验证邮件。
   *
   * 这是必需的路径而非补充：开启「要求邮箱验证」后，未验证用户连登录都过不去
   * （403 EMAIL_NOT_VERIFIED），此时他手上没有可用令牌，只能凭邮箱请求重发。
   *
   * 邮箱不存在或已注销时静默返回 —— 否则这个免认证端点就成了账号枚举工具。
   */
  async resendVerificationByEmail(email: string): Promise<SendVerificationResult> {
    await this.assertMailReady();

    const user = await this.users.findByEmail(email);
    if (!user || user.purgedAt !== null) {
      return { sent: false, alreadyVerified: false };
    }
    return this.sendVerification(user.id);
  }

  /**
   * 消费验证链接。
   * 消费令牌与置位 email_verified 放在同一事务：否则可能「链接作废了但邮箱仍未验证」，
   * 用户拿着已失效的链接反复重试，只能人工介入。
   */
  async verifyEmail(token: string): Promise<AccountActionResult> {
    const row = await this.loadToken('email_verification', token);
    const user = await this.users.findById(row.userId);
    if (!user || user.purgedAt !== null) {
      throw new AppError('NOT_FOUND', '用户不存在');
    }

    const now = this.now();
    await this.db.transaction(async () => {
      const consumed = await this.tokens.consume(
        'email_verification',
        row.tokenHash,
        now,
      );
      if (!consumed) {
        // 走到这里说明并发下被别人抢先消费（loadToken 到 consume 之间的窗口）
        throw new AppError('TOKEN_REVOKED', '该验证链接已被使用');
      }
      await this.users.setEmailVerified(consumed.userId, true, now);
    });

    return { userId: user.id, email: user.email };
  }

  // ---- 密码重置 ----

  private async issueAndSendReset(user: UserRow): Promise<void> {
    const token = await this.issueToken('password_reset', user.id, RESET_TTL_MS);
    const url = await this.siteUrl.link('/reset-password', { token });
    await this.mail.sendPasswordReset({ to: user.email, url });
  }

  /** 发送重置邮件；账号不存在时静默成功（防账号枚举，见文件头） */
  async sendReset(email: string): Promise<void> {
    await this.assertMailReady();

    const user = await this.users.findByEmail(email);
    if (!user || user.purgedAt !== null) return;

    await this.issueAndSendReset(user);
  }

  /**
   * 已登录用户请求重置密码（个人中心的「忘记密码」入口走这条）。
   * 会话仍在时无需再让用户填一遍邮箱 —— 身份由令牌给出，与匿名入口共用同一套
   * 签发逻辑，避免两条路径出现有效期或作废策略不一致。
   */
  async sendResetForUser(userId: string): Promise<void> {
    await this.assertMailReady();

    const user = await this.users.findById(userId);
    if (!user || user.purgedAt !== null) {
      throw new AppError('NOT_FOUND', '用户不存在');
    }
    await this.issueAndSendReset(user);
  }

  /**
   * 消费重置链接并改密。
   *
   * 三件事在事务内一起完成：消费令牌、写入新密码、置 email_verified。
   * 「重置密码顺带完成邮箱验证」不是偷懒 —— 能点开这封邮件就已经证明了邮箱归属，
   * 同时也是用户卡在「未验证」状态时的自救路径（管理员没配好 SMTP 时尤其重要）。
   *
   * 事务外吊销全部会话：密码变了，旧凭据必须立刻失效（与 change-password 语义一致）。
   */
  async resetPassword(
    token: string,
    newPassword: string,
  ): Promise<AccountActionResult> {
    const row = await this.loadToken('password_reset', token);
    const user = await this.users.findById(row.userId);
    if (!user || user.purgedAt !== null) {
      throw new AppError('NOT_FOUND', '用户不存在');
    }
    // 先算哈希（bcrypt 很慢），把耗时放在事务外，别让事务持有时间被哈希拖长
    const passwordHash = await this.passwords.hashPassword(newPassword);

    const now = this.now();
    await this.db.transaction(async () => {
      const consumed = await this.tokens.consume(
        'password_reset',
        row.tokenHash,
        now,
      );
      if (!consumed) {
        throw new AppError('TOKEN_REVOKED', '该重置链接已被使用');
      }
      await this.users.updatePassword(user.id, passwordHash, now);
      await this.users.setEmailVerified(user.id, true, now);
      await this.tokens.invalidateUnusedForUser('password_reset', user.id, now);
    });

    await this.tokenService.revokeAllForUser(user.id);
    return { userId: user.id, email: user.email };
  }

  // ---- 状态查询 ----

  /** 当前账号的邮箱与验证状态（个人中心展示用） */
  async getEmailStatus(
    userId: string,
  ): Promise<{ email: string; emailVerified: boolean }> {
    const user = await this.users.findById(userId);
    if (!user || user.purgedAt !== null) {
      throw new AppError('NOT_FOUND', '用户不存在');
    }
    return { email: user.email, emailVerified: user.emailVerified };
  }

  // ---- 管理端 ----

  /** 管理员手动放行/收回邮箱验证（用户收不到信时的兜底） */
  async adminSetEmailVerified(
    userId: string,
    verified: boolean,
  ): Promise<AccountActionResult & { emailVerified: boolean }> {
    const user = await this.users.findById(userId);
    if (!user || user.purgedAt !== null) {
      throw new AppError('NOT_FOUND', '用户不存在');
    }
    await this.users.setEmailVerified(user.id, verified, this.now());
    return { userId: user.id, email: user.email, emailVerified: verified };
  }

  /** 启动时清理过期令牌；表只增不减会无限膨胀 */
  async purgeExpiredTokens(): Promise<void> {
    const cutoff = this.now();
    await this.tokens.deleteExpired('email_verification', cutoff);
    await this.tokens.deleteExpired('password_reset', cutoff);
  }
}
