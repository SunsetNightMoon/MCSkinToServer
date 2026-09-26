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
  | 'ACCOUNT_DELETED';

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
