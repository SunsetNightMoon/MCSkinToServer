import type { NextFunction, Request, Response } from 'express';
import type { AppErrorCode } from '../errors.js';
import { AppError } from '../errors.js';
import { YggdrasilError } from '../yggdrasil/errors.js';

/**
 * 统一错误 → HTTP 映射（蓝图 §6.1 集中映射的 HTTP 侧）。
 * YggdrasilError → 协议响应体；AppError → { error: code, message }；未知 → 500 不泄露细节。
 */

export function mapAppErrorStatus(code: AppErrorCode): number {
  switch (code) {
    case 'VALIDATION_ERROR':
      return 400;
    case 'TOKEN_INVALID':
    case 'TOKEN_EXPIRED':
    case 'TOKEN_REVOKED':
    case 'INVALID_CREDENTIALS':
      return 401;
    case 'USER_DISABLED':
    case 'USER_BANNED':
    case 'NAME_COOLDOWN':
      return 403;
    case 'EMAIL_TAKEN':
    case 'NAME_TAKEN':
      return 409;
    case 'NOT_FOUND':
      return 404;
    case 'DOWNLOAD_FORBIDDEN':
    case 'FORBIDDEN':
      return 403;
    default:
      return 500;
  }
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) {
    return;
  }
  if (err instanceof YggdrasilError) {
    res.status(err.status).json(err.toBody());
    return;
  }
  if (err instanceof AppError) {
    res
      .status(mapAppErrorStatus(err.code))
      .json({ error: err.code, message: err.message });
    return;
  }
  console.error('[http] unhandled error:', err);
  res.status(500).json({ error: 'INTERNAL_ERROR', message: '内部错误' });
}
