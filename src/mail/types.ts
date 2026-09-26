/**
 * 邮件发送端口（P5）。
 *
 * 与 StoragePort 同样的「窄端口 + 可替换实现」思路：业务层只知道「发一封信」，
 * 不知道背后是 SMTP、SES 还是内存记录器。测试注入 MemoryMailer 即可断言
 * 「注册后确实发了一封带验证链接的邮件」，而不需要起一个 SMTP 服务。
 *
 * 错误契约：**允许抛错**（与 RateLimiterPort 一致，与 CachePort 相反）。
 * 邮件是业务动作的一部分 —— 「注册了但验证邮件没发出去」必须让调用方知情，
 * 否则用户永远收不到链接却没有任何提示。抛错时使用 AppError('SMTP_ERROR', ...)。
 */

export interface MailMessage {
  to: string;
  subject: string;
  /** HTML 正文；纯文本由实现从 HTML 剥离（本地实现不做，SMTP 会带 text 兜底） */
  html: string;
}

export interface MailPort {
  /** 投递一封信；失败抛 AppError('SMTP_ERROR') */
  send(message: MailMessage): Promise<void>;

  /** 连接/认证自检（管理端「测试 SMTP 连接」用）；失败抛 AppError('SMTP_ERROR') */
  verify(): Promise<void>;
}
