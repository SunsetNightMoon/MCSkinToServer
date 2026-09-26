import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { AppError } from '../errors.js';
import { sha256Hex } from '../util/crypto.js';
import type { RuntimeSettings, SmtpSettings } from '../site/runtimeSettings.js';
import type { MailMessage, MailPort } from './types.js';

/**
 * SMTP 实现（P5）。配置一律从站点设置现读，不在这里持有配置副本 ——
 * 管理员改完 SMTP 应当立即生效，而不是等重启。
 *
 * ## 连接池为什么要自建
 *
 * nodemailer 没有「配置变更后自动重连」的机制：transport 在创建时就固定了
 * host/port/凭据。若每次 send 都 createTransport，会为每封信新建 TCP+TLS 连接，
 * 发验证邮件这种低频场景尚可，但批量场景会明显变慢且可能被邮件服务商限流。
 * 因此在实例内缓存一个 transport，并用**配置指纹**判断是否需要重建：
 * 指纹变了（管理员改了服务器）就丢弃旧的重建，没变就复用。
 *
 * 指纹里口令只放哈希：指纹本身的用途只是判断「变没变」，
 * 没必要为此在内存里多留一份明文口令副本。
 *
 * ## TLS 校验
 *
 * 默认保持证书校验开启。自建邮件服务器（尤其是内网 Exchange / 自签证书的
 * Postfix）几乎必然触发 "self signed certificate"，因此提供显式逃生门
 * `SMTP_ALLOW_SELF_SIGNED=true`。不做成默认放开：那等于对所有人静默降级
 * 到不校验，把中间人风险藏起来。
 */

/** 允许自签证书的环境变量开关（仅对自建邮件服务器有意义） */
export const ALLOW_SELF_SIGNED_ENV = 'SMTP_ALLOW_SELF_SIGNED';

interface CachedTransport {
  fingerprint: string;
  transporter: Transporter;
}

/** 把 nodemailer 的错误压成一句可读文本（它常把真正原因藏在 code/response 里） */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const extra = err as Error & { code?: string; response?: string };
  const parts = [err.message];
  if (extra.code && !err.message.includes(extra.code)) parts.push(`(${extra.code})`);
  if (extra.response) parts.push(extra.response);
  return parts.join(' ');
}

/** 组装 From 头：有显示名时用 RFC 5322 的 `"名字" <地址>` 形式 */
function formatFrom(settings: SmtpSettings): string {
  const address = settings.from !== '' ? settings.from : settings.user;
  if (address === '') {
    throw new AppError('SMTP_ERROR', 'SMTP 未配置发件人地址（SMTP_FROM）');
  }
  return settings.fromName !== ''
    ? `"${settings.fromName.replace(/"/g, '')}" <${address}>`
    : address;
}

export class SmtpMailer implements MailPort {
  private cached: CachedTransport | null = null;
  private readonly allowSelfSigned: boolean;

  constructor(
    private readonly runtime: RuntimeSettings,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.allowSelfSigned = env[ALLOW_SELF_SIGNED_ENV] === 'true';
  }

  private fingerprintOf(settings: SmtpSettings): string {
    return [
      settings.host,
      String(settings.port),
      settings.secure ? '1' : '0',
      settings.user,
      sha256Hex(settings.pass),
      settings.from,
      settings.fromName,
    ].join('|');
  }

  /** 取（必要时重建）transport，并返回本次使用的配置 */
  private async resolve(): Promise<{ transporter: Transporter; settings: SmtpSettings }> {
    const settings = await this.runtime.smtp();
    if (settings.host === '') {
      throw new AppError('SMTP_ERROR', '尚未配置 SMTP 服务器地址');
    }
    if (settings.user !== '' && settings.pass === '') {
      throw new AppError('SMTP_ERROR', 'SMTP 已填写用户名但缺少密码/授权码');
    }

    const fingerprint = this.fingerprintOf(settings);
    if (this.cached && this.cached.fingerprint === fingerprint) {
      return { transporter: this.cached.transporter, settings };
    }

    const transporter = createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth:
        settings.user === ''
          ? undefined
          : { user: settings.user, pass: settings.pass },
      ...(this.allowSelfSigned ? { tls: { rejectUnauthorized: false } } : {}),
    });
    this.cached = { fingerprint, transporter };
    return { transporter, settings };
  }

  async send(message: MailMessage): Promise<void> {
    const { transporter, settings } = await this.resolve();
    try {
      await transporter.sendMail({
        from: formatFrom(settings),
        to: message.to,
        subject: message.subject,
        html: message.html,
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('SMTP_ERROR', `邮件发送失败：${describeError(err)}`, {
        cause: err,
      });
    }
  }

  async verify(): Promise<void> {
    const { transporter } = await this.resolve();
    try {
      await transporter.verify();
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('SMTP_ERROR', `SMTP 连接失败：${describeError(err)}`, {
        cause: err,
      });
    }
  }
}
