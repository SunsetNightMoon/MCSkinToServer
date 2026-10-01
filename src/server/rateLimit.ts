import type { NextFunction, Request, Response } from 'express';
import type { RateLimiterPort } from '../cache/types.js';
import type { RateLimitSettings } from '../config.js';
import { TooManyRequestsError } from '../errors.js';

/**
 * 认证端点限流中间件（P5）。
 *
 * 错误契约：抛 `TooManyRequestsError`（HTTP 429，定义在 errors.ts），
 * body 由 errorHandler 统一产出
 * `{ error: 'TOO_MANY_REQUESTS', message, errorMessage, retryAfterSeconds }`，
 * 并带标准 `Retry-After` 响应头。旧版前端多按 `errorMessage` 取文案，故该字段必须有。
 */

/**
 * 取客户端地址。
 *
 * 用 `req.ip` 而不是直接读 `X-Forwarded-For`：Express 只在设置了 `trust proxy` 时
 * 才采信 XFF，否则 req.ip 就是 socket 地址。直接读 XFF 会让攻击者伪造任意 IP 绕过限流。
 * 部署在 OpenResty 之后需要设 TRUST_PROXY（见 app.ts），否则拿到的是反代自身地址。
 */
export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export interface RateLimitMiddlewareOptions {
  limiter: RateLimiterPort;
  settings: RateLimitSettings;
  /**
   * 由请求推导限流键；返回 null 表示无法确定（跳过限流，如缺字段的畸形请求）。
   *
   * 允许异步：登录限流需要先把「提交的标识」解析成账号 id —— 备用邮箱是同一个账号的
   * 另一个登录入口，按提交字符串取键等于给那个账号两份配额。解析一次索引查询而已。
   */
  keyOf: (req: Request) => string | null | Promise<string | null>;
  /** 拒绝时的文案 */
  message?: (retryAfterSeconds: number) => string;
}

/**
 * 生成限流中间件。
 *
 * **失败开放（fail-open）**：限流器自身报错（如 Redis 中途断开）时放行并记 warning，
 * 而不是把认证整体打挂。取舍理由：限流是防滥用的加固层，不是鉴权本身；
 * 因缓存故障导致全站无法登录，代价远大于短时间内失去限流保护。
 */
export function rateLimit(
  options: RateLimitMiddlewareOptions,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const { limiter, settings, keyOf } = options;
  const buildMessage =
    options.message ??
    ((seconds: number) => `请求过于频繁，请 ${seconds} 秒后再试`);

  return async (req, res, next) => {
    if (!settings.enabled) {
      next();
      return;
    }
    const key = await keyOf(req);
    if (!key) {
      next();
      return;
    }

    let result;
    try {
      result = await limiter.consume(key, settings.max, settings.windowMs);
    } catch (err) {
      console.warn(
        `[rate-limit] 计数器不可用，本次放行：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      next();
      return;
    }

    res.setHeader('X-RateLimit-Limit', String(result.limit));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));

    if (result.allowed) {
      next();
      return;
    }

    const retryAfterSeconds = Math.max(1, Math.ceil(result.resetAfterMs / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.setHeader('X-RateLimit-Reset', String(retryAfterSeconds));
    next(new TooManyRequestsError(buildMessage(retryAfterSeconds), retryAfterSeconds));
  };
}

/**
 * 从请求体取一个字符串字段，trim 后为空或缺失返回 null。
 * 供需要「先拿原始提交值、再自己决定键」的异步 keyOf 使用（如登录按账号取键）。
 */
export function bodyField(req: Request, field: string): string | null {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const raw = body[field];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return raw.trim();
}

/**
 * 从请求体里取字段做限流键。字段缺失时返回 null（畸形请求交给后续的参数校验报 400，
 * 不应占用限流配额）。
 */
export function bodyKey(
  field: string,
  normalize: (value: string) => string = (v) => v,
): (req: Request) => string | null {
  return (req: Request) => {
    const raw = bodyField(req, field);
    return raw === null ? null : normalize(raw);
  };
}
