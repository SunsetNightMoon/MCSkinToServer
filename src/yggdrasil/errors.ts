import { AppError } from '../errors.js';

/**
 * Yggdrasil 协议错误（蓝图 §6.1 集中映射表）。
 * HTTP 适配层捕获后转成 { error, errorMessage } 响应体。
 */

export type YggdrasilErrorName =
  | 'IllegalArgumentException'
  | 'ForbiddenOperationException';

export class YggdrasilError extends AppError {
  constructor(
    readonly status: 400 | 403 | 500,
    readonly errorName: YggdrasilErrorName,
    message: string,
  ) {
    super('YGGDRASIL_ERROR', message);
    this.name = 'YggdrasilError';
  }

  toBody(): { error: YggdrasilErrorName; errorMessage: string } {
    return { error: this.errorName, errorMessage: this.message };
  }
}

/** 参数缺失/非法 → 400 */
export function illegalArgument(message: string): YggdrasilError {
  return new YggdrasilError(400, 'IllegalArgumentException', message);
}

/** 凭据无效 / token 无效 → 403 */
export function forbiddenOperation(message: string): YggdrasilError {
  return new YggdrasilError(403, 'ForbiddenOperationException', message);
}

/** 非预期内部错误 → 500（响应体不泄露细节） */
export function internalYggdrasilError(): YggdrasilError {
  return new YggdrasilError(500, 'IllegalArgumentException', '内部错误');
}
