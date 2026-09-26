import { Router } from 'express';
import type { IdentityService } from '../../auth/identity.js';
import type { TokenService } from '../../auth/tokens.js';
import type { EmailFlow } from '../../account/emailFlow.js';
import type { RuntimeSettings } from '../../site/runtimeSettings.js';
import type { RateLimiterPort } from '../../cache/types.js';
import type { RateLimitSettings } from '../../config.js';
import { requireAuth } from '../middleware.js';
import { bodyKey, clientIp, rateLimit } from '../rateLimit.js';
import { RateLimitKeys } from '../../cache/keys.js';
import { AppError } from '../../errors.js';

/**
 * Web 身份 HTTP 适配层：
 * - POST /api/auth/register  注册（成功即登录）
 * - POST /api/auth/login     登录
 * - POST /api/auth/logout    登出（吊销当前 token）
 * - POST /api/auth/change-password  修改密码（需旧密码，成功后全部会话失效）
 * - POST /api/auth/delete-account   注销账号（需密码，15 天可恢复宽限期）
 * - POST /api/auth/restore-account  恢复已注销账号（宽限期内，免认证）
 * - GET  /api/me/profiles    角色列表（含每个角色的当前皮肤/披风 ID 与 URL）
 * - GET  /api/me/skin        当前默认角色的皮肤（顶栏头像）
 * - POST /api/profiles       新建角色
 * - POST /api/profiles/:id/name  改名（30 天冷却）
 * - DELETE /api/profiles/:id 删除角色
 */

export interface IdentityRouteDependencies {
  identity: IdentityService;
  tokenService: TokenService;
  /**
   * 站点运行期设置（注册开关 / 邮箱验证开关）。
   * 未注入时按「允许注册、不要求验证」处理 —— 与 RUNTIME_SETTING_DEFAULTS 一致，
   * 使未接线的测试与嵌入式用法行为不变。
   */
  runtimeSettings?: RuntimeSettings;
  /** 邮箱流程；仅在开启「要求邮箱验证」时用到，未注入则该开关无法生效 */
  emailFlow?: EmailFlow;
  /** 限流器；未注入则不做限流（测试场景） */
  rateLimiter?: RateLimiterPort;
  /** 限流参数；缺省用 DEFAULT_RATE_LIMIT */
  rateLimit?: RateLimitSettings;
}

const Bearer = 'bearer' as const;

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== Bearer || !token) return null;
  return token;
}

export function createIdentityRouter(deps: IdentityRouteDependencies): Router {
  const router = Router();

  /**
   * 登录按邮箱限流（防定向撞库）；注册按来源 IP 限流（防批量注册）。
   * 未注入限流器时为空数组，路由行为与加限流前完全一致。
   */
  const loginLimit: ReturnType<typeof rateLimit>[] =
    deps.rateLimiter && deps.rateLimit
      ? [
          rateLimit({
            limiter: deps.rateLimiter,
            settings: deps.rateLimit,
            keyOf: bodyKey('email', (v) => RateLimitKeys.webLogin(v)),
            message: (seconds) => `登录尝试过于频繁，请在 ${seconds} 秒后重试`,
          }),
        ]
      : [];

  const registerLimit: ReturnType<typeof rateLimit>[] =
    deps.rateLimiter && deps.rateLimit
      ? [
          rateLimit({
            limiter: deps.rateLimiter,
            settings: deps.rateLimit,
            keyOf: (req) => RateLimitKeys.webRegister(clientIp(req)),
            message: (seconds) => `注册请求过于频繁，请在 ${seconds} 秒后重试`,
          }),
        ]
      : [];

  router.post('/api/auth/register', ...registerLimit, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // 注册总开关：关闭时不建号（管理员仍可用管理端接口/直接改库加人）
    if (deps.runtimeSettings && !(await deps.runtimeSettings.allowRegistration())) {
      throw new AppError('REGISTRATION_DISABLED', '本站已关闭注册');
    }

    const requiresVerification = deps.runtimeSettings
      ? await deps.runtimeSettings.requireEmailVerification()
      : false;

    // 预检发信能力：宁可现在拒绝，也不要把用户建成「登不进去、也收不到验证信」的账号。
    // 那种账号既占邮箱又只能靠人工放行，是最糟的失败形态。
    if (requiresVerification) {
      if (!deps.emailFlow) {
        throw new AppError(
          'SMTP_ERROR',
          '本站要求邮箱验证，但邮件发送能力未启用，请联系管理员',
        );
      }
      await deps.emailFlow.assertMailReady();
    }

    const result = await deps.identity.register({
      email: String(body['email'] ?? ''),
      password: String(body['password'] ?? ''),
      profileName: String(body['profileName'] ?? ''),
      // 要求验证时不签发会话：否则「必须验证邮箱」形同虚设
      issueSession: !requiresVerification,
    });

    let verificationEmailSent = false;
    if (requiresVerification && deps.emailFlow) {
      try {
        verificationEmailSent = (await deps.emailFlow.sendVerification(result.user.id)).sent;
      } catch (err) {
        // 账号已经建好，此时回滚代价更大（用户会卡在「邮箱已被注册」）。
        // 如实把失败回报给前端，让用户能点重发、或由管理员在用户管理页手动放行。
        console.error(
          '[register] 验证邮件发送失败:',
          err instanceof Error ? err.message : err,
        );
      }
    }

    res.status(201).json({
      user: result.user,
      profile: result.profile,
      token: result.token?.token ?? null,
      expiresAt: result.token?.expiresAt ?? null,
      requiresVerification,
      verificationEmailSent,
    });
  });

  router.post('/api/auth/login', ...loginLimit, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await deps.identity.loginWeb({
      email: String(body['email'] ?? ''),
      password: String(body['password'] ?? ''),
      requireEmailVerified: deps.runtimeSettings
        ? await deps.runtimeSettings.requireEmailVerification()
        : false,
    });
    res.json({
      user: result.user,
      profile: result.profile,
      token: result.token?.token ?? null,
      expiresAt: result.token?.expiresAt ?? null,
    });
  });

  router.post('/api/auth/logout', async (req, res) => {
    const token = bearerToken(req.headers.authorization);
    if (token) {
      await deps.tokenService.revoke(token);
    }
    res.status(204).end();
  });

  /**
   * 恢复已注销账号（15 天宽限期内）。此时用户已无有效令牌，所以不挂认证；
   * 用邮箱+密码验证身份，成功后直接下发新会话。
   */
  router.post('/api/auth/restore-account', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await deps.identity.restoreAccount({
      email: String(body['email'] ?? ''),
      password: String(body['password'] ?? ''),
    });
    res.json({
      user: result.user,
      profile: result.profile,
      token: result.token?.token ?? null,
      expiresAt: result.token?.expiresAt ?? null,
    });
  });

  // ---- 角色管理（以下均需认证）----

  const auth = requireAuth(deps.tokenService);

  router.get('/api/me/profiles', auth, async (req, res) => {
    const list = await deps.identity.listProfilesWithTextures(req.context!.userId);
    res.json({ profiles: list });
  });

  /** 当前用户默认角色的皮肤（顶栏头像） */
  router.get('/api/me/skin', auth, async (req, res) => {
    const skin = await deps.identity.getMySkin(req.context!.userId);
    res.json(skin);
  });

  router.post('/api/profiles', auth, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const profile = await deps.identity.createProfile(
      req.context!.userId,
      String(body['name'] ?? ''),
    );
    res.status(201).json({ profile });
  });

  router.post('/api/profiles/:id/name', auth, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const profile = await deps.identity.renameProfile(
      req.context!.userId,
      String(req.params['id'] ?? ''),
      String(body['name'] ?? ''),
    );
    res.json({ profile });
  });

  router.delete('/api/profiles/:id', auth, async (req, res) => {
    await deps.identity.deleteProfile(
      req.context!.userId,
      String(req.params['id'] ?? ''),
    );
    res.status(204).end();
  });

  // ---- 账号生命周期（改密 / 注销）----

  /** 修改密码：需旧密码；成功后该用户全部会话（含 Yggdrasil）失效 */
  router.post('/api/auth/change-password', auth, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    await deps.identity.changePassword({
      userId: req.context!.userId,
      oldPassword: String(body['oldPassword'] ?? ''),
      newPassword: String(body['newPassword'] ?? ''),
    });
    res.json({ ok: true });
  });

  /** 注销账号：需密码确认，进入 15 天可恢复宽限期 */
  router.post('/api/auth/delete-account', auth, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await deps.identity.deleteAccount({
      userId: req.context!.userId,
      password: String(body['password'] ?? ''),
    });
    res.json(result);
  });

  return router;
}
