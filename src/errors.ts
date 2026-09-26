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
  | 'TOO_MANY_REQUESTS';

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
