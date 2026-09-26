import { Router } from 'express';
import type { TokenService } from '../../auth/tokens.js';
import type { EmailChangeFlow } from '../../account/emailChangeFlow.js';
import type { RateLimiterPort } from '../../cache/types.js';
import type { RateLimitSettings } from '../../config.js';
import { requireAuth } from '../middleware.js';
import { bodyKey, clientIp, rateLimit } from '../rateLimit.js';
import { RateLimitKeys } from '../../cache/keys.js';
import { AppError } from '../../errors.js';

/**
 * 备用邮箱与邮箱变更 HTTP 适配层（0003）。
 *
 * - POST   /api/me/backup-email           发起绑定备用邮箱（需登录，往待绑定地址发信）
 * - POST   /api/me/backup-email/verify    消费备用邮箱验证链接（**可匿名**，凭令牌）
 * - DELETE /api/me/backup-email           解除备用邮箱绑定（需登录）
 * - POST   /api/me/email-change           发起变更并发出两封信（需登录）
 * - POST   /api/me/email-change/confirm   消费其中一封（**可匿名**，凭令牌）
 * - POST   /api/me/email-change/finalize  收敛：两枚都点过就落地（需登录，幂等）
 * - DELETE /api/me/email-change           取消进行中的变更（需登录）
 *
 * ## 为什么 verify / confirm 允许匿名
 *
 * 用户点邮件里的链接时不一定带着会话 —— 可能在手机邮件客户端里点开，也可能
 * 另一个邮箱根本不在同一台设备上。要求先登录才能确认，等于把流程卡死在
 * 「两个邮箱必须在同一台浏览器里登录同一个账号」上。
 *
 * 安全性由令牌承担而不是会话：令牌 256 bit 随机、库中只存哈希、一次性消费、
 * 1 小时过期，且**必须两枚都消费完**变更才生效 —— 单靠一枚拿不到任何东西。
 *
 * ## finalize 为什么存在
 *
 * 两枚链接被并发点击时，两个事务可能各自只看见自己那一枚已消费（未提交写入
 * 对对方不可见），双双判定「还差另一侧」，于是变更永远不生效而令牌都已作废。
 * 前端在等待页轮询本端点即可自愈（详见 EmailChangeFlow.findChangeToken 注释）。
 */

export interface EmailChangeRouteDependencies {
  tokenService: TokenService;
  emailChangeFlow: EmailChangeFlow;
  /** 限流器；未注入则不做限流（测试场景） */
  rateLimiter?: RateLimiterPort;
  rateLimit?: RateLimitSettings;
}

export function createEmailChangeRouter(
  deps: EmailChangeRouteDependencies,
): Router {
  const router = Router();
  const auth = requireAuth(deps.tokenService);

  const limited = (
    keyOf: Parameters<typeof rateLimit>[0]['keyOf'],
    message: (s: number) => string,
  ) =>
    deps.rateLimiter && deps.rateLimit
      ? [rateLimit({ limiter: deps.rateLimiter, settings: deps.rateLimit, keyOf, message })]
      : [];

  /** 按来源地址限流（消费令牌端点用） */
  const tokenLimit = (message: (s: number) => string) =>
    limited((req) => RateLimitKeys.tokenConsume(clientIp(req)), message);

  // ---- 备用邮箱 ----

  router.post(
    '/api/me/backup-email',
    auth,
    ...limited(
      bodyKey('email', (email) => RateLimitKeys.backupEmail(email)),
      (s) => `验证邮件发送过于频繁，请在 ${s} 秒后重试`,
    ),
    async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const email = String(body['email'] ?? '').trim();
      if (email === '') {
        throw new AppError('VALIDATION_ERROR', '请提供备用邮箱地址');
      }
      const result = await deps.emailChangeFlow.requestBackupEmail(
        req.context!.userId,
        email,
      );
      res.json(result);
    },
  );

  /**
   * 消费备用邮箱验证链接。URL 里给的是 token，但旧前端可能把整个链接塞进 body，
   * 两种都收 —— 与 reset-password 的字段名宽容策略同一考虑。
   */
  router.post(
    '/api/me/backup-email/verify',
    ...tokenLimit((s) => `请求过于频繁，请在 ${s} 秒后重试`),
    async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await deps.emailChangeFlow.verifyBackupEmail(
        String(body['token'] ?? ''),
      );
      res.json({ ok: true, email: result.email });
    },
  );

  router.delete('/api/me/backup-email', auth, async (req, res) => {
    const result = await deps.emailChangeFlow.removeBackupEmail(
      req.context!.userId,
    );
    res.json({ ok: true, removed: result.email });
  });

  // ---- 邮箱变更 ----

  router.post(
    '/api/me/email-change',
    auth,
    ...limited(
      (req) => {
        const userId = req.context?.userId;
        return userId ? RateLimitKeys.emailChange(userId) : null;
      },
      (s) => `邮箱变更请求过于频繁，请在 ${s} 秒后重试`,
    ),
    async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const target = String(body['target'] ?? 'primary');
      if (target !== 'primary' && target !== 'backup') {
        throw new AppError('VALIDATION_ERROR', 'target 只能是 primary 或 backup');
      }
      const result = await deps.emailChangeFlow.requestChange(
        req.context!.userId,
        {
          target,
          newEmail: String(body['newEmail'] ?? body['email'] ?? ''),
        },
      );
      res.json(result);
    },
  );

  router.post(
    '/api/me/email-change/confirm',
    ...tokenLimit((s) => `请求过于频繁，请在 ${s} 秒后重试`),
    async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await deps.emailChangeFlow.confirmChange(
        String(body['token'] ?? ''),
      );
      res.json(result);
    },
  );

  /**
   * 收敛点。前端在「等待另一个邮箱确认」页轮询它；已经在等待中而两枚都已点过时
   * 直接完成并返回 completed:true。
   */
  router.post('/api/me/email-change/finalize', auth, async (req, res) => {
    const result = await deps.emailChangeFlow.finalizePendingChange(
      req.context!.userId,
    );
    res.json(result);
  });

  router.delete('/api/me/email-change', auth, async (req, res) => {
    const result = await deps.emailChangeFlow.cancelChange(req.context!.userId);
    res.json({ ok: true, ...result });
  });

  return router;
}
