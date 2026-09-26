import type { NextFunction, Request, Response } from 'express';
import type { RequestContext, TokenService, UserRole } from '../auth/tokens.js';

/**
 * 统一认证/授权中间件（蓝图 §7.1）：
 * 路由不再自己解析 Authorization，所有需要认证的接口挂 requireAuth，
 * 角色检查挂 requireAdmin / requireSuperAdmin。
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** requireAuth 验证成功后写入（蓝图 §7.1 RequestContext） */
      context?: RequestContext;
    }
  }
}

const ROLE_LEVEL: Record<UserRole, number> = {
  user: 0,
  admin: 1,
  super_admin: 2,
};

const FAILURE_RESPONSE: Record<
  string,
  { status: number; code: string; message: string }
> = {
  invalid: { status: 401, code: 'TOKEN_INVALID', message: '令牌无效' },
  expired: { status: 401, code: 'TOKEN_EXPIRED', message: '令牌已过期' },
  revoked: { status: 401, code: 'TOKEN_REVOKED', message: '令牌已吊销' },
  user_disabled: { status: 403, code: 'USER_DISABLED', message: '账号已停用' },
};

export function requireAuth(
  tokenService: TokenService,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      res
        .status(401)
        .json({ error: 'TOKEN_INVALID', message: '缺少 Bearer token' });
      return;
    }
    const result = await tokenService.verify(token);
    if (!result.ok) {
      const failure = FAILURE_RESPONSE[result.reason]!;
      res.status(failure.status).json({
        error: failure.code,
        message: failure.message,
      });
      return;
    }
    req.context = result.context;
    next();
  };
}

/** 角色层级门槛：1 = admin 及以上，2 = 仅 super_admin */
export function requireRole(
  minLevel: 1 | 2,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const context = req.context;
    if (!context) {
      res.status(401).json({ error: 'TOKEN_INVALID', message: '未认证' });
      return;
    }
    if (ROLE_LEVEL[context.role] < minLevel) {
      res.status(403).json({ error: 'FORBIDDEN', message: '权限不足' });
      return;
    }
    next();
  };
}

export const requireAdmin = requireRole(1);
export const requireSuperAdmin = requireRole(2);

/**
 * 可选认证（公开库接口用）：带有效 Bearer token 则写入 req.context，
 * 没有 / 无效则匿名放行（context = undefined）。无效 token 不报错——
 * 公开内容对坏 token 的访客也应当可见（与 plan3 行为对齐，避免藏匿内容被探测）。
 */
export function optionalAuth(
  tokenService: TokenService,
): (req: Request, _res: Response, next: NextFunction) => Promise<void> {
  return async (req, _res, next) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token) {
      const result = await tokenService.verify(token);
      if (result.ok) {
        req.context = result.context;
      }
    }
    next();
  };
}
