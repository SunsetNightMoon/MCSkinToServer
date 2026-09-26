import { Router } from 'express';
import type { TokenService } from '../../auth/tokens.js';
import type { EmailFlow } from '../../account/emailFlow.js';
import type { EmailChangeFlow } from '../../account/emailChangeFlow.js';
import type { RateLimiterPort } from '../../cache/types.js';
import type { RateLimitSettings } from '../../config.js';
import { optionalAuth, requireAuth } from '../middleware.js';
import { requestOrigin } from '../requestOrigin.js';
import { bodyKey, clientIp, rateLimit } from '../rateLimit.js';
import { RateLimitKeys } from '../../cache/keys.js';
import { AppError } from '../../errors.js';

/**
 * 账号辅助流程 HTTP 适配层（P5）：邮箱验证 + 密码重置。
 *
 * - POST /api/auth/send-verification  发送/重发验证邮件（可匿名，按邮箱）
 * - POST /api/auth/verify-email       消费验证链接（可匿名，凭令牌）
 * - POST /api/auth/send-reset-email   发送重置密码邮件（可匿名，按邮箱）
 * - POST /api/auth/reset-password     消费重置链接并改密（可匿名，凭令牌）
 *
 * 为什么全都是匿名可调：这三个动作发生在**用户拿不到会话**的时刻 ——
 * 注册未验证、忘记密码、登录被「未验证」拦下。要求先登录才能验证邮箱是死锁。
 * 安全性由令牌与限流承担，而不是由会话承担：
 * - 令牌是 256 bit 随机值且库中只存哈希，无法枚举
 * - 发信类端点按收件邮箱限流，防「拿别人邮箱刷信」
 *
 * ## 响应刻意寡淡
 *
 * send-* 两个端点无论邮箱是否注册过都返回同一个 `{ ok: true }`。
 * 一旦「不存在」与「已发送」的响应不同，这两个免认证端点立刻变成账号枚举接口。
 * 具体是否真的发了，只有收件人自己知道。
 */

export interface AccountRouteDependencies {
  tokenService: TokenService;
  emailFlow: EmailFlow;
  /**
   * 0003：备用邮箱与邮箱变更流程。可选 —— 未注入时 `/api/me/email-status`
   * 只返回主邮箱与验证状态，保持 P5 的行为不变（既有测试与部署不必同步升级）。
   */
  emailChangeFlow?: EmailChangeFlow;
  /** 限流器；未注入则不做限流（测试场景） */
  rateLimiter?: RateLimiterPort;
  rateLimit?: RateLimitSettings;
}

export function createAccountRouter(deps: AccountRouteDependencies): Router {
  const router = Router();

  /** 按收件邮箱限流（发信端点用）；邮箱缺失时返回 null 跳过限流，交给后续校验报 400 */
  const mailLimit = (pick: (email: string) => string, message: (s: number) => string) =>
    deps.rateLimiter && deps.rateLimit
      ? [
          rateLimit({
            limiter: deps.rateLimiter,
            settings: deps.rateLimit,
            keyOf: bodyKey('email', pick),
            message,
          }),
        ]
      : [];

  /** 按来源地址限流（消费令牌端点用）：令牌不可猜，限流只为压制无脑扫库 */
  const tokenLimit = (message: (s: number) => string) =>
    deps.rateLimiter && deps.rateLimit
      ? [
          rateLimit({
            limiter: deps.rateLimiter,
            settings: deps.rateLimit,
            keyOf: (req) => RateLimitKeys.tokenConsume(clientIp(req)),
            message,
          }),
        ]
      : [];

  const optional = optionalAuth(deps.tokenService);

  /** 发送验证邮件：已登录按会话身份，匿名按请求体邮箱 */
  router.post(
    '/api/auth/send-verification',
    ...mailLimit(
      (email) => RateLimitKeys.emailVerification(email),
      (s) => `验证邮件发送过于频繁，请在 ${s} 秒后重试`,
    ),
    optional,
    async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const userId = req.context?.userId;

      if (userId) {
        // 已登录：忽略请求体邮箱，避免拿自己的会话给别人刷信
        const result = await deps.emailFlow.sendVerification(userId, requestOrigin(req));
        res.json({ ok: true, alreadyVerified: result.alreadyVerified });
        return;
      }

      const email = String(body['email'] ?? '').trim();
      if (email === '') {
        throw new AppError('VALIDATION_ERROR', '请提供邮箱地址');
      }
      await deps.emailFlow.resendVerificationByEmail(email, requestOrigin(req));
      res.json({ ok: true });
    },
  );

  /** 消费验证链接；成功即表示该邮箱已验证 */
  router.post('/api/auth/verify-email', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await deps.emailFlow.verifyEmail(String(body['token'] ?? ''));
    res.json({ ok: true, email: result.email });
  });

  /** 发送重置密码邮件：已登录按会话身份，匿名按请求体邮箱 */
  router.post(
    '/api/auth/send-reset-email',
    ...mailLimit(
      (email) => RateLimitKeys.passwordReset(email),
      (s) => `重置邮件发送过于频繁，请在 ${s} 秒后重试`,
    ),
    optional,
    async (req, res) => {
      const userId = req.context?.userId;
      if (userId) {
        await deps.emailFlow.sendResetForUser(userId, requestOrigin(req));
        res.json({ ok: true });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const email = String(body['email'] ?? '').trim();
      if (email === '') {
        throw new AppError('VALIDATION_ERROR', '请提供邮箱地址');
      }
      await deps.emailFlow.sendReset(email, requestOrigin(req));
      res.json({ ok: true });
    },
  );

  /** 消费重置链接并改密；成功后该用户全部会话（含 Yggdrasil）失效 */
  router.post(
    '/api/auth/reset-password',
    ...tokenLimit((s) => `请求过于频繁，请在 ${s} 秒后重试`),
    async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // 旧前端的字段名与新版不同（newPassword / code），两个都收 ——
      // 移植期的字段名分歧如果只支持一个，表现是「提交没反应」，非常难排查
      const password = String(body['password'] ?? body['newPassword'] ?? '');
      const token = String(body['token'] ?? body['code'] ?? '');
      const result = await deps.emailFlow.resetPassword(token, password);
      res.json({ ok: true, email: result.email });
    },
  );

  // ---- 需认证：查询自己的邮箱验证状态 ----

  const auth = requireAuth(deps.tokenService);

  /**
   * 个人中心用：当前账号的邮箱与验证状态。
   *
   * 0003 起注入了 EmailChangeFlow 时，把备用邮箱与进行中的邮箱变更**合并**进同一
   * 响应（而不是另开一个端点）：界面上这是同一张「邮箱」卡片的三块信息，
   * 分成两个接口只会让前端多一次往返、并制造「两次读之间状态变了」的窗口。
   */
  router.get('/api/me/email-status', auth, async (req, res) => {
    const userId = req.context!.userId;
    const base = await deps.emailFlow.getEmailStatus(userId);
    if (!deps.emailChangeFlow) {
      res.json(base);
      return;
    }
    const extra = await deps.emailChangeFlow.getStatus(userId);
    // 两者都带 email / emailVerified（值相同），展开顺序不影响结果
    res.json({ ...base, ...extra });
  });

  return router;
}
