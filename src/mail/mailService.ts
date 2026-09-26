import type { RuntimeSettings } from '../site/runtimeSettings.js';
import { renderMail } from './templates.js';
import type { MailPort } from './types.js';

/**
 * 邮件应用服务：把「渲染什么内容」与「怎么发出去」分开。
 *
 * 调用方（EmailFlow）负责生成令牌与链接，这里只负责：读站点设置（自定义模板、
 * 站点名）→ 渲染 → 交给 MailPort。这样换一个 MailPort 实现（测试的内存实现、
 * 将来的 SES）不影响邮件内容逻辑。
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

  private async build(kind: 'verify' | 'reset', input: OutboundMailInput) {
    return renderMail({
      kind,
      custom: await this.runtime.mailTemplate(),
      vars: {
        email: input.to,
        url: input.url,
        siteTitle: await this.runtime.siteTitle(),
        year: String(this.now().getUTCFullYear()),
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

  /** 管理端「测试 SMTP 连接」；失败抛 AppError('SMTP_ERROR') */
  async verifyConnection(): Promise<void> {
    await this.mailer.verify();
  }
}
