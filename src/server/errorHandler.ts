import type { NextFunction, Request, Response } from 'express';
import type { AppErrorCode } from '../errors.js';
import { AppError, TooManyRequestsError } from '../errors.js';
import { YggdrasilError } from '../yggdrasil/errors.js';

/**
 * 统一错误 → HTTP 映射（蓝图 §6.1 集中映射的 HTTP 侧）。
 * YggdrasilError → 协议响应体；AppError → { error: code, message }；未知 → 500 不泄露细节。
 *
 * `errorMessage` 与 `message` 同值冗余输出：旧版（plan3）Web 接口的错误体是
 * `{ error, errorMessage }`，移植过来的前端有 20+ 处按 `data.errorMessage` 取文案。
 * 只发 `message` 会让这些位置全部退化成「操作失败」这类通用提示，用户看不到
 * 「密码不正确」等真实原因。冗余一个键即可让旧前端原样工作，且不影响既有消费方。
 */

export function mapAppErrorStatus(code: AppErrorCode): number {
  switch (code) {
    case 'VALIDATION_ERROR':
    // 验证码错误属于请求内容问题，前端要允许用户重试
    case 'CAPTCHA_INVALID':
      return 400;
    case 'TOKEN_INVALID':
    case 'TOKEN_EXPIRED':
    case 'TOKEN_REVOKED':
    case 'INVALID_CREDENTIALS':
      return 401;
    case 'USER_DISABLED':
    case 'USER_BANNED':
    case 'NAME_COOLDOWN':
    // 单用户名模式的「换 ID」冷却：凭据正确但当前状态不允许，语义同改名冷却
    case 'MODE_COOLDOWN':
    // 预留角色的写操作：角色归属正确，但它当前不是可用状态
    case 'PROFILE_RESERVED':
    case 'ACCOUNT_DELETED':
    // 关闭注册：请求方无权创建账号（而不是请求格式错）
    case 'REGISTRATION_DISABLED':
    // 未验证邮箱：凭据正确但账号状态不允许登录，前端据此展示「重发验证邮件」
    case 'EMAIL_NOT_VERIFIED':
      return 403;
    // SMTP 是上游依赖，故障归 502 而不是 500（区分「我们写错了」与「邮件服务不通」）
    case 'SMTP_ERROR':
      return 502;
    // 未安装：状态问题（装完就好），语义同 USER_DISABLED 的 403
    case 'SETUP_REQUIRED':
      return 403;
    case 'EMAIL_TAKEN':
    case 'NAME_TAKEN':
    // 账号状态与请求冲突：必须先做完「选择保留 ID」才能继续操作
    case 'MODE_CHOICE_REQUIRED':
      return 409;
    case 'NOT_FOUND':
      return 404;
    case 'DOWNLOAD_FORBIDDEN':
    case 'FORBIDDEN':
      return 403;
    case 'TOO_MANY_REQUESTS':
      return 429;
    // 预留端口：地址是对的、能力没实现。501 而不是 404，见 errors.ts 的说明
    case 'NOT_IMPLEMENTED':
      return 501;
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
    // 限流拒绝：除通用字段外补 retryAfterSeconds + 标准 Retry-After 头
    if (err instanceof TooManyRequestsError) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds));
      res.status(429).json({
        error: err.code,
        message: err.message,
        errorMessage: err.message,
        retryAfterSeconds: err.retryAfterSeconds,
      });
      return;
    }
    res.status(mapAppErrorStatus(err.code)).json({
      error: err.code,
      message: err.message,
      // 兼容旧前端（见文件头注释）
      errorMessage: err.message,
    });
    return;
  }
  console.error('[http] unhandled error:', err);
  res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: '内部错误',
    errorMessage: '内部错误',
  });
}
