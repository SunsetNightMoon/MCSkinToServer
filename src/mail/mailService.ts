import type { RuntimeSettings } from '../site/runtimeSettings.js';
import { CUSTOMIZABLE_MAIL_KINDS, renderMail, type MailKind } from './templates.js';
import type { MailPort } from './types.js';

/**
 * 邮件应用服务：把「渲染什么内容」与「怎么发出去」分开。
 *
 * 调用方（EmailFlow / EmailChangeFlow）负责生成令牌与链接，这里只负责：读站点设置
 * （自定义模板、站点名）→ 渲染 → 交给 MailPort。这样换一个 MailPort 实现
 * （测试的内存实现、将来的 SES）不影响邮件内容逻辑。
 */

export interface MailServiceDependencies {
  mailer: MailPort;
  runtime: RuntimeSettings;
  now?: () => Date;
}

export interface OutboundMailInput {
  to: string;
  /** 邮件里的动作链接（由 SiteUrlResolver 生成，已含站点根与哈希路由） */
  url: string;
}

/** 邮箱变更通知：无动作链接，只有前后的两个地址 */
export interface OutboundNoticeInput {
  to: string;
  oldEmail: string;
  newEmail: string;
}

export class MailService {
  private readonly mailer: MailPort;
  private readonly runtime: RuntimeSettings;
  private readonly now: () => Date;

  constructor(deps: MailServiceDependencies) {
    this.mailer = deps.mailer;
    this.runtime = deps.runtime;
    this.now = deps.now ?? (() => new Date());
  }

  /** SMTP 是否具备发信条件（host 已填、有认证时口令已备） */
  async configured(): Promise<boolean> {
    return this.runtime.smtpConfigured();
  }

  /**
   * 渲染一封邮件。
   *
   * `custom` 只对「管理员可自定义」的种类读取设置（见 CUSTOMIZABLE_MAIL_KINDS）：
   * 0003 的四类账号安全通知只有内置正文，读设置也没人会写，白白多一次缓存读。
   */
  private async build(
    kind: MailKind,
    input: OutboundMailInput & { oldEmail?: string; newEmail?: string },
  ): Promise<{ subject: string; html: string }> {
    return renderMail({
      kind,
      custom: CUSTOMIZABLE_MAIL_KINDS.has(kind)
        ? await this.runtime.mailTemplate()
        : null,
      vars: {
        email: input.to,
        url: input.url,
        siteTitle: await this.runtime.siteTitle(),
        // 邮件抬头与登录/注册页用同一枚徽标（SITE_LOGO）；未设置 = 空串，
        // 内置模板里的 {{SITE_LOGO_IMG}} 会随之留空，不会渲染出破图
        siteLogo: await this.runtime.siteLogoUrl(),
        year: String(this.now().getUTCFullYear()),
        ...(input.oldEmail !== undefined ? { oldEmail: input.oldEmail } : {}),
        ...(input.newEmail !== undefined ? { newEmail: input.newEmail } : {}),
      },
    });
  }

  async sendVerification(input: OutboundMailInput): Promise<void> {
    const mail = await this.build('verify', input);
    await this.mailer.send({ to: input.to, ...mail });
  }

  async sendPasswordReset(input: OutboundMailInput): Promise<void> {
    const mail = await this.build('reset', input);
    await this.mailer.send({ to: input.to, ...mail });
  }

  /** 0003：验证待绑定的备用邮箱 */
  async sendBackupEmailVerification(input: OutboundMailInput): Promise<void> {
    const mail = await this.build('backup_verify', input);
    await this.mailer.send({ to: input.to, ...mail });
  }

  /** 0003：改邮箱 —— 发给新地址，证明归属 */
  async sendEmailChangeVerify(input: OutboundMailInput): Promise<void> {
    const mail = await this.build('change_verify', input);
    await this.mailer.send({ to: input.to, ...mail });
  }

  /** 0003：改邮箱 —— 发给另一个邮箱，交叉授权 */
  async sendEmailChangeAuthorize(input: OutboundMailInput): Promise<void> {
    const mail = await this.build('change_authorize', input);
    await this.mailer.send({ to: input.to, ...mail });
  }

  /** 0003：改邮箱 —— 通知被改掉的那个邮箱（纯知情，不需要操作） */
  async sendEmailChangeNotice(input: OutboundNoticeInput): Promise<void> {
    const mail = await this.build('change_notice', {
      to: input.to,
      url: '',
      oldEmail: input.oldEmail,
      newEmail: input.newEmail,
    });
    await this.mailer.send({ to: input.to, ...mail });
  }

  /** 管理端「测试 SMTP 连接」；失败抛 AppError('SMTP_ERROR') */
  async verifyConnection(): Promise<void> {
    await this.mailer.verify();
  }
}
