import { Router, type Request } from 'express';
import type { IdentityService } from '../../auth/identity.js';
import type { TokenService } from '../../auth/tokens.js';
import type { EmailFlow } from '../../account/emailFlow.js';
import { requestOrigin } from '../requestOrigin.js';
import type { CaptchaService } from '../../account/captcha.js';
import type { ExternalCaptchaService } from '../../account/externalCaptcha.js';
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
 * - POST /api/profiles/:id/name  改名（单用户名模式下 30 天冷却）
 * - DELETE /api/profiles/:id 删除角色
 * - GET  /api/me/profile-mode        用户名模式与角色状态（0003）
 * - POST /api/me/profile-mode        决定 / 切换用户名模式（0003）
 * - POST /api/me/profiles/:id/activate  启用预留角色（0003）
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
  /**
   * 0004：自托管人机验证（`math` / `image` 两种类型都用它）。
   * **开启但未注入时注册/登录直接拒绝** —— 安全开关设成「开了但没人执行」比没开更糟。
   */
  captcha?: CaptchaService;
  /**
   * Issue #3：外部人机验证（`external` 类型）。同样未注入即拒绝，不静默放行。
   */
  externalCaptcha?: ExternalCaptchaService;
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

  /**
   * 人机验证闸门（0004）。开关关闭时是空操作。
   *
   * ## 为什么放在最前面（早于密码校验）
   *
   * 验证码的全部意义就是**在密码被尝试之前**拦住自动化脚本。若放在密码校验之后，
   * 撞库脚本可以先高速试密码、只在最后才需要过验证码 —— 等于没装。
   * 这里不会泄露任何账号信息（验证码与邮箱无关），所以不存在「提前暴露账号是否存在」
   * 的问题（那个顾虑只适用于 EMAIL_NOT_VERIFIED 这类依赖账号状态的检查）。
   *
   * ## 失败即消费
   *
   * 校验成功或失败都会把这道题烧掉（见 CaptchaService.verify）。因此密码输错重试时
   * 必须换一道题 —— 旧版前端在 catch 分支里正是这么做的。这样做是为了避免
   * 「一道题反复试密码」。
   */
  const assertCaptcha = async (
    req: Request,
    body: Record<string, unknown>,
  ): Promise<void> => {
    if (!deps.runtimeSettings) return;
    const type = await deps.runtimeSettings.captchaType();
    if (type === 'none') return;

    if (type === 'external') {
      // 外部人机验证：token 由前端组件给出，真正的判定在服务端那次出站校验里。
      // 没接上校验能力同样属于「已开启但不可用」，宁可拒绝也不静默放行。
      if (!deps.externalCaptcha) {
        throw new AppError(
          'CAPTCHA_UNAVAILABLE',
          '本站已启用外部人机验证，但校验能力未启用，请联系管理员',
        );
      }
      const settings = await deps.runtimeSettings.externalCaptcha();
      await deps.externalCaptcha.verify(
        settings,
        body['captcha_token'] ?? body['captchaToken'],
        clientIp(req),
      );
      return;
    }

    // math 与 image 共用同一条「一次一题 + 先消费再比对」的校验路径
    if (!deps.captcha) {
      // 开关开了但服务没接上：宁可拒绝，也不要让「已开启验证码」变成一句空话
      throw new AppError(
        'CAPTCHA_INVALID',
        '本站已启用验证码，但验证码服务未启用，请联系管理员',
      );
    }
    await deps.captcha.verify(
      body['captcha_session_id'] ?? body['captchaSessionId'],
      body['captcha_answer'] ?? body['captchaAnswer'],
    );
  };

  router.post('/api/auth/register', ...registerLimit, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    await assertCaptcha(req, body);

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
        verificationEmailSent = (
          await deps.emailFlow.sendVerification(result.user.id, requestOrigin(req))
        ).sent;
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

    await assertCaptcha(req, body);

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

  // ---- 用户名模式（0003）----

  /** 模式与角色状态快照：模式、待选择标记、上限、冷却剩余、预留口数量 */
  router.get('/api/me/profile-mode', auth, async (req, res) => {
    const state = await deps.identity.getProfileModeState(req.context!.userId);
    res.json(state);
  });

  /**
   * 首次选择保留 ID（P5 第十一批收窄）。
   *
   * 全局切到 single 时名下有多个使用中 ID 的账号会进入「待选择」态，
   * 这里就是那个强制弹窗的提交端点。模式本身是全站统一的（`PROFILE_MODE`
   * 设置），任何账号（含超管）都没有自助切换入口 —— 已决定的账号调用
   * 这里会拿到 403。响应体返回选择后的完整状态，前端不需要再拉一次。
   */
  router.post('/api/me/profile-mode', auth, async (req, res) => {
    const userId = req.context!.userId;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const keepProfileId =
      body['keepProfileId'] === undefined || body['keepProfileId'] === null
        ? null
        : String(body['keepProfileId']);
    const state = await deps.identity.decideKeepId({ userId, keepProfileId });
    res.json(state);
  });

  /** 启用预留口里的角色（单用户名模式下唯一的「换 ID」路径） */
  router.post('/api/me/profiles/:id/activate', auth, async (req, res) => {
    const state = await deps.identity.activateReservedProfile(
      req.context!.userId,
      String(req.params['id'] ?? ''),
    );
    res.json(state);
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
