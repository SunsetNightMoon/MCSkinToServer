import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../types.js';
import { AppError } from '../errors.js';
import { sha256Hex } from '../util/crypto.js';
import type { IdentityService } from '../auth/identity.js';
import type { UserRepository, UserRow } from '../repositories/userRepository.js';
import type {
  EmailChangeRepository,
  EmailChangeRequestRow,
  EmailChangeRole,
  EmailChangeTarget,
  EmailChangeTokenRow,
} from '../repositories/emailChangeRepository.js';
import type { MailService } from '../mail/mailService.js';
import type { SiteUrlResolver } from '../site/siteUrl.js';

/**
 * 备用邮箱与邮箱变更（0003）。
 *
 * ## 三条分工（产品口径，不要混）
 *
 * 1. **绑定备用邮箱**：独立验证 —— 往待绑定的地址发一封验证信，点开即完成。
 *    不需要主邮箱参与。
 * 2. **变更任一个邮箱**：**交叉验证** ——
 *    - 新地址负责「证明归属」（verify 令牌）
 *    - **另一个**邮箱负责「授权这次变更」（authorize 令牌）
 *    - **两枚都消费完才生效**，任何一侧单独完成都不产生效果
 * 3. **被改掉的那个旧邮箱**：只收一封「已被更改」的通知，**不需要它做任何操作**；
 *    通知发失败也不阻塞变更（用户已经用另外两个邮箱证明了归属与授权，
 *    旧邮箱能不能收到信与「这次变更是否合法」无关）。
 *
 * ## 为什么不是「点一封邮件就改完」
 *
 * 单封链接的邮箱变更有一个经典问题：拿到会话的人（例如在共用电脑上忘了退出）
 * 只要控制一个新邮箱，就能把账号整个搬走。要求「另一个邮箱也要点头」之后，
 * 攻击者还需要控制受害者原有的邮箱之一 —— 而它恰恰是他想摆脱的那个。
 *
 * ## 单邮箱账号不会死锁
 *
 * 没有已验证备用邮箱时，改主邮箱的授权方回落到**当前主邮箱自己**：
 * 新地址那封验证信 + 当前地址那封授权信仍发往两个不同的邮箱，交叉验证的形态不变
 * （新地址无法自我授权）。代价只是「换邮箱」变成需要同时持有新旧两个地址，
 * 这是任何方案都绕不开的 —— 否则忘了密码的人可以靠改邮箱接管任意账号。
 * 同时响应里带 `backupEmailRecommended`，界面上提示补一个备用邮箱作兜底。
 *
 * ## 有效期
 *
 * 1 小时（比单纯验证邮箱的 30 分钟长）：用户要分别打开两个邮箱并点两封邮件，
 * 30 分钟在多邮箱、多设备的真实使用里偏紧，而这条路径的风险由「两枚令牌」
 * 承担，不靠缩短有效期。
 *
 * ## 不吊销会话
 *
 * 变更完成后**不**吊销该用户的其余登录态（与 changePassword 不同）。
 * 威胁模型不同：改密针对的是「密码已泄露」，而改邮箱需要同时控制新旧两个地址，
 * 攻击者拿不到旧地址点不了授权链接。此处吊销只会让正常用户在流程结束时被踢下线。
 */

/** 备用邮箱验证链接有效期；与 templates 里 backup_verify 文案绑定 */
export const BACKUP_VERIFY_TTL_MS = 30 * 60 * 1000;
/** 改邮箱两枚令牌的有效期；与 templates 里 change_* 文案绑定 */
export const CHANGE_TTL_MS = 60 * 60 * 1000;

const MAIL_NOT_CONFIGURED =
  '站点尚未配置 SMTP，无法发送邮件。请联系管理员配置邮件设置。';

export interface EmailChangeFlowDependencies {
  db: DatabaseConnection;
  users: UserRepository;
  changes: EmailChangeRepository;
  mail: MailService;
  siteUrl: SiteUrlResolver;
  /** 邮箱格式校验（复用 IdentityService，避免两套正则各自漂移） */
  emails: Pick<IdentityService, 'assertValidEmail'>;
  now?: () => Date;
}

/** 新增备用邮箱的请求结果 */
export interface AddBackupEmailResult {
  /** 本次是否真的发出了验证信 */
  sent: boolean;
  /** 待验证的地址（小写） */
  pendingEmail: string;
  /** 已有已验证的备用邮箱时不再重复发信 */
  alreadyVerified: boolean;
}

/** 发起改邮箱的请求结果 */
export interface EmailChangeRequestResult {
  requestId: string;
  target: EmailChangeTarget;
  newEmail: string;
  /** 承担交叉授权的邮箱 */
  authorizeVia: EmailChangeTarget;
  /** 授权信收件地址（界面用来提示「请去这个邮箱点授权」） */
  authorizeEmail: string;
  /** true = 没有已验证备用邮箱，授权回落到当前主邮箱自己（见文件头） */
  fallbackToSelf: boolean;
  /** true = 建议补一个备用邮箱作兜底（界面上给出提示语） */
  backupEmailRecommended: boolean;
}

/** 消费一枚改邮箱令牌后的结果 */
export interface EmailChangeConfirmResult {
  /** false = 只完成了一侧，还差另一侧 */
  completed: boolean;
  /** 本次消费的是哪一枚 */
  role: EmailChangeRole;
  target: EmailChangeTarget;
  newEmail: string;
  /** completed=false 时给出还等着的那一侧 */
  waitingFor: EmailChangeRole | null;
  /** completed=true 时给出变更后的当前邮箱地址 */
  email: string | null;
}

/** 邮箱与安全状态（个人中心「邮箱」卡片一次拿全） */
export interface EmailSecurityStatus {
  email: string;
  emailVerified: boolean;
  backupEmail: string | null;
  backupEmailVerified: boolean;
  /** 有无已验证备用邮箱：决定改主邮箱走交叉授权还是回落授权 */
  hasVerifiedBackup: boolean;
  /** 未绑定/未验证备用邮箱 → 界面提示补一个（防主邮箱失效后找不回账号） */
  backupEmailRecommended: boolean;
  /** 进行中的改邮箱请求（未完成未取消） */
  pendingChange: {
    id: string;
    target: EmailChangeTarget;
    newEmail: string;
    authorizeVia: EmailChangeTarget;
    /** 新地址那枚是否已消费 */
    verifyConfirmed: boolean;
    /** 授权那枚是否已消费 */
    authorizeConfirmed: boolean;
  } | null;
}

export class EmailChangeFlow {
  private readonly db: DatabaseConnection;
  private readonly users: UserRepository;
  private readonly changes: EmailChangeRepository;
  private readonly mail: MailService;
  private readonly siteUrl: SiteUrlResolver;
  private readonly emails: Pick<IdentityService, 'assertValidEmail'>;
  private readonly now: () => Date;

  constructor(deps: EmailChangeFlowDependencies) {
    this.db = deps.db;
    this.users = deps.users;
    this.changes = deps.changes;
    this.mail = deps.mail;
    this.siteUrl = deps.siteUrl;
    this.emails = deps.emails;
    this.now = deps.now ?? (() => new Date());
  }

  /** SMTP 未配置时给出可执行提示，而不是让底层报一串错误 */
  async assertMailReady(): Promise<void> {
    if (!(await this.mail.configured())) {
      throw new AppError('SMTP_ERROR', MAIL_NOT_CONFIGURED);
    }
  }

  // ---- 内部工具 ----

  private async requireUser(userId: string): Promise<UserRow> {
    const user = await this.users.findById(userId);
    if (!user || user.purgedAt !== null) {
      throw new AppError('NOT_FOUND', '用户不存在');
    }
    return user;
  }

  /**
   * 校验一个地址可以「作为」用户的某个邮箱槽位。
   *
   * 三条必须同时成立的约束：
   * 1. 不能与**自己**另一个槽位相同（产品要求：第一邮箱与第二邮箱不能相同）
   * 2. 不能是**别人的**主邮箱（否则两个账号共享一个地址，找回密码会互相踩）
   * 3. 不能是**别人的**备用邮箱
   *
   * 第 2、3 条不能只靠唯一索引兜底：索引会抛一句数据库错误，用户看不懂，
   * 而且报的是「重复」而不是「被占用」。
   */
  private async assertAddressAvailable(
    userId: string,
    address: string,
    slot: EmailChangeTarget,
  ): Promise<void> {
    const owner = await this.users.findByEmail(address);
    if (owner && owner.id !== userId) {
      throw new AppError('EMAIL_TAKEN', '该邮箱已被其他账号使用');
    }
    const backupOwner = await this.users.findByBackupEmail(address);
    if (backupOwner && backupOwner.id !== userId) {
      throw new AppError('EMAIL_TAKEN', '该邮箱已被其他账号用作备用邮箱');
    }
    // 与自己的另一个槽位相同 —— 只有主/备之间可能撞，同槽位相等由调用方另行判定
    const user = await this.requireUser(userId);
    const other = slot === 'primary' ? user.backupEmail : user.email;
    if (other !== null && other.toLowerCase() === address) {
      throw new AppError(
        'VALIDATION_ERROR',
        slot === 'primary'
          ? '主邮箱不能与备用邮箱相同；如需对调请先解除备用邮箱绑定'
          : '备用邮箱不能与主邮箱相同',
      );
    }
  }

  private async issueBackupToken(userId: string, pendingEmail: string): Promise<string> {
    const now = this.now();
    await this.changes.invalidateUnusedBackupEmailTokens(userId, now);
    const token = randomBytes(32).toString('base64url');
    await this.changes.insertBackupEmailToken({
      id: randomUUID(),
      userId,
      pendingEmail,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(now.getTime() + BACKUP_VERIFY_TTL_MS),
      createdAt: now,
    });
    return token;
  }

  private async issueChangeToken(
    userId: string,
    requestId: string,
    role: EmailChangeRole,
  ): Promise<string> {
    const now = this.now();
    await this.changes.invalidateUnusedChangeTokensForRequest(requestId, role, now);
    const token = randomBytes(32).toString('base64url');
    await this.changes.insertChangeToken({
      id: randomUUID(),
      userId,
      requestId,
      role,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(now.getTime() + CHANGE_TTL_MS),
      createdAt: now,
    });
    return token;
  }

  /** 取出并校验备用邮箱令牌（不消费），三种失败各有精确文案 */
  private async loadBackupToken(token: string) {
    if (typeof token !== 'string' || token.trim() === '') {
      throw new AppError('TOKEN_INVALID', '链接缺少令牌参数');
    }
    const row = await this.changes.findBackupEmailTokenByHash(sha256Hex(token));
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

  // ==========================================================================
  // 备用邮箱
  // ==========================================================================

  /**
   * 绑定备用邮箱的第一步：往待绑定地址发验证信。
   * 独立验证 —— 不需要主邮箱参与（见文件头第 1 条）。
   */
  async requestBackupEmail(
    userId: string,
    address: string,
    requestOrigin?: string,
  ): Promise<AddBackupEmailResult> {
    this.emails.assertValidEmail(address);
    const email = address.toLowerCase().trim();
    const user = await this.requireUser(userId);

    if (user.email.toLowerCase() === email) {
      throw new AppError('VALIDATION_ERROR', '备用邮箱不能与主邮箱相同');
    }
    if (user.backupEmailVerified && user.backupEmail?.toLowerCase() === email) {
      return { sent: false, pendingEmail: email, alreadyVerified: true };
    }
    await this.assertAddressAvailable(userId, email, 'backup');
    await this.assertMailReady();

    const token = await this.issueBackupToken(userId, email);
    const url = await this.siteUrl.link(
      '/verify-backup-email',
      { token },
      { requestOrigin },
    );
    await this.mail.sendBackupEmailVerification({ to: email, url });
    return { sent: true, pendingEmail: email, alreadyVerified: false };
  }

  /**
   * 绑定备用邮箱的第二步：消费验证信里的令牌，把地址落库并标记已验证。
   *
   * 消费与写入放同一事务：否则可能出现「令牌作废了但地址没绑上」，
   * 用户拿着已失效的链接反复重试，只能人工介入。
   *
   * 这里要重新校验一次地址可用性：发信与点击之间可能隔了几十分钟，
   * 期间该地址可能已经被别人注册 —— 唯一索引会拦，但那时报的是数据库错误。
   */
  async verifyBackupEmail(token: string): Promise<{ userId: string; email: string }> {
    const row = await this.loadBackupToken(token);
    const user = await this.requireUser(row.userId);
    const email = row.pendingEmail.toLowerCase();
    await this.assertAddressAvailable(row.userId, email, 'backup');

    const now = this.now();
    await this.db.transaction(async () => {
      const consumed = await this.changes.consumeBackupEmailToken(
        row.tokenHash,
        now,
      );
      if (!consumed) {
        throw new AppError('TOKEN_REVOKED', '该验证链接已被使用');
      }
      await this.users.setBackupEmail(consumed.userId, email, now);
      await this.users.markBackupEmailVerified(consumed.userId, true, now);
    });

    return { userId: user.id, email };
  }

  /** 解除备用邮箱绑定（未验证的绑定也走这条清理） */
  async removeBackupEmail(userId: string): Promise<{ email: string | null }> {
    const user = await this.requireUser(userId);
    if (user.backupEmail === null) {
      return { email: null };
    }
    const removed = user.backupEmail;
    const now = this.now();
    await this.users.clearBackupEmail(userId, now);
    // 只取消**依赖这个槽位**的进行中请求：无差别的「取消该用户全部未结束请求」
    // 会顺手干掉一个与备用邮箱无关、已经完成一半的主邮箱变更。
    const request = await this.changes.findOpenChangeRequestByUser(userId);
    if (request && (request.target === 'backup' || request.authorizeVia === 'backup')) {
      await this.changes.cancelChangeRequest(request.id, now);
    }
    return { email: removed };
  }

  // ==========================================================================
  // 改邮箱
  // ==========================================================================

  /**
   * 发起邮箱变更：一次请求 + 两枚令牌（verify 发给新地址、authorize 发给另一个邮箱）。
   *
   * 同时挂两个请求会让「哪个新地址生效」取决于用户先点开哪封信，而旧的那封里的
   * 地址可能早已不是他想要的，所以发起前先把未结束的请求全部取消。
   */
  async requestChange(
    userId: string,
    input: { target: EmailChangeTarget; newEmail: string },
    requestOrigin?: string,
  ): Promise<EmailChangeRequestResult> {
    this.emails.assertValidEmail(input.newEmail);
    const newEmail = input.newEmail.toLowerCase().trim();
    const user = await this.requireUser(userId);

    if (input.target !== 'primary' && input.target !== 'backup') {
      throw new AppError('VALIDATION_ERROR', 'target 只能是 primary 或 backup');
    }
    const current = input.target === 'primary' ? user.email : user.backupEmail;
    if (current !== null && current.toLowerCase() === newEmail) {
      throw new AppError(
        'VALIDATION_ERROR',
        input.target === 'primary' ? '新邮箱与当前邮箱相同' : '新邮箱与当前备用邮箱相同',
      );
    }
    await this.assertAddressAvailable(userId, newEmail, input.target);
    await this.assertMailReady();

    // 改主邮箱时：有已验证备用邮箱就让它授权，否则回落到当前主邮箱自己（防死锁）
    const hasVerifiedBackup =
      user.backupEmail !== null && user.backupEmailVerified;
    const authorizeVia: EmailChangeTarget =
      input.target === 'backup' ? 'primary' : hasVerifiedBackup ? 'backup' : 'primary';
    const fallbackToSelf = input.target === 'primary' && !hasVerifiedBackup;

    const authorizeEmail =
      authorizeVia === 'primary'
        ? user.email
        : (user.backupEmail ?? user.email);

    const now = this.now();
    const requestId = randomUUID();
    // 请求与两枚令牌必须一起落库：只建了请求没建令牌，用户会拿到一个
    // 「进行中」却永远点不动的状态；只建了令牌没建请求，令牌指向一个不存在的请求。
    // 发信放在事务外（SMTP 不参与事务，回滚也退不回已发出的邮件）。
    let verifyToken = '';
    let authorizeToken = '';
    await this.db.transaction(async () => {
      await this.changes.cancelOpenChangeRequestsForUser(userId, now);
      await this.changes.insertChangeRequest({
        id: requestId,
        userId,
        target: input.target,
        newEmail,
        authorizeVia,
        createdAt: now,
      });
      verifyToken = await this.issueChangeToken(userId, requestId, 'verify');
      authorizeToken = await this.issueChangeToken(
        userId,
        requestId,
        'authorize',
      );
    });

    const verifyUrl = await this.siteUrl.link(
      '/confirm-email-change',
      { token: verifyToken },
      { requestOrigin },
    );
    await this.mail.sendEmailChangeVerify({ to: newEmail, url: verifyUrl });

    const authorizeUrl = await this.siteUrl.link(
      '/confirm-email-change',
      { token: authorizeToken },
      { requestOrigin },
    );
    await this.mail.sendEmailChangeAuthorize({
      to: authorizeEmail,
      url: authorizeUrl,
    });

    return {
      requestId,
      target: input.target,
      newEmail,
      authorizeVia,
      authorizeEmail,
      fallbackToSelf,
      backupEmailRecommended: fallbackToSelf,
    };
  }

  /**
   * 取出改邮箱令牌（**不检查 usedAt**）。
   *
   * 与其它 load* 不同的地方：这里允许「已消费」的令牌走完整流程。
   * 原因是并发点击 —— 两枚链接几乎同时被点开时，两个请求可能各自只看见
   * 自己那一枚已消费（各自的未提交写入对对方不可见），双双判定「还差另一侧」。
   * 此时两枚令牌都已作废、变更却没生效。允许已消费的令牌继续走到收敛判定，
   * 第三次点击（或前端的状态轮询）就能把变更落地，不需要人工介入。
   *
   * 这不会削弱安全性：手持令牌本身就是授权凭证，重放一次能拿到的也只是
   * 「这次变更已经生效」这个既成事实。
   */
  private async findChangeToken(token: string): Promise<EmailChangeTokenRow> {
    if (typeof token !== 'string' || token.trim() === '') {
      throw new AppError('TOKEN_INVALID', '链接缺少令牌参数');
    }
    const row = await this.changes.findChangeTokenByHash(sha256Hex(token));
    if (!row) {
      throw new AppError('TOKEN_INVALID', '链接无效或已被清理，请重新获取');
    }
    if (row.usedAt === null && new Date(row.expiresAt).getTime() <= this.now().getTime()) {
      throw new AppError('TOKEN_EXPIRED', '链接已过期，请重新获取');
    }
    return row;
  }

  /**
   * 尝试把变更落地：两枚令牌都已消费时，抢占请求并把新地址写库。
   * 返回 true = 本次调用完成了变更（或发现已完成）。
   *
   * 幂等且并发安全：先把「未完成」作为条件抢占 request 行（claim），抢到才写邮箱，
   * 且两者在同一事务内 —— 否则崩在中间会留下「请求已完成但邮箱没改」的死状态。
   */
  private async tryFinalize(
    request: EmailChangeRequestRow,
    user: UserRow,
  ): Promise<boolean> {
    const tokens = await this.changes.listChangeTokensByRequest(request.id);
    const verifyDone = tokens.some((t) => t.role === 'verify' && t.usedAt !== null);
    const authorizeDone = tokens.some(
      (t) => t.role === 'authorize' && t.usedAt !== null,
    );
    if (!verifyDone || !authorizeDone) return false;

    const now = this.now();
    const oldEmail =
      request.target === 'primary' ? user.email : user.backupEmail;

    const applied = await this.db.transaction(async () => {
      const claimed = await this.changes.claimChangeRequest(request.id, now);
      if (!claimed) return false;
      if (request.target === 'primary') {
        await this.users.updateEmail(user.id, request.newEmail, now);
      } else {
        await this.users.setBackupEmail(user.id, request.newEmail, now);
        await this.users.markBackupEmailVerified(user.id, true, now);
      }
      return true;
    });

    if (!applied) return false;
    // 通知旧地址（事务外、失败不回滚，见文件头第 3 条）
    if (oldEmail !== null) {
      await this.notifyChanged(oldEmail, oldEmail, request.newEmail);
    }
    return true;
  }

  /**
   * 消费改邮箱链接（verify 或 authorize 都可能）。
   *
   * **只有两枚都消费完才真正生效** —— 这也是本方法需要「查另一枚状态」的原因：
   * 单看手上这一枚无法判断该不该落库。
   */
  async confirmChange(token: string): Promise<EmailChangeConfirmResult> {
    const row = await this.findChangeToken(token);
    const request = await this.changes.findChangeRequestById(row.requestId);
    if (!request) {
      throw new AppError('TOKEN_INVALID', '链接无效或已被清理，请重新获取');
    }
    const user = await this.requireUser(request.userId);
    const changedEmail =
      request.target === 'primary' ? request.newEmail : user.email;

    // 重复点击不该报错：变更已经生效，如实回答「已完成」即可
    if (request.completedAt !== null) {
      return {
        completed: true,
        role: row.role,
        target: request.target,
        newEmail: request.newEmail,
        waitingFor: null,
        email: changedEmail,
      };
    }
    if (request.cancelledAt !== null) {
      throw new AppError('TOKEN_REVOKED', '该变更请求已被取消');
    }

    if (row.usedAt === null) {
      const now = this.now();
      await this.db.transaction(async () => {
        const consumed = await this.changes.consumeChangeToken(row.tokenHash, now);
        if (!consumed) {
          throw new AppError('TOKEN_REVOKED', '该链接已被使用');
        }
      });
    }

    if (await this.tryFinalize(request, user)) {
      return {
        completed: true,
        role: row.role,
        target: request.target,
        newEmail: request.newEmail,
        waitingFor: null,
        email: changedEmail,
      };
    }

    const tokens = await this.changes.listChangeTokensByRequest(request.id);
    const verifyDone = tokens.some((t) => t.role === 'verify' && t.usedAt !== null);
    return {
      completed: false,
      role: row.role,
      target: request.target,
      newEmail: request.newEmail,
      waitingFor: verifyDone ? 'authorize' : 'verify',
      email: null,
    };
  }

  /**
   * 前端在「等待另一个邮箱确认」页轮询时调用：两枚都点过就落地。
   *
   * 存在的意义是让并发点击造成的「都点过了却都没生效」自愈 ——
   * 详见 findChangeToken 的注释。也顺便给界面一个确定的收敛点：
   * 轮询到 `completed: true` 就可以停止等待。
   */
  async finalizePendingChange(userId: string): Promise<{
    completed: boolean;
    email: string | null;
  }> {
    const user = await this.requireUser(userId);
    const request = await this.changes.findOpenChangeRequestByUser(userId);
    if (!request) {
      return {
        completed: true,
        email: user.email,
      };
    }
    const done = await this.tryFinalize(request, user);
    if (!done) return { completed: false, email: null };
    // 重新读一次：邮箱可能刚被改掉，返回给前端的是变更后的当前主邮箱
    const refreshed = await this.requireUser(userId);
    return { completed: true, email: refreshed.email };
  }

  /**
   * 给被改掉的那个邮箱发「已被更改」通知。
   *
   * **失败只记日志**：变更已经完成，此时抛错会让用户以为没成功而重复操作；
   * 而通知只是知情权 —— 这次变更的合法性由 verify + authorize 两枚令牌保证，
   * 与旧邮箱能不能收到信无关。
   */
  private async notifyChanged(
    to: string,
    oldEmail: string,
    newEmail: string,
  ): Promise<void> {
    try {
      await this.mail.sendEmailChangeNotice({ to, oldEmail, newEmail });
    } catch (err) {
      console.warn(
        `[email-change] 变更通知发送失败（不影响变更结果）：${to} - ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** 发起方主动取消进行中的改邮箱请求 */
  async cancelChange(userId: string): Promise<{ cancelled: number }> {
    await this.requireUser(userId);
    const cancelled = await this.changes.cancelOpenChangeRequestsForUser(
      userId,
      this.now(),
    );
    return { cancelled };
  }

  // ==========================================================================
  // 状态查询
  // ==========================================================================

  /** 个人中心「邮箱」卡片所需的全部状态（一次拿全，避免前端串三个接口） */
  async getStatus(userId: string): Promise<EmailSecurityStatus> {
    const user = await this.requireUser(userId);
    const request = await this.changes.findOpenChangeRequestByUser(userId);
    let pendingChange: EmailSecurityStatus['pendingChange'] = null;
    if (request) {
      const tokens = await this.changes.listChangeTokensByRequest(request.id);
      pendingChange = {
        id: request.id,
        target: request.target,
        newEmail: request.newEmail,
        authorizeVia: request.authorizeVia,
        verifyConfirmed: tokens.some(
          (t) => t.role === 'verify' && t.usedAt !== null,
        ),
        authorizeConfirmed: tokens.some(
          (t) => t.role === 'authorize' && t.usedAt !== null,
        ),
      };
    }
    const hasVerifiedBackup =
      user.backupEmail !== null && user.backupEmailVerified;
    return {
      email: user.email,
      emailVerified: user.emailVerified,
      backupEmail: user.backupEmail,
      backupEmailVerified: user.backupEmailVerified,
      hasVerifiedBackup,
      backupEmailRecommended: !hasVerifiedBackup,
      pendingChange,
    };
  }

  /** 启动时清理过期令牌与残留请求；这两类表只增不减 */
  async purgeExpired(): Promise<void> {
    const now = this.now();
    await this.changes.deleteExpiredBackupEmailTokens(now);
    await this.changes.deleteExpiredChangeTokens(now);
    await this.changes.cancelStaleOpenRequests(
      new Date(now.getTime() - CHANGE_TTL_MS),
      now,
    );
  }
}
