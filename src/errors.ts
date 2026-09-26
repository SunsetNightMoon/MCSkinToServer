/**
 * 统一错误类型（蓝图 P0）。
 * 所有领域/基础设施错误继承 AppError，携带稳定错误码，
 * HTTP/Yggdrasil 适配层据码映射响应（蓝图 §6.1 错误映射表）。
 */

export type AppErrorCode =
  | 'CONFIG_ERROR'
  | 'MIGRATION_ERROR'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_REVOKED'
  | 'USER_DISABLED'
  | 'STORAGE_ERROR'
  | 'YGGDRASIL_ERROR'
  | 'VALIDATION_ERROR'
  | 'EMAIL_TAKEN'
  | 'NAME_TAKEN'
  | 'NAME_COOLDOWN'
  | 'INVALID_CREDENTIALS'
  | 'USER_BANNED'
  | 'NOT_FOUND'
  | 'DOWNLOAD_FORBIDDEN'
  | 'FORBIDDEN'
  | 'ACCOUNT_DELETED'
  | 'TOO_MANY_REQUESTS'
  // ---- P5：注册开关 / 邮箱验证 / 验证码 / 发信 ----
  /** 站点设置关闭了注册（ALLOW_REGISTRATION=false） */
  | 'REGISTRATION_DISABLED'
  /** 站点要求邮箱验证，但该账号尚未验证 */
  | 'EMAIL_NOT_VERIFIED'
  /** 验证码缺失、错误或已过期；为防自动化探测，三者不区分错误码 */
  | 'CAPTCHA_INVALID'
  /** SMTP 连接或投递失败（上游故障，非请求方错误） */
  | 'SMTP_ERROR'
  // ---- 0003：用户名模式 / 角色预留 ----
  /**
   * 单用户名模式下「启用预留角色」的换 ID 冷却中。
   *
   * 与 NAME_COOLDOWN 是**同一个 30 天窗口**的两种触发形式（换角色 / 改名字）。
   * 分成两个码而不是共用一个，是因为前端要展示的文案不同：
   * 改名冷却说「改名冷却中」，而这里是「更换角色 ID 的冷却中」——
   * 用户根本没改名，告诉他「改名冷却」只会让人以为系统搞错了。
   */
  | 'MODE_COOLDOWN'
  /** 该角色处于预留状态，当前不可用（不能改名、不能作为会话的 selectedProfile） */
  | 'PROFILE_RESERVED'
  /**
   * 账号尚未完成首次模式选择（存量多角色用户）。
   * 任何模式/角色写操作都必须先走「选择保留 ID」流程，
   * 否则会出现「用户还没选，后端已经替他定了」的状态漂移。
   */
  | 'MODE_CHOICE_REQUIRED'
  // ---- 0003 / 批4-F：预留端口 ----
  /**
   * 该能力在本项目里只是**预留端口**，没有内置实现。
   *
   * 与 404 的区别是有意的：404 说「没有这个东西」，501 说
   * 「接线口在这里，但需要接入方自己实现」——后者对部署者是可行动的
   * （去看 `docs/oauth-provider-guide.md`），前者会让人以为是地址写错了。
   */
  | 'NOT_IMPLEMENTED';

export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = new.target.name;
  }
}

/**
 * 限流拒绝（HTTP 429）。
 *
 * 单独成类而非用裸 AppError：错误的响应体除 error/message 外还要带
 * `retryAfterSeconds` 与标准 `Retry-After` 头，errorHandler 需要据此特判。
 */
export class TooManyRequestsError extends AppError {
  constructor(
    message: string,
    /** 建议重试等待秒数（向上取整，最小 1） */
    readonly retryAfterSeconds: number,
  ) {
    super('TOO_MANY_REQUESTS', message);
  }
}
