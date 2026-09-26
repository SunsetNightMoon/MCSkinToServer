import { Router } from 'express';
import type { CaptchaService } from '../../account/captcha.js';
import type { RuntimeSettings } from '../../site/runtimeSettings.js';
import type { RateLimiterPort } from '../../cache/types.js';
import type { RateLimitSettings } from '../../config.js';
import { DEFAULT_CAPTCHA_GENERATE_RATE_LIMIT } from '../../config.js';
import { clientIp, rateLimit } from '../rateLimit.js';
import { RateLimitKeys } from '../../cache/keys.js';

/**
 * 人机验证的 HTTP 适配层（0004）。
 *
 * - GET /api/captcha/captcha-type     当前类型：`{ type: 'math' | 'none' }`
 * - GET /api/captcha/generate         出题：`{ question, sessionId, expiresInSeconds }`
 *
 * ## 为什么形状是这两个端点
 *
 * 旧版前端（`web/src/pages/Auth/Login.tsx` / `Register.tsx` / `Upload/SkinUpload.tsx`）
 * 在挂载时就调 `captcha-type`，拿到 `'turnstile' | 'math' | 'none'` 后决定渲染哪种控件；
 * `math` 时再调 `generate?sessionId=…` 取题，提交表单时回传
 * `captcha_session_id` + `captcha_answer`。**沿用旧版界面是硬约束**，
 * 所以这里适配前端，而不是改前端来适配这里。
 *
 * 本项目**不接 Turnstile**（不引外部 JS/服务、也不把访客 IP 交给第三方），
 * 因此 `type` 只可能是 `'math'` 或 `'none'`，响应里**不含 siteKey**。
 * 前端的 turnstile 分支因此永远不会被走到，但它留着不影响 —— 将来真要去掉，
 * 应当连同 `TurnstileWidget` 组件一起摘。
 *
 * ## 未开启时的行为
 *
 * 开关（`ENABLE_CAPTCHA`）关闭时 `captcha-type` 返回 `'none'`，前端整块验证码 UI 不渲染；
 * `generate` 仍然可用（幂等无害），便于管理员开启前先自测题目样式。
 */
export interface CaptchaRouteDependencies {
  captcha?: CaptchaService;
  /** 站点运行期设置；未注入时按「不开启验证码」处理 */
  runtimeSettings?: RuntimeSettings;
  rateLimiter?: RateLimiterPort;
  /**
   * 出题端点专用限流参数；缺省用 DEFAULT_CAPTCHA_GENERATE_RATE_LIMIT（10 次/5 分钟）。
   *
   * 刻意**不复用认证端点那套 5 次/5 分钟**：实测正常用户几步就能打满，
   * 而打满后题干空白且无提示，直接堵死注册（详见 config.ts 中的取值说明）。
   */
  generateRateLimit?: RateLimitSettings;
}

export function createCaptchaRouter(deps: CaptchaRouteDependencies): Router {
  const router = Router();

  /**
   * 出题端点按**来源地址**限流。
   *
   * 这是整个数学题方案里收紧「批量预生成答案」的地方：题目本身没有难度，
   * 所以必须限制**出题速率**，否则攻击者可以一次性领走大量题目、把答案存下来慢慢用。
   * 但真正的批量闸门在别处 —— 注册/登录端点各自按 IP 限流，且每个账号还需要
   * 配一个自己算对的答案。所以这里只求「压掉脚本狂刷」，不求卡住真人：
   * 真人进入页面取一题、答错换一道、严格模式下挂载重复一次，都应当畅通。
   */
  const generateSettings = deps.generateRateLimit ?? DEFAULT_CAPTCHA_GENERATE_RATE_LIMIT;
  const generateLimit: ReturnType<typeof rateLimit>[] =
    deps.rateLimiter && generateSettings.enabled
      ? [
          rateLimit({
            limiter: deps.rateLimiter,
            settings: generateSettings,
            keyOf: (req) => RateLimitKeys.captchaGenerate(clientIp(req)),
            message: (seconds) => `验证码请求过于频繁，请在 ${seconds} 秒后重试`,
          }),
        ]
      : [];

  /**
   * 开关答案的来源。刻意**每次请求都问一遍**（RuntimeSettings 自己有 30s 缓存），
   * 这样管理员在后台点开关后无需重启即可生效。
   */
  const isEnabled = async (): Promise<boolean> =>
    deps.runtimeSettings ? deps.runtimeSettings.enableCaptcha() : false;

  router.get('/api/captcha/captcha-type', async (_req, res) => {
    // 开关状态随时可能被管理员改动，不能让中间层缓存住旧的 'none'
    res.setHeader('Cache-Control', 'no-store');
    const enabled = await isEnabled();
    res.json({ type: enabled ? 'math' : 'none' });
  });

  router.get('/api/captcha/generate', ...generateLimit, async (req, res) => {
    if (!deps.captcha) {
      // 未注入服务属于部署问题，不该静默给一个空题目（前端会渲染成一片空白）
      res.status(503).json({
        error: 'CAPTCHA_UNAVAILABLE',
        errorMessage: '人机验证服务未启用',
        message: '人机验证服务未启用',
      });
      return;
    }
    const sessionId = req.query['sessionId'];
    const question = await deps.captcha.generate(
      Array.isArray(sessionId) ? sessionId[0] : sessionId,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json(question);
  });

  return router;
}
